// ============================================================
//  lib/session.js — HMAC-signed session tokens
//
//  Format: base64url(JSON payload) + "." + HMAC-SHA256 signature
//  Requires env var: SESSION_SECRET  (min 32 random bytes, hex or any string)
// ============================================================
const crypto = require('crypto');

const ALGORITHM = 'sha256';
const SEP       = '.';

/** Returns the hex HMAC of `data` using SESSION_SECRET */
function sign(data) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET env var is not set');
  return crypto.createHmac(ALGORITHM, secret).update(data).digest('hex');
}

/** Encode a session payload object → signed token string */
function encodeSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = sign(body);
  return body + SEP + sig;
}

/**
 * Decode and verify a session token.
 * Returns the payload object, or null if invalid/expired/tampered.
 */
function decodeSession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split(SEP);
  // Token must be exactly two parts: body + signature
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  // Constant-time comparison to prevent timing attacks
  const expected = sign(body);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract and verify the session from a request.
 * Checks Authorization: Bearer header first, then the raidlead_session cookie.
 * Returns the decoded payload or null.
 */
function getSession(req) {
  const auth   = req.headers?.authorization || '';
  const cookie = req.headers?.cookie        || '';
  let token    = null;

  if (auth.startsWith('Bearer ')) {
    token = auth.slice(7).trim();
  } else {
    const m = cookie.match(/raidlead_session=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }

  return decodeSession(token);
}

/** Standard CORS + content-type headers for every API response */
function setCommonHeaders(res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', 'https://raidlead.vercel.app');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
}

module.exports = { encodeSession, decodeSession, getSession, setCommonHeaders };
