// ============================================================
//  raiderio.js — proxies Raider.io data for the Progress tab
//  (world-wide boss kill counts, by difficulty + region, plus this
//  guild's own progress).
//
//  Two Raider.io endpoints are used:
//   - /api/raids/instance-rankings -- undocumented but public/unauthenticated,
//     the same one their own rankings pages call. Its "timeline" is a
//     per-milestone HISTOGRAM: timeline[i].totalGuilds is the count of
//     guilds whose CURRENT furthest kill is exactly i bosses, not a
//     cumulative "at least i" count. To get "guilds who have killed boss
//     i" we sum totalGuilds from i up through the last boss (any guild
//     sitting further along has necessarily also killed boss i).
//   - /api/v1/guilds/profile -- Raider.io's documented public API,
//     queried by region/realm/guild name (all already in Guild
//     Configuration) for this guild's own raid_progression.
//  Both are public data with no auth of their own; proxied server-side
//  only to avoid depending on Raider.io's CORS policy.
//
//  Action: progress (teamId, difficulty)
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('./lib/session');
const { assertTeamMembership } = require('./lib/teamAuth');

const VALID_DIFFICULTIES = ['normal', 'heroic', 'mythic'];

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
        .from('teams').select('raiderio_raid_slug, guilds ( name, server, region )').eq('id', teamId).single();
      if (!team?.raiderio_raid_slug) {
        return res.status(200).json({ configured: false });
      }
      const region     = team.guilds?.region || 'us';
      const raidSlug   = team.raiderio_raid_slug;

      const rankingsUrl = `https://raider.io/api/raids/instance-rankings?difficulty=${encodeURIComponent(difficulty)}` +
        `&raid=${encodeURIComponent(raidSlug)}&region=${encodeURIComponent(region)}` +
        `&realm=all&page=0&faction=&recent=false&limit=0`;

      const resp = await fetch(rankingsUrl);
      if (!resp.ok) throw new Error(`Raider.io returned ${resp.status} -- the raid URL in Guild Settings may be wrong.`);
      const data = await resp.json();
      const rr = data.raidRankings;
      if (!rr || !rr.raid) throw new Error('Unexpected response from Raider.io -- check the raid URL in Guild Settings.');

      const encounters = (rr.raid.encounters || []).slice().sort((a, b) => a.ordinal - b.ordinal);
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

      const bosses = encounters.map((enc, i) => ({
        name:           enc.name,
        slug:           enc.slug,
        iconUrl:        enc.iconUrl ? `https://cdn.raiderio.net${enc.iconUrl}` : null,
        guildsDefeated: atLeastByProgress[i + 1] || 0,
      }));

      // This guild's own progress, straight from Raider.io's guild profile --
      // no manual entry, it's whatever Raider.io has last crawled for them.
      let yourGuild = null;
      if (team.guilds?.name && team.guilds?.server) {
        try {
          const profileUrl = `https://raider.io/api/v1/guilds/profile?region=${encodeURIComponent(region)}` +
            `&realm=${encodeURIComponent(team.guilds.server)}&name=${encodeURIComponent(team.guilds.name)}` +
            `&fields=raid_progression`;
          const profResp = await fetch(profileUrl);
          if (profResp.ok) {
            const profile = await profResp.json();
            const prog = profile?.raid_progression?.[raidSlug];
            if (prog) {
              const killedKey = `${difficulty}_bosses_killed`;
              yourGuild = {
                killed:      prog[killedKey] ?? 0,
                totalBosses: prog.total_bosses ?? maxProgress,
                summary:     prog.summary || null,
              };
            }
          }
        } catch (e) { /* Your Guild is a nice-to-have -- world data above still renders without it */ }
      }

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
