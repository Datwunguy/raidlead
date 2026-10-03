// ============================================================
// wowPaths.js — locating the WoW SavedVariables files this app reads/writes.
//
// RaidLeadDB / RaidLeadExportDB (addon-owned, account-wide):
//   <WowRoot>/_retail_/WTF/Account/<ACCOUNT>/SavedVariables/RaidLead.lua
// RaidLeadCompanionDB (this app's own output, per-character -- see the
// addon's .toc comment for why it's a separate file from the one above):
//   <WowRoot>/_retail_/WTF/Account/<ACCOUNT>/<Realm>/<Character>/SavedVariables/RaidLead.lua
//
// Finding the install: Battle.net's entry in Windows' installed-programs
// list says where WoW is, on any drive; failing that, common folders on
// the PC's own drives are checked. Settings shows what was found and lets
// the person pick a different folder -- any folder in or above the install.
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Windows' own tools, by full path -- never whatever a same-named program
// in the current folder or on PATH happens to be.
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const TOOLS = {
  tasklist: path.join(SYSTEM32, 'tasklist.exe'),
  reg: path.join(SYSTEM32, 'reg.exe'),
  powershell: path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
};

/** True if a WoW client process is currently running. */
function isWowRunning() {
  return new Promise((resolve) => {
    execFile(TOOLS.tasklist, ['/FI', 'IMAGENAME eq Wow.exe', '/NH'], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      resolve(!err && /wow\.exe/i.test(stdout));
    });
  });
}

/** A WoW install: the folder holding _retail_. */
const isWowRoot = dir => !!dir && fs.existsSync(path.join(dir, '_retail_'));
const trimSep = p => path.normalize(p).replace(/[\\/]+$/, '');

// Battle.net lists each game it installs in Windows' installed-programs list
// (Settings -> Apps) with its folder -- the reliable record of where WoW is.
// (Not Blizzard's own "InstallPath" registry value: other WoW launchers
// overwrite it -- seen on a real PC, pointing at a private-server client.)
const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\World of Warcraft',
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\World of Warcraft',
];

// One value out of `reg query` output ("    InstallLocation    REG_SZ    C:\...").
function parseRegValue(stdout, name) {
  const line = String(stdout || '').split(/\r?\n/).find(l => l.trim().toLowerCase().startsWith(name.toLowerCase() + ' '));
  const m = line && line.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/);
  return m ? m[1] : null;
}

function readInstallLocation(key) {
  return new Promise((resolve) => {
    execFile(TOOLS.reg, ['query', key, '/v', 'InstallLocation'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : parseRegValue(stdout, 'InstallLocation'));
    });
  });
}

