// ============================================================
// updater.js — the ONLY network access this app has, ever: periodically
// fetches a tiny JSON file from raidlead.vercel.app and compares its
// version against this app's own. Deliberately does NOT download or
// install anything -- it only notifies, and leaves the actual download +
// install to the person, the same as installing it the first time. That
// was a specific, deliberate choice over full silent auto-update:
// automatically pulling and running a new binary in the background is a
// meaningfully bigger trust ask than "hey, a newer version exists."
//
// version.json is a single hand-maintained file (see
// scripts/build-companion.ps1) -- {"version": "0.2.0"} is all it needs to
// be. No electron-builder publish machinery, no differential-update
// blockmap format -- just a version string to compare against.
// ============================================================
const { app, Notification, shell } = require('electron');
const https = require('https');

const VERSION_URL = 'https://raidlead.vercel.app/updates/version.json';
const DOWNLOAD_URL = 'https://github.com/Datwunguy/raidlead/releases/latest/download/RaidLead-Companion-Setup.exe';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // a background app doesn't need to check more often than a few times a day

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    }).on('error', reject);
  });
}

// Simple numeric semver comparison (no pre-release/build-metadata handling
// needed for this project's plain "0.1.0"-style versions) -- avoids pulling
// in a whole semver dependency for a three-number comparison.
function isNewer(remote, current) {
  const r = String(remote).split('.').map(Number);
  const c = String(current).split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    const rv = r[i] || 0, cv = c[i] || 0;
    if (rv !== cv) return rv > cv;
  }
  return false;
}

let notifiedVersion = null; // don't fire a second OS notification for the same available version
// Queryable synchronously via getStatus() -- a persistent banner in Settings
// (see settingsWindow.html) is more reliable than the one-shot OS
// notification below, which can be missed, auto-dismissed, or silently
// blocked by Windows' Focus Assist with no way for this app to know.
let latestKnown = { available: false, version: null, current: app.getVersion() };

function getStatus() {
  return latestKnown;
}

async function checkOnce(onLog) {
  const log = (msg) => onLog(`[update] ${msg}`);
  try {
    const data = await fetchJson(VERSION_URL);
    const current = app.getVersion();
    if (!data.version) throw new Error('version.json missing a "version" field');

    const available = isNewer(data.version, current);
    latestKnown = { available, version: available ? data.version : null, current };

    if (!available) {
      log(`Up to date (running ${current}).`);
      return;
    }

    log(`A newer version is available: v${data.version} (you're on v${current}).`);
    if (notifiedVersion !== data.version) {
      notifiedVersion = data.version;
      if (Notification.isSupported()) {
        const n = new Notification({
          title: 'RaidLead Companion update available',
          body: `Version ${data.version} is available (you're on ${current}). Click to download.`,
        });
        n.on('click', () => shell.openExternal(DOWNLOAD_URL));
        n.show();
      }
    }
  } catch (err) {
    log(`Update check failed (will retry later): ${err.message}`);
  }
}

function startUpdateChecks(onLog) {
  // Dev mode (`npm start`) has no installed copy to "update" -- the version
  // comparison would just be noise, so skip it there.
  if (!app.isPackaged) { onLog('[update] Skipped (dev mode).'); return; }

  checkOnce(onLog);
  setInterval(() => checkOnce(onLog), CHECK_INTERVAL_MS);
}

module.exports = { startUpdateChecks, checkOnce, getStatus, DOWNLOAD_URL };
