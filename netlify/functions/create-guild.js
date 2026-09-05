// ============================================================
//  create-guild.js
//  Creates a guild, first team, and owner membership in Supabase
// ============================================================

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // Verify session
  const authHeader = event.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return json(401, { error: 'Not authenticated' });
  }

  const sessionToken = authHeader.slice(7);
  let sessionData;
  try {
    sessionData = JSON.parse(Buffer.from(sessionToken, 'base64').toString());
    if (sessionData.exp < Date.now()) return json(401, { error: 'Session expired' });
  } catch(e) {
    return json(401, { error: 'Invalid session' });
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch(e) {
    return json(400, { error: 'Invalid request body' });
  }

  const { guild, server, region, difficulty, teamName, wowaudit, wclUrl, zoneId } = body;

  if (!guild || !server || !wowaudit) {
    return json(400, { error: 'Missing required fields' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // 1. Create guild
    const { data: guildData, error: guildError } = await supabase
      .from('guilds')
      .insert({
        name:         guild,
        server:       server.toLowerCase(),
        region:       region || 'us',
        difficulty:   difficulty || 'mythic',
        wowaudit_url: wowaudit,
        wcl_url:      wclUrl || null,
        zone_id:      zoneId || null,
        created_by:   sessionData.id,
      })
      .select()
      .single();

    if (guildError) throw new Error('Failed to create guild: ' + guildError.message);

    // 2. Create first team
    const { data: teamData, error: teamError } = await supabase
      .from('teams')
      .insert({
        guild_id: guildData.id,
        name:     teamName || 'Main Team',
      })
      .select()
      .single();

    if (teamError) throw new Error('Failed to create team: ' + teamError.message);

    // 3. Add creator as owner
    const { error: memberError } = await supabase
      .from('guild_members')
      .insert({
        guild_id:   guildData.id,
        account_id: sessionData.id,
        role:       'owner',
      });

    if (memberError) throw new Error('Failed to add member: ' + memberError.message);

    return json(200, {
      guild:  guildData,
      team:   teamData,
    });

  } catch(err) {
    console.error('Create guild error:', err);
    return json(500, { error: err.message });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}