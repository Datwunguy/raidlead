// ============================================================
// luaData.js — the two translations between this app and WoW's Lua-syntax
// SavedVariables files.
//
// Reading loot (RaidLeadExportDB): the addon deliberately keeps this
// SavedVariable as ONE Lua string containing JSON (see Core.lua's
// RefreshExport) specifically so this side only ever needs to pull out one
// string literal and JSON.parse it -- never a general Lua-table parser.
//
// Writing the roster mirror (RaidLeadCompanionDB): WoW loads this file as
// real Lua, so it has to actually BE valid Lua table syntax for the addon
// to read it as normal nested tables -- there's no way around emitting Lua
// here. luaSerialize below produces exactly the ["key"] = value, style
// WoW's own serializer uses.
//
// Caveat worth knowing: WoW only reads this file at login/reload, and a
// plain logout (not just /reload) re-flushes whatever's still in memory
// back to disk -- so a write that lands in the narrow window between "WoW
// already running with the old copy in memory" and "player logs out" can
// get silently overwritten once. Harmless for a roster mirror (it's a
// display convenience, and the next poll cycle just writes it again) --
// this is why loot data intentionally lives in a completely separate,
// addon-owned file instead of sharing this one.
// ============================================================
const fs = require('fs');
const path = require('path');

function extractTopLevelString(luaSource, varName) {
  const marker = `${varName} = "`;
  const start = luaSource.indexOf(marker);
  if (start === -1) return null;

  let i = start + marker.length;
  let out = '';
  const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
  while (i < luaSource.length) {
    const c = luaSource[i];
    if (c === '\\') {
      const next = luaSource[i + 1];
      out += ESCAPES[next] !== undefined ? ESCAPES[next] : (next || '');
      i += 2;
    } else if (c === '"') {
      return out;
    } else {
      out += c;
      i += 1;
    }
  }
  return null; // unterminated -- file was mid-write or corrupt, caller treats as "no data"
}

/** Reads RaidLeadExportDB from the addon's account-wide SavedVariables file. Returns {} on any failure. */
function readLootRecords(filePath) {
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {};
  }
  const jsonStr = extractTopLevelString(source, 'RaidLeadExportDB');
  if (!jsonStr) return {};
  try {
    return JSON.parse(jsonStr);
  } catch {
    return {};
  }
}

function luaEscapeString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

function luaSerialize(value, indentLevel = 1) {
  const pad = '  '.repeat(indentLevel);
  const closePad = '  '.repeat(Math.max(indentLevel - 1, 0));

  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'string') return `"${luaEscapeString(value)}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '{}';
    const items = value.map(v => `${pad}${luaSerialize(v, indentLevel + 1)},`).join('\n');
    return `{\n${items}\n${closePad}}`;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined && value[k] !== null);
    if (keys.length === 0) return '{}';
    const items = keys
      .map(k => `${pad}["${luaEscapeString(k)}"] = ${luaSerialize(value[k], indentLevel + 1)},`)
      .join('\n');
    return `{\n${items}\n${closePad}}`;
  }

  return 'nil';
}

/** Writes RaidLeadCompanionDB as a real Lua table literal so the addon can read it natively. */
function writeCompanionDb(filePath, data) {
  const lua = `RaidLeadCompanionDB = ${luaSerialize(data, 1)}\n`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lua, 'utf8');
}

module.exports = { readLootRecords, writeCompanionDb, luaSerialize };
