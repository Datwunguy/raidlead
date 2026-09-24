// ============================================================
//  discord.js — Discord Interactions endpoint (slash commands)
//  Commands: /attendance <out|in> [date], /link <code>
//
//  Discord signs every request with Ed25519 over "timestamp + rawBody",
//  so the raw (unparsed) request body is required for verification --
//  hence bodyParser is disabled and we read+parse it ourselves.
// ============================================================
const nacl = require('tweetnacl');
const { createClient } = require('@supabase/supabase-js');

module.exports.config = {
  api: { bodyParser: false },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifyDiscordRequest(req, rawBody) {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp  = req.headers['x-signature-timestamp'];
  const publicKey  = process.env.DISCORD_PUBLIC_KEY;
  if (!signature || !timestamp || !publicKey) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + rawBody),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );
  } catch (e) { return false; }
}

// CHANNEL_MESSAGE_WITH_SOURCE, flags:64 = EPHEMERAL (only the invoking user sees it)
function ephemeral(content) {
  return { type: 4, data: { content, flags: 64 } };
}

// Strips accents/diacritics and case so "Tiesto" matches a roster entry stored
// as "Tiësto" -- players shouldn't need special characters on their keyboard.
function normalizeName(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function attendanceDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Accepts "9/8", "09/08", "9/8/2026", or "2026-09-08"
function parseDateInput(input) {
  const trimmed = (input || '').trim();

  let m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    if (isNaN(d.getTime())) return null;
    return attendanceDateStr(d);
  }

  m = trimmed.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const now = new Date();
    const month = parseInt(m[1]);
    const day   = parseInt(m[2]);
    let year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : now.getFullYear();
    let candidate = new Date(year, month - 1, day);
    if (isNaN(candidate.getTime())) return null;
    // No year given and it looks like a date well in the past -- assume they mean next year
    if (!m[3] && (now - candidate) / 86400000 > 60) {
      candidate = new Date(year + 1, month - 1, day);
    }
    return attendanceDateStr(candidate);
  }

  return null;
}

async function nextUpcomingRaidDate(supabase, teamRow) {
  const { data: extraRows } = await supabase.from('raid_extra_days').select('raid_date').eq('team_id', teamRow.id);
  const extraDays = (extraRows || []).map(r => r.raid_date);
  const recurringDays = teamRow.raid_days || [];
  for (let i = 0; i < 60; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dStr = attendanceDateStr(d);
    if (recurringDays.includes(d.getDay()) || extraDays.includes(dStr)) return dStr;
  }
  return attendanceDateStr(new Date());
}

