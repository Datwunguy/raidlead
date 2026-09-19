// ============================================================
//  companion.js — lets the Companion desktop app log in and talk to
//  RaidLead directly, instead of relaying through a browser-picked "bridge
//  folder" (see sql/2026_09_companion_auth.sql for why/what).
//
//  Actions: startPairing, getPairingInfo, approvePairing, checkPairing,
//           getMyTeams, uploadLoot, getRosterSync, listMyTokens, revokeToken
//
//  Two separate credential types are handled in this one file, and they
//  never cross-validate:
//   - startPairing/getPairingInfo/checkPairing: no auth (a pairing code is
//     the only thing identifying the request, and it's short-lived).
//   - approvePairing/listMyTokens/revokeToken: the normal website session
//     (lib/session.js's getSession/cookie), completely unchanged from every
//     other api/*.js file.
//   - getMyTeams/uploadLoot/getRosterSync: the Companion app's own bearer
//     token, verified by getCompanionSession() below -- a DB lookup against
//     companion_tokens, deliberately NOT lib/session.js's decodeSession.
//     Companion tokens are opaque random strings (not signed JSON), stored
//     only as a sha256 hash, and individually revocable (revoked_at) --
//     unlike the stateless 30-day session cookie, which has no revocation
//     mechanism short of rotating SESSION_SECRET for every user at once.
//     That's the whole reason this is a second, separate auth path instead
//     of just minting more of the existing session token.
//
//  Vercel Hobby's zero-config Node Functions caps at 12 files under api/ --
//  this is the 11th. Any future companion-related need must be another
//  `?action=` branch in this file, not a new file.
// ============================================================
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('../lib/session');
const { assertTeamMembership, getMyTeams } = require('../lib/teamAuth');
const { importLootRecords } = require('../lib/lootImport');

const SITE_ORIGIN = 'https://raidlead.vercel.app';
const PAIRING_TTL_MS = 10 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// A pairing code is never typed by a person (it only ever travels inside a
// clicked link and a programmatic poll), so there's no need for join_code's
// short, no-ambiguous-characters alphabet -- 12 hex chars (48 bits) makes a
// collision astronomically unlikely, so unlike generateUniqueJoinCode
// (api/guild.js) this doesn't need a retry-on-clash loop.
function generatePairingCode() {
  return crypto.randomBytes(6).toString('hex');
}

