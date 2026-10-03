// ============================================================
//  lib/characterClaims.js — which roster characters belong to whom, straight
//  from Blizzard. Sign-in asks Battle.net for the wow.profile permission, and
//  the character list on the player's own Battle.net account is saved to
//  their RaidLead account. Roster characters that match (same name + realm,
//  in the team's region) are connected to them automatically -- no claiming.
//  Used by api/auth.js (sign-in, joining a team), api/roster.js (adding a
//  character) and api/wowaudit.js (roster imports).
//
//  Everything here is best-effort: a Blizzard or database hiccup never
//  blocks signing in, joining, or adding a character.
// ============================================================

const { GAMES, GAME_ORDER, blizzardProfileNamespace } = require('./games');

const PROFILE_REGIONS = ['us', 'eu', 'kr', 'tw'];

// Blizzard spells realms as slugs ("azjolnerub", "area-52"); RaidLead's roster
// may say "azjol-nerub" or "Aggra (Português)". Compare without accents or
// punctuation. Names keep their accents (Häzey and Hazey are different
// characters) but ignore case. The WoW version is part of it too: a Retail
// Datwunguy and a Classic one are different characters.
const realmKey = r => String(r || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nameKey  = n => String(n || '').normalize('NFC').toLocaleLowerCase();
const charKey  = (region, name, realm, game = 'retail') => `${game || 'retail'}|${region}|${nameKey(name)}|${realmKey(realm)}`;

// RaidLead's "oceanic" is Blizzard's US region.
const blizzardRegion = r => (!r || r === 'oceanic' ? 'us' : String(r).toLowerCase());

// One Blizzard lookup per region + WoW version, all at once. Each comes back
// { region, game, status, characters }: status 'ok' with the characters
// there (none is fine -- Blizzard says 404), or what went wrong (an HTTP
// status, 'timeout', 'error') with characters null. A busy or slow Blizzard
// gets one more try; 401/403 mean the sign-in didn't include permission to
// read characters, which trying again won't change.
const LOOKUP_TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 1000;
const retryable = status => status === 'timeout' || status === 'error' || status === 429 || status >= 500;

async function readLookup(accessToken, { region, game, namespace }) {
  for (let attempt = 0; ; attempt++) {
    let status;
    try {
      const resp = await fetch(`https://${region}.api.blizzard.com/profile/user/wow?namespace=${namespace}&locale=en_US`, {
        headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (resp.status === 404) return { region, game, status: 'ok', characters: [] };
      if (resp.ok) {
        const data = await resp.json();
        const characters = (data.wow_accounts || []).flatMap(a => a.characters || []).map(c => ({
          id:        c.id,
          name:      c.name,
          realmSlug: c.realm?.slug || '',
          realmName: c.realm?.name || c.realm?.slug || '',
          region,
          game,
          class:     (c.playable_class?.name || '').toLowerCase() || null,
          level:     c.level || null,
        })).filter(c => c.name && c.realmSlug);
        return { region, game, status: 'ok', characters };
      }
      status = resp.status;
    } catch (e) {
      status = e.name === 'TimeoutError' ? 'timeout' : 'error';
    }
    if (attempt > 0 || !retryable(status)) return { region, game, status, characters: null };
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
  }
}

// Every WoW character on the signed-in player's Battle.net account, across
// regions and versions (Retail, Classic, ...), each tagged with its version.
function readAccountCharacters(accessToken) {
  const lookups = PROFILE_REGIONS.flatMap(region => GAME_ORDER
    .map(game => ({ region, game, namespace: blizzardProfileNamespace(GAMES[game], region) }))
    .filter(l => l.namespace)); // a version Blizzard's API doesn't cover yet
  return Promise.all(lookups.map(l => readLookup(accessToken, l)));
}

// The saved list, updated: each region + version that answered replaces its
// characters; one that didn't keeps what was saved, so a slow or failed
// lookup never wipes anyone's characters.
function mergeCharacters(saved, results) {
  const answered = new Set(results.filter(r => r.characters).map(r => `${r.game}|${r.region}`));
  return [
    ...(Array.isArray(saved) ? saved : []).filter(c => !answered.has(`${c.game || 'retail'}|${c.region}`)),
    ...results.flatMap(r => r.characters || []),
  ];
}

// How the account's last Battle.net sync went (accounts.wow_sync): the page
// waits on it after sign-in, and it's there to look at when one fails.
//   { status: 'syncing' | 'ok' | 'partial' | 'no_permission' | 'failed',
//     startedAt, finishedAt, characters, connected: [names], failed: ['us/era: 503'] }
async function recordSync(supabase, accountId, sync) {
  const { error } = await supabase.from('accounts').update({ wow_sync: sync }).eq('id', accountId);
  if (error) console.error('[bnet sync] could not record status:', error.message);
}

// The whole sync after a sign-in -- read Blizzard, save, connect matching
// roster characters -- run after the sign-in has already gone through (the
// page waits for the result), and recorded with recordSync.
async function syncAccountCharacters(supabase, accountId, accessToken, startedAt = new Date().toISOString()) {
  let sync;
  try {
    const results = await readAccountCharacters(accessToken);
    const failed = results.filter(r => !r.characters).map(r => `${r.region}/${r.game}: ${r.status}`);
    // Refused (401/403) with not one character found anywhere: no permission
    // to read them -- even if versions they don't play said "none here".
    const denied = results.some(r => r.status === 401 || r.status === 403) && !results.some(r => r.characters?.length);
    if (denied || failed.length === results.length) {
      sync = { status: denied ? 'no_permission' : 'failed', failed };
    } else {
      const { data: acct } = await supabase.from('accounts').select('wow_characters').eq('id', accountId).maybeSingle();
      const characters = mergeCharacters(acct?.wow_characters, results);
      const { error } = await supabase.from('accounts')
        .update({ wow_characters: characters, wow_characters_synced_at: new Date().toISOString() })
        .eq('id', accountId);
      if (error) throw new Error(error.message);
      const connected = await syncAccountClaims(supabase, accountId);
      sync = { status: failed.length ? 'partial' : 'ok', characters: characters.length, connected, failed };
    }
  } catch (e) {
    sync = { status: 'failed', error: e.message };
  }
  sync = { ...sync, startedAt, finishedAt: new Date().toISOString() };
  if (sync.status !== 'ok') console.error('[bnet sync]', accountId, JSON.stringify(sync));
  await recordSync(supabase, accountId, sync);
  return sync;
}

// Someone who has a character on a team now: a Viewer there becomes a Member.
// (Battle.net connecting one, below, or an officer assigning one --
// api/members.js assignCharacter.) True if they were a Viewer.
async function promoteViewer(supabase, teamId, accountId) {
  const { data } = await supabase.from('team_members').update({ role: 'member' })
    .eq('team_id', teamId).eq('account_id', accountId).eq('role', 'viewer').select('account_id');
  return !!data?.length;
}

// Connect a roster character to an account (verified by Blizzard), and make
// a Viewer on that team a Member -- they have a character there now.
async function connect(supabase, teamId, characterId, accountId) {
  await supabase.from('characters').update({ account_id: accountId, claim_verified: true }).eq('id', characterId).eq('team_id', teamId);
  await promoteViewer(supabase, teamId, accountId);
}

// After sign-in (the account's list was just read from Blizzard): connect
// every roster character, on every team this account is on, that Blizzard
// says is theirs. That includes taking one back from another member who
// claimed it -- unless that member's own Blizzard data is newer and also
// lists it, which is the one case with room for doubt; officers handle
// those. Returns the names newly connected.
async function syncAccountClaims(supabase, accountId) {
  const connected = [];
  try {
    const { data: acct } = await supabase
      .from('accounts').select('wow_characters, wow_characters_synced_at').eq('id', accountId).maybeSingle();
    if (!Array.isArray(acct?.wow_characters)) return connected;
    const mine = new Set(acct.wow_characters.map(c => charKey(c.region, c.name, c.realmSlug, c.game)));
    const mySync = Date.parse(acct.wow_characters_synced_at || 0);

    const { data: memberships } = await supabase
      .from('team_members').select('team_id, teams ( guilds ( region, game ) )').eq('account_id', accountId);
    for (const m of memberships || []) {
      const region = blizzardRegion(m.teams?.guilds?.region);
      const game = m.teams?.guilds?.game || 'retail';
      const { data: roster } = await supabase
        .from('characters').select('id, name, server, account_id, claim_verified')
        .eq('team_id', m.team_id).eq('active', true);
      for (const c of roster || []) {
        if (!c.server || !mine.has(charKey(region, c.name, c.server, game))) continue;
        if (c.account_id === accountId) {
          if (!c.claim_verified) await supabase.from('characters').update({ claim_verified: true }).eq('id', c.id);
          continue;
        }
        if (c.account_id) {
          const { data: holder } = await supabase
            .from('accounts').select('wow_characters, wow_characters_synced_at').eq('id', c.account_id).maybeSingle();
          const holderHasIt = (holder?.wow_characters || []).some(h => charKey(h.region, h.name, h.realmSlug, h.game) === charKey(region, c.name, c.server, game));
          if (holderHasIt && Date.parse(holder.wow_characters_synced_at || 0) > mySync) continue; // doubt: leave it to officers
        }
        await connect(supabase, m.team_id, c.id, accountId);
        connected.push(c.name);
      }
    }
  } catch (e) { /* best-effort */ }
  return connected;
}

// After characters are added to a roster (by hand or by an import): connect
// each unclaimed one to the team member whose Battle.net account has it --
// only when exactly one member's does. (Pass null for every unclaimed
// character on the team.) Returns the names connected.
async function linkRosterCharacters(supabase, teamId, characterIds = null) {
  const connected = [];
  try {
    const [{ data: team }, { data: members }] = await Promise.all([
      supabase.from('teams').select('guilds ( region, game )').eq('id', teamId).maybeSingle(),
      supabase.from('team_members').select('account_id, accounts ( wow_characters )').eq('team_id', teamId),
    ]);
    const region = blizzardRegion(team?.guilds?.region);
    const game = team?.guilds?.game || 'retail';
    const owners = new Map(); // character key -> account ids whose Battle.net lists it
    for (const m of members || []) {
      const acct = Array.isArray(m.accounts) ? m.accounts[0] : m.accounts;
      for (const c of acct?.wow_characters || []) {
        const k = charKey(c.region, c.name, c.realmSlug, c.game);
        owners.set(k, [...(owners.get(k) || []), m.account_id]);
      }
    }
    if (!owners.size) return connected;

    let q = supabase.from('characters').select('id, name, server, account_id').eq('team_id', teamId).eq('active', true).is('account_id', null);
    if (characterIds) q = q.in('id', characterIds);
    const { data: roster } = await q;
    for (const c of roster || []) {
      if (!c.server) continue;
      const who = owners.get(charKey(region, c.name, c.server, game)) || [];
      if (who.length !== 1) continue; // nobody, or more than one member's data lists it
      await connect(supabase, teamId, c.id, who[0]);
      connected.push(c.name);
    }
  } catch (e) { /* best-effort */ }
  return connected;
}

module.exports = {
  readAccountCharacters, mergeCharacters, recordSync, syncAccountCharacters, syncAccountClaims, linkRosterCharacters, promoteViewer,
  realmKey, nameKey, charKey, blizzardRegion,
};