async function handleAttendanceCommand(supabase, interaction) {
  const discordGuildId = interaction.guild_id;
  const discordUserId  = interaction.member?.user?.id || interaction.user?.id;
  if (!discordGuildId || !discordUserId) {
    return ephemeral('This command has to be used in a Discord server, not a DM.');
  }

  // Any number of teams can independently link the same Discord server -- e.g. two
  // teams under one guild sharing a server. Resolve every team linked here, then
  // figure out which one this specific command is about.
  const { data: teamRows } = await supabase
    .from('teams').select('id, name, raid_days').eq('discord_guild_id', discordGuildId);
  if (!teamRows || teamRows.length === 0) {
    return ephemeral("This Discord server isn't linked to a RaidLead team yet. Ask an officer to connect it from Guild Settings.");
  }

  const options       = interaction.data.options || [];
  const statusOpt     = options.find(o => o.name === 'status')?.value;
  const dateOpt       = options.find(o => o.name === 'date')?.value;
  const characterOpt  = options.find(o => o.name === 'character')?.value;
  const teamOpt       = options.find(o => o.name === 'team')?.value;

  // Narrow to a named team if given (only meaningful once 2+ teams share this
  // server); otherwise search across every team linked here.
  let candidateTeams = teamRows;
  if (teamOpt) {
    const normTeam = normalizeName(teamOpt);
    candidateTeams = teamRows.filter(t => normalizeName(t.name).includes(normTeam));
    if (candidateTeams.length === 0) {
      return ephemeral(`No team named "${teamOpt}" is linked to this server. Linked teams: ${teamRows.map(t => t.name).join(', ')}.`);
    }
  }

  let character, teamRow;
  if (characterOpt) {
    // Direct character-name mode -- no Discord/RaidLead account linking required.
    // Note: this means anyone in the server can mark any character's attendance.
    // Matched accent-insensitively (Postgres ilike alone won't treat "Tiesto" and
    // "Tiësto" as equal), so players don't need to type special characters.
    //
    // active-only matters: confirmed live that a team with both a current
    // "Häzey" and an old, removed "Hazëy" (soft-deleted, not hard-deleted --
    // see removeCharacter) normalizes both to the same "hazey" target, and
    // an unfiltered query could match whichever one Supabase happened to
    // return first, silently marking the wrong (inactive, roster-invisible)
    // character's attendance instead of the real one.
    //
    // Two *active* characters on the same team can still collide once
    // accents are stripped (e.g. "Häzey" and "Hazey" both currently on the
    // roster) -- try an exact, accent-preserving match first, since typing
    // the real spelling should resolve that cleanly without ever hitting
    // the ambiguous case below. Only fall back to the accent-stripped fuzzy
    // match (and only then risk a same-team collision) when nothing matches
    // exactly.
    const target    = normalizeName(characterOpt);
    const rawTarget = characterOpt.trim().toLowerCase();
    const matches = [];
    for (const t of candidateTeams) {
      const { data: chars } = await supabase.from('characters').select('name').eq('team_id', t.id).eq('active', true);
      const list = chars || [];
      let candidatesInTeam = list.filter(c => c.name.trim().toLowerCase() === rawTarget);
      if (candidatesInTeam.length === 0) {
        candidatesInTeam = list.filter(c => normalizeName(c.name) === target);
      }
      if (candidatesInTeam.length === 1) {
        matches.push({ team: t, character: candidatesInTeam[0] });
      } else if (candidatesInTeam.length > 1) {
        matches.push({ team: t, character: null, ambiguousNames: candidatesInTeam.map(c => c.name) });
      }
    }
    if (matches.length === 0) {
      return ephemeral(`Couldn't find a character named "${characterOpt}" on ${candidateTeams.length > 1 ? 'any team linked to this server' : `"${candidateTeams[0].name}"`}.`);
    }
    if (matches.length > 1) {
      return ephemeral(`"${characterOpt}" exists on more than one team here (${matches.map(m => m.team.name).join(', ')}) -- add \`team:\` to say which one you mean.`);
    }
    if (!matches[0].character) {
      return ephemeral(`More than one character on "${matches[0].team.name}" matches "${characterOpt}" once accents are ignored (${matches[0].ambiguousNames.join(', ')}) -- type the exact name, with the right accent marks, to tell them apart.`);
    }
    teamRow = matches[0].team;
    character = matches[0].character;
  } else {
    const { data: account } = await supabase
      .from('accounts').select('id, battletag').eq('discord_id', discordUserId).maybeSingle();
    if (!account) {
      return ephemeral("Your Discord account isn't linked to RaidLead yet. Either add `character:YourCharacterName` to this command, run `/link <code>` with the code from your RaidLead profile, or ask an officer to link you.");
    }
    const matches = [];
    for (const t of candidateTeams) {
      const { data: char } = await supabase
        .from('characters').select('name').eq('team_id', t.id).eq('account_id', account.id).maybeSingle();
      if (char) matches.push({ team: t, character: char });
    }
    if (matches.length === 0) {
      return ephemeral("You haven't claimed a character on RaidLead yet -- do that first in the app, or use `character:YourCharacterName` with this command.");
    }
    if (matches.length > 1) {
      return ephemeral(`You have a claimed character on more than one team here (${matches.map(m => m.team.name).join(', ')}) -- add \`team:\` to say which one you mean.`);
    }
    teamRow = matches[0].team;
    character = matches[0].character;
  }

  let raidDate;
  if (dateOpt) {
    raidDate = parseDateInput(dateOpt);
    if (!raidDate) return ephemeral("Couldn't understand that date -- try formats like `9/8` or `2026-09-08`.");
  } else {
    raidDate = await nextUpcomingRaidDate(supabase, teamRow);
  }

  const unavailable = statusOpt === 'out';

  if (unavailable) {
    const { data: existing } = await supabase
      .from('attendance_marks').select('id')
      .eq('team_id', teamRow.id).eq('character_name', character.name).eq('raid_date', raidDate)
      .maybeSingle();
    if (existing) {
      const { error } = await supabase.from('attendance_marks').update({ status: 'unavailable' }).eq('id', existing.id);
      if (error) return ephemeral('Error saving attendance: ' + error.message);
    } else {
      const { error } = await supabase.from('attendance_marks')
        .insert({ team_id: teamRow.id, character_name: character.name, raid_date: raidDate, status: 'unavailable' });
      if (error) return ephemeral('Error saving attendance: ' + error.message);
    }
  } else {
    const { error } = await supabase.from('attendance_marks')
      .delete().eq('team_id', teamRow.id).eq('character_name', character.name).eq('raid_date', raidDate);
    if (error) return ephemeral('Error saving attendance: ' + error.message);
  }

  const label = unavailable ? 'OUT' : 'IN (available)';
  const teamSuffix = teamRows.length > 1 ? ` (${teamRow.name})` : '';
  return ephemeral(`Marked **${character.name}**${teamSuffix} as **${label}** for ${raidDate}.`);
}

