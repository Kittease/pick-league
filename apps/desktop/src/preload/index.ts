import { contextBridge, ipcRenderer } from 'electron';
import { type AppState, IPC, type PickLeagueBridge } from '../core/app-state.ts';

const bridge: PickLeagueBridge = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  getStatic: () => ipcRenderer.invoke(IPC.getStatic),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  applyNow: () => ipcRenderer.invoke(IPC.applyNow),
  previewBuild: (championId) => ipcRenderer.invoke(IPC.previewBuild, championId),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
  onState(listener) {
    const handler = (_e: unknown, state: AppState) => listener(state);
    ipcRenderer.on(IPC.state, handler);
    return () => ipcRenderer.removeListener(IPC.state, handler);
  },
};

contextBridge.exposeInMainWorld('pickleague', bridge);
