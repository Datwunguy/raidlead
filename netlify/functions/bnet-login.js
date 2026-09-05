// ============================================================
//  bnet-login.js
//  Redirects the user to Battle.net's OAuth authorization page
// ============================================================

exports.handler = async (event) => {
  const clientId    = process.env.BNET_CLIENT_ID;
  const redirectUri = process.env.BNET_REDIRECT_URI;
  const region      = event.queryStringParameters?.region || 'us';

  // Map region to Battle.net OAuth base URL
  const regionUrls = {
    us: 'https://us.battle.net/oauth/authorize',
    eu: 'https://eu.battle.net/oauth/authorize',
    kr: 'https://kr.battle.net/oauth/authorize',
    tw: 'https://tw.battle.net/oauth/authorize',
    cn: 'https://www.battlenet.com.cn/oauth/authorize',
  };

  const authUrl = regionUrls[region] || regionUrls.us;

  // Generate a random state value to prevent CSRF attacks
  const state = Math.random().toString(36).substring(2, 15) +
                Math.random().toString(36).substring(2, 15);

  const params = new URLSearchParams({
    client_id:     clientId,
    scope:         'openid',
    state:         state,
    redirect_uri:  redirectUri,
    response_type: 'code',
  });

  return {
    statusCode: 302,
    headers: {
      Location:   `${authUrl}?${params.toString()}`,
      'Set-Cookie': `bnet_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    },
    body: '',
  };
};
