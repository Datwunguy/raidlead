// ============================================================
//  lib/guildVerification.js — who can do what with a guild, per Blizzard:
//   - set one up in RaidLead (create it, start a team under it, or change
//     its name/server/region -- api/guild.js): their highest-ranked
//     character in that guild must be the Guild Master or one of the next
//     two ranks (checkGuildLeader);
//   - join one of its teams without an invite (api/auth.js): any rank
//     (checkGuildMember);
//   - and the list of guilds their characters are in, for the Create and
//     Join screens (listMyGuilds).
//
//  The person's characters are the ones on their own Battle.net account
//  (accounts.wow_characters, saved at sign-in -- see lib/characterClaims.js),
//  matched to Blizzard's live guild roster by character id. Every character
//  counts, alts included: whichever is ranked highest decides.
// ============================================================
const { readGuildRoster, readCharacterGuild } = require('./battleNet');
const { charKey, nameKey, realmKey, blizzardRegion } = require('./characterClaims');
const { gameFor, blizzardProfileNamespace } = require('./games');

const MAX_CREATOR_RANK = 2; // 0 = Guild Master, then the guild's next two ranks

const fail = (status, code, error) => ({ ok: false, status, code, error });

// This person's best-ranked character in a roster (by Blizzard character id,
// else name + realm), among their characters in that region and WoW version.
function bestRankIn(roster, chars, region, game) {
  const bRegion = blizzardRegion(region);
  const version = game || 'retail';
  const mine = (chars || []).filter(c => c.region === bRegion && (c.game || 'retail') === version);
  const ids = new Set(mine.map(c => c.id).filter(id => id != null));
  const keys = new Set(mine.map(c => charKey(bRegion, c.name, c.realmSlug, version)));
  const inGuild = roster.members.filter(m => Number.isInteger(m.rank)
    && ((m.id != null && ids.has(m.id)) || keys.has(charKey(bRegion, m.name, m.realmSlug, version))));
  return inGuild.length ? inGuild.reduce((a, b) => (b.rank < a.rank ? b : a)) : null;
}

async function accountCharacters(supabase, accountId) {
  const { data: acct } = await supabase.from('accounts').select('wow_characters').eq('id', accountId).maybeSingle();
  return Array.isArray(acct?.wow_characters) ? acct.wow_characters : [];
}

/**
 * Is this person in the guild, at rank maxRank or better?
 * { ok: true, verification: 'blizzard', guildName, realmName, character, rank }
 *   -- guildName / realmName are Blizzard's own spelling;
 * { ok: true, verification: 'not_available' } -- a WoW version Blizzard's API
 *   doesn't cover yet (e.g. Forever before launch), when allowWithoutApi;
 * { ok: false, status, code, error } -- refused, with a message saying why.
 */
async function checkGuildRank(supabase, accountId, { guild, server, region, game }, { maxRank, allowWithoutApi }) {
  const roster = await readGuildRoster(region, server, guild, game);
  if (roster.status === 'no_api') {
    return allowWithoutApi ? { ok: true, verification: 'not_available' }
      : fail(403, 'NO_BLIZZARD_API', `Blizzard can't confirm guild members for ${gameFor(game).label} yet -- ask an officer for an invite code.`);
  }
  if (roster.status === 'unavailable') {
    return fail(503, 'BLIZZARD_UNAVAILABLE', "Couldn't reach Blizzard to confirm you're in this guild. Try again in a few minutes.");
  }
  if (roster.status === 'not_found') {
    return fail(404, 'GUILD_NOT_FOUND', `Blizzard doesn't have a guild called "${guild}" on ${server} (${String(region || 'us').toUpperCase()}). `
      + 'Check the spelling, realm and region -- a guild that was just made or renamed can take a while to show up.');
  }

  const chars = await accountCharacters(supabase, accountId);
  if (!chars.length) {
    return fail(403, 'NEED_BNET_CHARACTERS', "RaidLead needs your characters from Battle.net to confirm you're in this guild. Sync from Battle.net, then try again.");
  }
  const best = bestRankIn(roster, chars, region, game);
  if (!best) {
    return fail(403, 'NOT_IN_GUILD', `None of your Battle.net characters are in ${roster.guild.name}, according to Blizzard. `
      + "If you just joined or made a new character, log into it in WoW, then Sync from Battle.net and try again.");
  }
  if (best.rank > maxRank) {
    return fail(403, 'RANK_TOO_LOW', `Only ${roster.guild.name}'s Guild Master and the next ${maxRank} ranks can set it up in RaidLead -- `
      + `your highest-ranked character there is ${best.name} (rank ${best.rank}). Ask one of them to create it and invite you.`);
  }
  return { ok: true, verification: 'blizzard', guildName: roster.guild.name, realmName: roster.guild.realmName || null, character: best.name, rank: best.rank };
}

