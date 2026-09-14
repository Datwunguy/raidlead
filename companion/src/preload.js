// ============================================================
// preload.js — the only bridge between the settings window (renderer,
// no Node access) and main.js (fs/network access). Keeps the renderer a
// plain, sandboxed webpage per Electron's security guidance.
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('raidlead', {
  getConfig: () => ipcRenderer.invoke('raidlead:getConfig'),
  setConfig: (partial) => ipcRenderer.invoke('raidlead:setConfig', partial),
  getLog: () => ipcRenderer.invoke('raidlead:getLog'),
  getWowStatus: () => ipcRenderer.invoke('raidlead:getWowStatus'),
  browseWowFolder: () => ipcRenderer.invoke('raidlead:browseWowFolder'),
  browseBridgeFolder: () => ipcRenderer.invoke('raidlead:browseBridgeFolder'),
  syncNow: () => ipcRenderer.invoke('raidlead:syncNow'),
  onLog: (callback) => ipcRenderer.on('raidlead:log', (_e, line) => callback(line)),
});
