// ============================================================
//  lib/wowSpecs.js — every class's specs and the raid role each fills,
//  plus reading a spec out of free text like "Resto Shaman" or
//  "Mage - Fire/Arcane" (the application form's class/spec answer).
//  public/app.js keeps a copy of CLASS_SPECS for the recruit spec picker
//  -- keep the two in sync by hand.
// ============================================================

const CLASS_SPECS = {
  'death knight': [['Blood', 'tank'], ['Frost', 'melee'], ['Unholy', 'melee']],
  'demon hunter': [['Havoc', 'melee'], ['Vengeance', 'tank'], ['Devourer', 'ranged']],
  'druid':        [['Balance', 'ranged'], ['Feral', 'melee'], ['Guardian', 'tank'], ['Restoration', 'heal']],
  'evoker':       [['Augmentation', 'ranged'], ['Devastation', 'ranged'], ['Preservation', 'heal']],
  'hunter':       [['Beast Mastery', 'ranged'], ['Marksmanship', 'ranged'], ['Survival', 'melee']],
  'mage':         [['Arcane', 'ranged'], ['Fire', 'ranged'], ['Frost', 'ranged']],
  'monk':         [['Brewmaster', 'tank'], ['Mistweaver', 'heal'], ['Windwalker', 'melee']],
  'paladin':      [['Holy', 'heal'], ['Protection', 'tank'], ['Retribution', 'melee']],
  'priest':       [['Discipline', 'heal'], ['Holy', 'heal'], ['Shadow', 'ranged']],
  'rogue':        [['Assassination', 'melee'], ['Outlaw', 'melee'], ['Subtlety', 'melee']],
  'shaman':       [['Elemental', 'ranged'], ['Enhancement', 'melee'], ['Restoration', 'heal']],
  'warlock':      [['Affliction', 'ranged'], ['Demonology', 'ranged'], ['Destruction', 'ranged']],
  'warrior':      [['Arms', 'melee'], ['Fury', 'melee'], ['Protection', 'tank']],
};

// "Beast Mastery" / "BeastMastery" / "beast-mastery" -> "beastmastery"
const specKey = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// The class's own spelling of a spec name, or null if it isn't one of theirs.
function canonicalSpec(cls, spec) {
  const key = specKey(spec);
  return (CLASS_SPECS[String(cls || '').toLowerCase()] || []).find(([name]) => specKey(name) === key)?.[0] || null;
}

function roleForSpec(cls, spec) {
  const key = specKey(spec);
  return (CLASS_SPECS[String(cls || '').toLowerCase()] || []).find(([name]) => specKey(name) === key)?.[1] || null;
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
function parseSpec(text, cls) {
  const specs = CLASS_SPECS[String(cls || '').toLowerCase()];
  if (!specs) return null;
  const words = String(text || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (const candidate of [words[i] + (words[i + 1] || ''), words[i]]) { // "beast mastery" is two words
      const key = SPEC_ALIASES[candidate] || candidate;
      const hit = specs.find(([name]) => specKey(name) === key);
      if (hit) return hit[0];
    }
  }
  return null;
}

module.exports = { CLASS_SPECS, canonicalSpec, roleForSpec, parseSpec };
