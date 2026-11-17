import { contextBridge, ipcRenderer } from 'electron';
import { type AppState, IPC, type PickLeagueBridge, type WindowState } from '../core/app-state.ts';
import { UPDATE_IPC, type UpdateState } from '../core/update.ts';

const bridge: PickLeagueBridge = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  getStatic: () => ipcRenderer.invoke(IPC.getStatic),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  applyNow: () => ipcRenderer.invoke(IPC.applyNow),
  previewBuild: (championId) => ipcRenderer.invoke(IPC.previewBuild, championId),
  refresh: () => ipcRenderer.invoke(IPC.refresh),
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
  update: {
    getState: () => ipcRenderer.invoke(UPDATE_IPC.getState),
    check: () => ipcRenderer.send(UPDATE_IPC.check),
    install: () => ipcRenderer.send(UPDATE_IPC.install),
    onState(listener) {
      const handler = (_e: unknown, state: UpdateState) => listener(state);
      ipcRenderer.on(UPDATE_IPC.state, handler);
      return () => ipcRenderer.removeListener(UPDATE_IPC.state, handler);
    },
  },
  getTierList: (role, filters) => ipcRenderer.invoke(IPC.tierList, role, filters),
  getTierListChampion: (role, championId, filters) =>
    ipcRenderer.invoke(IPC.tierListChampion, role, championId, filters),
  getGenericBuild: (championId, role) => ipcRenderer.invoke(IPC.genericBuild, championId, role),
  draftPicks: (request) => ipcRenderer.invoke(IPC.draftPicks, request),
  draftBuild: (request) => ipcRenderer.invoke(IPC.draftBuild, request),
  evaluateDraft: (request) => ipcRenderer.invoke(IPC.evaluateDraft, request),
  onState(listener) {
    const handler = (_e: unknown, state: AppState) => listener(state);
    ipcRenderer.on(IPC.state, handler);
    return () => ipcRenderer.removeListener(IPC.state, handler);
  },
};

contextBridge.exposeInMainWorld('pickleague', bridge);
