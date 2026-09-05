// ============================================================
//  members.js — handles member actions
//  Actions: get, updateRole, updateDisplayName, claimCharacter, removeMember
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('./lib/session');

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Resolve the caller's guild membership once — used by every action below
  const { data: myMembership } = await supabase
    .from('guild_members')
    .select('role, guild_id')
    .eq('account_id', session.id)
    .single();

  if (!myMembership) return res.status(404).json({ error: 'Not a guild member' });

  const isOfficer = ['owner', 'officer'].includes(myMembership.role);
  const isOwner   = myMembership.role === 'owner';
  const myGuildId = myMembership.guild_id;

  // ── GET: return all members ──
  if (action === 'get' || req.method === 'GET') {
    try {
      const { data: members, error } = await supabase
        .from('guild_members')
        .select(`role, account_id, accounts ( id, battletag, display_name, last_login )`)
        .eq('guild_id', myGuildId);
      if (error) throw error;

      const { data: teams } = await supabase.from('teams').select('id').eq('guild_id', myGuildId).limit(1);
      const teamId = teams?.[0]?.id || null;
      let characterMap = {};
      if (teamId) {
        const accountIds = members.map(m => m.account_id).filter(Boolean);
        const { data: chars } = await supabase
          .from('characters')
          .select('name, class, primary_role, account_id')
          .eq('team_id', teamId)
          .not('account_id', 'is', null);
        (chars || []).forEach(c => { if (!characterMap[c.account_id]) characterMap[c.account_id] = []; characterMap[c.account_id].push(c); });
      }

      const enriched = (members || []).map(m => ({ ...m, characters: characterMap[m.account_id] || [] }));
      return res.status(200).json({ members: enriched, myRole: myMembership.role });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── UPDATE ROLE ──
  if (action === 'updateRole') {
    if (!isOfficer) return res.status(403).json({ error: 'Officers only' });

    const { targetAccountId, role } = req.body;
    if (!targetAccountId || !role) return res.status(400).json({ error: 'targetAccountId and role required' });

    // Only owners can assign officer/owner roles
    if (['officer', 'owner'].includes(role) && !isOwner) return res.status(403).json({ error: 'Owners only for this role' });

    // Prevent owner from removing their own owner status without a transfer
    if (targetAccountId === session.id && isOwner) {
      return res.status(400).json({ error: 'Use the transfer ownership action to change your own role' });
    }

    try {
      await supabase
        .from('guild_members')
        .update({ role })
        .eq('account_id', targetAccountId)
        .eq('guild_id', myGuildId);       // scope to caller's guild
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── UPDATE DISPLAY NAME ──
  if (action === 'updateDisplayName') {
    const { displayName } = req.body;
    if (!displayName?.trim()) return res.status(400).json({ error: 'Display name required' });
    try {
      await supabase.from('accounts').update({ display_name: displayName.trim() }).eq('id', session.id);
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── CLAIM CHARACTER ──
  if (action === 'claimCharacter') {
    const { characterName, teamId, targetAccountId, characterClass, characterServer, characterRole } = req.body;
    if (!characterName || !teamId) return res.status(400).json({ error: 'characterName and teamId required' });

    // Verify the teamId belongs to the caller's guild — prevents cross-guild claims
    const { data: team } = await supabase
      .from('teams')
      .select('id')
      .eq('id', teamId)
      .eq('guild_id', myGuildId)
      .single();
    if (!team) return res.status(403).json({ error: 'Team does not belong to your guild' });

    // Officers can claim on behalf of another account; regular members can only claim for themselves
    const accountId = (isOfficer && targetAccountId) ? targetAccountId : session.id;

    try {
      const { data: updated, error: claimErr } = await supabase
        .from('characters')
        .update({ account_id: accountId })
        .eq('name', characterName)
        .eq('team_id', teamId)
        .select('name');
      if (claimErr) throw new Error(claimErr.message);

      // The character row may not exist yet (roster hasn't synced to the DB for this
      // name/team combo) — a plain UPDATE silently matches zero rows in that case.
      // Fall back to creating the row so the claim isn't lost.
      if (!updated || updated.length === 0) {
        const { error: upsertErr } = await supabase
          .from('characters')
          .upsert({
            team_id:      teamId,
            name:         characterName,
            class:        characterClass  || 'unknown',
            server:       characterServer || '',
            primary_role: characterRole   || 'ranged',
            account_id:   accountId,
          }, { onConflict: 'team_id,name' });
        if (upsertErr) throw new Error(upsertErr.message);
        console.warn('[claimCharacter] character row did not exist, created via upsert:', characterName, teamId);
      }

      return res.status(200).json({ success: true, characterName, accountId });
    } catch (err) {
      console.error('[claimCharacter] error:', err.message, { characterName, teamId, accountId });
      return res.status(500).json({ error: err.message });
    }
  }

  // ── REMOVE MEMBER ──
  if (action === 'removeMember') {
    if (!isOwner) return res.status(403).json({ error: 'Owners only' });

    const { targetAccountId } = req.body;
    if (!targetAccountId) return res.status(400).json({ error: 'targetAccountId required' });

    // Prevent owner from removing themselves — use transferOwner in guild.js first
    if (targetAccountId === session.id) return res.status(400).json({ error: 'Owner cannot remove themselves — transfer ownership first' });

    try {
      // Unclaim any characters this member owned on this guild's teams
      const { data: guildTeams } = await supabase
        .from('teams').select('id').eq('guild_id', myGuildId);
      const teamIds = (guildTeams || []).map(t => t.id);
      if (teamIds.length > 0) {
        const { error: unclaimErr } = await supabase
          .from('characters')
          .update({ account_id: null })
          .eq('account_id', targetAccountId)
          .in('team_id', teamIds);
        if (unclaimErr) throw new Error('unclaim: ' + unclaimErr.message);
      }
      // Remove from guild
      const { data: removed, error: removeErr } = await supabase
        .from('guild_members')
        .delete()
        .eq('account_id', targetAccountId)
        .eq('guild_id', myGuildId)
        .select('account_id');
      if (removeErr) throw new Error('remove: ' + removeErr.message);
      if (!removed || removed.length === 0) {
        console.warn('[removeMember] delete matched 0 rows — check RLS/service key permissions:', { targetAccountId, myGuildId });
        throw new Error('remove: no matching guild_members row was deleted (check that account_id/guild_id match, and that the Supabase key has delete permission)');
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[removeMember] error:', err.message, { targetAccountId, myGuildId });
      return res.status(500).json({ error: err.message });
    }
  }

  // ── DIAGNOSTIC: which Supabase key role is actually loaded in this deployment ──
  // Decodes only the JWT payload's `role` claim -- never exposes the key itself.
  if (action === 'diagKey') {
    if (!isOwner) return res.status(403).json({ error: 'Owners only' });
    try {
      const key = process.env.SUPABASE_SERVICE_KEY || '';
      const parts = key.split('.');
      if (parts.length !== 3) return res.status(200).json({ error: 'SUPABASE_SERVICE_KEY is not set or is not a JWT', length: key.length });
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      return res.status(200).json({ role: payload.role, projectRef: payload.ref, issuer: payload.iss });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── GET ATTENDANCE: raid extra nights + all marks for the team ──
  // ── DIAGNOSTIC: test attendance read/write directly ──
  if (action === 'diagAttendance') {
    const teamId = req.query.teamId || req.body?.teamId;
    try {
      // Test write
      const testDate = '2099-01-01';
      const { data: insertData, error: insertErr } = await supabase
        .from('attendance_marks')
        .insert({ team_id: teamId, character_name: 'TEST', raid_date: testDate, status: 'unavailable' })
        .select();
      
      // Test read
      const { data: readData, error: readErr } = await supabase
        .from('attendance_marks')
        .select('*')
        .eq('team_id', teamId)
        .limit(10);

      // Cleanup
      await supabase.from('attendance_marks').delete()
        .eq('team_id', teamId).eq('character_name', 'TEST').eq('raid_date', testDate);

      return res.status(200).json({
        supabaseUrl: process.env.SUPABASE_URL,
        keyPrefix: (process.env.SUPABASE_SERVICE_KEY || '').slice(0, 30),
        insertData, insertErr: insertErr?.message,
        readCount: readData?.length,
        readErr: readErr?.message,
        readSample: readData?.slice(0, 3),
      });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (action === 'getAttendance') {
    const teamId = req.body?.teamId || req.query.teamId;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });
    console.log('[attendance] getAttendance called, teamId:', teamId, 'myGuildId:', myGuildId);
    try {
      const { data: team, error: teamErr } = await supabase.from('teams').select('id').eq('id', teamId).eq('guild_id', myGuildId).maybeSingle();
      console.log('[attendance] team check:', team, teamErr?.message);
      if (!team) return res.status(403).json({ error: 'Team does not belong to your guild' });

      const { data: extraDays, error: extraErr } = await supabase
        .from('raid_extra_days')
        .select('id, raid_date')
        .eq('team_id', teamId);
      if (extraErr) throw new Error('raid_extra_days: ' + extraErr.message);

      const { data: marks, error: marksErr } = await supabase
        .from('attendance_marks')
        .select('character_name, raid_date, status')
        .eq('team_id', teamId);
      console.log('[attendance] getAttendance teamId:', teamId, 'myGuildId:', myGuildId, 'marks count:', marks?.length, 'marks:', JSON.stringify(marks?.slice(0,3)), 'error:', marksErr?.message);
      if (marksErr) throw new Error('attendance_marks: ' + marksErr.message);

      return res.status(200).json({
        extraDays: (extraDays || []).map(d => d.raid_date),
        marks:     marks || [],
      });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── MARK ATTENDANCE: toggle a character's unavailability for a date ──
  if (action === 'markAttendance') {
    const { teamId, characterName, raidDate, unavailable } = req.body;
    if (!teamId || !characterName || !raidDate) return res.status(400).json({ error: 'teamId, characterName, raidDate required' });

    // A regular member can only mark the character THEY claimed; officers may mark any character
    if (!isOfficer) {
      const { data: char } = await supabase
        .from('characters')
        .select('account_id')
        .eq('team_id', teamId)
        .eq('name', characterName)
        .single();
      if (!char || char.account_id !== session.id) {
        return res.status(403).json({ error: 'You can only mark attendance for your own claimed character' });
      }
    }

    try {
      if (unavailable) {
        // Try update first, then insert if no row exists
        const { data: existing } = await supabase.from('attendance_marks')
          .select('id')
          .eq('team_id', teamId).eq('character_name', characterName).eq('raid_date', raidDate)
          .maybeSingle();
        console.log('[attendance] existing:', existing, 'teamId:', teamId, 'char:', characterName, 'date:', raidDate);
        if (existing) {
          const { error: updateErr, data: updateData } = await supabase.from('attendance_marks')
            .update({ status: 'unavailable' })
            .eq('team_id', teamId).eq('character_name', characterName).eq('raid_date', raidDate)
            .select();
          console.log('[attendance] update result:', updateData, updateErr);
          if (updateErr) throw new Error('update: ' + updateErr.message);
        } else {
          const { error: insertErr, data: insertData } = await supabase.from('attendance_marks')
            .insert({ team_id: teamId, character_name: characterName, raid_date: raidDate, status: 'unavailable' })
            .select();
          console.log('[attendance] insert result:', insertData, insertErr);
          if (insertErr) throw new Error('insert: ' + insertErr.message);
        }
      } else {
        const { error: deleteErr } = await supabase.from('attendance_marks')
          .delete()
          .eq('team_id', teamId).eq('character_name', characterName).eq('raid_date', raidDate);
        if (deleteErr) throw new Error('delete: ' + deleteErr.message);
      }
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── ADD RAID NIGHT: one-off extra raid date (officers only) ──
  if (action === 'addRaidNight') {
    if (!isOfficer) return res.status(403).json({ error: 'Officers only' });
    const { teamId, raidDate } = req.body;
    if (!teamId || !raidDate) return res.status(400).json({ error: 'teamId and raidDate required' });
    try {
      await supabase.from('raid_extra_days').upsert({
        team_id: teamId, raid_date: raidDate, created_by: session.id,
      }, { onConflict: 'team_id,raid_date' });
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── REMOVE RAID NIGHT: remove a one-off extra raid date (officers only) ──
  if (action === 'removeRaidNight') {
    if (!isOfficer) return res.status(403).json({ error: 'Officers only' });
    const { teamId, raidDate } = req.body;
    if (!teamId || !raidDate) return res.status(400).json({ error: 'teamId and raidDate required' });
    try {
      await supabase.from('raid_extra_days').delete().eq('team_id', teamId).eq('raid_date', raidDate);
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  res.status(400).json({ error: 'Invalid action' });
};
