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

  if (action === 'progress' || req.method === 'GET') {
    const teamId     = req.query.teamId || req.body?.teamId;
    const difficulty = (req.query.difficulty || req.body?.difficulty || 'mythic').toLowerCase();
    if (!teamId) return res.status(400).json({ error: 'teamId required' });
    if (!VALID_DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: 'Invalid difficulty' });

    try {
      await assertTeamMembership(supabase, session.id, teamId);

      const { data: team } = await supabase
        .from('teams').select('id, zone_id, zone_name, guilds ( name, server, region )').eq('id', teamId).single();

      const zoneName = await ensureZoneName(supabase, team);
      const raidSlug = slugifyRaidName(zoneName);
      if (!raidSlug) {
        return res.status(200).json({ configured: false, reason: 'NO_ZONE' });
      }
      const region = team.guilds?.region || 'us';

      const rankingsUrl = `https://raider.io/api/raids/instance-rankings?difficulty=${encodeURIComponent(difficulty)}` +
        `&raid=${encodeURIComponent(raidSlug)}&region=${encodeURIComponent(region)}` +
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
        const region_    = encodeURIComponent(region);
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
                // (separate from the per-boss ranks below).
                regionRank:  rank?.region || null,
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
        yourRegionRank: bossRankBySlug[enc.slug]?.region ?? null,
      }));

      return res.status(200).json({
        configured: true,
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

  res.status(400).json({ error: 'Invalid action' });
};
