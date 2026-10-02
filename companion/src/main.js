// ============================================================
// main.js — Electron main process: tray icon, settings window, and the
// only place fs/network access happens (the renderer talks to this via
// preload.js's IPC bridge, never directly).
// ============================================================
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } = require('electron');

const config = require('./config');
const wowPaths = require('./wowPaths');
const auth = require('./auth');
const { SyncManager } = require('./sync');
const { startUpdateChecks, checkOnce, getStatus: getUpdateStatus, DOWNLOAD_URL } = require('./updater');

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

// Finds WoW on its own the first time (or if the saved folder is gone -- a
// moved install), so most people never pick a folder at all. Settings
// shows what was found and can change it.
async function ensureWowRoot() {
  if (wowPaths.isWowRoot(currentConfig.wowRoot)) return;
  const found = await wowPaths.findWowInstall();
  if (!found) {
    sendLog('Couldn\'t find World of Warcraft automatically -- open Settings and pick your WoW folder.');
    return;
  }
  currentConfig = { ...currentConfig, wowRoot: found.root, wowRootAuto: true };
  config.save(currentConfig);
  sendLog(`Found World of Warcraft at ${found.root}.`);
}

// What Settings shows about the install: where it is, how it was found, and the addon's state.
function wowInstallInfo() {
  const wowRoot = wowPaths.isWowRoot(currentConfig.wowRoot) ? currentConfig.wowRoot : null;
  const addon = wowRoot ? wowPaths.addonStatus(wowRoot) : null;
  return { wowRoot, auto: !!currentConfig.wowRootAuto, addonInstalled: addon?.state === 'installed', addonProblem: wowPaths.describeAddonProblem(addon) };
}

app.whenReady().then(async () => {
  currentConfig = config.load();
  sync = new SyncManager(() => currentConfig, sendLog);
  await ensureWowRoot();

  // Opt-out, not opt-in -- launching this app is the whole point of it
  // (replacing a scheduled task + hidden-window script with a normal
  // always-running tray app), so it starts with Windows by default. Uses
  // Electron's own login-item registration, the same standard mechanism
  // Discord/Steam/etc. use -- no Task Scheduler, no hidden-window trick,
  // nothing for antivirus to flag as suspicious persistence.
  app.setLoginItemSettings({ openAtLogin: currentConfig.autoStart !== false });

  createTray();
  // Only pop the settings window open when someone actually launched this
  // themselves (double-clicked it, or it's their first-ever run) -- a
  // window suddenly appearing every time Windows boots is exactly the kind
  // of "why is this here" surprise the tray-app model is supposed to avoid.
  // Auto-started-at-login runs stay fully in the tray until clicked.
  if (!app.getLoginItemSettings().wasOpenedAtLogin) createWindow();
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

ipcMain.handle('raidlead:getWowStatus', () => sync.wowRunning);

ipcMain.handle('raidlead:getUpdateStatus', () => ({ ...getUpdateStatus(), downloadUrl: DOWNLOAD_URL }));

ipcMain.handle('raidlead:openDownloadLink', () => shell.openExternal(DOWNLOAD_URL));

ipcMain.handle('raidlead:getWowInstall', () => wowInstallInfo());

// Picking the folder by hand (when it wasn't found, or to use a different
// install): any folder in or above the install works.
ipcMain.handle('raidlead:browseWowFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your World of Warcraft folder (or any folder inside it)',
    defaultPath: currentConfig.wowRoot || undefined,
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const wowRoot = wowPaths.wowRootFrom(result.filePaths[0]);
  if (!wowRoot) {
    return { error: 'Couldn\'t find World of Warcraft there -- pick your World of Warcraft folder (the one with _retail_ inside it).' };
  }
  currentConfig = { ...currentConfig, wowRoot, wowRootAuto: false };
  config.save(currentConfig);
  sync.start();
  return wowInstallInfo();
});

ipcMain.handle('raidlead:syncNow', async () => {
  sync.exportLoot(true);
  sync.importRoster(true);
});

// ── LOGIN: device-pairing handshake (see auth.js) -- opens the system
// browser to the website's approve screen and polls until this app
// receives its own access token, then resolves which team to sync (only
// asks if the account belongs to more than one). Returns { success: true }
// or { error }, never throws across the IPC boundary. ──
ipcMain.handle('raidlead:login', async () => {
  try {
    const { pairingCode, approveUrl } = await auth.startPairing();
    shell.openExternal(approveUrl);
    sendLog('Waiting for approval in your browser...');
    const token = await auth.pollPairing(pairingCode, (status) => {
      if (status === 'pending') sendLog('Waiting for you to approve this in your browser...');
    });

    const teams = await auth.getMyTeams(token);
    if (teams.length === 0) {
      return { error: 'Logged in, but this account has no RaidLead team yet -- join or create one on the website first.' };
    }

    currentConfig = {
      ...currentConfig,
      authTokenEnc: auth.encryptToken(token),
      deviceLabel: auth.deviceLabel(),
      teamId: teams.length === 1 ? teams[0].teamId : null,
    };
    config.save(currentConfig);
    sync.start();
    sendLog('Logged in to RaidLead.');

    return { success: true, teams: teams.length > 1 ? teams : null };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('raidlead:logout', () => {
  currentConfig = { ...currentConfig, authTokenEnc: null, deviceLabel: null, teamId: null };
  config.save(currentConfig);
  sync.stop();
  sendLog('Logged out.');
  return currentConfig;
});

// For the multi-team picker -- only ever asked for right after login, when
// raidlead:login's own response already includes the team list, but exposed
// separately too in case Settings needs to re-show the picker later (e.g.
// the account was added to a second team since logging in).
ipcMain.handle('raidlead:getMyTeams', async () => {
  const token = auth.decryptToken(currentConfig.authTokenEnc);
  if (!token) return { error: 'Not logged in' };
  try {
    return { teams: await auth.getMyTeams(token) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('raidlead:setTeam', (_e, teamId) => {
  currentConfig = { ...currentConfig, teamId };
  config.save(currentConfig);
  sync.start();
  return currentConfig;
});
