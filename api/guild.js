// ============================================================
//  guild.js — handles guild + team actions
//  Actions: get, create, addTeam, update, generateJoinCode,
//           beginDiscordConnect, setDiscordGuildId, setWclCredentials,
//           setRaidSchedule, transferOwner
//
//  A "guild" (name/server/region) is a lightweight shared identity that one
//  or more "teams" attach to. Everything a team actually needs to operate
//  (roster source, WCL config, Discord link, join code) lives on the team
//  row, not the guild row -- teams under the same guild are independent:
//  no team's owner needs another team's permission for anything.
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('./lib/session');
const { getMyTeams, assertTeamMembership } = require('./lib/teamAuth');
const { ensureZoneName } = require('./lib/wclZone');

const TEAM_FIELDS = `id, name, guild_id, wowaudit_url, wcl_url, wcl_team_id, zone_id, zone_name,
  difficulty, raid_days, discord_guild_id, join_code, wcl_client_id, wcl_client_secret_enc,
  guilds ( id, name, server, region )`;

// Strips the encrypted secret before a team row is ever sent to the client.
function sanitizeTeam(team) {
  if (!team) return team;
  const t = { ...team };
  t.hasWclCredentials = !!t.wcl_client_secret_enc;
  delete t.wcl_client_secret_enc;
  return t;
}

