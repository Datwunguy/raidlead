// ============================================================
//  auth.js — handles all authentication actions
//  Actions: login, callback, session, join-guild
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { encodeSession, getSession, setCommonHeaders } = require('./lib/session');

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action = req.query.action || req.body?.action;

  // ── LOGIN: redirect to Battle.net ──
  if (action === 'login') {
    const clientId    = process.env.BNET_CLIENT_ID;
    const redirectUri = process.env.BNET_REDIRECT_URI;
    const region      = req.query.region || 'us';
    const regionUrls  = {
      us: 'https://us.battle.net/oauth/authorize',
      eu: 'https://eu.battle.net/oauth/authorize',
      kr: 'https://kr.battle.net/oauth/authorize',
      tw: 'https://tw.battle.net/oauth/authorize',
      cn: 'https://www.battlenet.com.cn/oauth/authorize',
    };

    // Generate a cryptographically random state value (CSRF protection)
    const { randomBytes } = require('crypto');
    const state  = randomBytes(16).toString('hex');
    const params = new URLSearchParams({
      client_id:     clientId,
      scope:         'openid',
      state,
      redirect_uri:  redirectUri,
      response_type: 'code',
    });

    res.setHeader('Set-Cookie', `bnet_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
    return res.redirect(302, `${regionUrls[region] || regionUrls.us}?${params.toString()}`);
  }

  // ── CALLBACK: handle Battle.net redirect ──
  if (action === 'callback') {
    const { code, state, error } = req.query;
    if (error) return res.redirect(302, `/?auth_error=${encodeURIComponent(error)}`);
    if (!code)  return res.redirect(302, '/?auth_error=no_code');

    // ── Validate OAuth state to prevent CSRF ──
    const cookieHeader  = req.headers?.cookie || '';
    const stateMatch    = cookieHeader.match(/bnet_state=([^;]+)/);
    const expectedState = stateMatch ? decodeURIComponent(stateMatch[1]) : null;
    if (!expectedState || state !== expectedState) {
      return res.redirect(302, '/?auth_error=state_mismatch');
    }
    // Clear the state cookie now that it has been consumed
    res.setHeader('Set-Cookie', 'bnet_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');

    try {
      const tokenRes = await fetch('https://us.battle.net/oauth/token', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(`${process.env.BNET_CLIENT_ID}:${process.env.BNET_CLIENT_SECRET}`).toString('base64'),
        },
        body: new URLSearchParams({
          grant_type:   'authorization_code',
          code,
          redirect_uri: process.env.BNET_REDIRECT_URI,
        }),
      });
      if (!tokenRes.ok) return res.redirect(302, '/?auth_error=token_failed');

      const { access_token } = await tokenRes.json();
      const userRes = await fetch('https://us.battle.net/oauth/userinfo', {
        headers: { 'Authorization': `Bearer ${access_token}` },
      });
      if (!userRes.ok) return res.redirect(302, '/?auth_error=userinfo_failed');

      const userData  = await userRes.json();
      const battletag = userData.battletag;
      const bnetId    = String(userData.id || userData.sub);
      if (!battletag || !bnetId) return res.redirect(302, '/?auth_error=no_battletag');

      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      // The Battle.net access token is only ever needed once, right here, to read the
      // BattleTag below -- it's intentionally never persisted (nothing in the app reads
      // it back, so storing it would just be unused, needlessly-retained credential data).
      const { data: account, error: dbError } = await supabase
        .from('accounts')
        .upsert(
          { bnet_id: bnetId, battletag, last_login: new Date().toISOString() },
          { onConflict: 'bnet_id', ignoreDuplicates: false }
        )
        .select()
        .single();
      if (dbError) { console.error('DB error:', dbError); return res.redirect(302, '/?auth_error=db_failed'); }

      // ── Build a HMAC-signed session token ──
      const sessionToken = encodeSession({
        id:       account.id,
        battletag,
        bnet_id:  bnetId,
        exp:      Date.now() + (30 * 24 * 60 * 60 * 1000),
      });

      // Deliver session only via HttpOnly cookie — never in the URL
      res.setHeader(
        'Set-Cookie',
        `raidlead_session=${encodeURIComponent(sessionToken)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`
      );
      return res.redirect(302, '/');
    } catch (err) {
      console.error('Callback error:', err);
      return res.redirect(302, '/?auth_error=server_error');
    }
  }

  // ── SESSION: verify and return account data ──
  if (action === 'session') {
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'No valid session' });

    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: account, error } = await supabase
        .from('accounts')
        .select('id, battletag, display_name, discord_id')
        .eq('id', session.id)
        .single();
      if (error || !account) return res.status(404).json({ error: 'Account not found' });
      return res.status(200).json({ account });
    } catch (err) { return res.status(500).json({ error: 'Server error' }); }
  }

  // ── JOIN-GUILD: create guild_members row ──
  if (action === 'join-guild') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const { guildName, server, joinCode } = req.body;
    if (!guildName && !joinCode) return res.status(400).json({ error: 'Guild name or join code required' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    try {
      let guild;
      if (joinCode) {
        const { data, error: codeErr } = await supabase
          .from('guilds')
          .select('id')
          .eq('join_code', joinCode.trim().toUpperCase())
          .maybeSingle();
        if (codeErr) throw codeErr;
        if (!data) return res.status(404).json({ error: 'Invalid join code.' });
        guild = data;
      } else {
        let query = supabase.from('guilds').select('id').ilike('name', guildName.trim());
        if (server) query = query.ilike('server', server.trim());
        const { data: guilds, error: findErr } = await query;
        if (findErr) throw findErr;
        if (!guilds || guilds.length === 0) {
          return res.status(404).json({ error: 'No guild found with that name/server. Double-check the spelling, or ask an officer for a join code.' });
        }
        if (guilds.length > 1) {
          return res.status(409).json({ error: 'Multiple guilds match that name — please also enter the server.' });
        }
        guild = guilds[0];
      }

      const { data: existing } = await supabase
        .from('guild_members')
        .select('id, role')
        .eq('guild_id', guild.id)
        .eq('account_id', session.id)
        .single();
      if (existing) return res.status(200).json({ success: true, role: existing.role, alreadyMember: true });

      await supabase.from('guild_members').insert({ guild_id: guild.id, account_id: session.id, role: 'member' });
      return res.status(200).json({ success: true, role: 'member', guildId: guild.id });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── LOGOUT: expire the session cookie ──
  if (action === 'logout') {
    res.setHeader('Set-Cookie', 'raidlead_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return res.status(200).json({ success: true });
  }

  res.status(400).json({ error: 'Invalid action' });
};