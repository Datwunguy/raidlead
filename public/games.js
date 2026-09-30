// ============================================================
//  public/games.js — the rules for each World of Warcraft version RaidLead
//  supports: classes, specs and the raid role each fills, raid buffs and
//  raid utility, raid difficulties and sizes, tier token groups, and where
//  each version's data lives (Warcraft Logs site, Raider.io, Blizzard API
//  namespace). One copy for everything: the page loads it as a script
//  (window.RAIDLEAD_GAMES) and the server require()s it (lib/games.js).
//
//  A guild belongs to one version (guilds.game); its teams follow it.
// ============================================================
(function (root) {
  // Talent-tree specs for Classic Era, TBC, and (until its talents are
  // confirmed at launch) Forever. Feral is split by what the druid does.
  const TREE_SPECS = {
    'druid':   [['Balance', 'ranged'], ['Feral (Bear)', 'tank'], ['Feral (Cat)', 'melee'], ['Restoration', 'heal']],
    'hunter':  [['Beast Mastery', 'ranged'], ['Marksmanship', 'ranged'], ['Survival', 'ranged']],
    'mage':    [['Arcane', 'ranged'], ['Fire', 'ranged'], ['Frost', 'ranged']],
    'paladin': [['Holy', 'heal'], ['Protection', 'tank'], ['Retribution', 'melee']],
    'priest':  [['Discipline', 'heal'], ['Holy', 'heal'], ['Shadow', 'ranged']],
    'rogue':   [['Assassination', 'melee'], ['Combat', 'melee'], ['Subtlety', 'melee']],
    'shaman':  [['Elemental', 'ranged'], ['Enhancement', 'melee'], ['Restoration', 'heal']],
    'warlock': [['Affliction', 'ranged'], ['Demonology', 'ranged'], ['Destruction', 'ranged']],
    'warrior': [['Arms', 'melee'], ['Fury', 'melee'], ['Protection', 'tank']],
  };
  const TREE_CLASSES = Object.keys(TREE_SPECS);

  // What talent-tree names come back as from Raider.io and Blizzard.
  const TREE_SPEC_ALIASES = { feralcombat: 'Feral (Cat)', feral: 'Feral (Cat)', cat: 'Feral (Cat)', bear: 'Feral (Bear)' };

  const one = (cls, spec) => [spec ? { class: cls, spec } : { class: cls }];

  // Classic Era raid buffs and debuffs worth planning around. Paladins are
  // Alliance-only and Shamans Horde-only here, so a guild sees one or the other.
  const ERA_BUFFS = [
    { name: 'Mark of the Wild',      providers: one('druid') },
    { name: 'Fortitude',             providers: one('priest') },
    { name: 'Arcane Intellect',      providers: one('mage') },
    { name: 'Blessings',             providers: one('paladin') },
    { name: 'Windfury & Totems',     providers: one('shaman') },
    { name: 'Battle Shout',          providers: one('warrior') },
    { name: 'Sunder Armor',          providers: one('warrior') },
    { name: 'Trueshot Aura',         providers: one('hunter', 'Marksmanship') },
    { name: 'Leader of the Pack',    providers: one('druid', 'Feral (Cat)').concat(one('druid', 'Feral (Bear)')) },
    { name: 'Moonkin Aura',          providers: one('druid', 'Balance') },
    { name: 'Shadow Weaving',        providers: one('priest', 'Shadow') },
    { name: 'Curse of the Elements', providers: one('warlock') },
  ];

  // TBC: the same core, plus the spec buffs raids are built around.
  const TBC_BUFFS = [
    { name: 'Mark of the Wild',      providers: one('druid') },
    { name: 'Fortitude',             providers: one('priest') },
    { name: 'Arcane Intellect',      providers: one('mage') },
    { name: 'Blessings',             providers: one('paladin') },
    { name: 'Windfury & Totems',     providers: one('shaman') },
    { name: 'Battle Shout',          providers: one('warrior') },
    { name: 'Blood Frenzy',          providers: one('warrior', 'Arms') },
    { name: 'Trueshot Aura',         providers: one('hunter', 'Marksmanship') },
    { name: 'Leader of the Pack',    providers: one('druid', 'Feral (Cat)').concat(one('druid', 'Feral (Bear)')) },
    { name: 'Moonkin Aura',          providers: one('druid', 'Balance') },
    { name: 'Vampiric Touch',        providers: one('priest', 'Shadow') },
    { name: 'Curse of the Elements', providers: one('warlock') },
  ];

  // Classic Era / Forever: warlock summons and stones, druid battle rez (the
  // only one there is). No Bloodlust before TBC.
  const ERA_UTILITY = [
    { name: 'Summons & Stones', providers: one('warlock') },
    { name: 'Battle Rez',       providers: one('druid') },
  ];

  const GAMES = {
    retail: {
      id: 'retail', label: 'Retail', badge: 'Retail',
      classes: ['death knight', 'demon hunter', 'druid', 'evoker', 'hunter', 'mage', 'monk', 'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior'],
      specs: {
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
      },
      raidBuffs: [
        { name: '3% Magic',    providers: one('demon hunter') },
        { name: '3% Vers',     providers: one('druid') },
        { name: 'Movement',    providers: one('evoker') },
        { name: '3% Damage',   providers: one('hunter') },
        { name: '3% Int',      providers: one('mage') },
        { name: '5% Physical', providers: one('monk') },
        { name: '3% DR',       providers: one('paladin') },
        { name: '5% Stam',     providers: one('priest') },
        { name: '3% Boss DR',  providers: one('rogue') },
        { name: '2% Mastery',  providers: one('shaman') },
        { name: '5% AP',       providers: one('warrior') },
      ],
      // Battle rez and Bloodlust come from several classes in Retail, so they
      // aren't single pills.
      raidUtility: [
        { name: 'Grip',          providers: one('death knight') },
        { name: 'Gate & Stones', providers: one('warlock') },
      ],
      difficulties: [
        { key: 'lfr',    label: 'LFR',    wcl: 1 },
        { key: 'normal', label: 'Normal', wcl: 3 },
        { key: 'heroic', label: 'Heroic', wcl: 4 },
        { key: 'mythic', label: 'Mythic', wcl: 5 },
      ],
      defaultDifficulty: 'mythic',
      raidCap: 30, raidCapLabel: 'Heroic raid cap',
      compTarget: { tank: 2, heal: 4, dps: 14 }, compLabel: 'a Mythic group',
      tokenGroups: [
        { name: 'Cloth',   classes: ['mage', 'priest', 'warlock'] },
        { name: 'Leather', classes: ['rogue', 'monk', 'druid', 'demon hunter'] },
        { name: 'Mail',    classes: ['hunter', 'shaman', 'evoker'] },
        { name: 'Plate',   classes: ['warrior', 'paladin', 'death knight'] },
      ],
      sources: {
        raiderio: { host: 'raider.io', mplus: true, rankings: true, calendar: true, guildProgress: true },
        wclHost: 'www', blizzardNs: '', armory: 'en-us',
      },
    },

    progression: {
      id: 'progression', label: 'Classic (MoP · WoD)', badge: 'Classic',
      classes: ['death knight', 'druid', 'hunter', 'mage', 'monk', 'paladin', 'priest', 'rogue', 'shaman', 'warlock', 'warrior'],
      specs: {
        'death knight': [['Blood', 'tank'], ['Frost', 'melee'], ['Unholy', 'melee']],
        'druid':        [['Balance', 'ranged'], ['Feral', 'melee'], ['Guardian', 'tank'], ['Restoration', 'heal']],
        'hunter':       [['Beast Mastery', 'ranged'], ['Marksmanship', 'ranged'], ['Survival', 'ranged']],
        'mage':         [['Arcane', 'ranged'], ['Fire', 'ranged'], ['Frost', 'ranged']],
        'monk':         [['Brewmaster', 'tank'], ['Mistweaver', 'heal'], ['Windwalker', 'melee']],
        'paladin':      [['Holy', 'heal'], ['Protection', 'tank'], ['Retribution', 'melee']],
        'priest':       [['Discipline', 'heal'], ['Holy', 'heal'], ['Shadow', 'ranged']],
        'rogue':        [['Assassination', 'melee'], ['Combat', 'melee'], ['Subtlety', 'melee']],
        'shaman':       [['Elemental', 'ranged'], ['Enhancement', 'melee'], ['Restoration', 'heal']],
        'warlock':      [['Affliction', 'ranged'], ['Demonology', 'ranged'], ['Destruction', 'ranged']],
        'warrior':      [['Arms', 'melee'], ['Fury', 'melee'], ['Protection', 'tank']],
      },
      // Mists of Pandaria's eight raid buff categories -- each can come from
      // several classes. (Hunter pets can fill most of them too.)
      raidBuffs: [
        { name: '5% Stats',       providers: one('paladin').concat(one('druid'), one('monk')) },
        { name: '10% Stamina',    providers: one('priest').concat(one('warlock'), one('warrior')) },
        { name: '10% Attack Power', providers: one('warrior').concat(one('death knight'), one('hunter')) },
        { name: '10% Spell Power', providers: one('mage').concat(one('warlock'), one('shaman')) },
        { name: '10% Melee Haste', providers: one('death knight', 'Frost').concat(one('death knight', 'Unholy'), one('rogue'), one('shaman', 'Enhancement')) },
        { name: '5% Spell Haste', providers: one('priest', 'Shadow').concat(one('druid', 'Balance'), one('shaman', 'Elemental')) },
        { name: '5% Crit',        providers: one('druid', 'Feral').concat(one('druid', 'Guardian'), one('mage'), one('monk', 'Windwalker')) },
        { name: 'Mastery',        providers: one('paladin').concat(one('shaman')) },
      ],
      raidUtility: [
        { name: 'Grip',          providers: one('death knight') },
        { name: 'Gate & Stones', providers: one('warlock') },
      ],
      difficulties: [
        { key: 'lfr',      label: 'LFR',     wcl: 1, size: 25 },
        { key: 'normal10', label: '10 N',    wcl: 3, size: 10 },
        { key: 'normal25', label: '25 N',    wcl: 3, size: 25 },
        { key: 'heroic10', label: '10 H',    wcl: 4, size: 10 },
        { key: 'heroic25', label: '25 H',    wcl: 4, size: 25 },
      ],
      defaultDifficulty: 'heroic25',
      raidCap: 25, raidCapLabel: '25-player raid',
      compTarget: { tank: 2, heal: 6, dps: 17 }, compLabel: 'a 25-player group',
      tokenGroups: [
        { name: 'Conqueror',  classes: ['paladin', 'priest', 'warlock'] },
        { name: 'Protector',  classes: ['warrior', 'hunter', 'shaman', 'monk'] },
        { name: 'Vanquisher', classes: ['rogue', 'death knight', 'mage', 'druid'] },
      ],
      sources: {
        raiderio: { host: 'classic.raider.io', mplus: false, rankings: false, calendar: false, guildProgress: true },
        wclHost: 'classic', blizzardNs: 'classic', armory: null,
      },
      resources: {
        'Logs & Progress': [
          { name: 'Warcraft Logs (Classic)', url: 'https://classic.warcraftlogs.com/', description: 'Logs, parses, and guild progress for Classic Progression realms.' },
          { name: 'Raider.io (Classic)',     url: 'https://classic.raider.io/',        description: 'Characters, guilds, and raid progression for Classic Progression realms.' },
        ],
        'Class/Spec Info': [
          { name: 'Wowhead (MoP Classic)', url: 'https://www.wowhead.com/mop-classic', description: 'Guides, BiS lists, items, and talents for Mists of Pandaria Classic.' },
        ],
      },
    },

    anniversary: {
      id: 'anniversary', label: 'TBC Anniversary', badge: 'TBC',
      classes: TREE_CLASSES, specs: TREE_SPECS, specAliases: TREE_SPEC_ALIASES,
      raidBuffs: TBC_BUFFS,
      // In TBC, Bloodlust/Heroism is Shaman-only and Rebirth is the only battle rez.
      raidUtility: [
        { name: 'Summons & Stones',   providers: one('warlock') },
        { name: 'Bloodlust/Heroism',  providers: one('shaman') },
        { name: 'Battle Rez',         providers: one('druid') },
      ],
      difficulties: [
        { key: 'raid10', label: '10', wcl: 3, size: 10 },
        { key: 'raid25', label: '25', wcl: 3, size: 25 },
      ],
      defaultDifficulty: 'raid25',
      raidCap: 25, raidCapLabel: '25-player raid',
      compTarget: { tank: 3, heal: 7, dps: 15 }, compLabel: 'a 25-player group',
      tokenGroups: [
        { name: 'Champion', classes: ['paladin', 'rogue', 'shaman'] },
        { name: 'Defender', classes: ['warrior', 'priest', 'druid'] },
        { name: 'Hero',     classes: ['hunter', 'mage', 'warlock'] },
      ],
      sources: {
        raiderio: null, // Raider.io's Classic site covers Progression realms only
        wclHost: 'fresh', blizzardNs: 'classicann', armory: null,
      },
      resources: {
        'Logs & Progress': [
          { name: 'Warcraft Logs (Fresh)', url: 'https://fresh.warcraftlogs.com/', description: 'Logs, parses, and guild progress for the TBC Anniversary realms.' },
        ],
        'Class/Spec Info': [
          { name: 'Wowhead (TBC Classic)', url: 'https://www.wowhead.com/tbc', description: 'Guides, BiS lists, items, and talents for The Burning Crusade.' },
        ],
      },
    },

    era: {
      id: 'era', label: 'Classic Era & Hardcore', badge: 'Era',
      classes: TREE_CLASSES, specs: TREE_SPECS, specAliases: TREE_SPEC_ALIASES,
      raidBuffs: ERA_BUFFS,
      raidUtility: ERA_UTILITY,
      difficulties: [
        { key: 'raid20', label: '20', wcl: 3, size: 20 },
        { key: 'raid40', label: '40', wcl: 3, size: 40 },
      ],
      defaultDifficulty: 'raid40',
      raidCap: 40, raidCapLabel: '40-player raid',
      compTarget: { tank: 5, heal: 12, dps: 23 }, compLabel: 'a 40-player group',
      tokenGroups: null,
      sources: {
        raiderio: null,
        wclHost: 'vanilla', blizzardNs: 'classic1x', armory: null,
      },
      resources: {
        'Logs & Progress': [
          { name: 'Warcraft Logs (Classic Era)', url: 'https://vanilla.warcraftlogs.com/', description: 'Logs, parses, and guild progress for Classic Era and Hardcore.' },
        ],
        'Class/Spec Info': [
          { name: 'Wowhead (Classic)', url: 'https://www.wowhead.com/classic', description: 'Guides, BiS lists, items, and talents for Classic Era.' },
        ],
      },
    },

    // World of Warcraft: Forever (Classic+) launches November 4, 2026. Built
    // from what's been announced (levels 1-60, 10- and 20-player raids); its
    // Warcraft Logs site, Blizzard namespace, and Raider.io coverage are
    // filled in at launch -- until then those features say they're coming.
    forever: {
      id: 'forever', label: 'Forever', badge: 'Forever', beta: true,
      classes: TREE_CLASSES, specs: TREE_SPECS, specAliases: TREE_SPEC_ALIASES,
      raidBuffs: ERA_BUFFS,
      raidUtility: ERA_UTILITY,
      difficulties: [
        { key: 'raid10', label: '10', wcl: 3, size: 10 },
        { key: 'raid20', label: '20', wcl: 3, size: 20 },
      ],
      defaultDifficulty: 'raid20',
      raidCap: 20, raidCapLabel: '20-player raid',
      compTarget: { tank: 2, heal: 4, dps: 14 }, compLabel: 'a 20-player group',
      tokenGroups: null,
      sources: { raiderio: null, wclHost: null, blizzardNs: null, armory: null },
      resources: {
        'Game Info': [
          { name: 'Forever on warcraft.wiki.gg', url: 'https://warcraft.wiki.gg/wiki/Forever', description: 'What\'s known about World of Warcraft: Forever so far.' },
        ],
      },
    },
  };

  const GAME_ORDER = ['retail', 'progression', 'anniversary', 'era', 'forever'];
  const gameFor = id => GAMES[id] || GAMES.retail;

  const api = { GAMES, GAME_ORDER, gameFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RAIDLEAD_GAMES = api;
})(typeof window !== 'undefined' ? window : this);
