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

const PROFILE_REGIONS = ['us', 'eu', 'kr', 'tw'];

// Blizzard spells realms as slugs ("azjolnerub", "area-52"); RaidLead's roster
// may say "azjol-nerub" or "Aggra (Português)". Compare without accents or
// punctuation. Names keep their accents (Häzey and Hazey are different
// characters) but ignore case.
const realmKey = r => String(r || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const nameKey  = n => String(n || '').normalize('NFC').toLocaleLowerCase();
const charKey  = (region, name, realm) => `${region}|${nameKey(name)}|${realmKey(realm)}`;

// RaidLead's "oceanic" is Blizzard's US region.
const blizzardRegion = r => (!r || r === 'oceanic' ? 'us' : String(r).toLowerCase());

// Every WoW character on the signed-in player's Battle.net account, across
// regions, from their sign-in access token. null if Blizzard couldn't be
// read at all (so a failed read never wipes the saved list).
async function fetchAccountCharacters(accessToken) {
  const results = await Promise.all(PROFILE_REGIONS.map(async region => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(`https://${region}.api.blizzard.com/profile/user/wow?namespace=profile-${region}&locale=en_US`, {
        headers: { Authorization: `Bearer ${accessToken}` }, signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (resp.status === 404) return [];            // no WoW account in this region
      if (!resp.ok) return null;
      const data = await resp.json();
      return (data.wow_accounts || []).flatMap(a => a.characters || []).map(c => ({
        id:        c.id,
        name:      c.name,
        realmSlug: c.realm?.slug || '',
        realmName: c.realm?.name || c.realm?.slug || '',
        region,
        class:     (c.playable_class?.name || '').toLowerCase() || null,
        level:     c.level || null,
      })).filter(c => c.name && c.realmSlug);
    } catch (e) {
      return null;
    }
  }));
  if (results.every(r => r === null)) return null;
  return results.filter(Boolean).flat();
}

async function saveAccountCharacters(supabase, accountId, characters) {
  await supabase.from('accounts')
    .update({ wow_characters: characters, wow_characters_synced_at: new Date().toISOString() })
    .eq('id', accountId);
}

// Connect a roster character to an account (verified by Blizzard), and make
// a Viewer on that team a Member -- they have a character there now.
async function connect(supabase, teamId, characterId, accountId) {
  await supabase.from('characters').update({ account_id: accountId, claim_verified: true }).eq('id', characterId).eq('team_id', teamId);
  await supabase.from('team_members').update({ role: 'member' }).eq('team_id', teamId).eq('account_id', accountId).eq('role', 'viewer');
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
    const mine = new Set(acct.wow_characters.map(c => charKey(c.region, c.name, c.realmSlug)));
    const mySync = Date.parse(acct.wow_characters_synced_at || 0);

    const { data: memberships } = await supabase
      .from('team_members').select('team_id, teams ( guilds ( region ) )').eq('account_id', accountId);
    for (const m of memberships || []) {
      const region = blizzardRegion(m.teams?.guilds?.region);
      const { data: roster } = await supabase
        .from('characters').select('id, name, server, account_id, claim_verified')
        .eq('team_id', m.team_id).eq('active', true);
      for (const c of roster || []) {
        if (!c.server || !mine.has(charKey(region, c.name, c.server))) continue;
        if (c.account_id === accountId) {
          if (!c.claim_verified) await supabase.from('characters').update({ claim_verified: true }).eq('id', c.id);
          continue;
        }
        if (c.account_id) {
          const { data: holder } = await supabase
            .from('accounts').select('wow_characters, wow_characters_synced_at').eq('id', c.account_id).maybeSingle();
          const holderHasIt = (holder?.wow_characters || []).some(h => charKey(h.region, h.name, h.realmSlug) === charKey(region, c.name, c.server));
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
      supabase.from('teams').select('guilds ( region )').eq('id', teamId).maybeSingle(),
      supabase.from('team_members').select('account_id, accounts ( wow_characters )').eq('team_id', teamId),
    ]);
    const region = blizzardRegion(team?.guilds?.region);
    const owners = new Map(); // character key -> account ids whose Battle.net lists it
    for (const m of members || []) {
      const acct = Array.isArray(m.accounts) ? m.accounts[0] : m.accounts;
      for (const c of acct?.wow_characters || []) {
        const k = charKey(c.region, c.name, c.realmSlug);
        owners.set(k, [...(owners.get(k) || []), m.account_id]);
      }
    }
    if (!owners.size) return connected;

    let q = supabase.from('characters').select('id, name, server, account_id').eq('team_id', teamId).eq('active', true).is('account_id', null);
    if (characterIds) q = q.in('id', characterIds);
    const { data: roster } = await q;
    for (const c of roster || []) {
      if (!c.server) continue;
      const who = owners.get(charKey(region, c.name, c.server)) || [];
      if (who.length !== 1) continue; // nobody, or more than one member's data lists it
      await connect(supabase, teamId, c.id, who[0]);
      connected.push(c.name);
    }
  } catch (e) { /* best-effort */ }
  return connected;
}

module.exports = {
  fetchAccountCharacters, saveAccountCharacters, syncAccountClaims, linkRosterCharacters,
  realmKey, nameKey, charKey, blizzardRegion,
};
