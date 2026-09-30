// ============================================================
//  lib/games.js — the server's view of public/games.js (the one list of
//  WoW versions and their rules), plus looking up which version a team is.
// ============================================================
const { GAMES, GAME_ORDER, gameFor } = require('../public/games.js');

const isGame = id => typeof id === 'string' && Object.prototype.hasOwnProperty.call(GAMES, id);

// A team's WoW version -- its guild's. Retail for anything older than versions.
async function teamGame(supabase, teamId) {
  if (!teamId) return GAMES.retail;
  const { data } = await supabase.from('teams').select('guilds ( game )').eq('id', teamId).maybeSingle();
  return gameFor(data?.guilds?.game);
}

// A difficulty key that belongs to the version, else the version's default.
const teamDifficulty = (game, key) => (game.difficulties.some(d => d.key === key) ? key : game.defaultDifficulty);

// A version's Blizzard profile namespace for a region: profile-us,
// profile-classic-us, ... null if Blizzard's API doesn't cover it (yet).
function blizzardProfileNamespace(game, region) {
  const ns = game?.sources?.blizzardNs;
  if (ns === null || ns === undefined) return null;
  return ns ? `profile-${ns}-${region}` : `profile-${region}`;
}

module.exports = { GAMES, GAME_ORDER, gameFor, isGame, teamGame, teamDifficulty, blizzardProfileNamespace };
