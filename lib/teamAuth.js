// ============================================================
//  lib/teamAuth.js — team-scoped membership/role resolution
//
//  A person can belong to any number of teams (team_members has one row
//  per account+team, not one row per account). Every action that touches
//  team data must be told WHICH team it's about (the client already sends
//  teamId almost everywhere) and this module verifies the caller actually
//  belongs to that specific team before anything proceeds -- membership
//  and role are never inherited from belonging to a sibling team under the
//  same guild, or from owning a sibling team.
// ============================================================

const OFFICER_ROLES = ['owner', 'officer'];
function isOfficerRole(role) { return OFFICER_ROLES.includes(role); }

/**
 * Every team this account belongs to, with role and guild identity attached.
 * Used for the team switcher and for join/create-time "does this guild
 * already exist" lookups.
 */
async function getMyTeams(supabase, accountId) {
  const { data, error } = await supabase
    .from('team_members')
    .select(`role, team_id, teams ( id, name, guild_id, guilds ( id, name, server, region ) )`)
    .eq('account_id', accountId);
  if (error) throw error;
  return (data || [])
    .filter(row => row.teams) // drop rows whose team was hard-deleted
    .map(row => ({
      teamId:      row.team_id,
      teamName:    row.teams.name,
      role:        row.role,
      guildId:     row.teams.guild_id,
      guildName:   row.teams.guilds?.name || null,
      guildServer: row.teams.guilds?.server || null,
    }));
}

/** This account's role on one specific team, or null if they're not on it. */
async function getTeamRole(supabase, accountId, teamId) {
  if (!teamId) return null;
  const { data } = await supabase
    .from('team_members')
    .select('role')
    .eq('account_id', accountId)
    .eq('team_id', teamId)
    .maybeSingle();
  return data?.role || null;
}

/**
 * Verifies the caller belongs to `teamId` (optionally requiring officer/owner),
 * throwing a { status } error otherwise -- the standard guard at the top of
 * every team-scoped action. Returns the caller's role on that team.
 */
async function assertTeamMembership(supabase, accountId, teamId, { requireOfficer = false } = {}) {
  if (!teamId) throw Object.assign(new Error('teamId required'), { status: 400 });
  const role = await getTeamRole(supabase, accountId, teamId);
  if (!role) throw Object.assign(new Error('You are not a member of this team'), { status: 403 });
  if (requireOfficer && !isOfficerRole(role)) throw Object.assign(new Error('Officers only'), { status: 403 });
  return role;
}

module.exports = { getMyTeams, getTeamRole, assertTeamMembership, isOfficerRole };
