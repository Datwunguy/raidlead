// ============================================================
//  lib/wclZone.js — resolves a WCL zone ID to its display name
//  (e.g. 53 -> "The Venomous Abyss") using the team's own WCL API
//  credentials.
//
//  zone_id is easy to get (it's the ?zone= param in a pasted WCL Guild
//  Progress URL), but that URL carries no name -- this backfills
//  teams.zone_name so the Roster stat card and the Progress tab (which
//  derives the current raid from the zone name) both have a real name
//  to work with instead of just a number.
// ============================================================
const { decrypt } = require('./crypto');

async function lookupWclZoneName(supabase, teamId, zoneId) {
  if (!teamId || !zoneId) return null;

  const { data: teamRow } = await supabase
    .from('teams').select('wcl_client_id, wcl_client_secret_enc').eq('id', teamId).single();
  if (!teamRow?.wcl_client_id || !teamRow?.wcl_client_secret_enc) return null;

  let clientSecret;
  try { clientSecret = decrypt(teamRow.wcl_client_secret_enc); } catch (e) { return null; }

  try {
    const tokenResp = await fetch('https://www.warcraftlogs.com/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${teamRow.wcl_client_id}:${clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.access_token) return null;

    const resp = await fetch('https://www.warcraftlogs.com/api/v2/client', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tokenData.access_token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query { worldData { zones { id name } } }' }),
    });
    const data = await resp.json();
    const zones = data?.data?.worldData?.zones || [];
    const zone = zones.find(z => z.id === zoneId);
    return zone?.name || null;
  } catch (e) {
    return null;
  }
}

// Looks up and persists the zone name onto the team row if it's missing.
// Returns the resolved name (existing or newly backfilled), or null.
async function ensureZoneName(supabase, team) {
  if (team?.zone_name) return team.zone_name;
  if (!team?.id || !team?.zone_id) return null;

  const name = await lookupWclZoneName(supabase, team.id, team.zone_id);
  if (name) {
    await supabase.from('teams').update({ zone_name: name }).eq('id', team.id);
    team.zone_name = name;
  }
  return name;
}

module.exports = { lookupWclZoneName, ensureZoneName };