// Verifies a Companion app's bearer token against companion_tokens --
// entirely separate from lib/session.js's getSession/decodeSession (see
// header comment). Returns { id: accountId } or null.
async function getCompanionSession(req, supabase) {
  const auth = req.headers?.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  if (!token) return null;

  const { data } = await supabase
    .from('companion_tokens')
    .select('id, account_id, revoked_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  if (!data || data.revoked_at) return null;

  await supabase.from('companion_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);
  return { id: data.account_id };
}

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action = req.query.action || req.body?.action;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // ── START PAIRING: Companion app begins a login (no auth) ──
  if (action === 'startPairing') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const deviceLabel = (req.body?.deviceLabel || 'Unknown device').toString().slice(0, 100);
    try {
      const pairingCode = generatePairingCode();
      const { error } = await supabase.from('companion_pairings').insert({ pairing_code: pairingCode, device_label: deviceLabel });
      if (error) throw error;
      return res.status(200).json({ pairingCode, approveUrl: `${SITE_ORIGIN}/?companion-pair=${pairingCode}` });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── GET PAIRING INFO: read-only, for the website's confirmation screen
  // (no auth). Deliberately separate from checkPairing below, which
  // CONSUMES an approved pairing -- if the browser used checkPairing just
  // to render "Approve login from X?", it could race the Companion app's
  // own poll and null out the token before the Companion app ever sees it. ──
  if (action === 'getPairingInfo') {
    const pairingCode = req.query.pairingCode || req.body?.pairingCode;
    if (!pairingCode) return res.status(400).json({ error: 'pairingCode required' });
    try {
      const { data } = await supabase.from('companion_pairings')
        .select('device_label, status, expires_at')
        .eq('pairing_code', pairingCode).maybeSingle();
      if (!data || new Date(data.expires_at) < new Date()) {
        return res.status(404).json({ error: 'This pairing code is invalid or has expired.' });
      }
      return res.status(200).json({ deviceLabel: data.device_label, status: data.status });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── APPROVE PAIRING: the website, already logged in normally, approves a
  // pairing on the user's behalf. Does NOT mint a token -- see checkPairing
  // for why the actual mint happens there instead. ──
  if (action === 'approvePairing') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const session = getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    const pairingCode = req.body?.pairingCode;
    if (!pairingCode) return res.status(400).json({ error: 'pairingCode required' });
    try {
      const { data, error } = await supabase.from('companion_pairings')
        .update({ status: 'approved', account_id: session.id })
        .eq('pairing_code', pairingCode)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .select('id').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'This pairing code is invalid, already used, or has expired.' });
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── CHECK PAIRING: polled by the Companion app (no auth). Reports status,
  // and -- the one time it sees `approved` -- atomically claims the pairing
  // and mints the token in this same request. Doing the mint here rather
  // than in approvePairing means the plaintext bearer token exists only in
  // this one HTTP response and is NEVER written to any column, even
  // momentarily: only its hash ever reaches the database. The
  // approved -> claimed compare-and-swap ensures a concurrent/duplicate
  // poll can't mint a second token for the same pairing. ──
  if (action === 'checkPairing') {
    const pairingCode = req.query.pairingCode || req.body?.pairingCode;
    if (!pairingCode) return res.status(400).json({ error: 'pairingCode required' });
    try {
      const { data: pairingRow } = await supabase.from('companion_pairings')
        .select('id, status, account_id, device_label, expires_at')
        .eq('pairing_code', pairingCode).maybeSingle();
      if (!pairingRow) return res.status(200).json({ status: 'not_found' });
      if (new Date(pairingRow.expires_at) < new Date()) return res.status(200).json({ status: 'expired' });
      if (pairingRow.status !== 'approved') return res.status(200).json({ status: pairingRow.status });

      const { data: claimed, error: claimErr } = await supabase.from('companion_pairings')
        .update({ status: 'claimed' })
        .eq('id', pairingRow.id).eq('status', 'approved').gt('expires_at', new Date().toISOString())
        .select('account_id, device_label').maybeSingle();
      if (claimErr) throw claimErr;
      // Lost the race to a concurrent poll (rare) -- the winning poll already
      // has the token; there is no way to hand it out twice by design.
      if (!claimed) return res.status(200).json({ status: 'claimed' });

      const token = 'rlc_' + crypto.randomBytes(32).toString('hex');
      const { error: insertErr } = await supabase.from('companion_tokens')
        .insert({ account_id: claimed.account_id, token_hash: hashToken(token), device_label: claimed.device_label });
      if (insertErr) throw insertErr;

      return res.status(200).json({ status: 'claimed', token });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── Every action below requires a Companion-app bearer token ──
  if (['getMyTeams', 'uploadLoot', 'getRosterSync'].includes(action)) {
    const companionSession = await getCompanionSession(req, supabase);
    if (!companionSession) return res.status(401).json({ error: 'Not authenticated' });

    // ── GET MY TEAMS: powers the Companion app's team picker for a
    // multi-team account -- single-team accounts don't need to ask. ──
    if (action === 'getMyTeams') {
      try {
        const teams = await getMyTeams(supabase, companionSession.id);
        return res.status(200).json({ teams });
      } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    // ── UPLOAD LOOT: same body shape as /api/loot?action=import, calling the
    // exact same shared logic (see lib/lootImport.js's header for why). ──
    if (action === 'uploadLoot') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const teamId = req.body?.teamId;
      try {
        await assertTeamMembership(supabase, companionSession.id, teamId);
        const { imported } = await importLootRecords(supabase, {
          teamId, records: req.body?.records, reportedByAccountId: companionSession.id,
        });
        return res.status(200).json({ success: true, imported });
      } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    }

    // ── GET ROSTER SYNC: everything the Companion app needs to write into
    // every character's SavedVariables, in one call -- replaces what used
    // to be 3 separate browser calls (api/plans.js's `get`, api/members.js's
    // `get` and `getAttendance`) that built this same { plan, roster,
    // syncedAt } shape client-side before writing it to the bridge folder.
    // Kept byte-for-byte identical to that old shape so
    // companion/src/luaData.js's writeCompanionDb needs zero changes. ──
    if (action === 'getRosterSync') {
      const teamId = req.query.teamId || req.body?.teamId;
      if (!teamId) return res.status(400).json({ error: 'teamId required' });
      try {
        await assertTeamMembership(supabase, companionSession.id, teamId);

        const [planQuery, membersQuery, charsQuery, marksQuery] = await Promise.all([
          supabase.from('raid_plans')
            .select(`id, name, published, updated_at, raid_date, swaps,
              raid_plan_members ( assigned_role, characters ( id, name, class, primary_role, server, realm_name ) )`)
            .eq('team_id', teamId).eq('published', true).order('updated_at', { ascending: false }).limit(1),
          supabase.from('team_members').select('role, account_id').eq('team_id', teamId),
          supabase.from('characters').select('id, name, class, primary_role, rank, account_id')
            .eq('team_id', teamId).eq('active', true).not('account_id', 'is', null),
          supabase.from('attendance_marks').select('character_name, raid_date, status').eq('team_id', teamId),
        ]);
        if (planQuery.error) throw planQuery.error;
        if (membersQuery.error) throw membersQuery.error;
        if (charsQuery.error) throw charsQuery.error;
        if (marksQuery.error) throw marksQuery.error;

        // Same grouping api/members.js's `get` action does, so `roster` ends
        // up identical to what the old browser path built from that action's
        // response -- only currently-claimed characters of current team
        // members, not every character row that happens to share an
        // account_id.
        const charactersByAccount = {};
        (charsQuery.data || []).forEach(c => {
          (charactersByAccount[c.account_id] ||= []).push(c);
        });
        const roster = (membersQuery.data || [])
          .flatMap(m => charactersByAccount[m.account_id] || [])
          .map(c => ({ name: c.name, class: c.class, primaryRole: c.primary_role }));

        const planRow = planQuery.data?.[0] || null;
        let plan = null;
        if (planRow) {
          const unavailable = (marksQuery.data || [])
            .filter(m => m.status === 'unavailable' && m.raid_date === planRow.raid_date)
            .map(m => m.character_name);
          plan = {
            name: planRow.name,
            raidDate: planRow.raid_date,
            updatedAt: planRow.updated_at,
            members: (planRow.raid_plan_members || [])
              .filter(m => m.characters)
              .map(m => ({
                name: m.characters.name, class: m.characters.class, primaryRole: m.characters.primary_role,
                assignedRole: m.assigned_role, server: m.characters.server, realmName: m.characters.realm_name,
              })),
            unavailable,
          };
        }

        return res.status(200).json({ plan, roster, syncedAt: Math.floor(Date.now() / 1000) });
      } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
    }
  }

  // ── Every action below requires the normal website session ──
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  // ── LIST MY TOKENS: "Connected devices" list in website Settings ──
  if (action === 'listMyTokens') {
    try {
      const { data, error } = await supabase.from('companion_tokens')
        .select('id, device_label, created_at, last_used_at, revoked_at')
        .eq('account_id', session.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ tokens: data || [] });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── REVOKE TOKEN: e.g. a lost laptop -- immediately blocks that device's
  // Companion app from calling uploadLoot/getRosterSync/getMyTeams again. ──
  if (action === 'revokeToken') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const tokenId = req.body?.tokenId;
    if (!tokenId) return res.status(400).json({ error: 'tokenId required' });
    try {
      const { data, error } = await supabase.from('companion_tokens')
        .update({ revoked_at: new Date().toISOString() })
        .eq('id', tokenId).eq('account_id', session.id)
        .select('id').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Token not found' });
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  res.status(400).json({ error: 'Invalid action' });
};
