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
const { gameFor, blizzardProfileNamespace } = require('./games');

// Blizzard keeps each WoW version's profiles in its own namespace
// (profile-us, profile-classic-us, ...). null: a version its API doesn't cover.
const profileNamespace = (game, apiRegion) => blizzardProfileNamespace(gameFor(typeof game === 'string' ? game : game?.id), apiRegion);

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
// Only a real region ever reaches a hostname (https://<region>.api.blizzard.com
// -- anything else could send the app token to another server); else 'us'.
const API_REGIONS = ['us', 'eu', 'kr', 'tw', 'cn'];
function toBattleNetRegion(region) {
  const r = String(region || 'us').toLowerCase();
  if (r === 'oceanic') return 'us';
  return API_REGIONS.includes(r) ? r : 'us';
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
async function fetchGuildRoster(region, realm, guildName, game) {
  try {
    const token = await getAppAccessToken();
    const apiRegion = toBattleNetRegion(region);
    const realmSlug = slugifyServer(realm);
    const guildSlug = slugifyGuildName(guildName);
    const namespace = profileNamespace(game, apiRegion);
    if (!namespace) return null;

    const [rosterResp, classNames] = await Promise.all([
      fetch(
        `https://${apiRegion}.api.blizzard.com/data/wow/guild/${realmSlug}/${guildSlug}/roster` +
        `?namespace=${namespace}&locale=en_US`,
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
async function fetchCharacterSpec(region, realm, characterName, game) {
  try {
    const token = await getAppAccessToken();
    const apiRegion = toBattleNetRegion(region);
    const realmSlug = slugifyServer(realm);
    const namespace = profileNamespace(game, apiRegion);
    if (!namespace) return null;

    const resp = await fetch(
      `https://${apiRegion}.api.blizzard.com/profile/wow/character/${realmSlug}/${encodeURIComponent(characterName.toLowerCase())}/specializations` +
      `?namespace=${namespace}&locale=en_US`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!resp.ok) return null;
    return specFromSpecializations(await resp.json());
  } catch (e) {
    return null;
  }
}

// Retail names the active spec outright. Classic's talent trees don't have
// one -- the tree they've put the most points into is their spec.
function specFromSpecializations(data) {
  if (data?.active_specialization?.name) return data.active_specialization.name;
  const groups = data?.specialization_groups || [];
  const group = groups.find(g => g.is_active) || groups[0];
  const trees = (group?.specializations || []).filter(t => t.specialization_name && t.spent_points > 0);
  trees.sort((a, b) => b.spent_points - a.spent_points);
  return trees[0]?.specialization_name || null;
}

// A character's class, level, spec and item level straight from Blizzard --
// how versions Raider.io doesn't cover (TBC Anniversary, Classic Era) look
// characters up. Same shape as lib/raiderioCharacter.js's summary; null if
// Blizzard doesn't know them (or doesn't cover the version).
async function fetchCharacterProfile(region, realm, characterName, game) {
  try {
    const token = await getAppAccessToken();
    const apiRegion = toBattleNetRegion(region);
    const realmSlug = slugifyServer(realm);
    const namespace = profileNamespace(game, apiRegion);
    if (!namespace) return null;
    const base = `https://${apiRegion}.api.blizzard.com/profile/wow/character/${realmSlug}/${encodeURIComponent(characterName.toLowerCase())}`;
    const headers = { Authorization: `Bearer ${token}` };
    const [profileResp, specResp] = await Promise.all([
      fetch(`${base}?namespace=${namespace}&locale=en_US`, { headers }),
      fetch(`${base}/specializations?namespace=${namespace}&locale=en_US`, { headers }).catch(() => null),
    ]);
    if (!profileResp.ok) return null;
    const p = await profileResp.json();
    const spec = specResp?.ok ? specFromSpecializations(await specResp.json()) : (p.active_spec?.name || null);
    return {
      name:      p.name || characterName,
      realmName: p.realm?.name || realm,
      class:     p.character_class?.name ? p.character_class.name.toLowerCase() : null,
      spec,
      level:     p.level || null,
      ilvl:      p.equipped_item_level || p.average_item_level || null,
    };
  } catch (e) {
    return null;
  }
}

module.exports = { getAppAccessToken, toBattleNetRegion, fetchGuildRoster, fetchCharacterSpec, fetchCharacterProfile, specFromSpecializations };