// Two WowAudit URLs are "the same spreadsheet" if they point at the same Google
// Sheets doc, regardless of trailing gid/edit-vs-view differences -- so compare
// the sheet ID when present, and fall back to a normalized exact match otherwise.
function wowauditKey(url) {
  if (!url) return null;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

// Looks for another team already tracking this same spreadsheet -- a strong
// signal someone is accidentally re-creating a team that already exists,
// rather than typing the URL for a genuinely new team.
async function findDuplicateWowaudit(supabase, url, excludeTeamId) {
  const key = wowauditKey(url);
  if (!key) return null;
  let query = supabase.from('teams').select('id, name, wowaudit_url, guilds ( name, server )');
  if (excludeTeamId) query = query.neq('id', excludeTeamId);
  const { data: rows } = await query;
  return (rows || []).find(row => wowauditKey(row.wowaudit_url) === key) || null;
}

function duplicateWowauditResponse(dup) {
  const where = dup.guilds ? ` (${dup.guilds.name} — ${dup.guilds.server})` : '';
  return {
    error: 'WOWAUDIT_DUPLICATE',
    message: `That spreadsheet is already registered to "${dup.name}"${where}. Continue anyway if that's intentional, or double check the URL.`,
    existingTeamName: dup.name,
    existingGuildName: dup.guilds?.name || null,
    existingGuildServer: dup.guilds?.server || null,
  };
}

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── GET: list every team this account belongs to; if a teamId is given (or
  // there's only one team), also return that team's full config ──
  if (action === 'get' || req.method === 'GET') {
    try {
      const myTeams = await getMyTeams(supabase, session.id);
      if (myTeams.length === 0) {
        return res.status(404).json({ error: 'No team found', code: 'NO_GUILD', teams: [] });
      }

      const requestedTeamId = req.query.teamId || req.body?.teamId || null;
      const activeTeamId = requestedTeamId || (myTeams.length === 1 ? myTeams[0].teamId : null);

      let team = null, role = null, claimedCharacter = null;
      if (activeTeamId) {
        const membership = myTeams.find(t => t.teamId === activeTeamId);
        if (!membership) return res.status(403).json({ error: 'You are not a member of that team' });
        role = membership.role;

        const { data: teamRow, error: teamErr } = await supabase
          .from('teams').select(TEAM_FIELDS).eq('id', activeTeamId).single();
        if (teamErr) throw teamErr;

        // Backfill zone_name if only the numeric zone_id has ever been set (e.g.
        // parsed from a pasted WCL URL, which carries no name) -- powers both the
        // Roster stat card and the Progress tab's raid detection.
        if (!teamRow.zone_name && teamRow.zone_id) {
          await ensureZoneName(supabase, teamRow);
        }

        team = sanitizeTeam(teamRow);

        const { data: charRow } = await supabase
          .from('characters').select('name')
          .eq('account_id', session.id).eq('team_id', activeTeamId)
          .limit(1).maybeSingle();
        claimedCharacter = charRow?.name || null;
      }

      return res.status(200).json({
        teams: myTeams, // [{ teamId, teamName, role, guildId, guildName, guildServer }]
        activeTeamId,
        role,
        team,
        claimedCharacter,
      });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── CREATE: create a brand-new guild+team, OR (with confirmNewTeam) a new
  // sibling team under a guild that already exists by name+server ──
  if (action === 'create') {
    const { guild, server, region, difficulty, teamName, wowaudit, wclUrl, zoneId, wclTeamId, raidDays, confirmNewTeam, confirmDuplicateWowaudit } = req.body;
    if (!guild || !server || !wowaudit) return res.status(400).json({ error: 'Missing required fields' });

    try {
      const normServer = server.trim().toLowerCase();

      const { data: existingGuild } = await supabase
        .from('guilds')
        .select('id, name, server, region')
        .ilike('name', guild.trim())
        .ilike('server', normServer)
        .maybeSingle();

      if (existingGuild && !confirmNewTeam) {
        const { data: siblingTeams } = await supabase
          .from('teams').select('name').eq('guild_id', existingGuild.id);
        return res.status(409).json({
          error: 'GUILD_EXISTS',
          message: `"${existingGuild.name}" on ${existingGuild.server} already exists. Are you starting a second team, or do you need to join an existing one?`,
          existingGuild,
          teamNames: (siblingTeams || []).map(t => t.name),
        });
      }

      if (!confirmDuplicateWowaudit) {
        const dup = await findDuplicateWowaudit(supabase, wowaudit);
        if (dup) return res.status(409).json(duplicateWowauditResponse(dup));
      }

      const guildId = existingGuild
        ? existingGuild.id
        : (await (async () => {
            const { data: g, error: ge } = await supabase.from('guilds')
              .insert({ name: guild.trim(), server: normServer, region: region || 'us', created_by: session.id })
              .select('id').single();
            if (ge) throw new Error(ge.message);
            return g.id;
          })());

      const { data: teamData, error: te } = await supabase
        .from('teams')
        .insert({
          guild_id:     guildId,
          name:         teamName || 'Main Team',
          wowaudit_url: wowaudit,
          wcl_url:      wclUrl || null,
          wcl_team_id:  wclTeamId || null,
          zone_id:      zoneId || null,
          difficulty:   difficulty || 'mythic',
          raid_days:    Array.isArray(raidDays) ? raidDays : [],
        })
        .select(TEAM_FIELDS)
        .single();
      if (te) throw new Error(te.message);

      const { error: me } = await supabase
        .from('team_members')
        .insert({ team_id: teamData.id, account_id: session.id, role: 'owner' });
      if (me) throw new Error(me.message);

      return res.status(200).json({ team: sanitizeTeam(teamData) });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── ADD TEAM: shortcut for an existing team's owner/officer to spin up a
  // sibling team under the same guild, from inside their own settings.
  // Doesn't require anything from a sibling team's owner -- same as the
  // confirmNewTeam path above, just reached from a different starting point. ──
  if (action === 'addTeam') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { teamId, teamName, wowaudit, wclUrl, zoneId, wclTeamId, difficulty, raidDays, confirmDuplicateWowaudit } = req.body;
    if (!teamId || !teamName || !wowaudit) return res.status(400).json({ error: 'teamId, teamName, and wowaudit are required' });
    try {
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      if (!confirmDuplicateWowaudit) {
        const dup = await findDuplicateWowaudit(supabase, wowaudit);
        if (dup) return res.status(409).json(duplicateWowauditResponse(dup));
      }

      const { data: anchorTeam, error: anchorErr } = await supabase
        .from('teams').select('guild_id').eq('id', teamId).single();
      if (anchorErr || !anchorTeam) throw new Error('Could not find the guild for that team');

      const { data: teamData, error: te } = await supabase
        .from('teams')
        .insert({
          guild_id:     anchorTeam.guild_id,
          name:         teamName,
          wowaudit_url: wowaudit,
          wcl_url:      wclUrl || null,
          wcl_team_id:  wclTeamId || null,
          zone_id:      zoneId || null,
          difficulty:   difficulty || 'mythic',
          raid_days:    Array.isArray(raidDays) ? raidDays : [],
        })
        .select(TEAM_FIELDS)
        .single();
      if (te) throw new Error(te.message);

      const { error: tme } = await supabase
        .from('team_members')
        .insert({ team_id: teamData.id, account_id: session.id, role: 'owner' });
      if (tme) throw new Error(tme.message);

      return res.status(200).json({ team: sanitizeTeam(teamData) });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── UPDATE: update a team's settings, and (since it's shared) the guild's
  // name/server/region too if provided -- any officer of any sibling team can
  // do this, consistent with there being no elevated cross-team tier ──
  if (action === 'update') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { teamId, guild, server, region, wowaudit, wclUrl, zoneId, teamName, wclTeamId, raidDays, confirmDuplicateWowaudit } = req.body;
      if (!teamId) return res.status(400).json({ error: 'teamId required' });
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });
      if (!guild || !server || !wowaudit) return res.status(400).json({ error: 'Missing required fields' });

      const { data: currentTeam } = await supabase.from('teams').select('guild_id').eq('id', teamId).single();
      if (!currentTeam) return res.status(404).json({ error: 'Team not found' });

      if (!confirmDuplicateWowaudit) {
        const dup = await findDuplicateWowaudit(supabase, wowaudit, teamId);
        if (dup) return res.status(409).json(duplicateWowauditResponse(dup));
      }

      if (guild && server) {
        await supabase.from('guilds').update({
          name: guild.trim(), server: server.trim().toLowerCase(), region: region || 'us',
        }).eq('id', currentTeam.guild_id);
      }

      const { data, error } = await supabase
        .from('teams')
        .update({
          name:         teamName || undefined,
          wowaudit_url: wowaudit,
          wcl_url:      wclUrl || null,
          wcl_team_id:  wclTeamId || null,
          zone_id:      zoneId || null,
          raid_days:    Array.isArray(raidDays) ? raidDays : [],
        })
        .eq('id', teamId)
        .select(TEAM_FIELDS)
        .single();
      if (error) throw new Error(error.message);

      return res.status(200).json({ team: sanitizeTeam(data) });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── GENERATE JOIN CODE: short, DB-backed code others use to join THIS team (officers+) ──
  if (action === 'generateJoinCode') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { teamId } = req.body;
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      // Skip visually ambiguous characters (0/O, 1/I/L)
      const { randomInt } = require('crypto');
      const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const genCode = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

      let code = null;
      for (let attempt = 0; attempt < 5 && !code; attempt++) {
        const candidate = genCode();
        const { data: clash } = await supabase.from('teams').select('id').eq('join_code', candidate).maybeSingle();
        if (!clash) code = candidate;
      }
      if (!code) return res.status(500).json({ error: 'Could not generate a unique join code — try again' });

      const { error } = await supabase.from('teams').update({ join_code: code }).eq('id', teamId);
      if (error) throw error;

      return res.status(200).json({ success: true, joinCode: code });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── BEGIN DISCORD CONNECT: kick off the "Connect to Discord" OAuth flow for
  // THIS team (officers+). Any number of teams -- of the same or different
  // guilds -- can independently connect the same Discord server; there's no
  // uniqueness constraint on discord_guild_id anymore. Whoever completes the
  // resulting URL (needs "Manage Server" on the target Discord) doesn't need a
  // RaidLead login -- the callback resolves the team purely from this state token. ──
  if (action === 'beginDiscordConnect') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { teamId } = req.body;
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      const appId = process.env.DISCORD_APPLICATION_ID;
      if (!appId) return res.status(500).json({ error: 'Discord integration is not configured yet (missing DISCORD_APPLICATION_ID).' });

      const { randomBytes } = require('crypto');
      const state = randomBytes(16).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      const { error } = await supabase.from('teams').update({
        discord_connect_state: state,
        discord_connect_state_expires_at: expiresAt,
      }).eq('id', teamId);
      if (error) throw error;

      return res.status(200).json({ success: true, state, discordApplicationId: appId });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── SET DISCORD GUILD ID: link a Discord server to THIS team manually (officers+) ──
  if (action === 'setDiscordGuildId') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { teamId, discordGuildId } = req.body;
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      const value = (discordGuildId || '').trim() || null;
      if (value && !/^\d{5,25}$/.test(value)) {
        return res.status(400).json({ error: 'That doesn\'t look like a Discord Server ID (should be a long number).' });
      }

      const { error } = await supabase.from('teams').update({ discord_guild_id: value }).eq('id', teamId);
      if (error) throw error;

      return res.status(200).json({ success: true, discordGuildId: value });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── SET WCL CREDENTIALS: this team's own Warcraft Logs API client (officers+) ──
  // Each team brings its own WCL v2 API client (id + secret, created at
  // warcraftlogs.com/api/clients/) so teams' WCL usage is fully isolated from
  // each other -- one team's fetches can never draw on or be capped by another's
  // quota. The secret is encrypted before it's stored; only the client ID (not
  // sensitive) and a hasWclCredentials boolean are ever sent back to the browser.
  if (action === 'setWclCredentials') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { teamId, wclClientId, wclClientSecret } = req.body;
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });

      const clientId = (wclClientId || '').trim() || null;
      const clientSecret = (wclClientSecret || '').trim() || null;

      if (!clientId && !clientSecret) {
        const { error } = await supabase.from('teams').update({
          wcl_client_id: null, wcl_client_secret_enc: null,
        }).eq('id', teamId);
        if (error) throw error;
        return res.status(200).json({ success: true, cleared: true });
      }

      if (!clientId || !clientSecret) {
        return res.status(400).json({ error: 'Both Client ID and Client Secret are required' });
      }

      const { encrypt } = require('./lib/crypto');
      const { error } = await supabase.from('teams').update({
        wcl_client_id:         clientId,
        wcl_client_secret_enc: encrypt(clientSecret),
      }).eq('id', teamId);
      if (error) throw error;

      return res.status(200).json({ success: true });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── SET RAID SCHEDULE: update THIS team's weekly recurring raid days (officers+) ──
  if (action === 'setRaidSchedule') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const { teamId, raidDays } = req.body;
      await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });
      if (!Array.isArray(raidDays)) return res.status(400).json({ error: 'raidDays must be an array' });

      const { error } = await supabase.from('teams').update({ raid_days: raidDays }).eq('id', teamId);
      if (error) throw error;

      return res.status(200).json({ success: true, raidDays });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── TRANSFER OWNERSHIP: this team's owner hands off to another member of THIS team ──
  if (action === 'transferOwner') {
    try {
      const { teamId, targetAccountId } = req.body;
      if (!targetAccountId) return res.status(400).json({ error: 'targetAccountId required' });
      if (targetAccountId === session.id) return res.status(400).json({ error: 'Cannot transfer ownership to yourself' });

      const myRole = await assertTeamMembership(supabase, session.id, teamId);
      if (myRole !== 'owner') return res.status(403).json({ error: 'Owners only' });

      const { data: targetMembership } = await supabase
        .from('team_members').select('id').eq('account_id', targetAccountId).eq('team_id', teamId).maybeSingle();
      if (!targetMembership) return res.status(400).json({ error: 'That account is not a member of this team' });

      await supabase.from('team_members').update({ role: 'owner' }).eq('account_id', targetAccountId).eq('team_id', teamId);
      await supabase.from('team_members').update({ role: 'officer' }).eq('account_id', session.id).eq('team_id', teamId);
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  res.status(400).json({ error: 'Invalid action' });
};
