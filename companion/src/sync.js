// ============================================================
// sync.js — the same job RaidLeadBridge.ps1 does, just running continuously
// in a real background process instead of via a Windows Task Scheduler task
// firing every 5 minutes. That mechanism (a scheduled task launching
// wscript.exe to hide a PowerShell console window) turned out to be
// genuinely fragile in the wild -- antivirus quietly deleting the .ps1/.vbs
// files, Controlled Folder Access blocking script writes to Desktop, a
// poisoned task name blocking re-registration -- all discovered on a real
// user's machine, not in theory. A normal always-running tray app avoids
// every one of those categorically: no scheduled task, no hidden-window
// trick, nothing for antivirus to flag as "a script quietly creating a
// timer to relaunch itself."
//
// This never touches the network -- exactly like the PowerShell script it
// replaces, it only ever reads/writes files on this PC: the addon's real
// WoW SavedVariables, and the same bridge-folder JSON files
// (config.json/loot-export.json/roster-import.json) the website's
// browser-based sync already reads and writes. Swapping this app in for the
// .bat/scheduled-task setup requires zero changes on the website side.
// ============================================================
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const wowPaths = require('./wowPaths');
const luaData = require('./luaData');

const ROSTER_POLL_MS = 60 * 1000; // far more responsive than the old 5-minute Task Scheduler interval costs nothing extra now

class SyncManager {
  constructor(getConfig, onLog) {
    this.getConfig = getConfig; // () => current config object
    this.onLog = onLog || (() => {});
    this.lootWatcher = null;
    this.rosterWatcher = null;
    this.pollTimer = null;
    // Last content actually written for each direction -- the poll timer
    // calls both every minute regardless of whether anything changed, and
    // without this it'd re-log (and re-write) the same unchanged data every
    // single tick.
    this.lastLootJson = null;
    this.lastRosterJson = null;
  }

  log(msg) {
    this.onLog(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  isConfigured() {
    const c = this.getConfig();
    return !!(c.wowRoot && c.bridgeFolderPath);
  }

  bridgePath(...parts) {
    return path.join(this.getConfig().bridgeFolderPath, ...parts);
  }

  start() {
    this.stop();
    if (!this.isConfigured()) {
      this.log('Not configured yet -- set your WoW folder and bridge folder in Settings.');
      return;
    }

    // Marks this folder as "already in use" for the website's own hasRun
    // check (Connect Bridge Folder looks for config.json to decide whether
    // to show its first-time-setup hint) -- written once up front rather
    // than only after a full sync succeeds, so that check is accurate even
    // before this account's SavedVariables exist yet.
    this.writeBridgeConfig();

    const account = wowPaths.resolveAccount(this.getConfig().wowRoot);
    if (account) {
      const lootPath = wowPaths.accountSavedVariablesPath(account.fullPath);
      this.log(`Watching ${lootPath} for new loot...`);
      this.lootWatcher = chokidar.watch(lootPath, { awaitWriteFinish: { stabilityThreshold: 1000 } });
      this.lootWatcher.on('change', () => this.exportLoot());
      this.lootWatcher.on('add', () => this.exportLoot());
    } else {
      this.log('No single WoW account resolved yet -- log into WoW with RaidLead installed at least once.');
    }

    const rosterImportPath = this.bridgePath('roster-import.json');
    this.rosterWatcher = chokidar.watch(rosterImportPath, { awaitWriteFinish: { stabilityThreshold: 1000 } });
    this.rosterWatcher.on('change', () => this.importRoster());
    this.rosterWatcher.on('add', () => this.importRoster());

    this.exportLoot();
    this.importRoster();
    // Belt-and-suspenders poll on top of the file watchers above -- catches
    // the case where the account wasn't resolvable yet at start() but is by
    // now (e.g. this app started before the player's first WoW login).
    this.pollTimer = setInterval(() => { this.exportLoot(); this.importRoster(); }, ROSTER_POLL_MS);
  }

  stop() {
    if (this.lootWatcher) { this.lootWatcher.close(); this.lootWatcher = null; }
    if (this.rosterWatcher) { this.rosterWatcher.close(); this.rosterWatcher = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  writeBridgeConfig() {
    try {
      fs.mkdirSync(this.getConfig().bridgeFolderPath, { recursive: true });
      fs.writeFileSync(this.bridgePath('config.json'), JSON.stringify({ wowRoot: this.getConfig().wowRoot }, null, 2), 'utf8');
    } catch (err) {
      this.log(`Couldn't write to the bridge folder: ${err.message}`);
    }
  }

  // ── EXPORT: pull captured loot out of WoW's save file, into the bridge folder ──
  // `force` skips the unchanged-content shortcut, so a manual Sync Now click
  // always reports something instead of looking like it silently did nothing.
  exportLoot(force = false) {
    if (!this.isConfigured()) return;
    const account = wowPaths.resolveAccount(this.getConfig().wowRoot);
    if (!account) { if (force) this.log('No single WoW account resolved -- log into WoW with RaidLead installed at least once.'); return; }

    const lootPath = wowPaths.accountSavedVariablesPath(account.fullPath);
    if (!fs.existsSync(lootPath)) {
      if (force) this.log('No addon save file found yet -- log into WoW with the addon installed and /reload at least once.');
      return;
    }

    const records = luaData.readLootRecords(lootPath);
    const json = JSON.stringify(records);
    const count = Object.keys(records).length;
    if (json === this.lastLootJson && !force) return; // nothing new since last export -- stay quiet

    try {
      fs.writeFileSync(this.bridgePath('loot-export.json'), json, 'utf8');
      this.lastLootJson = json;
      this.log(count > 0 ? `Exported ${count} loot record(s) -- ready for the website to sync.` : 'No loot captured yet.');
    } catch (err) {
      this.log(`Loot export failed: ${err.message}`);
    }
  }

  // ── IMPORT: push whatever roster the website prepared into every character ──
  importRoster(force = false) {
    if (!this.isConfigured()) return;
    const rosterImportPath = this.bridgePath('roster-import.json');
    if (!fs.existsSync(rosterImportPath)) {
      if (force) this.log('No roster waiting to import yet (sync on the website first).');
      return;
    }

    const account = wowPaths.resolveAccount(this.getConfig().wowRoot);
    if (!account) { if (force) this.log('No single WoW account resolved -- log into WoW with RaidLead installed at least once.'); return; }

    const rawJson = fs.readFileSync(rosterImportPath, 'utf8');
    if (rawJson === this.lastRosterJson && !force) return; // already imported this exact payload

    let payload;
    try {
      payload = JSON.parse(rawJson);
    } catch (err) {
      this.log(`Couldn't read roster-import.json: ${err.message}`);
      return;
    }

    const characters = wowPaths.listCharacters(account.fullPath);
    for (const character of characters) {
      const companionPath = wowPaths.characterSavedVariablesPath(account.fullPath, character.name);
      luaData.writeCompanionDb(companionPath, payload);
    }

    this.lastRosterJson = rawJson;
    this.log(`Roster written to ${characters.length} character(s) -- /reload in-game to see it.`);
  }
}

module.exports = { SyncManager };
