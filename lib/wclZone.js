// ============================================================
//  lib/wclZone.js — WCL zone lookups using a team's own WCL API
//  credentials: id <-> name in either direction, plus detecting whichever
//  zone is currently live (excluding PTR content and Mythic+ season
//  wrapper zones, which show up in the same list as real raids).
//
//  Raider.io (see lib/raiderioRaids.js) is the primary, credential-free
//  source for "what's the current raid" -- these are used to enrich that
//  result with a real WCL zone id when the team has credentials
//  connected (needed for Scores/Mitigation), and as the last-resort
//  fallback for teams that don't, if Raider.io itself fails to resolve
//  anything. See api/roster.js's advanceSeason action.
// ============================================================
const { decrypt } = require('./crypto');

// Fetches this team's raw WCL zone list ({id, name, frozen} per zone), or
// null if WCL credentials aren't connected -- the shared building block
// for every WCL zone lookup below, in either direction (name -> id here,
// id -> name in lookupWclZoneName, "what's currently live" in
// detectCurrentWclZone).
async function fetchWclZones(supabase, teamId) {
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
      body: JSON.stringify({ query: 'query { worldData { zones { id name frozen } } }' }),
    });
    const data = await resp.json();
    return data?.data?.worldData?.zones || null;
  } catch (e) {
    return null;
  }
}

async function lookupWclZoneName(supabase, teamId, zoneId) {
  if (!teamId || !zoneId) return null;
  const zones = await fetchWclZones(supabase, teamId);
  if (!zones) return null;
  const zone = zones.find(z => z.id === zoneId);
  return zone?.name || null;
}

// Finds the WCL zone id matching a zone name exactly (case-insensitive) --
// used to enrich a Raider.io-resolved raid with its WCL zone number, for
// teams that have WCL credentials connected. Scores/Mitigation need a real
// WCL zone id to function; a credential-less team simply won't get one
// here, which is fine since those features are already unavailable to
// them regardless.
async function lookupWclZoneIdByName(supabase, teamId, zoneName) {
  if (!teamId || !zoneName) return null;
  const zones = await fetchWclZones(supabase, teamId);
  if (!zones) return null;
  const match = zones.find(z => (z.name || '').toLowerCase() === zoneName.toLowerCase());
  return match?.id ?? null;
}

// Same PTR/season-name exclusion as the client-side detectCurrentZone() in
// public/app.js -- kept in sync by hand since there's no easy way to share
// the literal function between browser JS and this server module. Used
// only as advanceSeason's last-resort fallback, for when Raider.io itself
// can't resolve anything (network hiccup, or a brand-new expansion not in
// its static data yet) but the team does have WCL credentials to fall
// back on.
async function detectCurrentWclZone(supabase, teamId) {
  const zones = await fetchWclZones(supabase, teamId);
  if (!zones) return null;
  const active = zones.filter(z =>
    !z.frozen && !/\(PTR\)/i.test(z.name || '') && !/season\s*\d+/i.test(z.name || ''));
  if (active.length === 0) return null;
  active.sort((a, b) => b.id - a.id);
  return { zoneId: active[0].id, zoneName: active[0].name };
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

module.exports = { lookupWclZoneName, lookupWclZoneIdByName, detectCurrentWclZone, ensureZoneName };
