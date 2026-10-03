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
      sandbox: true,
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
    { label: 'Sync Now', click: () => { if (sync) sync.syncNow(); } },
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

// Settles which team this PC syncs from the account's current teams (see
// auth.pickTeam): someone on just one team never has to choose, and a team
// they've left is cleared so Settings asks again. Network trouble changes
// nothing. Returns the teams, or null if they couldn't be fetched.
async function refreshTeamChoice() {
  const token = auth.decryptToken(currentConfig.authTokenEnc);
  if (!token) return null;
  let teams;
  try { teams = await auth.getMyTeams(token); } catch { return null; }
  const teamId = auth.pickTeam(teams, currentConfig.teamId);
  if (teamId !== currentConfig.teamId) {
    currentConfig = { ...currentConfig, teamId };
    config.save(currentConfig);
    sync.start();
  }
  return teams;
}

// The settings window only ever shows its own page: it can't be navigated
// anywhere else or open new windows (links that should open, like the
// update download, go through main.js to the browser instead).
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

// A login an older version saved as plain text (only ever when Windows
// couldn't encrypt it): signed out on RaidLead and removed, never used.
async function dropPlaintextLogin() {
  const stored = currentConfig.authTokenEnc;
  if (typeof stored !== 'string' || !stored.startsWith('rlc_')) return; // encrypted ones are base64, never "rlc_"
  currentConfig = { ...currentConfig, authTokenEnc: null, deviceLabel: null };
  config.save(currentConfig);
  await auth.revokeToken(stored);
  sendLog('Your saved login was stored unprotected by an older version, so it was removed -- click Log In again.');
}

app.whenReady().then(async () => {
  currentConfig = config.load();
  await dropPlaintextLogin();
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
  refreshTeamChoice(); // not awaited -- a slow network shouldn't hold up the tray
  startUpdateChecks(sendLog);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  // Tray keeps the process alive on purpose -- do nothing here.
});

// ── IPC surface for the renderer (see preload.js) ──────────────────────
// Only the settings window can call these, and it only ever gets what it
// shows: never the saved login itself (publicConfig), and the one setting
// it can change directly is Start with Windows.
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!mainWindow || e.sender !== mainWindow.webContents) throw new Error('Not allowed');
    return fn(...args);
  });
}

function publicConfig() {
  const { deviceLabel, teamId, autoStart, wowRoot } = currentConfig;
  return { loggedIn: !!currentConfig.authTokenEnc, deviceLabel, teamId, autoStart, wowRoot };
}

handle('raidlead:getConfig', () => publicConfig());

handle('raidlead:setConfig', (partial) => {
  if (typeof partial?.autoStart !== 'boolean') return publicConfig();
  currentConfig = { ...currentConfig, autoStart: partial.autoStart };
  config.save(currentConfig);
  app.setLoginItemSettings({ openAtLogin: currentConfig.autoStart });
  return publicConfig();
});

handle('raidlead:getLog', () => logBuffer);

handle('raidlead:getWowStatus', () => sync.wowRunning);

handle('raidlead:getUpdateStatus', () => ({ ...getUpdateStatus(), downloadUrl: DOWNLOAD_URL }));

handle('raidlead:openDownloadLink', () => shell.openExternal(DOWNLOAD_URL));

handle('raidlead:getWowInstall', () => wowInstallInfo());

// Picking the folder by hand (when it wasn't found, or to use a different
// install): any folder in or above the install works.
handle('raidlead:browseWowFolder', async () => {
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

handle('raidlead:syncNow', async () => {
  sync.syncNow();
});

// ── LOGIN: device-pairing handshake (see auth.js) -- opens the system
// browser to the website's approve screen, shows the code to enter there,
// and polls until this app receives its own access token, then resolves
// which team to sync (only asks if the account belongs to more than one).
// Returns { success: true } or { error }, never throws across the IPC
// boundary. ──
function showLoginCode(code) {
  if (mainWindow) mainWindow.webContents.send('raidlead:loginCode', code);
}

handle('raidlead:login', async () => {
  try {
    const { pairingCode, approveUrl, confirmCode } = await auth.startPairing();
    const code = auth.formatConfirmCode(confirmCode);
    showLoginCode(code);
    shell.openExternal(approveUrl);
    sendLog(`Your login code is ${code} -- enter it on the RaidLead page that just opened in your browser.`);
    const token = await auth.pollPairing(pairingCode, (status) => {
      if (status === 'pending') sendLog(`Waiting for you to enter ${code} and approve this in your browser...`);
    });

    const teams = await auth.getMyTeams(token);
    if (teams.length === 0) {
      await auth.revokeToken(token);
      return { error: 'Logged in, but this account has no RaidLead team yet -- join or create one on the website first.' };
    }

    let authTokenEnc;
    try { authTokenEnc = auth.encryptToken(token); }
    catch (err) { await auth.revokeToken(token); throw err; } // not saved, so not left working either

    currentConfig = {
      ...currentConfig,
      authTokenEnc,
      deviceLabel: auth.deviceLabel(),
      teamId: auth.pickTeam(teams, currentConfig.teamId),
    };
    config.save(currentConfig);
    sync.start();
    sendLog('Logged in to RaidLead.');

    return { success: true, teams: teams.length > 1 ? teams : null };
  } catch (err) {
    return { error: err.message };
  } finally {
    showLoginCode(null);
  }
});

// Logs out here and on RaidLead: this PC's token stops working right away,
// the same as removing it under Connected Devices on the website.
handle('raidlead:logout', async () => {
  const token = auth.decryptToken(currentConfig.authTokenEnc);
  currentConfig = { ...currentConfig, authTokenEnc: null, deviceLabel: null, teamId: null };
  config.save(currentConfig);
  sync.stop();
  const signedOut = !token || await auth.revokeToken(token);
  sendLog(signedOut ? 'Logged out.'
    : 'Logged out on this PC, but RaidLead couldn\'t be reached to sign it out there -- remove it under My Profile > Connected Devices on the website.');
  return publicConfig();
});

// For the multi-team picker -- only ever asked for right after login, when
// raidlead:login's own response already includes the team list, but exposed
// separately too in case Settings needs to re-show the picker later (e.g.
// the account was added to a second team since logging in).
handle('raidlead:getMyTeams', async () => {
  if (!auth.decryptToken(currentConfig.authTokenEnc)) return { error: 'Not logged in' };
  try {
    // Settles the team too (only team chosen, a left team cleared) --
    // teamId is what's actually saved, for the picker to show.
    const teams = await refreshTeamChoice();
    if (!teams) throw new Error('Couldn\'t load your teams -- check your connection.');
    return { teams, teamId: currentConfig.teamId };
  } catch (err) {
    return { error: err.message };
  }
});

handle('raidlead:setTeam', (teamId) => {
  if (typeof teamId !== 'string' || !/^[\w-]{1,64}$/.test(teamId)) return publicConfig();
  currentConfig = { ...currentConfig, teamId };
  config.save(currentConfig);
  sync.start();
  return publicConfig();
});
