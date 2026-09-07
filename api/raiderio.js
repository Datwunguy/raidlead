// ============================================================
//  raiderio.js — proxies Raider.io's raid rankings data for the
//  Progress tab (world-wide boss kill counts, by difficulty + region).
//
//  Raider.io doesn't publish this as a documented public API, so this
//  hits the same endpoint their own site's front-end uses. It's public,
//  unauthenticated data (visible to any anonymous visitor on raider.io) --
//  proxied server-side purely to avoid depending on their CORS policy,
//  not because it's sensitive.
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
        .from('teams').select('raiderio_raid_slug, guilds ( region )').eq('id', teamId).single();
      if (!team?.raiderio_raid_slug) {
        return res.status(200).json({ configured: false });
      }
      const region = team.guilds?.region || 'us';

      const url = `https://raider.io/api/raids/instance-rankings?difficulty=${encodeURIComponent(difficulty)}` +
        `&raid=${encodeURIComponent(team.raiderio_raid_slug)}&region=${encodeURIComponent(region)}` +
        `&realm=all&page=0&faction=&recent=false&limit=0`;

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Raider.io returned ${resp.status} -- the raid URL in Guild Settings may be wrong.`);
      const data = await resp.json();
      const rr = data.raidRankings;
      if (!rr || !rr.raid) throw new Error('Unexpected response from Raider.io -- check the raid URL in Guild Settings.');

      const encounters = (rr.raid.encounters || []).slice().sort((a, b) => a.ordinal - b.ordinal);
      const timelineByProgress = {};
      (rr.timeline || []).forEach(t => { timelineByProgress[t.progress] = t; });

      const bosses = encounters.map((enc, i) => {
        const t = timelineByProgress[i + 1];
        return {
          name:           enc.name,
          slug:           enc.slug,
          iconUrl:        enc.iconUrl ? `https://cdn.raiderio.net${enc.iconUrl}` : null,
          guildsDefeated: t?.totalGuilds || 0,
        };
      });

      return res.status(200).json({
        configured: true,
        raidName:   rr.raid.name || null,
        difficulty,
        region,
        bosses,
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'Invalid action' });
};
