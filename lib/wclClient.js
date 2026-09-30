// ============================================================
//  lib/wclClient.js — server-side Warcraft Logs API calls using a team's
//  own WCL client credentials (stored encrypted on the team row), plus
//  character identity lookups that survive renames and realm transfers.
// ============================================================
const { decrypt } = require('./crypto');
const { gameFor } = require('./games');

// Every team brings its own WCL API client, so tokens are cached per client
// ID -- one team's usage never draws on another's quota. Each WoW version
// has its own Warcraft Logs site (www, classic, fresh, vanilla) with its
// own token and API endpoints, so the cache key includes the site too.
const tokenCache = new Map(); // "host|clientId" -> { token, expiresAt }
const wclBase = creds => `https://${creds.host || 'www'}.warcraftlogs.com`;

// A team's own WCL API credentials (decrypted) and its version's Warcraft
// Logs site, or null if it hasn't connected any -- or its version has no
// Warcraft Logs site yet (Forever, until launch).
async function teamWclCredentials(supabase, teamId) {
  if (!teamId) return null;
  const { data: teamRow } = await supabase
    .from('teams').select('wcl_client_id, wcl_client_secret_enc, guilds ( game )').eq('id', teamId).single();
  if (!teamRow?.wcl_client_id || !teamRow?.wcl_client_secret_enc) return null;
  const host = gameFor(teamRow.guilds?.game).sources.wclHost;
  if (!host) return null;
  try {
    return { clientId: teamRow.wcl_client_id, clientSecret: decrypt(teamRow.wcl_client_secret_enc), host };
  } catch (e) {
    console.error('[wcl] failed to decrypt credentials for team', teamId, e.message);
    return null;
  }
}

// An OAuth token for these credentials, reused until a minute before it
// expires. Throws (err.tokenFailed) when WCL won't issue one.
async function wclToken(creds) {
  const cacheKey = `${creds.host || 'www'}|${creds.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;
  const resp = await fetch(`${wclBase(creds)}/oauth/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw Object.assign(new Error('WCL token request failed'), { tokenFailed: true });
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + ((data.expires_in || 3600) - 60) * 1000 });
  return data.access_token;
}

// Runs one GraphQL query; returns WCL's whole response ({ data, errors }).
async function wclRequest(creds, query, variables) {
  const token = await wclToken(creds);
  const resp = await fetch(`${wclBase(creds)}/api/v2/client`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(variables ? { query, variables } : { query }),
  });
  return await resp.json();
}

// Runs one GraphQL query (with optional variables) against WCL using the
// team's credentials. Returns the `data` object, or null if the team has no
// credentials connected or anything fails -- callers treat WCL as optional.
async function teamWclQuery(supabase, teamId, query, variables) {
  const creds = await teamWclCredentials(supabase, teamId);
  if (!creds) return null;
  try {
    return (await wclRequest(creds, query, variables || {}))?.data || null;
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

module.exports = { teamWclCredentials, wclRequest, teamWclQuery, wclCharacterIdFromUrl, resolveCurrentCharacter };
