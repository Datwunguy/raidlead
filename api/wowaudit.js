// ============================================================
//  wowaudit.js — pulls a team's roster from WowAudit's real API, on demand
//  (officers click "Import from WowAudit" on the Roster tab; nothing here
//  runs automatically). This is a convenience for populating `characters`
//  -- the app's actual source of truth for the roster -- not a live mirror:
//  officers can freely add/edit/remove characters by hand afterward (see
//  api/roster.js's addCharacter/updateCharacter/removeCharacter) and a
//  later import will not touch anyone whose name it doesn't recognize.
//
//  WowAudit's API (confirmed live, 2026-09-15 -- their interactive docs at
//  wowaudit.com/api are login-gated so this was verified by direct request,
//  not from written documentation):
//   - Auth: `Authorization: Bearer <team API key>` (one full-access key per
//     WowAudit team, from that team's Settings > API page).
//   - GET /v1/characters -> array of { name, realm, class, role, rank,
//     status, blizzard_id, ... }. `class`/`role` are Title Case and map
//     directly onto this app's internal lowercase vocabulary with a plain
//     .toLowerCase() -- no further transform needed.
//   - `game_data` is present in the schema but empty on every character
//     even right after a Blizzard sync -- WowAudit's API does not expose
//     item level. That's why ilvl is sourced live from Raider.io instead,
//     in api/roster.js's `list` action, never from here.
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('../lib/session');
const { decrypt } = require('../lib/crypto');
const { assertTeamMembership } = require('../lib/teamAuth');
const { slugifyServer } = require('../lib/serverSlug');

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── IMPORT: fetch this team's roster from WowAudit and merge it into
  // `characters` (officers only) ──
  if (action === 'import') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const teamId = req.body?.teamId;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });

    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      const { data: team } = await supabase
        .from('teams').select('wowaudit_api_key_enc').eq('id', teamId).single();
      if (!team?.wowaudit_api_key_enc) {
        return res.status(400).json({ error: "This team hasn't connected a WowAudit API key yet. Add one in Guild Settings.", wowauditNotConfigured: true });
      }

      let apiKey;
      try {
        apiKey = decrypt(team.wowaudit_api_key_enc);
      } catch (e) {
        return res.status(500).json({ error: 'Could not decrypt the stored WowAudit API key -- try re-entering it in Guild Settings.' });
      }

      const resp = await fetch('https://wowaudit.com/v1/characters', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) {
        const reason = resp.status === 401 || resp.status === 403
          ? 'That WowAudit API key was rejected -- check it in Guild Settings.'
          : `WowAudit returned an error (${resp.status}) -- try again shortly.`;
        return res.status(502).json({ error: reason });
      }

      const raw = await resp.json();
      if (!Array.isArray(raw)) {
        return res.status(502).json({ error: "WowAudit's response didn't look like a character list -- try again shortly." });
      }

      const players = raw.map(c => ({
        name:         c.name,
        class:        (c.class || 'unknown').toLowerCase(),
        server:       slugifyServer(c.realm),
        primary_role: (c.role || 'ranged').toLowerCase(),
        rank:         c.rank || 'Main',
      })).filter(p => p.name);

      // Merge into `characters`, preserving account_id (claims) and officer-
      // set flex flags for anyone already on the roster -- same
      // preserve-on-conflict logic the old spreadsheet sync used.
      const { data: existing } = await supabase
        .from('characters')
        .select('name, account_id, flex_tank, flex_heal, flex_melee, flex_ranged, can_flex_tank, can_flex_heal, can_flex_melee, can_flex_ranged')
        .eq('team_id', teamId);
      const existingMap = {};
      (existing || []).forEach(c => { existingMap[c.name.toLowerCase()] = c; });

      const upsertData = players.map(p => {
        const ex = existingMap[p.name.toLowerCase()];
        return {
          team_id:         teamId,
          name:            p.name,
          class:           p.class,
          server:          p.server,
          primary_role:    p.primary_role,
          rank:            p.rank,
          active:          true,
          account_id:      ex?.account_id || null,
          flex_tank:       ex?.flex_tank       || false,
          flex_heal:       ex?.flex_heal       || false,
          flex_melee:      ex?.flex_melee      || false,
          flex_ranged:     ex?.flex_ranged     || false,
          can_flex_tank:   ex?.can_flex_tank   || false,
          can_flex_heal:   ex?.can_flex_heal   || false,
          can_flex_melee:  ex?.can_flex_melee  || false,
          can_flex_ranged: ex?.can_flex_ranged || false,
        };
      });

      if (upsertData.length) {
        const { error } = await supabase
          .from('characters')
          .upsert(upsertData, { onConflict: 'team_id,name', ignoreDuplicates: false });
        if (error) throw error;
      }

      return res.status(200).json({ success: true, imported: upsertData.length });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  res.status(400).json({ error: 'Invalid action' });
};
