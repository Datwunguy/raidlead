// ============================================================
// sync.js — watches WoW's real SavedVariables and keeps RaidLead in sync,
// running continuously in a background tray app rather than via a Windows
// Task Scheduler task firing every 5 minutes (that mechanism turned out to
// be genuinely fragile in the wild -- antivirus quietly deleting scripts,
// Controlled Folder Access blocking writes, a poisoned task name blocking
// re-registration -- all discovered on a real user's machine).
//
// Talks to RaidLead's backend directly via this app's own login (see
// auth.js) -- there is no bridge folder anymore. Loot exports whenever the
// addon's SavedVariables file changes; the published roster is pulled on a
// short poll (chokidar can't watch "a row changed in Supabase" the way it
// watches a local file).
// ============================================================
const fs = require('fs');
const chokidar = require('chokidar');
const wowPaths = require('./wowPaths');
const luaData = require('./luaData');
const auth = require('./auth');

const ROSTER_POLL_MS = 60 * 1000; // far more responsive than the old 5-minute Task Scheduler interval costs nothing extra now

class SyncManager {
  constructor(getConfig, onLog) {
    this.getConfig = getConfig; // () => current config object
    this.onLog = onLog || (() => {});
    this.lootWatcher = null;
    this.pollTimer = null;
    // Last content actually sent for each direction -- the poll timer calls
    // both every minute regardless of whether anything changed, and without
    // this it'd re-log (and re-send) the same unchanged data every tick.
    this.lastLootJson = null;
    this.lastRosterJson = null;
    // Cached, not re-checked on every single file event -- just enough to
    // show "waiting for WoW" vs "syncing" in Settings, and to only log the
    // transition once instead of on every poll tick.
    this.wowRunning = null;
  }

  log(msg) {
    this.onLog(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  isConfigured() {
    const c = this.getConfig();
    return !!(c.wowRoot && c.authTokenEnc && c.teamId);
  }

  getToken() {
    return auth.decryptToken(this.getConfig().authTokenEnc);
  }

  start() {
    this.stop();
    if (!this.isConfigured()) {
      this.log('Not configured yet -- log in and set your WoW folder in Settings.');
      return;
    }

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

    this.checkWowStatus();
    this.exportLoot();
    this.importRoster();
    // Belt-and-suspenders poll on top of the file watcher above -- catches
    // the case where the account wasn't resolvable yet at start() but is by
    // now, and is also the only way the roster half ever runs at all (there's
    // no local file to watch for "the published roster changed").
    this.pollTimer = setInterval(() => { this.checkWowStatus(); this.exportLoot(); this.importRoster(); }, ROSTER_POLL_MS);
  }

  // Purely for status/log clarity (Settings shows this, see main.js) -- the
  // file watcher/poll work fine whether or not WoW happens to be open, so
  // this never gates them, it just tells the person what's going on.
  async checkWowStatus() {
    const running = await wowPaths.isWowRunning();
    if (running !== this.wowRunning) {
      this.wowRunning = running;
      this.log(running ? 'WoW detected -- actively syncing.' : 'WoW isn\'t running -- waiting quietly in the background.');
    }
  }

  stop() {
    if (this.lootWatcher) { this.lootWatcher.close(); this.lootWatcher = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  // ── EXPORT: read captured loot straight out of WoW's save file and POST
  // it directly to RaidLead. `force` skips the unchanged-content shortcut,
  // so a manual Sync Now click always reports something instead of looking
  // like it silently did nothing. ──
  async exportLoot(force = false) {
    if (!this.isConfigured()) return;
    const account = wowPaths.resolveAccount(this.getConfig().wowRoot);
    if (!account) { if (force) this.log('No single WoW account resolved -- log into WoW with RaidLead installed at least once.'); return; }

    const lootPath = wowPaths.accountSavedVariablesPath(account.fullPath);
    if (!fs.existsSync(lootPath)) {
      if (force) this.log('No addon save file found yet -- log into WoW with the addon installed and /reload at least once.');
      return;
    }

    const records = luaData.readLootRecords(lootPath);
    const recordsList = Object.values(records);
    const json = JSON.stringify(records);
    if (json === this.lastLootJson && !force) return; // nothing new since last export -- stay quiet

    if (recordsList.length === 0) {
      this.lastLootJson = json;
      if (force) this.log('No loot captured yet.');
      return;
    }

    const token = this.getToken();
    if (!token) { this.log('Not logged in -- open Settings and log in again.'); return; }

    try {
      const resp = await fetch(`${auth.SITE_ORIGIN}/api/companion?action=uploadLoot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ teamId: this.getConfig().teamId, records: recordsList }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Upload failed');
      this.lastLootJson = json;
      this.log(`Uploaded ${data.imported} loot record(s).`);
    } catch (err) {
      this.log(`Loot upload failed: ${err.message}`);
    }
  }

  // ── ROSTER SYNC: pull the published roster + plan directly from RaidLead
  // and write it into every character, exactly like the old bridge-folder
  // path did -- just sourced from an HTTP call instead of a local file that
  // the website used to prepare. ──
  async importRoster(force = false) {
    if (!this.isConfigured()) return;
    const token = this.getToken();
    if (!token) { if (force) this.log('Not logged in -- open Settings and log in again.'); return; }

    const account = wowPaths.resolveAccount(this.getConfig().wowRoot);
    if (!account) { if (force) this.log('No single WoW account resolved -- log into WoW with RaidLead installed at least once.'); return; }

    let payload;
    try {
      const resp = await fetch(
        `${auth.SITE_ORIGIN}/api/companion?action=getRosterSync&teamId=${encodeURIComponent(this.getConfig().teamId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      payload = await resp.json();
      if (!resp.ok) throw new Error(payload.error || 'Roster fetch failed');
    } catch (err) {
      this.log(`Roster sync failed: ${err.message}`);
      return;
    }

    const rawJson = JSON.stringify(payload);
    if (rawJson === this.lastRosterJson && !force) return; // already synced this exact state

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
