// ============================================================
//  auth.js — handles all authentication actions
//  Actions: login, callback, session, join-guild
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { encodeSession, getSession, setCommonHeaders } = require('../lib/session');
const { waitUntil } = require('@vercel/functions');
const { recordSync, syncAccountCharacters, syncAccountClaims } = require('../lib/characterClaims');

// A sign-in that goes back through Battle.net asking it to show the approval
// screen again (prompt=consent) carries this on the end of its OAuth state.
const CONSENT_MARK = '.consent';
const BNET_PERMISSION_HELP = '/?bnet_sync=no_permission';

// Join codes are 6 characters, so they're guessable with enough tries: an
// account gets 5 wrong ones an hour (sql/2026_09_join_code_failures.sql).
const JOIN_FAIL_LIMIT = 5;
const JOIN_FAIL_WINDOW_MS = 60 * 60 * 1000;
const TOO_MANY_JOIN_CODES = 'Too many incorrect join codes. Try again in an hour, or ask an officer for an invite link.';

// The team a join code belongs to, under the hourly wrong-code limit (shared
// by join-guild and invite-info, so looking codes up isn't a way around it).
// Returns { team } or { status, error } to send back.
async function teamForJoinCode(supabase, accountId, joinCode) {
  const since = new Date(Date.now() - JOIN_FAIL_WINDOW_MS).toISOString();
  const { count: recentFailures, error: failErr } = await supabase
    .from('join_code_failures').select('id', { count: 'exact', head: true })
    .eq('account_id', accountId).gte('failed_at', since);
  if (failErr) console.error('[join-guild] failure count:', failErr.message); // fails open (e.g. SQL not run yet)
  if ((recentFailures || 0) >= JOIN_FAIL_LIMIT) return { status: 429, error: TOO_MANY_JOIN_CODES };

  const { data: team, error: codeErr } = await supabase
    .from('teams')
    .select('id, name, guilds ( name, server )')
    .eq('join_code', String(joinCode).trim().toUpperCase())
    .maybeSingle();
  if (codeErr) throw codeErr;
  if (!team) {
    await supabase.from('join_code_failures').insert({ account_id: accountId });
    const last = (recentFailures || 0) + 1 >= JOIN_FAIL_LIMIT;
    return { status: last ? 429 : 404, error: last ? TOO_MANY_JOIN_CODES : 'Invalid join code.' };
  }
  return { team };
}

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
    // consent=1: ask Battle.net to show the approval screen even if this
    // account approved RaidLead before -- see the callback's permission check.
    const consent = req.query.consent === '1';
    const state  = randomBytes(16).toString('hex') + (consent ? CONSENT_MARK : '');
    const params = new URLSearchParams({
      client_id:     clientId,
      // wow.profile: the WoW characters on the player's own Battle.net account,
      // so their roster characters connect automatically (lib/characterClaims.js).
      // Blizzard shows it on the same one-time consent screen as the BattleTag.
      scope:         'openid wow.profile',
      state,
      redirect_uri:  redirectUri,
      response_type: 'code',
    });
    if (consent) params.set('prompt', 'consent');

    res.setHeader('Set-Cookie', `bnet_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
    return res.redirect(302, `https://oauth.battle.net/authorize?${params.toString()}`);
  }

  // ── CALLBACK: handle Battle.net redirect ──
  if (action === 'callback') {
    const { code, state, error } = req.query;
    const consentRetry = String(state || '').endsWith(CONSENT_MARK);
    if (error) {
      // Battle.net turned down asking for approval again (not just "Cancel"):
      // someone still signed in gets the steps to fix it at account.battle.net.
      const session = consentRetry && error !== 'access_denied' && getSession(req);
      if (session) {
        await recordSync(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY), session.id,
          { status: 'no_permission', reason: `Battle.net: ${error}`, finishedAt: new Date().toISOString() });
        return res.redirect(302, BNET_PERMISSION_HELP);
      }
      return res.redirect(302, `/?auth_error=${encodeURIComponent(error)}`);
    }
    if (!code)  return res.redirect(302, '/?auth_error=no_code');

    // ── Validate OAuth state to prevent CSRF ──
    const cookieHeader  = req.headers?.cookie || '';
    const stateMatch    = cookieHeader.match(/bnet_state=([^;]+)/);
    const expectedState = stateMatch ? decodeURIComponent(stateMatch[1]) : null;
    if (!expectedState || state !== expectedState) {
      return res.redirect(302, '/?auth_error=state_mismatch');
    }
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

      const tokenData = await tokenRes.json();
      const { access_token } = tokenData;
      // The permissions Battle.net actually gave ("openid wow.profile"). An
      // account that approved RaidLead before it asked for WoW characters can
      // keep that older approval: sign-in works, characters are off-limits.
      const granted = typeof tokenData.scope === 'string' ? tokenData.scope.split(/[\s,]+/) : null; // null: not said
      const canReadCharacters = !granted || granted.includes('wow.profile');

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
      // BattleTag and the player's WoW characters below -- it's intentionally never
      // persisted (Blizzard's tokens only last a day, and storing one would just be
      // needlessly-retained credential data).
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

      // Deliver session only via HttpOnly cookie — never in the URL -- and
      // clear the state cookie now that it has been consumed.
      res.setHeader('Set-Cookie', [
        'bnet_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
        `raidlead_session=${encodeURIComponent(sessionToken)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}`,
      ]);

      if (!canReadCharacters) {
        // Once: back through Battle.net, asking it to show the approval screen.
        // Still no permission after that? The page shows how to fix it.
        if (!consentRetry) return res.redirect(302, '/api/auth?action=login&consent=1');
        const now = new Date().toISOString();
        await recordSync(supabase, account.id, { status: 'no_permission', reason: `granted: ${tokenData.scope}`, startedAt: now, finishedAt: now });
        return res.redirect(302, BNET_PERMISSION_HELP);
      }

      // Their WoW characters, straight from Blizzard, and any roster characters
      // on their teams that match -- read after the sign-in goes through, so
      // it never waits on Blizzard. The page watches accounts.wow_sync for
      // the result. (The access token stays in this function's memory only.)
      const startedAt = new Date().toISOString();
      await recordSync(supabase, account.id, { status: 'syncing', startedAt });
      waitUntil(syncAccountCharacters(supabase, account.id, access_token, startedAt));
      return res.redirect(302, '/?bnet_sync=started');
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
        .select('id, battletag, display_name, discord_id, wow_characters_synced_at, wow_sync')
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
  // ── INVITE-INFO: which team an invite code is for, so the page can ask
  // "Join <team>?" -- an invite link never joins anyone by itself. ──
  if (action === 'invite-info') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    const { joinCode } = req.body || {};
    if (!joinCode) return res.status(400).json({ error: 'Join code required' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    try {
      const found = await teamForJoinCode(supabase, session.id, joinCode);
      if (found.error) return res.status(found.status).json({ error: found.error });
      const { data: member } = await supabase
        .from('team_members').select('id').eq('team_id', found.team.id).eq('account_id', session.id).maybeSingle();
      return res.status(200).json({
        teamName: found.team.name, guildName: found.team.guilds?.name || null, server: found.team.guilds?.server || null,
        alreadyMember: !!member,
      });
    } catch (err) { return res.status(500).json({ error: 'Could not look up that invite.' }); }
  }

  if (action === 'join-guild') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const { joinCode } = req.body;
    if (!joinCode) return res.status(400).json({ error: 'Join code required' });

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    try {
      const found = await teamForJoinCode(supabase, session.id, joinCode);
      if (found.error) return res.status(found.status).json({ error: found.error });
      const { team } = found;

      const { data: existing } = await supabase
        .from('team_members')
        .select('id, role')
        .eq('team_id', team.id)
        .eq('account_id', session.id)
        .maybeSingle();
      if (existing) return res.status(200).json({ success: true, role: existing.role, alreadyMember: true, teamId: team.id });

      // Everyone joins as a Viewer; if their Battle.net account has a character
      // on this roster, it's connected and they become a Member right away.
      await supabase.from('team_members').insert({ team_id: team.id, account_id: session.id, role: 'viewer' });
      const connected = await syncAccountClaims(supabase, session.id);
      const { data: joined } = await supabase
        .from('team_members').select('role').eq('team_id', team.id).eq('account_id', session.id).maybeSingle();
      return res.status(200).json({ success: true, role: joined?.role || 'viewer', teamId: team.id, connected });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── LOGOUT: expire the session cookie ──
  if (action === 'logout') {
    res.setHeader('Set-Cookie', 'raidlead_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return res.status(200).json({ success: true });
  }

  res.status(400).json({ error: 'Invalid action' });
};