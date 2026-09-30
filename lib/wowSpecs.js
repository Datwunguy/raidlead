// ============================================================
//  lib/wowSpecs.js — each class's specs and the raid role each fills, per
//  WoW version (from public/games.js), plus reading a spec out of free text
//  like "Resto Shaman" or "Mage - Fire/Arcane" (the application form's
//  class/spec answer). `game` is a version id or entry; Retail if left out.
// ============================================================
const { gameFor } = require('./games');

const gameOf = game => gameFor(typeof game === 'string' ? game : game?.id);

// Retail's classes and specs, for anything that doesn't say which version.
const CLASS_SPECS = gameFor('retail').specs;

// "Beast Mastery" / "BeastMastery" / "beast-mastery" -> "beastmastery"
const specKey = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// A class's [name, role] pairs in one version ([] if the class isn't in it).
function specsFor(cls, game) {
  return gameOf(game).specs[String(cls || '').toLowerCase()] || [];
}

// The [name, role] entry a spec name (or a version's alias for it, like
// Classic's "Feral Combat") refers to, or undefined.
function findSpec(cls, spec, game) {
  const g = gameOf(game);
  const specs = specsFor(cls, g);
  const key = specKey(spec);
  const hit = specs.find(([name]) => specKey(name) === key);
  if (hit || !g.specAliases?.[key]) return hit;
  return specs.find(([name]) => name === g.specAliases[key]);
}

// The class's own spelling of a spec name, or null if it isn't one of theirs.
function canonicalSpec(cls, spec, game) {
  return findSpec(cls, spec, game)?.[0] || null;
}

function roleForSpec(cls, spec, game) {
  return findSpec(cls, spec, game)?.[1] || null;
}

// Short forms people actually type. Only used together with the class, so
// "resto" or "holy" can't land on the wrong class.
const SPEC_ALIASES = {
  resto: 'restoration', rdruid: 'restoration', rsham: 'restoration', disc: 'discipline',
  prot: 'protection', ret: 'retribution', bm: 'beastmastery', mm: 'marksmanship', surv: 'survival',
  sub: 'subtlety', sin: 'assassination', assa: 'assassination', assass: 'assassination',
  ww: 'windwalker', mw: 'mistweaver', brew: 'brewmaster', aug: 'augmentation', dev: 'devastation',
  deva: 'devastation', pres: 'preservation', ele: 'elemental', elem: 'elemental', enh: 'enhancement',
  enhance: 'enhancement', aff: 'affliction', affli: 'affliction', demo: 'demonology', destro: 'destruction',
  veng: 'vengeance', boomkin: 'balance', boomy: 'balance', moonkin: 'balance', spriest: 'shadow',
  bear: 'guardian', cat: 'feral', uh: 'unholy',
};

// First spec of `cls` mentioned in the text, reading left to right, so
// "Mage - Fire/Arcane" gives their main (Fire). null if none is found.
function parseSpec(text, cls, game) {
  const g = gameOf(game);
  if (!specsFor(cls, g).length) return null;
  const words = String(text || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (const candidate of [words[i] + (words[i + 1] || ''), words[i]]) { // "beast mastery" is two words
      const hit = findSpec(cls, candidate, g) || (!g.specAliases?.[candidate] && findSpec(cls, SPEC_ALIASES[candidate], g));
      if (hit) return hit[0];
    }
  }
  return null;
}

module.exports = { CLASS_SPECS, specsFor, canonicalSpec, roleForSpec, parseSpec };
