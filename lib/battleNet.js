// ============================================================
//  lib/battleNet.js — Battle.net Game Data API access for looking up a
//  guild's real roster, so officers can pick a character instead of
//  typing one in (see api/roster.js's guildRoster/guildCharacterSpec
//  actions). Uses the same registered Battle.net app as the login flow
//  in api/auth.js, just a different OAuth grant: client_credentials
//  (an app-level token, not tied to any one person's login) instead of
//  authorization_code. No new Blizzard registration needed.
// ============================================================
const { slugifyServer } = require('./serverSlug');

let tokenCache = { token: null, expiresAt: 0 };

async function getAppAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const resp = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${process.env.BNET_CLIENT_ID}:${process.env.BNET_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!resp.ok) throw new Error('Could not get a Battle.net app access token');
  const data = await resp.json();

  // Blizzard app tokens last ~24h -- cache with a safety margin so this
  // module doesn't re-request one on every single call.
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
  return tokenCache.token;
}

// Oceanic realms are hosted on US data centers -- same mapping as
// toRaiderioRegion in lib/raiderioRaids.js, just for a different API.
function toBattleNetRegion(region) {
  return region === 'oceanic' ? 'us' : (region || 'us');
}

function slugifyGuildName(name) {
  return slugifyServer(name); // same lowercase-hyphenated convention Blizzard's API expects
}

// The Guild Roster's per-member playable_class is just {id, key.href} -- no
// name -- so class names need a separate lookup. Classes never change
// (the same 13 IDs since Dragonflight added Evoker), so this is cached
// forever per region rather than re-fetched on any TTL.
const classNameCache = new Map(); // apiRegion -> {classId: className}

async function getPlayableClassNames(apiRegion) {
  if (classNameCache.has(apiRegion)) return classNameCache.get(apiRegion);
  try {
    const token = await getAppAccessToken();
    const resp = await fetch(
      `https://${apiRegion}.api.blizzard.com/data/wow/playable-class/index?namespace=static-${apiRegion}&locale=en_US`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return {};
    const data = await resp.json();
    const map = {};
    (data.classes || []).forEach(c => { map[c.id] = c.name; });
    classNameCache.set(apiRegion, map);
    return map;
  } catch (e) {
    return {};
  }
}

// Every member of a guild, straight from Blizzard -- not a crawled/cached
// third-party snapshot, so it's complete regardless of how active or
// well-known the guild is. Returns null (never throws) on any failure --
// guild not found, wrong name/server, API hiccup -- since this is always
// a nice-to-have alongside manual entry, never a hard dependency.
//
// realmSlug comes back per-member (not just once for the whole guild) --
// a guild's members can be spread across every realm in its connected-realm
// group, not all camped on the one realm the guild itself is "on".
async function fetchGuildRoster(region, realm, guildName) {
  try {
    const token = await getAppAccessToken();
    const apiRegion = toBattleNetRegion(region);
    const realmSlug = slugifyServer(realm);
    const guildSlug = slugifyGuildName(guildName);

    const [rosterResp, classNames] = await Promise.all([
      fetch(
        `https://${apiRegion}.api.blizzard.com/data/wow/guild/${realmSlug}/${guildSlug}/roster` +
        `?namespace=profile-${apiRegion}&locale=en_US`,
        { headers: { Authorization: `Bearer ${token}` } }
      ),
      getPlayableClassNames(apiRegion),
    ]);
    if (!rosterResp.ok) return null;
    const data = await rosterResp.json();

    return (data.members || []).map(m => ({
      name:      m.character?.name,
      class:     classNames[m.character?.playable_class?.id] || null,
      level:     m.character?.level || null,
      rank:      m.rank,
      realmSlug: m.character?.realm?.slug || realmSlug,
    })).filter(m => m.name);
  } catch (e) {
    return null;
  }
}

// Active spec only -- not part of the roster response, has to be looked
// up per character. Best-effort: returns null (never throws) if the
// character hasn't logged in recently enough to be in Blizzard's profile
// cache, or any other failure -- a missing spec should never block
// showing "Name -- Class" in the picker.
async function fetchCharacterSpec(region, realm, characterName) {
  try {
    const token = await getAppAccessToken();
    const apiRegion = toBattleNetRegion(region);
    const realmSlug = slugifyServer(realm);

    const resp = await fetch(
      `https://${apiRegion}.api.blizzard.com/profile/wow/character/${realmSlug}/${characterName.toLowerCase()}/specializations` +
      `?namespace=profile-${apiRegion}&locale=en_US`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.active_specialization?.name || null;
  } catch (e) {
    return null;
  }
}

module.exports = { getAppAccessToken, toBattleNetRegion, fetchGuildRoster, fetchCharacterSpec };
