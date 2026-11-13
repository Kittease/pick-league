import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDdragonClient } from '@pick-league/shared';
import { app, BrowserWindow, ipcMain, powerSaveBlocker, shell } from 'electron';
import { IPC, type Settings } from '../core/app-state.ts';
import { staticResponseFromDdragon } from '../core/static-from-ddragon.ts';
import { createApiClient } from './api-client.ts';
import { Controller } from './controller.ts';
import { createMockLcuSource } from './lcu/mock.ts';
import { createRealLcuSource } from './lcu/real.ts';
import { loadSettings, sanitizeSettings, saveSettings } from './settings.ts';

app.setName('PickLeague');

const forcedMock = process.env.PICKLEAGUE_MOCK_LCU === '1';
const log = (message: string) => console.log(`[pickleague] ${message}`);

function createWindow(controller: Controller): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'PickLeague',
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A second-screen companion lives behind the game window: keep it rendering.
      backgroundThrottling: false,
    },
  });
  // Links (none expected) open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const unsubscribe = controller.onChange((state) => {
    if (!win.isDestroyed()) win.webContents.send(IPC.state, state);
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
