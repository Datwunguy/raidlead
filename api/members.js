// ============================================================
//  members.js — handles member/attendance actions, all team-scoped
//  Actions: get, updateRole, updateDisplayName, setMemberDiscordId,
//           generateDiscordLinkCode, claimCharacter, unclaimCharacter,
//           removeMember, diagKey, getAttendance, markAttendance,
//           addRaidNight, removeRaidNight
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('../lib/session');
const { assertTeamMembership, isOfficerRole } = require('../lib/teamAuth');

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── GET: return all members of a specific team ──
  // `!action && req.method === 'GET'`, not just `req.method === 'GET'` --
  // the broader check silently swallowed every other GET-based action below
  // (getAttendance included) since a plain fetch() defaults to GET
  // regardless of the actual `action` param. Confirmed real impact: the
  // roster-sync's GET call to getAttendance was always hitting this branch
  // instead, so the "unavailable" list mirrored to the addon was always
  // empty -- while the Attendance tab's own POST call to the same action
  // worked fine, which is why marks showed up correctly there the whole time.
  if (action === 'get' || (!action && req.method === 'GET')) {
    const teamId = req.query.teamId || req.body?.teamId;
    try {
      await assertTeamMembership(supabase, session.id, teamId);

      const { data: members, error } = await supabase
        .from('team_members')
        .select(`role, account_id, accounts ( id, battletag, display_name, last_login, discord_id )`)
        .eq('team_id', teamId);
      if (error) throw error;

      const { data: chars } = await supabase
        .from('characters')
        .select('id, name, class, primary_role, rank, account_id')
        .eq('team_id', teamId)
        .eq('active', true)
        .not('account_id', 'is', null);
      const characterMap = {};
      (chars || []).forEach(c => { if (!characterMap[c.account_id]) characterMap[c.account_id] = []; characterMap[c.account_id].push(c); });

      const enriched = (members || []).map(m => ({ ...m, characters: characterMap[m.account_id] || [] }));
      const myRole = enriched.find(m => m.account_id === session.id)?.role || null;
      return res.status(200).json({ members: enriched, myRole });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── UPDATE ROLE ──
  if (action === 'updateRole') {
    const { teamId, targetAccountId, role } = req.body;
    if (!targetAccountId || !role) return res.status(400).json({ error: 'targetAccountId and role required' });

    try {
      const myRole = await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      // Only owners can hand out the owner role -- promoting to officer is a normal
      // officer-level action; becoming owner should only ever happen via transferOwner,
      // which also demotes the current owner atomically so exactly one owner exists.
      if (role === 'owner' && myRole !== 'owner') return res.status(403).json({ error: 'Owners only for this role' });

      // Prevent owner from removing their own owner status without a transfer
      if (targetAccountId === session.id && myRole === 'owner') {
        return res.status(400).json({ error: 'Use the transfer ownership action to change your own role' });
      }

      // Never let this action change the CURRENT owner's role away from owner --
      // that must go through transferOwner, same reasoning as above.
      const { data: targetMembership } = await supabase
        .from('team_members')
        .select('role')
        .eq('account_id', targetAccountId)
        .eq('team_id', teamId)
        .maybeSingle();
      if (!targetMembership) return res.status(404).json({ error: 'That account is not a member of this team' });
      if (targetMembership.role === 'owner' && role !== 'owner') {
        return res.status(400).json({ error: "Use the transfer ownership action to change the owner's role" });
      }

      await supabase
        .from('team_members')
        .update({ role })
        .eq('account_id', targetAccountId)
        .eq('team_id', teamId);
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── BECOME VIEWER (self-service): lets someone past the character-claim
  // gate without claiming a character, for anyone who just wants read-only
  // access -- officers/owners never need this, they bypass the gate
  // entirely on the client side regardless of role. Only ever changes the
  // caller's own role, and only downward (never touches an existing
  // officer/owner), so there's no privilege-escalation surface here. ──
  if (action === 'becomeViewer') {
    const { teamId } = req.body;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });
    try {
      const myRole = await assertTeamMembership(supabase, session.id, teamId);
      if (isOfficerRole(myRole)) return res.status(200).json({ success: true, role: myRole }); // nothing to do

      await supabase
        .from('team_members')
        .update({ role: 'viewer' })
        .eq('account_id', session.id)
        .eq('team_id', teamId);
      return res.status(200).json({ success: true, role: 'viewer' });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── UPDATE DISPLAY NAME (self-service, no team context) ──
  if (action === 'updateDisplayName') {
    const { displayName } = req.body;
    if (!displayName?.trim()) return res.status(400).json({ error: 'Display name required' });
    try {
      await supabase.from('accounts').update({ display_name: displayName.trim() }).eq('id', session.id);
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── SET MEMBER DISCORD ID: officer manually links a member's Discord account ──
  if (action === 'setMemberDiscordId') {
    const { teamId, targetAccountId, discordId } = req.body;
    if (!targetAccountId) return res.status(400).json({ error: 'targetAccountId required' });
    const value = (discordId || '').trim() || null;
    if (value && !/^\d{5,25}$/.test(value)) {
      return res.status(400).json({ error: 'That doesn\'t look like a Discord user ID (should be a long number -- right-click their name in Discord with Developer Mode on and choose "Copy User ID").' });
    }
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      // Verify targetAccountId is actually a member of THIS team -- without this, an
      // officer of any team could relink any account platform-wide.
      const { data: targetMembership } = await supabase
        .from('team_members')
        .select('account_id')
        .eq('account_id', targetAccountId)
        .eq('team_id', teamId)
        .maybeSingle();
      if (!targetMembership) return res.status(403).json({ error: 'That account is not a member of this team' });

      const { error } = await supabase.from('accounts').update({ discord_id: value }).eq('id', targetAccountId);
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'That Discord account is already linked to a different RaidLead account.' });
        throw error;
      }
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── GENERATE DISCORD LINK CODE: self-service linking (no team context) ──
  if (action === 'generateDiscordLinkCode') {
    try {
      const { randomInt } = require('crypto');
      const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

      const { error } = await supabase.from('accounts').update({
        discord_link_code: code,
        discord_link_code_expires_at: expiresAt,
      }).eq('id', session.id);
      if (error) throw error;

      return res.status(200).json({ success: true, code, expiresAt });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── CLAIM CHARACTER ──
  if (action === 'claimCharacter') {
    const { characterName, teamId, targetAccountId, characterClass, characterServer, characterRole } = req.body;
    if (!characterName || !teamId) return res.status(400).json({ error: 'characterName and teamId required' });

    try {
      const myRole = await assertTeamMembership(supabase, session.id, teamId);
      const isOfficer = isOfficerRole(myRole);

      // Officers can claim on behalf of another account; regular members can only claim for themselves
      const accountId = (isOfficer && targetAccountId) ? targetAccountId : session.id;

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
      console.error('[claimCharacter] error:', err.message, { characterName, teamId });
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── UNCLAIM CHARACTER: release a character claim -- self-service for your
  // own characters (so claiming a Main and Alt(s) doesn't lock you into
  // never being able to undo one), officers can release anyone's. ──
  if (action === 'unclaimCharacter') {
    const { characterName, teamId } = req.body;
    if (!characterName || !teamId) return res.status(400).json({ error: 'characterName and teamId required' });

    try {
      const myRole = await assertTeamMembership(supabase, session.id, teamId);
      const isOfficer = isOfficerRole(myRole);

      const { data: char } = await supabase
        .from('characters').select('account_id').eq('team_id', teamId).eq('name', characterName).maybeSingle();
      if (!char) return res.status(404).json({ error: 'Character not found' });
      if (!isOfficer && char.account_id !== session.id) {
        return res.status(403).json({ error: 'You can only release your own characters' });
      }

      const { error } = await supabase
        .from('characters').update({ account_id: null }).eq('team_id', teamId).eq('name', characterName);
      if (error) throw error;

      return res.status(200).json({ success: true });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── REMOVE MEMBER ──
  if (action === 'removeMember') {
    const { teamId, targetAccountId } = req.body;
    if (!targetAccountId) return res.status(400).json({ error: 'targetAccountId required' });

    // Prevent removing yourself this way — use transferOwner (if owner) or just leave
    if (targetAccountId === session.id) return res.status(400).json({ error: 'You cannot remove yourself this way' });

    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      // Nobody can remove this team's owner through this action, regardless of role --
      // ownership has to change hands via transferOwner first.
      const { data: targetMembership } = await supabase
        .from('team_members')
        .select('role')
        .eq('account_id', targetAccountId)
        .eq('team_id', teamId)
        .maybeSingle();
      if (!targetMembership) return res.status(404).json({ error: 'That account is not a member of this team' });
      if (targetMembership.role === 'owner') {
        return res.status(400).json({ error: 'The team owner cannot be removed — transfer ownership first' });
      }

      // Unclaim any characters this member owned on this team
      const { error: unclaimErr } = await supabase
        .from('characters')
        .update({ account_id: null })
        .eq('account_id', targetAccountId)
        .eq('team_id', teamId);
      if (unclaimErr) throw new Error('unclaim: ' + unclaimErr.message);

      // Remove from team
      const { data: removed, error: removeErr } = await supabase
        .from('team_members')
        .delete()
        .eq('account_id', targetAccountId)
        .eq('team_id', teamId)
        .select('account_id');
      if (removeErr) throw new Error('remove: ' + removeErr.message);
      if (!removed || removed.length === 0) {
        console.warn('[removeMember] delete matched 0 rows — check RLS/service key permissions:', { targetAccountId, teamId });
        throw new Error('remove: no matching team_members row was deleted (check that account_id/team_id match, and that the Supabase key has delete permission)');
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[removeMember] error:', err.message, { targetAccountId, teamId });
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── DIAGNOSTIC: which Supabase project/role is actually loaded in this
  // deployment -- catches the quiet failure mode where SUPABASE_SERVICE_KEY
  // is valid but points at the wrong project (e.g. an old key pasted back in
  // during a rotation), which otherwise wouldn't announce itself as an error.
  // Decodes only the JWT payload -- never exposes the key itself. Restricted
  // to the site owner's own account (not "any officer of any team," which
  // anyone can become by creating a throwaway guild) since this is
  // infrastructure info, not something a guild officer has a reason to see. ──
  if (action === 'diagKey') {
    try {
      const ownerTag = process.env.SITE_OWNER_BATTLETAG;
      if (!ownerTag) return res.status(403).json({ error: 'SITE_OWNER_BATTLETAG is not configured' });
      const { data: account } = await supabase.from('accounts').select('battletag').eq('id', session.id).maybeSingle();
      if (!account || account.battletag !== ownerTag) return res.status(403).json({ error: 'Not authorized' });

      const key = process.env.SUPABASE_SERVICE_KEY || '';
      const parts = key.split('.');
      if (parts.length !== 3) return res.status(200).json({ error: 'SUPABASE_SERVICE_KEY is not set or is not a JWT', length: key.length });
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      return res.status(200).json({ role: payload.role, projectRef: payload.ref, issuer: payload.iss });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (action === 'getAttendance') {
    const teamId = req.body?.teamId || req.query.teamId;
    try {
      await assertTeamMembership(supabase, session.id, teamId);

      const { data: extraDays, error: extraErr } = await supabase
        .from('raid_extra_days')
        .select('id, raid_date')
        .eq('team_id', teamId);
      if (extraErr) throw new Error('raid_extra_days: ' + extraErr.message);

      const { data: marks, error: marksErr } = await supabase
        .from('attendance_marks')
        .select('character_name, raid_date, status')
        .eq('team_id', teamId);
      if (marksErr) throw new Error('attendance_marks: ' + marksErr.message);

      return res.status(200).json({
        extraDays: (extraDays || []).map(d => d.raid_date),
        marks:     marks || [],
      });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── MARK ATTENDANCE: toggle a character's unavailability for a date ──
  if (action === 'markAttendance') {
    const { teamId, characterName, raidDate, unavailable } = req.body;
    if (!teamId || !characterName || !raidDate) return res.status(400).json({ error: 'teamId, characterName, raidDate required' });

    let isOfficer;
    try {
      const myRole = await assertTeamMembership(supabase, session.id, teamId);
      // A Viewer has no claimed character, so this would already be a no-op
      // in practice -- explicit check anyway for a clear error rather than
      // relying only on "there's nothing to match" below.
      if (myRole === 'viewer') return res.status(403).json({ error: 'Viewers cannot mark attendance' });
      isOfficer = isOfficerRole(myRole);
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }

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
        if (existing) {
          const { error: updateErr } = await supabase.from('attendance_marks')
            .update({ status: 'unavailable' })
            .eq('team_id', teamId).eq('character_name', characterName).eq('raid_date', raidDate);
          if (updateErr) throw new Error('update: ' + updateErr.message);
        } else {
          const { error: insertErr } = await supabase.from('attendance_marks')
            .insert({ team_id: teamId, character_name: characterName, raid_date: raidDate, status: 'unavailable' });
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
    const { teamId, raidDate } = req.body;
    if (!teamId || !raidDate) return res.status(400).json({ error: 'teamId and raidDate required' });
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });
      const { error } = await supabase.from('raid_extra_days').upsert({
        team_id: teamId, raid_date: raidDate, created_by: session.id,
      }, { onConflict: 'team_id,raid_date' });
      if (error) throw error;
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[addRaidNight] error:', err.message, { teamId, raidDate });
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── REMOVE RAID NIGHT: remove a one-off extra raid date (officers only) ──
  if (action === 'removeRaidNight') {
    const { teamId, raidDate } = req.body;
    if (!teamId || !raidDate) return res.status(400).json({ error: 'teamId and raidDate required' });
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });
      const { error } = await supabase.from('raid_extra_days').delete().eq('team_id', teamId).eq('raid_date', raidDate);
      if (error) throw error;
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('[removeRaidNight] error:', err.message, { teamId, raidDate });
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'Invalid action' });
};