// Setting a guild up: Guild Master or the next two ranks. A version Blizzard's
// API doesn't cover yet is allowed, and shown as not verified.
const checkGuildLeader = (supabase, accountId, guild) => checkGuildRank(supabase, accountId, guild, { maxRank: MAX_CREATOR_RANK, allowWithoutApi: true });
// Joining one of its teams without an invite: any rank -- but only where
// Blizzard can actually confirm it.
const checkGuildMember = (supabase, accountId, guild) => checkGuildRank(supabase, accountId, guild, { maxRank: Infinity, allowWithoutApi: false });

// What gets saved on the guild row (sql/2026_10_guild_verification.sql).
function verificationFields(check) {
  return {
    verification: check.verification,
    verified_at: new Date().toISOString(),
    verified_character: check.character || null,
    verified_rank: Number.isInteger(check.rank) ? check.rank : null,
  };
}

// ── The guilds a person's characters are in ─────────────────────────────
const MAX_CHARACTER_LOOKUPS = 60; // highest-level first; a guild nobody above that is in is rare
const LOOKUP_CONCURRENCY = 8;
const MAX_GUILDS = 20;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/**
 * Every guild this person's characters are in (per Blizzard), with their
 * best rank there, whether they can set it up in RaidLead, and its RaidLead
 * teams if it has any:
 *   { needSync, incomplete, guilds: [{ name, realmName, realmSlug, region, game,
 *       character, rank, canCreate, teams: [{ teamId, name, joined, role }] }] }
 * needSync: no Battle.net characters saved yet. incomplete: Blizzard didn't
 * answer for some of them (the list may be missing a guild -- try again).
 * Versions Blizzard's API doesn't cover (Forever) don't appear.
 */
async function listMyGuilds(supabase, accountId) {
  const chars = await accountCharacters(supabase, accountId);
  if (!chars.length) return { needSync: true, incomplete: false, guilds: [] };

  const lookups = chars
    .filter(c => c.name && c.realmSlug && blizzardProfileNamespace(gameFor(c.game || 'retail'), c.region))
    .sort((a, b) => (b.level || 0) - (a.level || 0))
    .slice(0, MAX_CHARACTER_LOOKUPS);
  const found = await mapLimit(lookups, LOOKUP_CONCURRENCY, c => readCharacterGuild(c.region, c.realmSlug, c.name, c.game || 'retail'));
  let incomplete = found.some(r => r.status === 'unavailable');

  const byGuild = new Map();
  lookups.forEach((c, i) => {
    const g = found[i].status === 'ok' && found[i].guild;
    if (!g) return;
    const game = c.game || 'retail';
    const key = `${game}|${c.region}|${realmKey(g.realmSlug)}|${nameKey(g.name)}`;
    if (!byGuild.has(key)) byGuild.set(key, { name: g.name, realmName: g.realmName, realmSlug: g.realmSlug, region: c.region, game });
  });
  const guilds = [...byGuild.values()].slice(0, MAX_GUILDS);

  // Their best rank in each (the roster, not the profile, has ranks)
  await Promise.all(guilds.map(async g => {
    const roster = await readGuildRoster(g.region, g.realmSlug, g.name, g.game);
    if (roster.status !== 'ok') { incomplete = true; g.rank = null; g.character = null; return; }
    const best = bestRankIn(roster, chars, g.region, g.game);
    g.name = roster.guild.name || g.name;
    g.realmName = roster.guild.realmName || g.realmName;
    g.rank = best ? best.rank : null;
    g.character = best ? best.name : null;
  }));

  // Which already have RaidLead teams, and which of those they're on
  const { data: memberships } = await supabase.from('team_members').select('team_id, role').eq('account_id', accountId);
  const myRole = new Map((memberships || []).map(m => [m.team_id, m.role]));
  for (const g of guilds) {
    const { data: rows } = await supabase.from('guilds').select('id, name, server, region, game')
      .eq('game', g.game).ilike('name', g.name.replace(/[\\%_]/g, '\\$&'));
    const ids = (rows || []).filter(r => realmKey(r.server) === realmKey(g.realmSlug) && blizzardRegion(r.region) === g.region).map(r => r.id);
    const { data: teams } = ids.length ? await supabase.from('teams').select('id, name, guild_id').in('guild_id', ids) : { data: [] };
    g.teams = (teams || []).map(t => ({ teamId: t.id, name: t.name, joined: myRole.has(t.id), role: myRole.get(t.id) || null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    g.canCreate = Number.isInteger(g.rank) && g.rank <= MAX_CREATOR_RANK;
  }

  guilds.sort((a, b) => (Number(b.canCreate) - Number(a.canCreate)) || a.name.localeCompare(b.name));
  return { needSync: false, incomplete, guilds };
}

module.exports = { checkGuildLeader, checkGuildMember, verificationFields, listMyGuilds, bestRankIn, MAX_CREATOR_RANK };
