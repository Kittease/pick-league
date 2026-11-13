import { contextBridge, ipcRenderer } from 'electron';
import { type AppState, IPC, type PickLeagueBridge, type WindowState } from '../core/app-state.ts';

const bridge: PickLeagueBridge = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  getStatic: () => ipcRenderer.invoke(IPC.getStatic),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  applyNow: () => ipcRenderer.invoke(IPC.applyNow),
  previewBuild: (championId) => ipcRenderer.invoke(IPC.previewBuild, championId),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  refreshStats: () => ipcRenderer.invoke(IPC.refreshStats),
  window: {
    getState: () => ipcRenderer.invoke(IPC.getWindowState),
    minimize: () => ipcRenderer.send(IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.windowToggleMaximize),
    close: () => ipcRenderer.send(IPC.windowClose),
    onState(listener) {
      const handler = (_e: unknown, state: WindowState) => listener(state);
      ipcRenderer.on(IPC.windowState, handler);
      return () => ipcRenderer.removeListener(IPC.windowState, handler);
    },
  },
  getTierList: (role) => ipcRenderer.invoke(IPC.tierList, role),
  getGenericBuild: (championId, role) => ipcRenderer.invoke(IPC.genericBuild, championId, role),
  onState(listener) {
    const handler = (_e: unknown, state: AppState) => listener(state);
    ipcRenderer.on(IPC.state, handler);
    return () => ipcRenderer.removeListener(IPC.state, handler);
  },
};

contextBridge.exposeInMainWorld('pickleague', bridge);
