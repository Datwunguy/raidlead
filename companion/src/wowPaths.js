// ============================================================
// wowPaths.js — locating the WoW SavedVariables files this app reads/writes.
//
// RaidLeadDB / RaidLeadExportDB (addon-owned, account-wide):
//   <WowRoot>/_retail_/WTF/Account/<ACCOUNT>/SavedVariables/RaidLead.lua
// RaidLeadCompanionDB (this app's own output, per-character -- see the
// addon's .toc comment for why it's a separate file from the one above):
//   <WowRoot>/_retail_/WTF/Account/<ACCOUNT>/<Realm>/<Character>/SavedVariables/RaidLead.lua
//
// Install location varies too much to rely on auto-detect alone (custom
// drives, non-default Battle.net install dirs), so this only offers a best-
// effort guess -- the settings UI always lets the user browse manually.
// ============================================================
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

/** True if a WoW client process is currently running. */
function isWowRunning() {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq Wow.exe" /NH', (err, stdout) => {
      resolve(!err && /wow\.exe/i.test(stdout));
    });
  });
}

const COMMON_ROOTS = [
  'C:\\Program Files (x86)\\World of Warcraft',
  'C:\\Program Files\\World of Warcraft',
  'D:\\World of Warcraft',
  'D:\\Games\\World of Warcraft',
];

const ADDONS_SUFFIX = path.join('_retail_', 'Interface', 'AddOns');

function guessWowRoot() {
  for (const root of COMMON_ROOTS) {
    if (fs.existsSync(path.join(root, '_retail_', 'WTF'))) return root;
  }
  return null;
}

/**
 * Derives the WoW root (the folder containing _retail_) from an AddOns
 * folder path -- the settings UI asks the user to browse to their AddOns
 * folder specifically, since that's the same folder they already had to
 * navigate to for the manual "copy the addon in" install step, rather than
 * introducing a second, less obviously-relevant "WoW folder" concept.
 * Returns null if the picked folder doesn't actually end in
 * _retail_/Interface/AddOns, so the caller can ask again with a clear error.
 */
function deriveWowRootFromAddonsFolder(addonsPath) {
  const normalized = path.normalize(addonsPath);
  const suffix = path.normalize(ADDONS_SUFFIX);
  if (!normalized.toLowerCase().endsWith(suffix.toLowerCase())) return null;
  return normalized.slice(0, normalized.length - suffix.length).replace(/[\\/]+$/, '');
}

/** True if the RaidLead addon folder is actually present in this AddOns folder. */
function addonIsInstalled(addonsPath) {
  return fs.existsSync(path.join(addonsPath, 'RaidLead', 'RaidLead.toc'));
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
 * there's only one account, use it; if several, prefer whichever already has
 * this addon's save file (a strong signal -- that only happens where someone
 * actually logged in with RaidLead installed); otherwise it's genuinely
 * ambiguous and the caller should just skip this cycle rather than guess.
 */
function resolveAccount(wowRoot) {
  const accounts = listAccounts(wowRoot);
  if (accounts.length === 0) return null;
  if (accounts.length === 1) return accounts[0];

  const withAddonData = accounts.filter(a => fs.existsSync(accountSavedVariablesPath(a.fullPath)));
  if (withAddonData.length === 1) return withAddonData[0];

  return null; // ambiguous -- caller logs and skips rather than guessing
}

module.exports = {
  guessWowRoot, deriveWowRootFromAddonsFolder, addonIsInstalled, listAccounts, listCharacters,
  accountSavedVariablesPath, characterSavedVariablesPath, resolveAccount, isWowRunning,
};
