// ============================================================
//  lib/wclClient.js — server-side Warcraft Logs API calls using a team's
//  own WCL client credentials (stored encrypted on the team row), plus
//  character identity lookups that survive renames and realm transfers.
// ============================================================
const { decrypt } = require('./crypto');

const tokenCache = new Map(); // clientId -> { token, expiresAt }

// Runs one GraphQL query (with optional variables) against WCL using the
// team's credentials. Returns the `data` object, or null if the team has no
// credentials connected or anything fails -- callers treat WCL as optional.
async function teamWclQuery(supabase, teamId, query, variables) {
  const { data: teamRow } = await supabase
    .from('teams').select('wcl_client_id, wcl_client_secret_enc').eq('id', teamId).single();
  if (!teamRow?.wcl_client_id || !teamRow?.wcl_client_secret_enc) return null;

  try {
    let cached = tokenCache.get(teamRow.wcl_client_id);
    if (!cached || Date.now() > cached.expiresAt) {
      const clientSecret = decrypt(teamRow.wcl_client_secret_enc);
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
      cached = { token: tokenData.access_token, expiresAt: Date.now() + ((tokenData.expires_in || 3600) - 60) * 1000 };
      tokenCache.set(teamRow.wcl_client_id, cached);
    }

    const resp = await fetch('https://www.warcraftlogs.com/api/v2/client', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cached.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
    const data = await resp.json();
    return data?.data || null;
  } catch (e) {
    return null;
  }
}

// "https://www.warcraftlogs.com/character/id/40989140" -> 40989140. These
// ID links survive renames and transfers; name-based links don't.
function wclCharacterIdFromUrl(url) {
  const m = String(url || '').match(/warcraftlogs\.com\/character\/id\/(\d+)/i);
  return m ? Number(m[1]) : null;
}

const CHARACTER_FIELDS = 'id canonicalID name server { slug name }';

// A character's CURRENT name and realm, even after a rename or realm
// transfer. WCL keeps one identity across both: an old name/realm still
// resolves to the character, and canonicalID points at its latest version
// (confirmed by other WCL API users: two different name/realm pairs for
// one character resolve to the same ID). Pass `wclCharacterId` when an ID
// link is known -- it skips the name lookup entirely. Returns
// { name, realmSlug, realmName, wclId } or null.
async function resolveCurrentCharacter(supabase, teamId, { region, name, realmSlug, wclCharacterId }) {
  const byId = id => teamWclQuery(supabase, teamId,
    `query($id: Int) { characterData { character(id: $id) { ${CHARACTER_FIELDS} } } }`, { id });

  let data = wclCharacterId
    ? await byId(wclCharacterId)
    : await teamWclQuery(supabase, teamId,
        `query($name: String, $server: String, $region: String) {
          characterData { character(name: $name, serverSlug: $server, serverRegion: $region) { ${CHARACTER_FIELDS} } } }`,
        { name, server: realmSlug, region: region === 'oceanic' ? 'us' : region }); // WCL files OCE realms under US
  let character = data?.characterData?.character;
  if (!character) return null;

  if (character.canonicalID && character.canonicalID !== character.id) {
    data = await byId(character.canonicalID);
    character = data?.characterData?.character || character;
  }
  if (!character.name || !character.server?.slug) return null;
  return {
    name:      character.name,
    realmSlug: character.server.slug,
    realmName: character.server.name || character.server.slug,
    wclId:     character.canonicalID || character.id,
  };
}

module.exports = { teamWclQuery, wclCharacterIdFromUrl, resolveCurrentCharacter };
