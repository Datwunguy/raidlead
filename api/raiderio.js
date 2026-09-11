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
//  All are public data with no auth of their own; proxied server-side
//  only to avoid depending on Raider.io's CORS policy.
//
//  Action: progress (teamId, difficulty)
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('./lib/session');
const { assertTeamMembership } = require('./lib/teamAuth');
const { ensureZoneName } = require('./lib/wclZone');

const VALID_DIFFICULTIES = ['normal', 'heroic', 'mythic'];

// "Oceanic" is a RaidLead-only region choice -- Blizzard/WCL's realm-region
// system has no such thing, Oceanic realms are still part of the "us" region
// there. It only matters for the Progress tab's world-wide rankings pool:
// Raider.io's "us" rankings bucket is actually a combined "United States &
// Oceania" pool, while its separate "americas" bucket is US/Canada only,
// excluding Oceania. A RaidLead guild configured as plain "US" gets a more
// precise comparison pool by querying "americas". Raider.io does also offer
// a genuine Oceania-only "region=oceanic" pool, but per product decision
// "Oceanic" here intentionally uses the combined "us" bucket instead (the
// same pool "US" used before this option existed), not the narrower one.
function toRankingsRegion(region) {
  if (region === 'us') return 'americas';
  if (region === 'oceanic') return 'us';
  return region;
}

// For anything realm-scoped (a specific guild's profile or per-boss rank) --
// unlike the rankings pool above, these need the real Raider.io/Blizzard
// realm-region a guild's realm actually belongs to, which "oceanic" isn't.
function toRealmRegion(region) {
  return region === 'oceanic' ? 'us' : region;
}

