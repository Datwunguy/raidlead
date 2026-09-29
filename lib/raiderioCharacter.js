// ============================================================
//  lib/raiderioCharacter.js — one-call Raider.io summary of any character
//  (not just guild members), used to size up recruits: class/spec/role,
//  equipped ilvl, current-season M+ score, and current-raid progress.
// ============================================================
const { slugifyServer } = require('./serverSlug');
const { toRaiderioRegion } = require('./raiderioRaids');
const { roleForSpec } = require('./wowSpecs');

// Raider.io's active_spec_role only says TANK / HEALING / DPS -- RaidLead's
// roster splits DPS into melee and ranged, so the role comes from the
// spec (lib/wowSpecs.js). Raider.io's own role is the fallback for a spec
// that table doesn't know yet (a brand-new one), with DPS counted as ranged.
function roleFor(className, specName, raiderioRole) {
  const known = roleForSpec(className, specName);
  if (known) return known;
  if (raiderioRole === 'TANK') return 'tank';
  if (raiderioRole === 'HEALING') return 'heal';
  return raiderioRole === 'DPS' ? 'ranged' : null;
}

// Picks the progress summary ("6/8 M") for the given raid slug when known,
// otherwise the first raid Raider.io lists -- best-effort, display-only.
function pickRaidProgress(raidProgression, raidSlug) {
  if (!raidProgression) return null;
  const entry = (raidSlug && raidProgression[raidSlug]) || Object.values(raidProgression)[0];
  return entry?.summary || null;
}

// Returns { name, realmName, class, spec, role, ilvl, mplusScore,
// raidProgress, profileUrl } or null if the character isn't found or
// Raider.io is unreachable. Never throws -- a missing lookup should never
// block saving a recruit.
async function fetchCharacterSummary(region, realm, name, raidSlug) {
  try {
    const params = new URLSearchParams({
      region: toRaiderioRegion(region || 'us'),
      realm:  slugifyServer(realm),
      name:   name.trim(),
      fields: 'gear,mythic_plus_scores_by_season:current,raid_progression',
    });
    const resp = await fetch(`https://raider.io/api/v1/characters/profile?${params}`);
    if (!resp.ok) return null;
    const data = await resp.json();

    const className = data.class || null;
    const specName  = data.active_spec_name || null;
    return {
      name:         data.name || name.trim(),
      realmName:    data.realm || realm,
      class:        className ? className.toLowerCase() : null,
      spec:         specName,
      role:         roleFor(className, specName, data.active_spec_role),
      ilvl:         data.gear?.item_level_equipped || null,
      mplusScore:   data.mythic_plus_scores_by_season?.[0]?.scores?.all ?? null,
      raidProgress: pickRaidProgress(data.raid_progression, raidSlug),
      profileUrl:   data.profile_url || null,
      fetchedAt:    new Date().toISOString(),
    };
  } catch (e) {
    return null;
  }
}

// Characters whose names start like `term`, in one region, from the search
// box on raider.io (accents ignored: "hazey" finds Häzey and Hazëy). It's
// their site's own search, not a documented API, so any failure just means
// no suggestions. Same-realm characters first; cached a minute per term.
const searchCache = new Map(); // "region|realm|term" -> { at, results }
async function searchCharacters(term, region, homeRealmSlug) {
  const r = toRaiderioRegion(region || 'us');
  const key = `${r}|${homeRealmSlug || ''}|${term.toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.results;
  try {
    const resp = await fetch(`https://raider.io/api/search?term=${encodeURIComponent(term)}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const results = (data.matches || [])
      .filter(m => m.type === 'character' && m.data?.region?.slug === r && m.data?.name && m.data?.realm?.name)
      .map(m => ({
        name:      m.data.name,
        realmName: m.data.realm.name,
        realmSlug: m.data.realm.slug || slugifyServer(m.data.realm.name),
        class:     m.data.class?.name ? m.data.class.name.toLowerCase() : null,
      }))
      .sort((a, b) => (b.realmSlug === homeRealmSlug) - (a.realmSlug === homeRealmSlug))
      .slice(0, 8);
    searchCache.set(key, { at: Date.now(), results });
    if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
    return results;
  } catch (e) {
    return [];
  }
}

module.exports = { fetchCharacterSummary, searchCharacters };
