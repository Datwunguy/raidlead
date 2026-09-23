// ============================================================
//  lib/raiderioRaids.js — shared Raider.io raid-lookup helpers. Used by
//  api/raiderio.js (the raid-tier selector) and api/roster.js
//  (advanceSeason's credential-free zone detection) -- one
//  CURRENT_EXPANSION_ID_FALLBACK to update per expansion, not two copies
//  that can quietly drift out of sync.
// ============================================================

// Hand-maintained -- bump when a new expansion ships. Only ever used when
// live discovery/date-matching doesn't resolve on its own.
const CURRENT_EXPANSION_ID_FALLBACK = 11; // Midnight, as of 2026-09

function toRaiderioRegion(region) {
  return region === 'oceanic' ? 'us' : region;
}

// Finds whichever raid in Raider.io's static-data is "current" for a
// region, by real Blizzard-confirmed per-region start/end dates -- no WCL
// credentials needed, and more authoritative than any heuristic based on
// when someone happened to notice a zone change. Checks the current
// expansion and the previous one (a brand-new expansion's raid may not be
// in static-data yet right at launch, or the live raid could still be
// last expansion's final tier). Returns { zoneName, raidSlug } or null.
async function resolveCurrentRaidByDate(region) {
  const raiderioRegion = toRaiderioRegion(region);
  const now = Date.now();

  for (const expansionId of [CURRENT_EXPANSION_ID_FALLBACK, CURRENT_EXPANSION_ID_FALLBACK - 1]) {
    try {
      const resp = await fetch(`https://raider.io/api/v1/raiding/static-data?expansion_id=${expansionId}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const raids = data?.raids || [];

      let best = null, bestStarts = 0;
      for (const raid of raids) {
        const startsAt = raid.starts?.[raiderioRegion] ? Date.parse(raid.starts[raiderioRegion]) : null;
        const endsAt   = raid.ends?.[raiderioRegion] ? Date.parse(raid.ends[raiderioRegion]) : null;
        if (!startsAt || startsAt > now) continue; // not live yet
        if (endsAt && endsAt < now) continue;       // already over
        if (startsAt > bestStarts) { best = raid; bestStarts = startsAt; }
      }
      if (best) return { zoneName: best.name, raidSlug: best.slug };
    } catch (e) { /* try the next expansion_id */ }
  }
  return null;
}

module.exports = { CURRENT_EXPANSION_ID_FALLBACK, toRaiderioRegion, resolveCurrentRaidByDate };
