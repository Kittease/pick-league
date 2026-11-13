import { join } from 'node:path';
import { createDdragonClient } from '@pick-league/shared';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { IPC, type Settings } from '../core/app-state.ts';
import { staticResponseFromDdragon } from '../core/static-from-ddragon.ts';
import { createApiClient } from './api-client.ts';
import { Controller } from './controller.ts';
import { createMockLcuSource } from './lcu/mock.ts';
import { createRealLcuSource } from './lcu/real.ts';
import { loadSettings, saveSettings } from './settings.ts';

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
  return win;
}

async function main(): Promise<void> {
  await app.whenReady();
  const settingsPath = join(app.getPath('userData'), 'settings.json');
  const settings = await loadSettings(settingsPath);
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
