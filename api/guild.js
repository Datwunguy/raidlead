// ============================================================
//  guild.js — handles guild actions
//  Actions: get, create
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('./lib/session');

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── GET: return guild + role for current user ──
  if (action === 'get' || req.method === 'GET') {
    try {
      const { data: membership } = await supabase
        .from('guild_members')
        .select(`role, guilds ( id, name, server, region, difficulty, wowaudit_url, wcl_url, wcl_team_id, zone_id, zone_name, raid_days, join_code, discord_guild_id, teams ( id, name ) )`)
        .eq('account_id', session.id)
        .single();
      if (!membership) return res.status(404).json({ error: 'No guild found', code: 'NO_GUILD' });

      const teamId = membership.guilds?.teams?.[0]?.id || null;

      // Check whether this account has claimed a character ON THIS TEAM — used to gate
      // access until claimed. Scoped to teamId so a character claimed in another guild
      // doesn't falsely satisfy the gate for a newly-joined guild.
      let claimedChar = null;
      if (teamId) {
        const { data } = await supabase
          .from('characters')
          .select('name')
          .eq('account_id', session.id)
          .eq('team_id', teamId)
          .limit(1)
          .maybeSingle();
        claimedChar = data;
      }

      return res.status(200).json({
        role: membership.role,
        guild: membership.guilds,
        team: membership.guilds?.teams?.[0] || null,
        claimedCharacter: claimedChar?.name || null,
      });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── CREATE: create guild + team + owner membership ──
  if (action === 'create') {
    const { guild, server, region, difficulty, teamName, wowaudit, wclUrl, zoneId, wclTeamId, raidDays } = req.body;
    if (!guild || !server || !wowaudit) return res.status(400).json({ error: 'Missing required fields' });
    try {
      const { data: guildData, error: ge } = await supabase
        .from('guilds')
        .insert({ name: guild, server: server.toLowerCase(), region: region || 'us', difficulty: difficulty || 'mythic', wowaudit_url: wowaudit, wcl_url: wclUrl || null, zone_id: zoneId || null, wcl_team_id: wclTeamId || null, raid_days: Array.isArray(raidDays) ? raidDays : [], created_by: session.id })
        .select()
        .single();
      if (ge) throw new Error(ge.message);

      const { data: teamData, error: te } = await supabase
        .from('teams')
        .insert({ guild_id: guildData.id, name: teamName || 'Main Team' })
        .select()
        .single();
      if (te) throw new Error(te.message);

      const { error: me } = await supabase
        .from('guild_members')
        .insert({ guild_id: guildData.id, account_id: session.id, role: 'owner' });
      if (me) throw new Error(me.message);

      return res.status(200).json({ guild: guildData, team: teamData });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── UPDATE: update guild settings (owner only) ──
  if (action === 'update') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { data: myMembership } = await supabase
        .from('guild_members')
        .select('role, guild_id')
        .eq('account_id', session.id)
        .single();
      if (!myMembership || myMembership.role !== 'owner') return res.status(403).json({ error: 'Owners only' });

      const { guild, server, region, wowaudit, wclUrl, zoneId, teamName, wclTeamId, raidDays } = req.body;
      if (!guild || !server || !wowaudit) return res.status(400).json({ error: 'Missing required fields' });

      const { data, error } = await supabase
        .from('guilds')
        .update({
          name:         guild,
          server:       server.toLowerCase(),
          region:       region || 'us',
          wowaudit_url: wowaudit,
          wcl_url:      wclUrl  || null,
          wcl_team_id:  wclTeamId || null,
          zone_id:      zoneId  || null,
          raid_days:    Array.isArray(raidDays) ? raidDays : [],
        })
        .eq('id', myMembership.guild_id)
        .select()
        .single();
      if (error) throw new Error(error.message);

      // Update team name if provided
      if (teamName) {
        const { data: team } = await supabase
          .from('teams')
          .select('id')
          .eq('guild_id', myMembership.guild_id)
          .order('created_at', { ascending: true })
          .limit(1)
          .single();
        if (team) {
          await supabase.from('teams').update({ name: teamName }).eq('id', team.id);
        }
      }

      return res.status(200).json({ guild: data });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── GENERATE JOIN CODE: short, DB-backed code members can type in to join (officers+) ──
  if (action === 'generateJoinCode') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { data: myMembership } = await supabase
        .from('guild_members')
        .select('role, guild_id')
        .eq('account_id', session.id)
        .single();
      if (!myMembership || !['owner', 'officer'].includes(myMembership.role)) {
        return res.status(403).json({ error: 'Officers only' });
      }

      // Skip visually ambiguous characters (0/O, 1/I/L)
      const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const genCode = () => Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

      let code = null;
      for (let attempt = 0; attempt < 5 && !code; attempt++) {
        const candidate = genCode();
        const { data: clash } = await supabase.from('guilds').select('id').eq('join_code', candidate).maybeSingle();
        if (!clash) code = candidate;
      }
      if (!code) return res.status(500).json({ error: 'Could not generate a unique join code — try again' });

      const { error } = await supabase.from('guilds').update({ join_code: code }).eq('id', myMembership.guild_id);
      if (error) throw error;

      return res.status(200).json({ success: true, joinCode: code });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── SET DISCORD GUILD ID: link a Discord server to this RaidLead guild (officers+) ──
  if (action === 'setDiscordGuildId') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { data: myMembership } = await supabase
        .from('guild_members')
        .select('role, guild_id')
        .eq('account_id', session.id)
        .single();
      if (!myMembership || !['owner', 'officer'].includes(myMembership.role)) {
        return res.status(403).json({ error: 'Officers only' });
      }

      const { discordGuildId } = req.body;
      const value = (discordGuildId || '').trim() || null;
      if (value && !/^\d{5,25}$/.test(value)) {
        return res.status(400).json({ error: 'That doesn\'t look like a Discord Server ID (should be a long number).' });
      }

      const { error } = await supabase.from('guilds').update({ discord_guild_id: value }).eq('id', myMembership.guild_id);
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'That Discord server is already linked to a different RaidLead guild.' });
        throw error;
      }

      return res.status(200).json({ success: true, discordGuildId: value });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── TRANSFER OWNERSHIP: owner hands off to another member ──
  // ── SET RAID SCHEDULE: update the weekly recurring raid days (officers+) ──
  if (action === 'setRaidSchedule') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { data: myMembership } = await supabase
        .from('guild_members')
        .select('role, guild_id')
        .eq('account_id', session.id)
        .single();
      if (!myMembership || !['owner', 'officer'].includes(myMembership.role)) {
        return res.status(403).json({ error: 'Officers only' });
      }

      const { raidDays } = req.body;
      if (!Array.isArray(raidDays)) return res.status(400).json({ error: 'raidDays must be an array' });

      const { error } = await supabase
        .from('guilds')
        .update({ raid_days: raidDays })
        .eq('id', myMembership.guild_id);
      if (error) throw error;

      return res.status(200).json({ success: true, raidDays });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (action === 'transferOwner') {
    const { targetAccountId } = req.body;
    if (!targetAccountId) return res.status(400).json({ error: 'targetAccountId required' });

    try {
      const { data: myMembership } = await supabase
        .from('guild_members')
        .select('role, guild_id')
        .eq('account_id', session.id)
        .single();
      if (!myMembership || myMembership.role !== 'owner') return res.status(403).json({ error: 'Owners only' });
      if (targetAccountId === session.id) return res.status(400).json({ error: 'Cannot transfer ownership to yourself' });

      // Promote target to owner, demote current owner to officer
      await supabase.from('guild_members').update({ role: 'owner' }).eq('account_id', targetAccountId).eq('guild_id', myMembership.guild_id);
      await supabase.from('guild_members').update({ role: 'officer' }).eq('account_id', session.id).eq('guild_id', myMembership.guild_id);
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  res.status(400).json({ error: 'Invalid action' });
};
