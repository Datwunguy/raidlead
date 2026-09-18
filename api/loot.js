// ============================================================
//  loot.js — handles loot-tracking actions
//  Actions: import, get, reassign, delete, deleteSession,
//           getTierChecks, setTierCheck, resetTierChecks, resolveCharacterIds
//
//  `import` is append-only -- there is no update/delete path reachable
//  through it, even though it only needs a normal team-member session (the
//  browser reads the addon's SavedVariables file directly via the File
//  System Access API and posts here as itself; there's no separate
//  companion-app credential to worry about). Every other action requires
//  Officer/Owner, exactly like the rest of this codebase's officer-gated
//  actions (see plans.js, members.js). This split is deliberate: anything
//  that changes recorded history (a trade, or cleaning up a non-guild run)
//  stays an Officer/Owner action -- see the "Guild run vs. pug run" note on
//  session_id/likely_pug.
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('../lib/session');
const { assertTeamMembership } = require('../lib/teamAuth');

// Resolves a batch of character names to { name -> id } for one team, best-effort --
// a name with no match (e.g. a brand new alt) simply has no entry, and callers
// keep the raw name for display rather than failing the whole import.
async function resolveCharacterIds(supabase, teamId, names) {
  const uniqueNames = [...new Set(names.filter(Boolean))];
  if (uniqueNames.length === 0) return {};
  const { data: chars } = await supabase
    .from('characters')
    .select('id, name')
    .eq('team_id', teamId)
    .in('name', uniqueNames);
  const map = {};
  (chars || []).forEach(c => { if (!(c.name in map)) map[c.name] = c.id; });
  return map;
}

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
    const reportedBy = importSession.id;

    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    if (records.length === 0) return res.status(400).json({ error: 'records array required' });

    try {
      const nameMap = await resolveCharacterIds(supabase, teamId, records.map(r => r.recipientName));

      const rows = records
        .filter(r => r.addonRecordId && r.itemId && r.recipientName && r.sessionId)
        .map(r => ({
          team_id:                     teamId,
          raid_date:                   r.raidDate || null,
          encounter_id:                r.encounterId ?? null,
          boss_name:                   r.bossName || null,
          difficulty:                  r.difficulty || null,
          item_id:                     r.itemId,
          item_name:                   r.itemName || null,
          is_tier_token:               !!r.isTierToken,
          is_boe:                      !!r.isBoe,
          item_quality_track:          r.qualityTrack || null,
          upgrade_level:               r.upgradeLevel ?? null,
          upgrade_level_max:           r.upgradeLevelMax ?? null,
          item_slot:                   r.itemSlot || null,
          armor_type:                  r.armorType || null,
          loot_method:                 r.lootMethod || 'personal',
          roll_type:                   r.rollType || null,
          roll_value:                  r.rollValue ?? null,
          roll_participants:           r.rollParticipants || null,
          recipient_name:              r.recipientName,
          recipient_character_id:      nameMap[r.recipientName] || null,
          current_holder_name:         r.recipientName,
          current_holder_character_id: nameMap[r.recipientName] || null,
          session_id:                  r.sessionId,
          likely_pug:                  !!r.likelyPug,
          addon_record_id:             r.addonRecordId,
          reported_by_account_id:      reportedBy,
        }));

      if (rows.length === 0) return res.status(400).json({ error: 'No valid records in payload' });

      // The addon's own local SavedVariables store keeps every record it's
      // ever captured (pruned only after 45 days) and has no idea an officer
      // later deleted one server-side -- it just re-exports the same
      // addon_record_id again next sync. ignoreDuplicates only protects
      // against re-uploading a record that's STILL there; once deleted,
      // there's no row left to conflict with, so it would otherwise silently
      // reinsert. This tombstone check is what makes a delete actually stick.
      const { data: tombstones } = await supabase
        .from('loot_deleted_records')
        .select('addon_record_id')
        .eq('team_id', teamId)
        .in('addon_record_id', rows.map(r => r.addon_record_id));
      const deletedIds = new Set((tombstones || []).map(t => t.addon_record_id));
      const liveRows = rows.filter(r => !deletedIds.has(r.addon_record_id));

      if (liveRows.length === 0) return res.status(200).json({ success: true, imported: 0 });

      // ignoreDuplicates -- a record that's already been uploaded is a silent no-op,
      // never an update, so a re-sent record can't stomp an officer's later reassign.
      const { error } = await supabase
        .from('loot_drops')
        .upsert(liveRows, { onConflict: 'team_id,addon_record_id', ignoreDuplicates: true });
      if (error) throw error;

      return res.status(200).json({ success: true, imported: liveRows.length });
    } catch (err) {
      console.error('[loot import] error:', err.message);
      return res.status(500).json({ error: err.message });
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
