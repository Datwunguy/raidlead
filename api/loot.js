// ============================================================
//  loot.js — handles loot-tracking actions
//  Actions: import, get, reassign, delete, deleteSession,
//           getTierChecks, setTierCheck, resetTierChecks, resolveCharacterIds
//
//  `import` is append-only -- there is no update/delete path reachable
//  through it, even though it only needs a normal team-member session. This
//  is now a legacy path: it was originally how the browser (reading the
//  addon's SavedVariables via the File System Access API) uploaded loot on
//  the addon's behalf. The Companion app now uploads directly via its own
//  credential -- see api/companion.js's `uploadLoot` action and
//  lib/lootImport.js, which both this action and that one call into, so
//  there's one implementation of the actual insert/tombstone logic. Kept
//  live as a manual-import fallback rather than deleted outright.
//  Every other action requires Officer/Owner, exactly like the rest of this
//  codebase's officer-gated actions (see plans.js, members.js). This split
//  is deliberate: anything that changes recorded history (a trade, or
//  cleaning up a non-guild run) stays an Officer/Owner action -- see the
//  "Guild run vs. pug run" note on session_id/likely_pug.
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('../lib/session');
const { assertTeamMembership } = require('../lib/teamAuth');
const { resolveCharacterIds, importLootRecords } = require('../lib/lootImport');

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── IMPORT: append-only, any team member (whoever's running the addon that raid). ──
  if (action === 'import') {
    const importSession = getSession(req);
    if (!importSession) return res.status(401).json({ error: 'Not authenticated' });
    const teamId = req.body?.teamId;
    try { await assertTeamMembership(supabase, importSession.id, teamId); }
    catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

    try {
      const { imported } = await importLootRecords(supabase, {
        teamId, records: req.body?.records, reportedByAccountId: importSession.id,
      });
      return res.status(200).json({ success: true, imported });
    } catch (err) {
      console.error('[loot import] error:', err.message);
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── Every action below requires a real team session ──
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  // ── GET: loot history for a team (any team member) ──
  // `!action && req.method === 'GET'` (not just `req.method === 'GET'`) --
  // that broader check was silently swallowing every OTHER GET-based action
  // below (getTierChecks included), since a plain fetch() defaults to GET
  // regardless of the actual `action` param. Writes (setTierCheck, a POST)
  // were never affected -- only reads were ever hijacked into returning the
  // loot list instead, which is exactly why checked state looked like it
  // never persisted even though it was being saved correctly the whole time.
  if (action === 'get' || (!action && req.method === 'GET')) {
    const teamId = req.query.teamId || req.body?.teamId;
    try {
      await assertTeamMembership(supabase, session.id, teamId);

      const { data: drops, error } = await supabase
        .from('loot_drops')
        .select('*')
        .eq('team_id', teamId)
        .order('created_at', { ascending: false });
      if (error) throw error;

      return res.status(200).json({ drops: drops || [] });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── REASSIGN: move current_holder after a trade (Officer/Owner only) ──
  if (action === 'reassign') {
    const { teamId, lootId, newHolderName } = req.body || {};
    if (!teamId || !lootId || !newHolderName) {
      return res.status(400).json({ error: 'teamId, lootId and newHolderName required' });
    }
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      const nameMap = await resolveCharacterIds(supabase, teamId, [newHolderName]);
      const { data, error } = await supabase
        .from('loot_drops')
        .update({
          current_holder_name:         newHolderName,
          current_holder_character_id: nameMap[newHolderName] || null,
        })
        .eq('id', lootId)
        .eq('team_id', teamId)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Loot record not found for this team' });

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── SET BIND TYPE: manual correction for the addon's auto-detected
  // bind_type (Officer/Owner only). Exists because GetItemInfo's bindType
  // can't reliably tell "Warbound Until Equipped" apart from plain BoE for
  // another player's loot -- confirmed live against an actual item whose
  // in-game tooltip disagreed with what the addon captured. "BoE" also
  // flips is_boe so the item moves into the BoEs sub-tab; "Warbound" clears
  // it back out. ──
  if (action === 'setBindType') {
    const { teamId, lootId, bindType } = req.body || {};
    const ALLOWED = { BoE: true, 'Warbound Until Equipped': true };
    if (!teamId || !lootId || !ALLOWED[bindType]) {
      return res.status(400).json({ error: 'teamId, lootId, and a valid bindType are required' });
    }
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      const { data, error } = await supabase
        .from('loot_drops')
        .update({ bind_type: bindType, is_boe: bindType === 'BoE' })
        .eq('id', lootId)
        .eq('team_id', teamId)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Loot record not found for this team' });

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── DELETE: remove one loot record (Officer/Owner only). Also tombstones its
  // addon_record_id so the addon's own local copy (which has no idea this
  // happened) can't silently re-upload it on the next sync. ──
  if (action === 'delete') {
    const { teamId, lootId } = req.body || {};
    if (!teamId || !lootId) return res.status(400).json({ error: 'teamId and lootId required' });
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      const { data, error } = await supabase
        .from('loot_drops')
        .delete()
        .eq('id', lootId)
        .eq('team_id', teamId)
        .select('addon_record_id')
        .maybeSingle();
      if (error) throw error;

      if (data?.addon_record_id) {
        await supabase.from('loot_deleted_records')
          .upsert({ team_id: teamId, addon_record_id: data.addon_record_id }, { onConflict: 'team_id,addon_record_id' });
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── DELETE SESSION: remove every loot record from one run at once (Officer/Owner only).
  // Same tombstoning as delete above, for every row in the session. ──
  if (action === 'deleteSession') {
    const { teamId, sessionId } = req.body || {};
    if (!teamId || !sessionId) return res.status(400).json({ error: 'teamId and sessionId required' });
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      const { data, error } = await supabase
        .from('loot_drops')
        .delete()
        .eq('team_id', teamId)
        .eq('session_id', sessionId)
        .select('addon_record_id');
      if (error) throw error;

      const tombstones = (data || [])
        .filter(r => r.addon_record_id)
        .map(r => ({ team_id: teamId, addon_record_id: r.addon_record_id }));
      if (tombstones.length > 0) {
        await supabase.from('loot_deleted_records').upsert(tombstones, { onConflict: 'team_id,addon_record_id' });
      }

      return res.status(200).json({ success: true, deleted: data?.length || 0 });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── GET TIER CHECKS: manual per-character "has their tier token" checklist
  // (any team member can view; who's allowed to check it off is enforced by
  // requireOfficer on setTierCheck/resetTierChecks below, not here) ──
  if (action === 'getTierChecks') {
    const teamId = req.query.teamId || req.body?.teamId;
    try {
      await assertTeamMembership(supabase, session.id, teamId);

      const { data, error } = await supabase
        .from('tier_token_checks')
        .select('character_id')
        .eq('team_id', teamId);
      if (error) throw error;

      return res.status(200).json({ checkedCharacterIds: (data || []).map(r => r.character_id) });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── SET TIER CHECK: toggle one character's manual checkbox (Officer/Owner only).
  // A row's presence IS the checked state -- checking inserts it, unchecking
  // deletes it, so there's no separate boolean to fall out of sync. ──
  if (action === 'setTierCheck') {
    const { teamId, characterId, checked } = req.body || {};
    if (!teamId || !characterId) return res.status(400).json({ error: 'teamId and characterId required' });
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      if (checked) {
        const { error } = await supabase
          .from('tier_token_checks')
          .upsert({ team_id: teamId, character_id: characterId, checked_by_account_id: session.id, checked_at: new Date().toISOString() },
            { onConflict: 'team_id,character_id' });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('tier_token_checks')
          .delete()
          .eq('team_id', teamId)
          .eq('character_id', characterId);
        if (error) throw error;
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── RESET TIER CHECKS: clear the whole team's checklist at once, for the
  // start of a new tier (Officer/Owner only) ──
  if (action === 'resetTierChecks') {
    const { teamId } = req.body || {};
    if (!teamId) return res.status(400).json({ error: 'teamId required' });
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      const { error } = await supabase.from('tier_token_checks').delete().eq('team_id', teamId);
      if (error) throw error;

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── RESOLVE CHARACTER IDS: name -> character_id lookup for a batch of names
  // (any team member). Used by the Tier Token checklist to tie the live
  // WowAudit-sourced roster (STATE.players, which has no DB id of its own)
  // to stable character_id values for persistence. ──
  if (action === 'resolveCharacterIds') {
    const { teamId, names } = req.body || {};
    if (!teamId || !Array.isArray(names)) return res.status(400).json({ error: 'teamId and names[] required' });
    try {
      await assertTeamMembership(supabase, session.id, teamId);
      const ids = await resolveCharacterIds(supabase, teamId, names);
      return res.status(200).json({ ids });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'Invalid action' });
};
