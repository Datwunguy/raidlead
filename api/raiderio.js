// ============================================================
//  raiderio.js — proxies Raider.io data for the Progress tab
//  (world-wide boss kill counts, by difficulty + region, plus this
//  guild's own progress).
//
//  The current raid isn't configured anywhere -- it's derived from the
//  team's WCL zone name (already required for WCL Scores), slugified the
//  same way Raider.io slugs its own raid names (e.g. "The Venomous Abyss"
//  -> "the-venomous-abyss"), then verified against Raider.io itself. If
//  Raider.io doesn't recognize the derived slug, the tab reports that
//  clearly rather than showing wrong data.
//
//  Three Raider.io endpoints are used:
//   - /api/raids/instance-rankings -- undocumented but public/unauthenticated,
//     the same one their own rankings pages call. Its "timeline" is a
//     per-milestone HISTOGRAM: timeline[i].totalGuilds is the count of
//     guilds whose CURRENT furthest kill is exactly i bosses, not a
//     cumulative "at least i" count. To get "guilds who have killed boss
//     i" we sum totalGuilds from i through the last boss (any guild
//     further along has necessarily also killed boss i). Its rankedGuilds
//     also carries each guild's encountersDefeated with kill timestamps,
//     used by deriveBossOrder() below -- see that function for why (the
//     encounter list's own "ordinal" field doesn't reliably match the
//     order guilds actually kill bosses in).
//   - /api/v1/guilds/profile -- Raider.io's documented public API,
//     queried by region/realm/guild name (all already in Guild
//     Configuration) for this guild's own raid_progression and overall
//     raid_rankings (a single rank for total progress on the raid).
//   - /api/guilds/raid-rankings -- undocumented but public, the same one
//     the guild profile page's "Raid Progression" table calls. This is
//     the one that actually gives a rank PER BOSS (world/region/realm),
//     keyed by boss slug.
//   - /api/v1/guilds/boss-kill -- documented (their swagger.json), public,
//     no auth needed. Given region/realm/guild/raid/boss/difficulty, returns
//     the full kill roster with each character's spec.role ("tank"/
//     "healer"/"dps") and spec.is_melee already classified -- no need to
//     hand-maintain a spec->role table, or to go through Warcraft Logs at
//     all (which would need per-team WCL credentials just to look at other
//     guilds' public data, and doesn't classify melee/ranged for you).
//     Gated per-guild by their raidComps privacy setting; guilds with it
//     off simply return no roster, handled as "skip this guild" everywhere
//     it's used. See progressComposition below.
//  All are public data with no auth of their own; proxied server-side
//  only to avoid depending on Raider.io's CORS policy.
//
//  Actions: progress (teamId, difficulty), progressPulls (teamId, raidSlug,
//  difficulty, rankStart), progressComposition (teamId, raidSlug, bossSlug,
//  difficulty), listRaids (teamId)
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('../lib/session');
const { assertTeamMembership } = require('../lib/teamAuth');
const { ensureZoneName } = require('../lib/wclZone');

const VALID_DIFFICULTIES = ['normal', 'heroic', 'mythic'];

// How many of the top (by overall progress) rankedGuilds to sample for the
// "recommended comp" stat -- a starting point, easy to raise (more
// representative, slower/more Raider.io calls) or filter by region later
// once we've seen how this sample size looks live.
const COMP_SAMPLE_SIZE = 20;

// Avg-pulls rank brackets (see progressPulls below) are this many guilds
// wide -- comparing a rank-470 guild's pulls against the top 20 is a
// misleading gap, so the frontend lets a guild pick (or defaults to, based
// on yourGuild.regionRank -- rankedGuilds here is scoped to the team's own
// region, same pool that rank is computed from) whichever 50-guild bracket
// it actually belongs in instead.
const PULLS_BRACKET_SIZE = 50;
const pullsPageCache = new Map(); // "raidSlug|difficulty|region|pageN" -> { data: rankedGuilds, fetchedAt }
const PULLS_PAGE_CACHE_MS = 30 * 60 * 1000;

