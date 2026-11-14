import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDdragonClient, isPosition, toTierListFilters } from '@pick-league/shared';
import { app, BrowserWindow, ipcMain, powerSaveBlocker, shell } from 'electron';
import { IPC, type Settings, type WindowState } from '../core/app-state.ts';
import { staticResponseFromDdragon } from '../core/static-from-ddragon.ts';
import { DEFAULT_ZOOM, stepZoom, zoomShortcut } from '../core/zoom.ts';
import { createApiClient } from './api-client.ts';
import { Controller } from './controller.ts';
import { createMockLcuSource } from './lcu/mock.ts';
import { createRealLcuSource } from './lcu/real.ts';
import { loadSettings, sanitizeSettings, saveSettings } from './settings.ts';

app.setName('PickLeague');
const forcedMock = process.env.PICKLEAGUE_MOCK_LCU === '1';
const log = (message: string) => console.log(`[pickleague] ${message}`);

/**
 * Windows and Linux: no native title bar nor menu bar; the app header is the drag region and
 * draws its own window controls. macOS keeps its native title bar and traffic lights.
 * Dev only: PICKLEAGUE_FORCE_FRAMELESS=1 applies the Windows setup on any OS (to check it on a Mac).
 */
const frameless =
  process.platform !== 'darwin' ||
  (!app.isPackaged && process.env.PICKLEAGUE_FORCE_FRAMELESS === '1');

function windowState(win: BrowserWindow): WindowState {
  return { customControls: frameless, maximized: win.isMaximized() || win.isFullScreen() };
}

/** Without a menu, the dev accelerators it provided are gone: keep reload + devtools in dev. */
function devShortcuts(win: BrowserWindow): void {
  if (app.isPackaged) return;
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (input.key === 'F12' || (mod && input.shift && key === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if ((mod && key === 'r') || input.key === 'F5') {
      win.webContents.reloadIgnoringCache();
      event.preventDefault();
    }
  });
}

/**
 * Ctrl (Cmd) + / - / 0 and Ctrl + mouse wheel change the zoom setting, so it always matches
 * what Settings shows (there is no menu to provide them on Windows/Linux anyway).
 */
function zoomShortcuts(win: BrowserWindow, controller: Controller): void {
  const setZoom = (zoom: number) => void controller.updateSettings({ zoom });
  const step = (direction: 1 | -1) =>
    setZoom(stepZoom(controller.getState().settings.zoom, direction));
  win.webContents.on('before-input-event', (event, input) => {
    const action = zoomShortcut(input);
    if (action === null) return;
    if (action === 'reset') setZoom(DEFAULT_ZOOM);
    else step(action === 'in' ? 1 : -1);
    event.preventDefault();
  });
  win.webContents.on('zoom-changed', (_e, direction) => step(direction === 'in' ? 1 : -1));
}

function createWindow(controller: Controller): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'PickLeague',
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    frame: !frameless,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A second-screen companion lives behind the game window: keep it rendering.
      backgroundThrottling: false,
      zoomFactor: controller.getState().settings.zoom,
    },
  });
  // Links (none expected) open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (frameless) {
    win.removeMenu();
    devShortcuts(win);
    // Window managers may resize a maximized window without an 'unmaximize' event: also
    // re-check on resize, sending only changes.
    let lastMaximized: boolean | null = null;
    const sendWindowState = () => {
      if (win.isDestroyed()) return;
      const state = windowState(win);
      if (state.maximized === lastMaximized) return;
      lastMaximized = state.maximized;
      win.webContents.send(IPC.windowState, state);
    };
    win.on('maximize', sendWindowState);
    win.on('unmaximize', sendWindowState);
    win.on('resize', sendWindowState);
    win.on('enter-full-screen', sendWindowState);
    win.on('leave-full-screen', sendWindowState);
  }

  // The zoom setting is the source of truth; reapplied after reloads too.
  const applyZoom = (zoom: number) => {
    if (!win.isDestroyed() && win.webContents.getZoomFactor() !== zoom) {
      win.webContents.setZoomFactor(zoom);
    }
  };
  win.webContents.on('did-finish-load', () => applyZoom(controller.getState().settings.zoom));
  zoomShortcuts(win, controller);

  const unsubscribe = controller.onChange((state) => {
    if (win.isDestroyed()) return;
    applyZoom(state.settings.zoom);
    win.webContents.send(IPC.state, state);
  });
  win.on('closed', unsubscribe);

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  startDevCaptures(win);
  return win;
}

