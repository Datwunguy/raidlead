// ============================================================
//  lib/applications.js — turns a Google Form response sheet (header row +
//  one row per response) into normalized applications for Team Management
//  -> Applicants. Pure functions, no I/O, so they're easy to test.
// ============================================================
const crypto = require('crypto');

// The columns RaidLead needs to understand. Every column (these included)
// is still shown to officers as a plain question/answer.
const FIELDS = ['timestamp', 'character', 'classSpec', 'contact', 'wcl', 'raiderio', 'armory'];

// Header keyword matchers, checked in this order so the link questions
// ("...your Warcraft logs, including characters...", "...Raider.io",
// "...Armory page") get claimed before the looser character/contact
// patterns can grab them.
const DETECTORS = [
  ['timestamp', h => /^timestamp$/.test(h)],
  ['wcl',       h => /warcraft ?logs|\bwcl\b/.test(h)],
  ['raiderio',  h => /raider\.?io/.test(h)],
  ['armory',    h => /armou?ry/.test(h)],
  ['character', h => /character|toon/.test(h)],
  ['classSpec', h => /\bclass\b/.test(h) && /spec/.test(h)],
  ['contact',   h => /battle\.?net|b\.?tag|battletag|discord/.test(h)],
];

function detectColumnMap(headers) {
  const map   = {};
  const taken = new Set();
  for (const [field, test] of DETECTORS) {
    const idx = headers.findIndex((h, i) => !taken.has(i) && test(String(h ?? '').toLowerCase().trim()));
    if (idx >= 0) { map[field] = idx; taken.add(idx); }
  }
  return map;
}

// Officer overrides win field by field; -1 means "this form has no such
// column". Anything the officer never touched falls back to auto-detect.
function mergeColumnMap(detected, saved) {
  const out = { ...detected };
  for (const f of FIELDS) {
    if (saved && Number.isInteger(saved[f])) {
      if (saved[f] < 0) delete out[f];
      else out[f] = saved[f];
    }
  }
  return out;
}

// Sheets serial day number (days since 1899-12-30, in the sheet's own
// timezone) -> Date holding that wall-clock time as UTC.
function serialToDate(v) {
  if (typeof v === 'number' && isFinite(v)) return new Date(Math.round((v - 25569) * 86400000));
  const parsed = Date.parse(v);
  return isNaN(parsed) ? null : new Date(parsed);
}

function firstUrl(v) {
  return String(v ?? '').match(/https?:\/\/[^\s<>"]+/)?.[0] || null;
}

// "Vuk-Sargeras", "Vuk - Sargeras", "Vuk (Sargeras)", "Vuk/Sargeras",
// "Vuk Sargeras", "Vuk-Azjol-Nerub" -> { name, realm }. WoW names can't
// contain spaces or hyphens, so everything after the first separator is
// the realm (which can itself contain a hyphen, e.g. Azjol-Nerub).
function parseCharacterText(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return { name: null, realm: null };
  const m = t.match(/^([^\s\-\/(,@]+)\s*[-\/(,@]\s*(.+?)\)?$/) || t.match(/^(\S+) (.+)$/);
  if (!m) return { name: t, realm: null };
  // Drop a trailing region tag ("Sargeras (US)", "Sargeras US") -- only when
  // it's its own word, so a realm that merely ends in those letters survives.
  const realm = m[2].replace(/(\s+|\s*\()(us|eu|na|oce)\)?$/i, '').trim();
  return { name: m[1], realm: realm || null };
}

// Raider.io / WCL / Armory character links all carry region/realm/name.
function parseCharacterLink(url) {
  const s = String(url ?? '');
  const m = s.match(/raider\.io\/characters\/([a-z]{2})\/([^/?#\s]+)\/([^/?#\s]+)/i)
        || s.match(/warcraftlogs\.com\/character\/([a-z]{2})\/([^/?#\s]+)\/([^/?#\s]+)/i)
        || s.match(/worldofwarcraft\.(?:blizzard\.)?com\/[a-z-]+\/character\/([a-z]{2})\/([^/?#\s]+)\/([^/?#\s]+)/i);
  if (!m) return null;
  const decode = x => { try { return decodeURIComponent(x); } catch (e) { return x; } };
  return { region: m[1].toLowerCase(), realm: decode(m[2]), name: decode(m[3]) };
}

// Checked in order: "Demon Hunter" has to win before plain "hunter".
const CLASS_PATTERNS = [
  ['death knight', /death ?knight|\bdk\b/],
  ['demon hunter', /demon ?hunter|\bdh\b/],
  ['druid',        /druid/],
  ['evoker',       /evoker|\bevo(ker)?\b/],
  ['hunter',       /hunter|\bhunt\b/],
  ['mage',         /\bmage\b/],
  ['monk',         /\bmonk\b/],
  ['paladin',      /paladin|\bpally\b|\bpal\b/],
  ['priest',       /priest/],
  ['rogue',        /rogue/],
  ['shaman',       /shaman|\bsham\b/],
  ['warlock',      /warlock|\block\b/],
  ['warrior',      /warrior|\bwar\b/],
];

function parseClass(text) {
  const t = String(text ?? '').toLowerCase();
  return CLASS_PATTERNS.find(([, re]) => re.test(t))?.[0] || null;
}

function formatAnswer(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  return String(v ?? '').trim();
}

function responseKey(row, map) {
  const pick = f => (map[f] != null ? formatAnswer(row[map[f]]) : '');
  const basis = map.timestamp != null
    ? `${pick('timestamp')}|${pick('contact')}|${pick('character')}`
    : row.map(formatAnswer).join('|');
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 24);
}

function toApplication(row, headers, map) {
  const cell = f => (map[f] != null ? row[map[f]] : undefined);

  const submitted = serialToDate(cell('timestamp'));
  const links = {
    wcl:      firstUrl(cell('wcl')),
    raiderio: firstUrl(cell('raiderio')),
    armory:   firstUrl(cell('armory')),
  };

  // Name/realm: the typed "Name-Realm" answer if it parses cleanly,
  // otherwise whichever character link they gave. A bare name with no
  // realm is kept (realm null) -- the officer fills it in on promote.
  const fromText = parseCharacterText(cell('character'));
  const fromLink = parseCharacterLink(links.raiderio) || parseCharacterLink(links.armory) || parseCharacterLink(links.wcl);
  let name = fromText.name, realm = fromText.realm;
  if ((!name || !realm) && fromLink) { name = fromLink.name; realm = fromLink.realm; }

  const classSpec = formatAnswer(cell('classSpec'));
  const answers = headers
    .map((q, i) => ({ question: String(q ?? '').trim(), answer: formatAnswer(row[i]) }))
    .filter((a, i) => i !== map.timestamp && a.question && a.answer);

  return {
    key:           responseKey(row, map),
    submittedAt:   submitted ? submitted.toISOString() : null,
    submittedDate: submitted ? submitted.toISOString().slice(0, 10) : null,
    name,
    realm,
    classSpec,
    class:         parseClass(classSpec),
    contact:       formatAnswer(cell('contact')),
    links,
    answers,
  };
}

// rows[0] is the header row. Blank rows are skipped; newest first.
function normalizeApplications(rows, map) {
  const [headers = [], ...data] = rows || [];
  return data
    .filter(row => (row || []).some(v => formatAnswer(v) !== ''))
    .map(row => toApplication(row, headers, map))
    .sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
}

module.exports = {
  FIELDS, detectColumnMap, mergeColumnMap, normalizeApplications,
  parseCharacterText, parseCharacterLink, parseClass, serialToDate,
};
