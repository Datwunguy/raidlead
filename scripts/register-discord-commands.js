// One-time (or whenever commands change) script to register RaidLead's
// slash commands with Discord. Run locally with Node 18+:
//
//   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/register-discord-commands.js
//
// Registers commands GLOBALLY (available in every server the bot is added
// to). Global registration can take up to an hour to propagate on first use.

const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN       = process.env.DISCORD_BOT_TOKEN;

if (!APPLICATION_ID || !BOT_TOKEN) {
  console.error('Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN environment variables first.');
  process.exit(1);
}

const commands = [
  {
    name: 'attendance',
    description: 'Mark attendance out or available for a raid night',
    options: [
      {
        name: 'status',
        description: 'Are you out or available?',
        type: 3, // STRING
        required: true,
        choices: [
          { name: 'Out', value: 'out' },
          { name: 'In (available)', value: 'in' },
        ],
      },
      {
        name: 'date',
        description: 'Raid date, e.g. 9/8 (defaults to the next upcoming raid night)',
        type: 3, // STRING
        required: false,
      },
      {
        name: 'character',
        description: 'Character name (skips needing /link -- marks that character directly)',
        type: 3, // STRING
        required: false,
      },
    ],
  },
  {
    name: 'link',
    description: 'Link your Discord account to your RaidLead account',
    options: [
      {
        name: 'code',
        description: 'The code shown in your RaidLead profile (Members panel)',
        type: 3, // STRING
        required: true,
      },
    ],
  },
];

async function main() {
  const resp = await fetch(`https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  const text = await resp.text();
  if (!resp.ok) {
    console.error('Failed to register commands:', resp.status, text);
    process.exit(1);
  }
  console.log('Registered commands:', JSON.parse(text).map(c => '/' + c.name).join(', '));
}

main();