// Where else people put it, checked on each of the PC's own drives.
const DRIVE_FOLDERS = [
  'World of Warcraft',
  'Games\\World of Warcraft',
  'Program Files (x86)\\World of Warcraft',
  'Program Files\\World of Warcraft',
  'Blizzard\\World of Warcraft',
  'Games\\Blizzard\\World of Warcraft',
  'Battle.net\\World of Warcraft',
];
const ALL_DRIVES = [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map(l => `${l}:\\`);

// The PC's own drives ("Fixed": internal disks, not USB sticks, card
// readers, discs or network drives -- a folder there isn't where Battle.net
// put WoW, and a disconnected network drive can hang the check). Every
// drive letter if Windows can't say.
function parseDriveList(stdout) {
  return String(stdout || '').split(/\r?\n/).map(l => l.trim().toUpperCase()).filter(l => /^[A-Z]:\\$/.test(l));
}
function fixedDrives() {
  return new Promise((resolve) => {
    execFile(TOOLS.powershell,
      ['-NoProfile', '-NonInteractive', '-Command', "[IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' } | ForEach-Object { $_.Name }"],
      { windowsHide: true, timeout: 15000 },
      (err, stdout) => {
        const drives = err ? [] : parseDriveList(stdout);
        resolve(drives.length ? drives : ALL_DRIVES);
      });
  });
}

/**
 * Finds the WoW install on its own: { root, source: 'installed-programs' |
 * 'drive-scan' }, or null. Reads only Battle.net's installed-programs entry
 * and whether those folders exist -- nothing else on the PC.
 */
async function findWowInstall({ readLocation = readInstallLocation, drives = null } = {}) {
  for (const key of UNINSTALL_KEYS) {
    const location = await readLocation(key);
    if (location && isWowRoot(location)) return { root: trimSep(location), source: 'installed-programs' };
  }
  for (const drive of drives || await fixedDrives()) {
    if (!fs.existsSync(drive)) continue;
    for (const folder of DRIVE_FOLDERS) {
      const root = path.join(drive, folder);
      if (isWowRoot(root)) return { root, source: 'drive-scan' };
    }
  }
  return null;
}

/**
 * The WoW install from any folder someone picks in or above it -- the WoW
 * folder, _retail_, Interface, AddOns, the RaidLead folder, or the drive or
 * folder holding "World of Warcraft". null if there's no install there.
 */
function wowRootFrom(picked) {
  if (!picked) return null;
  const dir = trimSep(picked);
  const parts = dir.split(/[\\/]/);
  const retail = parts.map(p => p.toLowerCase()).lastIndexOf('_retail_');
  if (retail > 0) {
    let root = parts.slice(0, retail).join(path.sep);
    if (/^[a-z]:$/i.test(root)) root += path.sep; // WoW at the top of a drive
    if (isWowRoot(root)) return root;
  }
  if (isWowRoot(dir)) return dir;
  const inside = path.join(dir, 'World of Warcraft');
  return isWowRoot(inside) ? inside : null;
}

/**
 * Where the RaidLead addon is: 'installed' (AddOns\RaidLead), 'nested' (a
 * folder too deep, e.g. AddOns\RaidLead-Download\RaidLead from "Extract All"
 * -- WoW never loads it), or 'missing'.
 */
function addonStatus(wowRoot) {
  const addonsPath = path.join(wowRoot, '_retail_', 'Interface', 'AddOns');
  const target = path.join(addonsPath, 'RaidLead');
  if (fs.existsSync(path.join(target, 'RaidLead.toc'))) return { state: 'installed', addonsPath, target };
  for (const dir of listDirs(addonsPath)) {
    const found = path.join(addonsPath, dir, 'RaidLead');
    if (fs.existsSync(path.join(found, 'RaidLead.toc'))) return { state: 'nested', addonsPath, target, found };
  }
  return { state: 'missing', addonsPath, target };
}

/** What to do about the addon, in a sentence -- null when it's installed. */
function describeAddonProblem(status) {
  if (!status || status.state === 'installed') return null;
  if (status.state === 'nested') {
    return path.dirname(status.found) === status.target
      ? `RaidLead is one folder too deep, so WoW won't load it -- move everything inside ${status.found} up into ${status.target}.`
      : `RaidLead is one folder too deep, so WoW won't load it -- move ${status.found} into ${status.addonsPath}.`;
  }
  return `The RaidLead addon isn't installed yet -- copy the "RaidLead" folder into ${status.addonsPath}.`;
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Given a WoW root (containing _retail_), lists account folders under
 * WTF/Account as { name, fullPath } -- fullPath is what gets stored as
 * config.wowAccountPath, so the renderer never has to build paths itself.
 */
function listAccounts(wowRoot) {
  const base = path.join(wowRoot, '_retail_', 'WTF', 'Account');
  // Some installs carry a stray top-level "SavedVariables" folder alongside the
  // real account folders (seen on a real install, not just theoretical) --
  // exclude it the same way listCharacters already excludes it one level down.
  return listDirs(base)
    .filter(name => name !== 'SavedVariables')
    .map(name => ({ name, fullPath: path.join(base, name) }));
}

/**
 * Given an account path, lists "Realm/Character" options as { name, label }
 * -- `name` is what characterSavedVariablesPath expects as its second
 * argument. sync.js writes the roster mirror to every one of these rather
 * than a single pre-picked character.
 */
function listCharacters(accountPath) {
  const out = [];
  for (const realm of listDirs(accountPath)) {
    if (realm === 'SavedVariables') continue;
    for (const character of listDirs(path.join(accountPath, realm))) {
      out.push({ name: `${realm}/${character}`, label: `${character} - ${realm}` });
    }
  }
  return out;
}

function accountSavedVariablesPath(accountPath) {
  return path.join(accountPath, 'SavedVariables', 'RaidLead.lua');
}

function characterSavedVariablesPath(accountPath, characterFolder) {
  // characterFolder is "Realm/Character" -- normalise to the platform separator.
  const parts = characterFolder.split('/');
  return path.join(accountPath, ...parts, 'SavedVariables', 'RaidLead.lua');
}

/**
 * Auto-picks which WoW account is "yours" -- same policy as the PowerShell
 * bridge script's Resolve-Account, so switching to this app doesn't bring
 * back the account-picker step that was deliberately removed earlier: if
 * there's only one account, use it; if several, the one with this addon's
 * save file (that only happens where someone actually logged in with
 * RaidLead installed) -- and if several have one (two WoW licenses, both
 * played with RaidLead), whichever saved most recently: the one being
 * played. null only when no account has played with RaidLead yet.
 */
function resolveAccount(wowRoot) {
  const accounts = listAccounts(wowRoot);
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0];

  const saved = accounts
    .map(a => { try { return { a, at: fs.statSync(accountSavedVariablesPath(a.fullPath)).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((x, y) => y.at - x.at);
  return saved.length ? saved[0].a : null;
}

module.exports = {
  findWowInstall, fixedDrives, parseDriveList, wowRootFrom, isWowRoot, addonStatus, describeAddonProblem, parseRegValue, readInstallLocation,
  listAccounts, listCharacters, accountSavedVariablesPath, characterSavedVariablesPath, resolveAccount, isWowRunning,
};
