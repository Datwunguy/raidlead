// ============================================================
//  lib/guildVerification.js — who can set a guild up in RaidLead: someone
//  whose highest-ranked character in that guild, per Blizzard, is the Guild
//  Master or one of the next two ranks. Checked when a guild is created, a
//  team is started under one, or a guild's name/server/region is changed
//  (api/guild.js) -- anything that puts a guild's name on a team.
//
//  The person's characters are the ones on their own Battle.net account
//  (accounts.wow_characters, saved at sign-in -- see lib/characterClaims.js),
//  matched to Blizzard's live guild roster by character id. Every character
//  counts, alts included: whichever is ranked highest decides.
// ============================================================
const { readGuildRoster } = require('./battleNet');
const { charKey, blizzardRegion } = require('./characterClaims');

const MAX_CREATOR_RANK = 2; // 0 = Guild Master, then the guild's next two ranks

const fail = (status, code, error) => ({ ok: false, status, code, error });

/**
 * { ok: true, verification: 'blizzard', guildName, character, rank } -- go ahead
 *   (guildName is Blizzard's own spelling);
 * { ok: true, verification: 'not_available' } -- a WoW version Blizzard's API
 *   doesn't cover yet (e.g. Forever before launch): allowed, marked unverified;
 * { ok: false, status, code, error } -- refused, with a message saying why.
 */
async function checkGuildLeader(supabase, accountId, { guild, server, region, game }) {
  const roster = await readGuildRoster(region, server, guild, game);
  if (roster.status === 'no_api') return { ok: true, verification: 'not_available' };
  if (roster.status === 'unavailable') {
    return fail(503, 'BLIZZARD_UNAVAILABLE', "Couldn't reach Blizzard to confirm you're in this guild. Try again in a few minutes.");
  }
  if (roster.status === 'not_found') {
    return fail(404, 'GUILD_NOT_FOUND', `Blizzard doesn't have a guild called "${guild}" on ${server} (${String(region || 'us').toUpperCase()}). `
      + 'Check the spelling, realm and region -- a guild that was just made or renamed can take a while to show up.');
  }

  const { data: acct } = await supabase.from('accounts').select('wow_characters').eq('id', accountId).maybeSingle();
  const chars = Array.isArray(acct?.wow_characters) ? acct.wow_characters : [];
  if (!chars.length) {
    return fail(403, 'NEED_BNET_CHARACTERS', "RaidLead needs your characters from Battle.net to confirm you're in this guild. Sync from Battle.net, then try again.");
  }

  const bRegion = blizzardRegion(region);
  const version = game || 'retail';
  const mine = chars.filter(c => c.region === bRegion && (c.game || 'retail') === version);
  const ids = new Set(mine.map(c => c.id).filter(id => id != null));
  const keys = new Set(mine.map(c => charKey(bRegion, c.name, c.realmSlug, version)));
  const inGuild = roster.members.filter(m => Number.isInteger(m.rank)
    && ((m.id != null && ids.has(m.id)) || keys.has(charKey(bRegion, m.name, m.realmSlug, version))));
  if (!inGuild.length) {
    return fail(403, 'NOT_IN_GUILD', `None of your Battle.net characters are in ${roster.guild.name}, according to Blizzard. `
      + "If you just joined or made a new character, log into it in WoW, then Sync from Battle.net and try again.");
  }

  const best = inGuild.reduce((a, b) => (b.rank < a.rank ? b : a));
  if (best.rank > MAX_CREATOR_RANK) {
    return fail(403, 'RANK_TOO_LOW', `Only ${roster.guild.name}'s Guild Master and the next ${MAX_CREATOR_RANK} ranks can set it up in RaidLead -- `
      + `your highest-ranked character there is ${best.name} (rank ${best.rank}). Ask one of them to create it and invite you.`);
  }
  return { ok: true, verification: 'blizzard', guildName: roster.guild.name, character: best.name, rank: best.rank };
}

// What gets saved on the guild row with it (sql/2026_10_guild_verification.sql).
function verificationFields(check) {
  return {
    verification: check.verification,
    verified_at: new Date().toISOString(),
    verified_character: check.character || null,
    verified_rank: Number.isInteger(check.rank) ? check.rank : null,
  };
}

module.exports = { checkGuildLeader, verificationFields, MAX_CREATOR_RANK };
