// ============================================================
// config.js — small persisted settings file in Electron's userData dir.
// Deliberately just JSON-on-disk rather than a config-store dependency --
// this app only has a handful of settings and this whole project favors
// minimal dependencies.
// ============================================================
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');

const DEFAULTS = {
  wowRoot: null,       // .../World of Warcraft (the folder containing _retail_) -- which account is "yours" is re-resolved fresh every sync, not stored
  authTokenEnc: null,  // this app's own RaidLead access token, encrypted via auth.js's encryptToken (safeStorage) -- never stored in plaintext
  deviceLabel: null,   // shown on the website's approve screen and Connected Devices list -- captured at login time, not re-derived every run
  teamId: null,         // which RaidLead team to sync -- auto-resolved at login for a single-team account, or chosen via the team picker for multi-team
  autoStart: true,      // launch this app automatically when Windows starts (opt-out, not opt-in -- see main.js)
};

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true });
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2), 'utf8');
}

module.exports = { load, save };