// Module-scope cache for listRaids' "current expansion" lookup -- see where
// it's used below. Persists across invocations on the same warm serverless
// instance, same pattern as roster.js's WCL token cache.
let currentExpansionIdCache = { id: null, fetchedAt: 0 };
const EXPANSION_ID_CACHE_MS = 60 * 60 * 1000; // 1 hour -- this basically never changes

// Composition is the expensive one (COMP_SAMPLE_SIZE separate Raider.io
// calls, one per sampled guild's boss-kill roster), so it's cached longer
// and behind its own action -- see progressComposition below. Keyed by
// raid+difficulty+boss+region since that's everything that changes the
// result.
const compositionCache = new Map(); // key -> { data, fetchedAt }
const COMPOSITION_CACHE_MS = 30 * 60 * 1000; // 30 min -- the top guilds' comps for a boss don't shift minute to minute

// "Oceanic" is a RaidLead-only region choice -- Blizzard/WCL/Raider.io's
// realm-region system has no such thing, Oceanic realms are still part of
// the "us" region everywhere else (Raider.io's "us" rankings bucket is
// itself a combined "United States & Oceania" pool). "US" and "Oceanic"
// intentionally use the exact same Raider.io pool for everything in this
// file -- a narrower Americas-only pool was tried for "US" at one point,
// but it made per-boss/region ranks look artificially better than the
// combined pool everyone actually sees on a guild's own Raider.io page,
// which is misleading rather than more precise. Keeping both on the same
// pool also means the per-boss rank and the world guild-count next to it
// always come from the same bucket, so one can't exceed the other.
function toRaiderioRegion(region) {
  return region === 'oceanic' ? 'us' : region;
}

// "The Venomous Abyss" -> "the-venomous-abyss" -- matches how Raider.io
// slugs its own raid names.
function slugifyRaidName(name) {
  if (!name) return null;
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || null;
}

