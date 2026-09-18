// ============================================================
//  auth.js — handles all authentication actions
//  Actions: login, callback, session, join-guild
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { encodeSession, getSession, setCommonHeaders } = require('../lib/session');

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action = req.query.action || req.body?.action;

  // ── LOGIN: redirect to Battle.net ──
  // Battle.net login is a single global service at oauth.battle.net -- there's no
  // per-region authorize/token/userinfo host to pick (that only applies to the
  // separate WoW game-data APIs, e.g. realm/character lookups). China (battlenet.com.cn)
  // is the one real exception -- it's run by NetEase as an entirely separate system --
  // but that's out of scope unless we actually need CN accounts to log in.
  if (action === 'login') {
    const clientId    = process.env.BNET_CLIENT_ID;
    const redirectUri = process.env.BNET_REDIRECT_URI;

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
    return res.redirect(302, `https://oauth.battle.net/authorize?${params.toString()}`);
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
      const tokenRes = await fetch('https://oauth.battle.net/token', {
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
      const userRes = await fetch('https://oauth.battle.net/userinfo', {
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

  // ── JOIN-GUILD: create a team_members row for a specific team ──
  // A join code is always required -- this used to also accept a bare
  // guildName+server match for unambiguous (single-team) guilds, but a
  // guild's name and server aren't secret (they're public on Raider.io/WCL),
  // so that path let any authenticated RaidLead account join any single-team
  // guild's roster with zero proof they actually belong to it. Every team
  // always has a join code available (auto-generated at creation, see
  // api/guild.js), so this doesn't remove any real capability -- officers
  // share that code instead of a name.
  if (action === 'join-guild') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const { joinCode } = req.body;
    if (!joinCode) return res.status(400).json({ error: 'Join code required' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    try {
      const { data: team, error: codeErr } = await supabase
        .from('teams')
        .select('id, name')
        .eq('join_code', joinCode.trim().toUpperCase())
        .maybeSingle();
      if (codeErr) throw codeErr;
      if (!team) return res.status(404).json({ error: 'Invalid join code.' });

      const { data: existing } = await supabase
        .from('team_members')
        .select('id, role')
        .eq('team_id', team.id)
        .eq('account_id', session.id)
        .maybeSingle();
      if (existing) return res.status(200).json({ success: true, role: existing.role, alreadyMember: true, teamId: team.id });

      await supabase.from('team_members').insert({ team_id: team.id, account_id: session.id, role: 'member' });
      return res.status(200).json({ success: true, role: 'member', teamId: team.id });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── LOGOUT: expire the session cookie ──
  if (action === 'logout') {
    res.setHeader('Set-Cookie', 'raidlead_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return res.status(200).json({ success: true });
  }

  res.status(400).json({ error: 'Invalid action' });
};