// /api/guilds/raid-rankings (the per-boss lookup) only ever accepts a real
// realm-region ("us"), never "americas" -- but its response carries BOTH a
// "region" rank (scoped to that combined us+oceania bucket) and a narrower
// "subregion" rank that lines up with the "americas" pool used above
// (verified: subregion values track the americas-pool guild counts closely,
// while "region" tracks the larger combined-us counts and can legitimately
// exceed the americas guild count shown alongside it -- a guild ranked 601st
// out of a 629-guild pool looks like nonsense next to "565 guilds have
// killed this boss" if that 565 came from the smaller americas pool). Pick
// whichever field actually matches the pool toRankingsRegion() queried.
function bossRankFieldFor(region) {
  return region === 'us' ? 'subregion' : 'region';
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
      const requestedSlug = req.query.raidSlug || req.body?.raidSlug || null;
      let raidSlug = requestedSlug;
      if (!raidSlug) {
        const zoneName = await ensureZoneName(supabase, team);
        raidSlug = slugifyRaidName(zoneName);
      }
      if (!raidSlug) {
        return res.status(200).json({ configured: false, reason: 'NO_ZONE' });
      }
      const region = team.guilds?.region || 'us'; // literal team selection, used for display + realm-scoped lookups below

      const rankingsUrl = `https://raider.io/api/raids/instance-rankings?difficulty=${encodeURIComponent(difficulty)}` +
        `&raid=${encodeURIComponent(raidSlug)}&region=${encodeURIComponent(toRankingsRegion(region))}` +
        `&realm=all&page=0&faction=&recent=false&limit=0`;

      const resp = await fetch(rankingsUrl);
      if (!resp.ok) {
        return res.status(200).json({ configured: false, reason: 'RAID_NOT_FOUND', zoneName });
      }
      const data = await resp.json();
      const rr = data.raidRankings;
      if (!rr || !rr.raid) {
        return res.status(200).json({ configured: false, reason: 'RAID_NOT_FOUND', zoneName });
      }

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
      let yourGuild = null;
      let bossRankBySlug = {};
      if (team.guilds?.name && team.guilds?.server) {
        const region_    = encodeURIComponent(toRealmRegion(region));
        const realm_     = encodeURIComponent(team.guilds.server);
        const guildName_ = encodeURIComponent(team.guilds.name);

        try {
          const profResp = await fetch(
            `https://raider.io/api/v1/guilds/profile?region=${region_}&realm=${realm_}&name=${guildName_}&fields=raid_progression,raid_rankings`
          );
          if (profResp.ok) {
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
                // (separate from the per-boss ranks below). Raider.io only publishes
                // this against the combined us+oceania bucket -- no americas-scoped
                // equivalent exists, so when the boss list below is using the
                // narrower americas pool, this is a genuinely bigger/different pool
                // than that list. regionRankIsBroaderPool tells the frontend to
                // label it accordingly instead of implying they match.
                regionRank:  rank?.region || null,
                regionRankIsBroaderPool: region === 'us',
                worldRank:   rank?.world || null,
              };
            }
          }
        } catch (e) { /* Your Guild is a nice-to-have -- world data above still renders without it */ }

        try {
          const bossRankResp = await fetch(
            `https://raider.io/api/guilds/raid-rankings?raid=${encodeURIComponent(raidSlug)}&difficulty=${encodeURIComponent(difficulty)}` +
            `&region=${region_}&realm=${realm_}&guild=${guildName_}`
          );
          if (bossRankResp.ok) {
            const bossRankData = await bossRankResp.json();
            (bossRankData?.bossRankings || []).forEach(b => {
              if (b.boss && b.ranks) bossRankBySlug[b.boss] = b.ranks;
            });
          }
        } catch (e) { /* per-boss rank is a nice-to-have -- world data above still renders without it */ }
      }

      const bosses = encounters.map((enc, i) => ({
        name:           enc.name,
        slug:           enc.slug,
        iconUrl:        enc.iconUrl ? `https://cdn.raiderio.net${enc.iconUrl}` : null,
        guildsDefeated: atLeastByProgress[i + 1] || 0,
        // Only meaningful once this boss is actually killed -- Raider.io also
        // returns entries for bosses that are merely attempted (best pull %),
        // which isn't a kill rank. The frontend gates display on youKilled.
        yourRegionRank: bossRankBySlug[enc.slug]?.[bossRankFieldFor(region)] ?? null,
      }));

      return res.status(200).json({
        configured: true,
        raidSlug,
        raidName:   rr.raid.name || null,
        difficulty,
        region,
        bosses,
        yourGuild,
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── LIST RAIDS: every raid tier Raider.io has progression data for on this
  // guild (their raid_progression keys), for the raid-tier selector. Names/
  // boss counts/release dates come from the lightweight static-data
  // endpoint (see below) rather than looking each tier up individually. ──
  if (action === 'listRaids') {
    const teamId = req.query.teamId || req.body?.teamId;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });

    try {
      await assertTeamMembership(supabase, session.id, teamId);

      const { data: team } = await supabase
        .from('teams').select('guilds ( name, server, region )').eq('id', teamId).single();
      if (!team?.guilds?.name || !team?.guilds?.server) {
        return res.status(200).json({ raids: [] });
      }

      const region_    = encodeURIComponent(toRealmRegion(team.guilds.region || 'us'));
      const realm_     = encodeURIComponent(team.guilds.server);
      const guildName_ = encodeURIComponent(team.guilds.name);

      const profResp = await fetch(
        `https://raider.io/api/v1/guilds/profile?region=${region_}&realm=${realm_}&name=${guildName_}&fields=raid_progression`
      );
      if (!profResp.ok) return res.status(200).json({ raids: [] });
      const profile = await profResp.json();
      const slugs = Object.keys(profile?.raid_progression || {});
      if (slugs.length === 0) return res.status(200).json({ raids: [] });

      // Bare-slug fallback if either lookup below fails -- still usable,
      // just without a friendly name or release-date sort.
      const fallbackRaids = slugs.map(slug => ({ slug, name: slug, totalBosses: null }));

      // instance-rankings does a full (slow, ~250ms+) rankings computation
      // no matter how small `limit` is, so calling it once per tier just to
      // read a name doesn't scale. Instead, call it ONCE for any one of the
      // guild's known slugs purely to read Raider.io's expansion_id, then
      // use that to pull the full tier list (name, boss count, real release
      // date) from the lightweight static-data endpoint in a single ~10ms
      // request that doesn't touch rankings computation at all.
      const metaResp = await fetch(
        `https://raider.io/api/raids/instance-rankings?difficulty=mythic&raid=${encodeURIComponent(slugs[slugs.length - 1])}` +
        `&region=us&realm=all&page=0&faction=&recent=false&limit=1`
      );
      if (!metaResp.ok) return res.status(200).json({ raids: fallbackRaids });
      const metaData = await metaResp.json();
      const expansionId = metaData?.raidRankings?.raid?.expansion_id;
      if (!expansionId) return res.status(200).json({ raids: fallbackRaids });

      const staticResp = await fetch(`https://raider.io/api/v1/raiding/static-data?expansion_id=${expansionId}`);
      if (!staticResp.ok) return res.status(200).json({ raids: fallbackRaids });
      const staticData = await staticResp.json();
      const bySlug = {};
      (staticData.raids || []).forEach(r => { bySlug[r.slug] = r; });

      const raids = slugs
        .map(slug => {
          const meta = bySlug[slug];
          return {
            slug,
            name:        meta?.name || slug,
            totalBosses: meta?.encounters?.length || null,
            starts:      meta?.starts?.us || null,
          };
        })
        .sort((a, b) => {
          // Most recently released tier first; a mini-raid/bonus encounter
          // often ships on the exact same date as that patch's main raid
          // (e.g. The Tidebound Grotto and The Venomous Abyss both started
          // 2026-08-18), so break same-date ties by boss count -- the
          // bigger raid is reliably the "main" one of the two.
          const dateDiff = new Date(b.starts || 0) - new Date(a.starts || 0);
          return dateDiff !== 0 ? dateDiff : (b.totalBosses || 0) - (a.totalBosses || 0);
        });

      return res.status(200).json({ raids });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'Invalid action' });
};
