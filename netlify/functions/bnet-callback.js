// ============================================================
//  bnet-callback.js
//  Handles the OAuth callback from Battle.net, exchanges the
//  code for a token, fetches the BattleTag, and creates/finds
//  the user in Supabase.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const { code, error } = event.queryStringParameters || {};

  if (error) {
    return redirect(`/?auth_error=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return redirect('/?auth_error=no_code');
  }

  try {
    const clientId      = process.env.BNET_CLIENT_ID;
    const clientSecret  = process.env.BNET_CLIENT_SECRET;
    const redirectUri   = process.env.BNET_REDIRECT_URI;
    const supabaseUrl   = process.env.SUPABASE_URL;
    const serviceKey    = process.env.SUPABASE_SERVICE_KEY; // bypasses RLS for account creation

    // ── Step 1: Exchange code for access token ──
    const tokenRes = await fetch('https://us.battle.net/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type:   'authorization_code',
        code:         code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error('Token exchange failed:', err);
      return redirect('/?auth_error=token_failed');
    }

    const tokenData   = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // ── Step 2: Fetch BattleTag and account ID ──
    const userRes = await fetch('https://us.battle.net/oauth/userinfo', {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!userRes.ok) {
      return redirect('/?auth_error=userinfo_failed');
    }

    const userData  = await userRes.json();
    const battletag = userData.battletag;
    const bnetId    = String(userData.id || userData.sub);

    if (!battletag || !bnetId) {
      return redirect('/?auth_error=no_battletag');
    }

    // ── Step 3: Create or update account in Supabase ──
    // Use service key here so RLS doesn't block new account creation
    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: account, error: dbError } = await supabase
      .from('accounts')
      .upsert({
        bnet_id:    bnetId,
        battletag:  battletag,
        bnet_token: accessToken,
        last_login: new Date().toISOString(),
      }, {
        onConflict:       'bnet_id',
        ignoreDuplicates: false,
      })
      .select()
      .single();

    if (dbError) {
      console.error('Supabase upsert error:', JSON.stringify(dbError));
      return redirect('/?auth_error=db_failed');
    }

    // ── Step 4: Create session token ──
    const sessionData = {
      id:        account.id,
      battletag: battletag,
      bnet_id:   bnetId,
      exp:       Date.now() + (30 * 24 * 60 * 60 * 1000), // 30 days
    };

    const sessionToken = Buffer.from(JSON.stringify(sessionData)).toString('base64');

    // ── Step 5: Redirect back to app with session ──
    return {
      statusCode: 302,
      headers: {
        Location:     `/?session=${encodeURIComponent(sessionToken)}`,
        'Set-Cookie': `raidlead_session=${sessionToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 60 * 60}`,
      },
      body: '',
    };

  } catch (err) {
    console.error('Callback error:', err);
    return redirect('/?auth_error=server_error');
  }
};

function redirect(url) {
  return {
    statusCode: 302,
    headers: { Location: url },
    body: '',
  };
}