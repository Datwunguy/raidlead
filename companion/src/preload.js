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
  getUpdateStatus: () => ipcRenderer.invoke('raidlead:getUpdateStatus'),
  openDownloadLink: () => ipcRenderer.invoke('raidlead:openDownloadLink'),
  browseWowFolder: () => ipcRenderer.invoke('raidlead:browseWowFolder'),
  syncNow: () => ipcRenderer.invoke('raidlead:syncNow'),
  login: () => ipcRenderer.invoke('raidlead:login'),
  logout: () => ipcRenderer.invoke('raidlead:logout'),
  getMyTeams: () => ipcRenderer.invoke('raidlead:getMyTeams'),
  setTeam: (teamId) => ipcRenderer.invoke('raidlead:setTeam', teamId),
  onLog: (callback) => ipcRenderer.on('raidlead:log', (_e, line) => callback(line)),
});