// Raider.io's own encounter "ordinal" field does NOT reliably match the order
// guilds actually kill bosses in (verified: for The Venomous Abyss it has
// Entombed Sentinels before The Lost Explorers, while every one of the top
// 100 US mythic guilds killed The Lost Explorers first). The rankings
// response we already fetch includes each ranked guild's encountersDefeated
// with a firstDefeated timestamp, so the real order can be derived directly:
// for each guild, sort their kills chronologically, and tally which boss
// most commonly occupies each position. Falls back to ordinal for any
// position no guild's data resolves (e.g. a boss nobody's killed yet).
function deriveBossOrder(rankedGuilds, encounters) {
  const votesByPosition = {};
  (rankedGuilds || []).forEach(g => {
    const sorted = [...(g.encountersDefeated || [])]
      .sort((a, b) => new Date(a.firstDefeated) - new Date(b.firstDefeated));
    sorted.forEach((enc, idx) => {
      const pos = idx + 1;
      if (!votesByPosition[pos]) votesByPosition[pos] = {};
      votesByPosition[pos][enc.slug] = (votesByPosition[pos][enc.slug] || 0) + 1;
    });
  });

  const assigned = new Set();
  const order = [];
  for (let pos = 1; pos <= encounters.length; pos++) {
    const votes = Object.entries(votesByPosition[pos] || {}).sort((a, b) => b[1] - a[1]);
    const winner = votes.find(([slug]) => !assigned.has(slug));
    if (winner) { order.push(winner[0]); assigned.add(winner[0]); }
    else order.push(null);
  }

  const ordinalFallback = encounters.slice().sort((a, b) => a.ordinal - b.ordinal)
    .map(e => e.slug).filter(slug => !assigned.has(slug));
  let fi = 0;
  const slugOrder = order.map(slug => slug ?? ordinalFallback[fi++]);

  const bySlug = {};
  encounters.forEach(e => { bySlug[e.slug] = e; });
  return slugOrder.map(slug => bySlug[slug]).filter(Boolean);
}

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  if (action === 'progress') {
    const teamId     = req.query.teamId || req.body?.teamId;
    const difficulty = (req.query.difficulty || req.body?.difficulty || 'mythic').toLowerCase();
    if (!teamId) return res.status(400).json({ error: 'teamId required' });
    if (!VALID_DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: 'Invalid difficulty' });

    try {
      await assertTeamMembership(supabase, session.id, teamId);

      const { data: team } = await supabase
        .from('teams').select('id, zone_id, zone_name, guilds ( name, server, region )').eq('id', teamId).single();

      // An explicit raidSlug (from the raid-tier selector) views a past
      // tier; otherwise default to whatever the team's WCL zone resolves to.
      // zoneName is declared out here (not just inside the `if`) because the
      // RAID_NOT_FOUND responses below reference it regardless of which path
      // was taken -- it stays null when raidSlug came from the selector.
      const requestedSlug = req.query.raidSlug || req.body?.raidSlug || null;
      let raidSlug = requestedSlug;
      let zoneName = null;
      if (!raidSlug) {
        zoneName = await ensureZoneName(supabase, team);
        raidSlug = slugifyRaidName(zoneName);
      }
      if (!raidSlug) {
        return res.status(200).json({ configured: false, reason: 'NO_ZONE' });
      }
      const region = team.guilds?.region || 'us'; // literal team selection, used for display + realm-scoped lookups below

      const rankingsUrl = `https://raider.io/api/raids/instance-rankings?difficulty=${encodeURIComponent(difficulty)}` +
        `&raid=${encodeURIComponent(raidSlug)}&region=${encodeURIComponent(toRaiderioRegion(region))}` +
        `&realm=all&page=0&faction=&recent=false&limit=0`;

      // Raider.io returns 400 for a slug it genuinely doesn't recognize, but
      // 5xx/timeouts (verified live: instance-rankings intermittently 502s/
      // 504s under load) mean their service is struggling, not that the raid
      // is wrong -- those need a different message, or "couldn't match your
      // zone" reads as a RaidLead bug when it's actually Raider.io's outage.
      const resp = await fetch(rankingsUrl);
      if (!resp.ok) {
        const reason = resp.status >= 500 ? 'RAIDERIO_UNAVAILABLE' : 'RAID_NOT_FOUND';
        return res.status(200).json({ configured: false, reason, zoneName });
      }
      const data = await resp.json();
      const rr = data.raidRankings;
      if (!rr || !rr.raid) {
        return res.status(200).json({ configured: false, reason: 'RAID_NOT_FOUND', zoneName });
      }

      // Raider.io's guild-profile "raid_progression"/"raid_rankings" fields
      // silently default to the guild's CURRENT expansion only -- for any
      // older raid (verified live: Manaforge Omega, a prior-expansion raid
      // this guild has fully cleared, was invisible there even though the
      // guild's own Raider.io page shows real 8/8 data for it) they need to
      // be scoped with "raid_progression:<expansion_id>" instead of the bare
      // field name to return anything at all. The raid we already looked up
      // above tells us exactly which expansion it belongs to.
      const raidExpansionId = rr.raid.expansion_id;

      const encounters = deriveBossOrder(rr.rankedGuilds, rr.raid.encounters || []);
      const bucketByProgress = {};
      (rr.timeline || []).forEach(t => { bucketByProgress[t.progress] = t.totalGuilds || 0; });

      // Suffix sum: guilds who've killed boss i (1-indexed) = every guild whose
      // current furthest kill is i or greater.
      const maxProgress = encounters.length;
      let runningTotal = 0;
      const atLeastByProgress = {};
      for (let p = maxProgress; p >= 1; p--) {
        runningTotal += bucketByProgress[p] || 0;
        atLeastByProgress[p] = runningTotal;
      }

      // This guild's own progress + per-boss ranks, straight from Raider.io --
      // no manual entry, it's whatever Raider.io has last crawled for them.
      // The two lookups don't depend on each other, so they run concurrently
      // instead of one after another.
      let yourGuild = null;
      let bossRankBySlug = {};
      if (team.guilds?.name && team.guilds?.server) {
        const region_    = encodeURIComponent(toRaiderioRegion(region));
        const realm_     = encodeURIComponent(team.guilds.server);
        const guildName_ = encodeURIComponent(team.guilds.name);

        const profilePromise = (async () => {
          try {
            const progField = raidExpansionId ? `raid_progression:${raidExpansionId}` : 'raid_progression';
            const rankField = raidExpansionId ? `raid_rankings:${raidExpansionId}`    : 'raid_rankings';
            const profResp = await fetch(
              `https://raider.io/api/v1/guilds/profile?region=${region_}&realm=${realm_}&name=${guildName_}&fields=${progField},${rankField}`
            );
            if (!profResp.ok) return;
            const profile = await profResp.json();
            const prog = profile?.raid_progression?.[raidSlug];
            const rank = profile?.raid_rankings?.[raidSlug]?.[difficulty];
            if (prog) {
              const killedKey = `${difficulty}_bosses_killed`;
              yourGuild = {
                killed:      prog[killedKey] ?? 0,
                totalBosses: prog.total_bosses ?? maxProgress,
                summary:     prog.summary || null,
                // Overall region/world rank for total progress on this raid+difficulty
                // (separate from the per-boss ranks below).
                regionRank:  rank?.region || null,
                worldRank:   rank?.world || null,
              };
            }
          } catch (e) { /* Your Guild is a nice-to-have -- world data above still renders without it */ }
        })();

        const bossRankPromise = (async () => {
          try {
            const bossRankResp = await fetch(
              `https://raider.io/api/guilds/raid-rankings?raid=${encodeURIComponent(raidSlug)}&difficulty=${encodeURIComponent(difficulty)}` +
              `&region=${region_}&realm=${realm_}&guild=${guildName_}`
            );
            if (!bossRankResp.ok) return;
            const bossRankData = await bossRankResp.json();
            (bossRankData?.bossRankings || []).forEach(b => {
              if (b.boss && b.ranks) bossRankBySlug[b.boss] = b.ranks;
            });
          } catch (e) { /* per-boss rank is a nice-to-have -- world data above still renders without it */ }
        })();

        await Promise.all([profilePromise, bossRankPromise]);
      }

      // Avg pull count per boss is fetched separately (see progressPulls
      // below) for whichever rank bracket the frontend has selected -- not
      // computed here, so there's exactly one implementation of that math
      // instead of two that can quietly drift apart.
      const bosses = encounters.map((enc, i) => ({
        name:           enc.name,
        slug:           enc.slug,
        iconUrl:        enc.iconUrl ? `https://cdn.raiderio.net${enc.iconUrl}` : null,
        guildsDefeated: atLeastByProgress[i + 1] || 0,
        // Only meaningful once this boss is actually killed -- Raider.io also
        // returns entries for bosses that are merely attempted (best pull %),
        // which isn't a kill rank. The frontend gates display on youKilled.
        yourRegionRank: bossRankBySlug[enc.slug]?.region ?? null,
      }));

      // "Current" boss for the composition recommendation below -- the next
      // one this guild hasn't killed yet, clamped to the last boss once
      // they've cleared the tier (or if Raider.io has no data for them at
      // all, in which case there's no better guess than the first boss).
      const currentBossIdx = Math.min(yourGuild?.killed ?? 0, Math.max(encounters.length - 1, 0));
      const currentBossSlug = encounters[currentBossIdx]?.slug || null;

      return res.status(200).json({
        configured: true,
        raidSlug,
        raidName:   rr.raid.name || null,
        difficulty,
        region,
        bosses,
        yourGuild,
        currentBossSlug,
        compSampleSize: COMP_SAMPLE_SIZE,
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── PROGRESS PULLS: avg pull count per boss for an arbitrary 50-guild
  // rank bracket (e.g. 451-500), instead of always the world's top
  // COMP_SAMPLE_SIZE -- a top-500 guild comparing itself to the top 20 sees
  // a misleading gap, since the best guilds in the world aren't a
  // reasonable comparison point. Cheap regardless of bracket: Raider.io
  // pages rankedGuilds 100 at a time (verified live), and every 50-guild
  // bracket boundary aligns with either the first or second half of a page,
  // so this is always exactly one Raider.io call no matter which bracket is
  // requested. ──
  if (action === 'progressPulls') {
    const teamId     = req.query.teamId || req.body?.teamId;
    const difficulty = (req.query.difficulty || req.body?.difficulty || 'mythic').toLowerCase();
    const raidSlug   = req.query.raidSlug || req.body?.raidSlug;
    const region     = req.query.region || req.body?.region || 'us';
    const rankStart  = parseInt(req.query.rankStart || req.body?.rankStart, 10);
    if (!teamId || !raidSlug) return res.status(400).json({ error: 'teamId and raidSlug required' });
    if (!VALID_DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: 'Invalid difficulty' });
    if (!Number.isInteger(rankStart) || rankStart < 1 || (rankStart - 1) % PULLS_BRACKET_SIZE !== 0) {
      return res.status(400).json({ error: `rankStart must be 1, ${PULLS_BRACKET_SIZE + 1}, ${2 * PULLS_BRACKET_SIZE + 1}, etc.` });
    }

    try {
      await assertTeamMembership(supabase, session.id, teamId);

      const raiderioRegion = toRaiderioRegion(region);
      const page = Math.floor((rankStart - 1) / 100);
      const sliceStart = (rankStart - 1) % 100;

      const cacheKey = `${raidSlug}|${difficulty}|${raiderioRegion}|page${page}`;
      let rankedGuilds;
      const cached = pullsPageCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < PULLS_PAGE_CACHE_MS) {
        rankedGuilds = cached.data;
      } else {
        const rankingsUrl = `https://raider.io/api/raids/instance-rankings?difficulty=${encodeURIComponent(difficulty)}` +
          `&raid=${encodeURIComponent(raidSlug)}&region=${encodeURIComponent(raiderioRegion)}` +
          `&realm=all&page=${page}&faction=&recent=false&limit=0`;
        const resp = await fetch(rankingsUrl);
        if (!resp.ok) return res.status(200).json({ pullsBySlug: {}, bracketSize: 0 });
        const rankData = await resp.json();
        rankedGuilds = rankData?.raidRankings?.rankedGuilds || [];
        pullsPageCache.set(cacheKey, { data: rankedGuilds, fetchedAt: Date.now() });
      }

      const bracketGuilds = rankedGuilds.slice(sliceStart, sliceStart + PULLS_BRACKET_SIZE);
      const pullsBySlug = {};
      bracketGuilds.forEach(g => {
        (g.encountersDefeated || []).forEach(e => {
          // Raider.io returns attempts: 0 (not null, not omitted) for a kill
          // it has no real pull-count telemetry for -- verified live against
          // their own rankings page, which renders that same case as "-".
          // A boss can't be killed in zero pulls, so 0 always means "no
          // data" here, never "a lucky first pull"; counting it as real
          // dragged the average down hard (a top-50 sample with mostly
          // untelemetered kills showed avg 9 instead of the true ~35 from
          // just the guilds that actually reported a count).
          if (typeof e.attempts !== 'number' || e.attempts <= 0) return;
          if (!pullsBySlug[e.slug]) pullsBySlug[e.slug] = { total: 0, count: 0 };
          pullsBySlug[e.slug].total += e.attempts;
          pullsBySlug[e.slug].count += 1;
        });
      });
      const result = {};
      Object.entries(pullsBySlug).forEach(([slug, { total, count }]) => {
        result[slug] = { avgPulls: Math.round(total / count), sampleSize: count };
      });

      return res.status(200).json({ pullsBySlug: result, bracketSize: bracketGuilds.length });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── PROGRESS COMPOSITION: "recommended comp" for a specific boss --
  // averages tank/healer/melee/ranged counts from the top COMP_SAMPLE_SIZE
  // guilds' actual kill rosters. Deliberately a separate action from
  // `progress` (which stays cheap/fast, a single request) since this one
  // costs up to COMP_SAMPLE_SIZE additional Raider.io calls -- the frontend
  // fetches it in the background after the main Progress view is already
  // showing, same pattern as the Roster tab's ilvl backfill. ──
  if (action === 'progressComposition') {
    const teamId     = req.query.teamId || req.body?.teamId;
    const difficulty = (req.query.difficulty || req.body?.difficulty || 'mythic').toLowerCase();
    const raidSlug   = req.query.raidSlug || req.body?.raidSlug;
    const bossSlug   = req.query.bossSlug || req.body?.bossSlug;
    const region     = req.query.region || req.body?.region || 'us';
    if (!teamId || !raidSlug || !bossSlug) {
      return res.status(400).json({ error: 'teamId, raidSlug, and bossSlug required' });
    }
    if (!VALID_DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: 'Invalid difficulty' });

    try {
      await assertTeamMembership(supabase, session.id, teamId);

      const raiderioRegion = toRaiderioRegion(region);
      const cacheKey = `${raidSlug}|${difficulty}|${bossSlug}|${raiderioRegion}`;
      const cached = compositionCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < COMPOSITION_CACHE_MS) {
        return res.status(200).json(cached.data);
      }

      const rankingsUrl = `https://raider.io/api/raids/instance-rankings?difficulty=${encodeURIComponent(difficulty)}` +
        `&raid=${encodeURIComponent(raidSlug)}&region=${encodeURIComponent(raiderioRegion)}` +
        `&realm=all&page=0&faction=&recent=false&limit=0`;
      const rankResp = await fetch(rankingsUrl);
      if (!rankResp.ok) return res.status(200).json({ composition: null, sampleSize: 0, sampleOf: 0 });
      const rankData = await rankResp.json();
      const topGuilds = (rankData?.raidRankings?.rankedGuilds || []).slice(0, COMP_SAMPLE_SIZE);

      // One boss-kill lookup per sampled guild, in parallel -- a guild with
      // raidComps privacy off, or that simply hasn't killed this boss yet,
      // just contributes nothing rather than failing the whole batch.
      const rosters = await Promise.all(topGuilds.map(async g => {
        try {
          const url = `https://raider.io/api/v1/guilds/boss-kill?region=${encodeURIComponent(g.guild?.region?.slug || raiderioRegion)}` +
            `&realm=${encodeURIComponent(g.guild?.realm?.slug || '')}&guild=${encodeURIComponent(g.guild?.name || '')}` +
            `&raid=${encodeURIComponent(raidSlug)}&boss=${encodeURIComponent(bossSlug)}&difficulty=${encodeURIComponent(difficulty)}`;
          const r = await fetch(url);
          if (!r.ok) return null;
          const kill = await r.json();
          return Array.isArray(kill.roster) && kill.roster.length ? kill.roster : null;
        } catch (e) { return null; }
      }));

      const tally = { tank: 0, healer: 0, melee: 0, ranged: 0 };
      let sampleSize = 0;
      rosters.forEach(roster => {
        if (!roster) return;
        sampleSize++;
        roster.forEach(member => {
          const spec = member?.character?.spec;
          if (!spec) return;
          if (spec.role === 'tank') tally.tank++;
          else if (spec.role === 'healer') tally.healer++;
          else if (spec.role === 'dps' && spec.is_melee) tally.melee++;
          else if (spec.role === 'dps' && !spec.is_melee) tally.ranged++;
        });
      });

      const responseData = sampleSize > 0 ? {
        composition: {
          tank:   Math.round(tally.tank   / sampleSize),
          healer: Math.round(tally.healer / sampleSize),
          melee:  Math.round(tally.melee  / sampleSize),
          ranged: Math.round(tally.ranged / sampleSize),
        },
        sampleSize,
        sampleOf: topGuilds.length,
      } : { composition: null, sampleSize: 0, sampleOf: topGuilds.length };

      compositionCache.set(cacheKey, { data: responseData, fetchedAt: Date.now() });
      return res.status(200).json(responseData);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // Raider.io's own encounter-name slugging for expansion display names --
  // static-data has no expansion-level name field, only its raids, so this
  // is hand-maintained for the 3 most recent expansions (current + two
  // prior, for cross-expansion comparison). Verified live that expansion_id
  // decrements by exactly 1 per prior expansion (11=Midnight, 10=The War
  // Within, 9=Dragonflight, 8=Shadowlands). Update this when a new
  // expansion ships -- everything shifts by one automatically since it's
  // indexed by offset from whatever the current expansion_id resolves to,
  // not a hardcoded ID.
  const EXPANSION_NAMES = ['Midnight', 'The War Within', 'Dragonflight'];

  // Fallback for the discovery block below, used only when live discovery
  // fails (e.g. the instance-rankings outage that made the dropdown vanish
  // entirely). The raid *list* itself comes from static-data, which doesn't
  // depend on instance-rankings at all -- so as long as this ID is correct,
  // the dropdown keeps working through an instance-rankings outage. Keep in
  // sync with EXPANSION_NAMES[0] when a new expansion ships.
  const CURRENT_EXPANSION_ID_FALLBACK = 11; // Midnight, as of 2026-09

  // ── LIST RAIDS: every raid from the 3 most recent expansions, for the
  // raid-tier selector -- not filtered to what this guild has raided, so
  // older tiers are browsable as a world-wide comparison even if the guild
  // has no Raider.io history there. Names/boss counts/release dates come
  // from the lightweight static-data endpoint rather than looking each
  // tier up individually. ──
  if (action === 'listRaids') {
    const teamId = req.query.teamId || req.body?.teamId;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });

    try {
      await assertTeamMembership(supabase, session.id, teamId);

      // Raider.io's expansion_id for "the current expansion" is the same
      // for every team, so it's cached at module scope (mirrors roster.js's
      // WCL token cache) -- the one slow instance-rankings call needed to
      // discover it then only actually happens once per warm serverless
      // instance instead of on every listRaids request, from any team.
      let currentExpansionId;
      if (currentExpansionIdCache.id && Date.now() - currentExpansionIdCache.fetchedAt < EXPANSION_ID_CACHE_MS) {
        currentExpansionId = currentExpansionIdCache.id;
      } else {
        // Try live discovery first (self-updating -- no code change needed
        // when a new expansion ships), but never let it block the dropdown:
        // any failure (bad zone/slug, network error, or the instance-rankings
        // outage that used to take the whole dropdown down with it) falls
        // back to the hand-maintained constant above instead.
        let discovered = null;
        try {
          const { data: team } = await supabase
            .from('teams').select('id, zone_id, zone_name').eq('id', teamId).single();

          // Any known raid slug works to discover Raider.io's current
          // expansion_id -- use the team's own current raid (from its WCL zone).
          const zoneName = await ensureZoneName(supabase, team);
          const currentSlug = slugifyRaidName(zoneName);

          if (currentSlug) {
            // instance-rankings does a full (slow, ~250ms+) rankings
            // computation no matter how small `limit` is, so this is the one
            // slow/failure-prone call -- everything else (the actual raid
            // list) comes from the lightweight, more reliable static-data
            // endpoint (~10ms, no rankings computation).
            const metaResp = await fetch(
              `https://raider.io/api/raids/instance-rankings?difficulty=mythic&raid=${encodeURIComponent(currentSlug)}` +
              `&region=us&realm=all&page=0&faction=&recent=false&limit=1`
            );
            if (metaResp.ok) {
              const metaData = await metaResp.json();
              discovered = metaData?.raidRankings?.raid?.expansion_id || null;
            }
          }
        } catch (e) { /* fall through to the fallback constant below */ }

        currentExpansionId = discovered || CURRENT_EXPANSION_ID_FALLBACK;
        currentExpansionIdCache = { id: currentExpansionId, fetchedAt: Date.now() };
      }

      const expansionResults = await Promise.all(
        EXPANSION_NAMES.map(async (expansionName, offset) => {
          try {
            const r = await fetch(`https://raider.io/api/v1/raiding/static-data?expansion_id=${currentExpansionId - offset}`);
            if (!r.ok) return { expansionName, raids: [] };
            const j = await r.json();
            return { expansionName, raids: j.raids || [] };
          } catch (e) { return { expansionName, raids: [] }; }
        })
      );

      const raids = expansionResults.flatMap(({ expansionName, raids: expansionRaids }) =>
        expansionRaids
          .map(r => ({
            slug:        r.slug,
            name:        r.name,
            expansion:   expansionName,
            totalBosses: r.encounters?.length || null,
            starts:      r.starts?.us || null,
          }))
          .sort((a, b) => {
            // Most recently released tier first; a mini-raid/bonus encounter
            // often ships on the exact same date as that patch's main raid
            // (e.g. The Tidebound Grotto and The Venomous Abyss both started
            // 2026-08-18), so break same-date ties by boss count -- the
            // bigger raid is reliably the "main" one of the two.
            const dateDiff = new Date(b.starts || 0) - new Date(a.starts || 0);
            return dateDiff !== 0 ? dateDiff : (b.totalBosses || 0) - (a.totalBosses || 0);
          })
      );

      return res.status(200).json({ raids });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'Invalid action' });
};