/**
 * Dev only: PICKLEAGUE_CAPTURE_DIR=<dir> saves a PNG of the window every 5 s, so the UI can be
 * checked without screen-recording permissions (used with the mock LCU + fake API).
 */
function startDevCaptures(win: BrowserWindow): void {
  const dir = process.env.PICKLEAGUE_CAPTURE_DIR;
  if (!dir || app.isPackaged) return;
  const started = Date.now();
  powerSaveBlocker.start('prevent-app-suspension');
  const timer = setInterval(async () => {
    if (win.isDestroyed()) {
      clearInterval(timer);
      return;
    }
    const image = await win.webContents.capturePage();
    const seconds = String(Math.round((Date.now() - started) / 1000)).padStart(3, '0');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `capture-${seconds}s.png`), image.toPNG());
  }, 5_000);
}

async function main(): Promise<void> {
  await app.whenReady();
  const settingsPath = join(app.getPath('userData'), 'settings.json');
  const saved = await loadSettings(settingsPath);
  // PICKLEAGUE_API_URL overrides the saved address for this run (dev / fake API).
  const envApiUrl = process.env.PICKLEAGUE_API_URL;
  const settings = envApiUrl ? sanitizeSettings({ ...saved, apiUrl: envApiUrl }) : saved;
  const ddragon = createDdragonClient();

  const controller = new Controller({
    settings,
    forcedMock,
    createSource: (kind) =>
      kind === 'mock' ? createMockLcuSource({ log }) : createRealLcuSource(),
    createApi: (url) => createApiClient(url),
    async loadDdragonStatic() {
      const [latest] = await ddragon.getLatestPatchVersions(1);
      if (!latest) throw new Error('Data Dragon has no versions');
      return staticResponseFromDdragon(await ddragon.getStaticPatchData(latest.ddragonVersion));
    },
    saveSettings: (s) => saveSettings(settingsPath, s),
    log,
  });

  ipcMain.handle(IPC.getState, () => controller.getState());
  ipcMain.handle(IPC.getStatic, () => controller.getStatic());
  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<Settings>) =>
    controller.updateSettings(patch),
  );
  ipcMain.handle(IPC.applyNow, () => controller.applyNow());
  ipcMain.handle(IPC.previewBuild, (_e, championId: number | null) =>
    controller.previewBuild(typeof championId === 'number' ? championId : null),
  );
  ipcMain.handle(IPC.refresh, () => controller.refresh());
  ipcMain.handle(IPC.refreshStats, () => controller.refreshStats());
  const senderWindow = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle(IPC.getWindowState, (e) => {
    const win = senderWindow(e);
    return win ? windowState(win) : { customControls: frameless, maximized: false };
  });
  ipcMain.on(IPC.windowMinimize, (e) => senderWindow(e)?.minimize());
  ipcMain.on(IPC.windowToggleMaximize, (e) => {
    const win = senderWindow(e);
    if (!win) return;
    if (win.isFullScreen()) win.setFullScreen(false);
    else if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on(IPC.windowClose, (e) => senderWindow(e)?.close());
  ipcMain.handle(IPC.tierList, (_e, role: unknown, filters: unknown) =>
    controller.tierList(
      isPosition(role) ? role : settings.fallbackRole,
      toTierListFilters(filters),
    ),
  );
  ipcMain.handle(IPC.genericBuild, (_e, championId: unknown, role: unknown) =>
    controller.genericBuild(
      typeof championId === 'number' ? championId : 0,
      isPosition(role) ? role : settings.fallbackRole,
    ),
  );

  controller.start();
  createWindow(controller);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(controller);
  });
  app.on('before-quit', () => controller.stop());
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

void main();
