// ============================================================
//  auth-session.js
//  Verifies a session token and returns the user's account
//  data including their guilds and roles.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  // Support both cookie and Authorization header
  const authHeader = event.headers?.authorization || '';
  const cookieHeader = event.headers?.cookie || '';

  let sessionToken = null;

  // Try Authorization header first
  if (authHeader.startsWith('Bearer ')) {
    sessionToken = authHeader.slice(7);
  } else {
    // Try cookie
    const match = cookieHeader.match(/raidlead_session=([^;]+)/);
    if (match) sessionToken = decodeURIComponent(match[1]);
  }

  if (!sessionToken) {
    return json(401, { error: 'No session token' });
  }

  try {
    // Decode session token
    const sessionData = JSON.parse(Buffer.from(sessionToken, 'base64').toString());

    // Check expiry
    if (sessionData.exp < Date.now()) {
      return json(401, { error: 'Session expired' });
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    // Fetch full account with guild memberships
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select(`
        id,
        battletag,
        discord_id,
        created_at,
        last_login,
        guild_members (
          role,
          guilds (
            id,
            name,
            server,
            region,
            wowaudit_url,
            wcl_url,
            zone_id,
            zone_name,
            difficulty,
            teams (
              id,
              name
            )
          )
        )
      `)
      .eq('id', sessionData.id)
      .single();

    if (accountError || !account) {
      return json(404, { error: 'Account not found' });
    }

    return json(200, {
      account: {
        id:         account.id,
        battletag:  account.battletag,
        discord_id: account.discord_id,
        guilds:     account.guild_members?.map(gm => ({
          ...gm.guilds,
          my_role: gm.role,
        })) || [],
      }
    });

  } catch (err) {
    console.error('Session error:', err);
    return json(500, { error: 'Server error' });
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
