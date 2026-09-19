// ============================================================
// auth.js — RaidLead Companion's own login, via a short device-pairing
// handshake instead of a username/password (RaidLead has no such
// credential -- every account is Battle.net OAuth only). The user clicks
// Log In here, approves the request on the website (already logged in
// normally there), and this polls until it receives its own long-lived,
// individually-revocable access token. See api/companion.js and
// sql/2026_09_companion_auth.sql on the website side for the rest of this
// flow -- this app never sees a Battle.net credential at any point.
// ============================================================
const os = require('os');
const { safeStorage } = require('electron');

const SITE_ORIGIN = 'https://raidlead.vercel.app';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // matches the server's pairing expiry

function deviceLabel() {
  return os.hostname() || 'Unknown device';
}

async function startPairing() {
  const resp = await fetch(`${SITE_ORIGIN}/api/companion?action=startPairing`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceLabel: deviceLabel() }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Could not start login');
  return data; // { pairingCode, approveUrl }
}

// Polls until the pairing resolves to a token, or times out. `onStatus`
// (optional) is called with each raw status string so the UI can show
// progress while the user is over on the website approving the request.
async function pollPairing(pairingCode, onStatus) {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const resp = await fetch(`${SITE_ORIGIN}/api/companion?action=checkPairing&pairingCode=${encodeURIComponent(pairingCode)}`);
    const data = await resp.json();
    if (onStatus) onStatus(data.status);

    if (data.status === 'claimed') {
      if (data.token) return data.token;
      // A token was already handed out for this pairing (e.g. this exact
      // poll retried after its response was lost) -- there is deliberately
      // no way to get a second copy, since the plaintext is never stored.
      throw new Error('This login was already completed -- try logging in again.');
    }
    if (data.status === 'expired' || data.status === 'not_found') {
      throw new Error('This login request expired -- try again.');
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Login timed out -- try again.');
}

// Encrypted at rest via Electron's safeStorage (OS-backed, e.g. Windows
// DPAPI) rather than plain JSON like the rest of config.js -- this token
// can act on the user's RaidLead account indefinitely (until revoked), so
// it gets the same at-rest protection Chrome/Edge already give your saved
// website passwords, not plaintext-on-disk treatment.
function encryptToken(token) {
  if (!safeStorage.isEncryptionAvailable()) return token; // fallback: store as-is rather than fail outright
  return safeStorage.encryptString(token).toString('base64');
}

function decryptToken(stored) {
  if (!stored) return null;
  if (!safeStorage.isEncryptionAvailable()) return stored;
  try { return safeStorage.decryptString(Buffer.from(stored, 'base64')); }
  catch { return null; } // encrypted under a different OS key (e.g. moved to another PC) -- treat as logged out
}

async function getMyTeams(token) {
  const resp = await fetch(`${SITE_ORIGIN}/api/companion?action=getMyTeams`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || 'Could not load teams');
  return data.teams || [];
}

module.exports = { SITE_ORIGIN, deviceLabel, startPairing, pollPairing, encryptToken, decryptToken, getMyTeams };
