// ============================================================
// main.js — Electron main process: tray icon, settings window, and the
// only place fs/network access happens (the renderer talks to this via
// preload.js's IPC bridge, never directly).
// ============================================================
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require('electron');

const config = require('./config');
const wowPaths = require('./wowPaths');
const { SyncManager } = require('./sync');
const { startUpdateChecks, checkOnce } = require('./updater');

let mainWindow = null;
let tray = null;
let currentConfig = null;
let sync = null;
let logBuffer = [];

function sendLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.shift();
  if (mainWindow) mainWindow.webContents.send('raidlead:log', line);
}

function createWindow() {
  if (mainWindow) { mainWindow.show(); return; }

  mainWindow = new BrowserWindow({
    width: 480,
    height: 620,
    title: 'RaidLead Companion',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'settingsWindow.html'));
  mainWindow.on('close', (e) => {
    // Keep running in the background (tray) rather than fully quitting --
    // this is a sync helper meant to sit there through a whole raid night.
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'icon.png'));
  tray.setToolTip('RaidLead Companion');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Settings', click: () => createWindow() },
    { label: 'Sync Now', click: () => { if (sync) { sync.exportLoot(true); sync.importRoster(true); } } },
    { label: 'Check for Updates', click: () => checkOnce(sendLog) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => createWindow());
}

app.whenReady().then(() => {
  currentConfig = config.load();
  sync = new SyncManager(() => currentConfig, sendLog);

  // Opt-out, not opt-in -- launching this app is the whole point of it
  // (replacing a scheduled task + hidden-window script with a normal
  // always-running tray app), so it starts with Windows by default. Uses
  // Electron's own login-item registration, the same standard mechanism
  // Discord/Steam/etc. use -- no Task Scheduler, no hidden-window trick,
  // nothing for antivirus to flag as suspicious persistence.
  app.setLoginItemSettings({ openAtLogin: currentConfig.autoStart !== false });

  createTray();
  createWindow();
  sync.start();
  startUpdateChecks(sendLog);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  // Tray keeps the process alive on purpose -- do nothing here.
});

// ── IPC surface for the renderer (see preload.js) ──────────────────────
ipcMain.handle('raidlead:getConfig', () => currentConfig);

ipcMain.handle('raidlead:setConfig', (_e, partial) => {
  currentConfig = { ...currentConfig, ...partial };
  config.save(currentConfig);
  if ('autoStart' in partial) app.setLoginItemSettings({ openAtLogin: currentConfig.autoStart !== false });
  sync.start(); // re-evaluate watchers/timers against the new config
  return currentConfig;
});

ipcMain.handle('raidlead:getLog', () => logBuffer);

ipcMain.handle('raidlead:browseWowFolder', async () => {
  // Ask for the AddOns folder specifically -- it's the same folder the user
  // already had to open to copy the RaidLead addon in, so there's only one
  // "which folder do I need" concept for them to hold onto instead of two.
  const guessedRoot = wowPaths.guessWowRoot();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your WoW AddOns folder (...\\_retail_\\Interface\\AddOns -- the one you just copied RaidLead into)',
    defaultPath: guessedRoot ? path.join(guessedRoot, '_retail_', 'Interface', 'AddOns') : undefined,
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const addonsPath = result.filePaths[0];
  const wowRoot = wowPaths.deriveWowRootFromAddonsFolder(addonsPath);
  if (!wowRoot) {
    return { error: 'That doesn\'t look like a WoW AddOns folder -- it should end in _retail_\\Interface\\AddOns.' };
  }
  return {
    wowRoot,
    addonInstalled: wowPaths.addonIsInstalled(addonsPath),
  };
});

ipcMain.handle('raidlead:browseBridgeFolder', async () => {
  // The exact same folder the website's "Connect Bridge Folder" button
  // points at -- whatever RaidLead Docs was extracted to and connected on
  // the Loot tab.
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your "RaidLead Docs" folder (the one connected on the website\'s Loot tab)',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('raidlead:syncNow', async () => {
  sync.exportLoot(true);
  sync.importRoster(true);
});