async function handleLinkCommand(supabase, interaction) {
  const discordUserId = interaction.member?.user?.id || interaction.user?.id;
  if (!discordUserId) return ephemeral('This command has to be used in a Discord server, not a DM.');

  const options = interaction.data.options || [];
  const code = (options.find(o => o.name === 'code')?.value || '').trim().toUpperCase();
  if (!code) return ephemeral('Please provide the code shown in your RaidLead profile.');

  const { data: account } = await supabase
    .from('accounts')
    .select('id, battletag, discord_link_code_expires_at')
    .eq('discord_link_code', code)
    .maybeSingle();
  if (!account) return ephemeral('That code is invalid. Generate a new one from your RaidLead profile (Members panel).');
  if (account.discord_link_code_expires_at && new Date(account.discord_link_code_expires_at) < new Date()) {
    return ephemeral('That code has expired. Generate a new one from your RaidLead profile.');
  }

  const { error } = await supabase.from('accounts').update({
    discord_id: discordUserId,
    discord_link_code: null,
    discord_link_code_expires_at: null,
  }).eq('id', account.id);

  if (error) {
    if (error.code === '23505') return ephemeral('That Discord account is already linked to a different RaidLead account.');
    return ephemeral('Error linking account: ' + error.message);
  }

  return ephemeral(`Linked! Your Discord is now connected to **${account.battletag}**.`);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  if (!verifyDiscordRequest(req, rawBody)) {
    return res.status(401).end('Bad request signature');
  }

  let interaction;
  try { interaction = JSON.parse(rawBody); } catch (e) { return res.status(400).end('Invalid JSON'); }

  // PING -- Discord's endpoint verification check
  if (interaction.type === 1) return res.status(200).json({ type: 1 });

  // APPLICATION_COMMAND
  if (interaction.type === 2) {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    try {
      let response;
      if (interaction.data?.name === 'attendance') {
        response = await handleAttendanceCommand(supabase, interaction);
      } else if (interaction.data?.name === 'link') {
        response = await handleLinkCommand(supabase, interaction);
      } else {
        response = ephemeral('Unknown command.');
      }
      return res.status(200).json(response);
    } catch (err) {
      console.error('[discord] error:', err.message);
      return res.status(200).json(ephemeral('Something went wrong: ' + err.message));
    }
  }

  return res.status(200).json({});
};
