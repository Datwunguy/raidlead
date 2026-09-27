// ============================================================
//  lib/googleSheets.js — read-only Google Sheets access through a Google
//  service account, used by Team Management -> Applicants to read a
//  guild's Google Form response sheet. Each guild shares its sheet with the
//  service account's email as a Viewer; the key lives only in the
//  GOOGLE_SERVICE_ACCOUNT_JSON env var. Uses a signed-JWT bearer grant
//  built with Node's own crypto, so there's no googleapis dependency.
// ============================================================
const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
let tokenCache = { token: null, expiresAt: 0 };

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;
    // Some env-var UIs keep the key's line breaks as a literal "\n".
    return { email: sa.client_email, key: sa.private_key.replace(/\\n/g, '\n') };
  } catch (e) {
    return null;
  }
}

function serviceAccountEmail() {
  return serviceAccount()?.email || null;
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const sa = serviceAccount();
  if (!sa) throw new Error('Google Sheets access is not set up on this RaidLead server.');

  const now    = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: sa.email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.key);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  `${header}.${claims}.${base64url(signature)}`,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error('Google rejected the service account: ' + (data.error_description || data.error || resp.status));
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in || 3600) - 120) * 1000 };
  return tokenCache.token;
}

// "https://docs.google.com/spreadsheets/d/<id>/edit?...#gid=123" -> { id, gid }
function parseSheetUrl(url) {
  const s   = String(url || '');
  const id  = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/)?.[1];
  const gid = s.match(/[#&?]gid=(\d+)/)?.[1] || null;
  return id ? { id, gid } : null;
}

async function sheetsGet(path, token) {
  const resp = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error?.message || `Google Sheets returned ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}

// Reads the whole tab matching `gid` (or the first tab). Values come back
// unformatted -- timestamps as serial day numbers -- so they parse the same
// no matter what locale the sheet is set to.
async function readSheetTab(spreadsheetId, gid) {
  const token = await getAccessToken();
  const meta  = await sheetsGet(`${spreadsheetId}?fields=properties.title,sheets.properties(sheetId,title)`, token);
  const tabs  = meta.sheets || [];
  const tab   = (gid != null && tabs.find(s => String(s.properties.sheetId) === String(gid))) || tabs[0];
  if (!tab) throw new Error('That spreadsheet has no tabs.');

  const title  = tab.properties.title;
  const range  = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
  const values = await sheetsGet(`${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`, token);
  return {
    spreadsheetTitle: meta.properties?.title || '',
    tabTitle:         title,
    gid:              String(tab.properties.sheetId),
    rows:             values.values || [],
  };
}

module.exports = { serviceAccountEmail, parseSheetUrl, readSheetTab };
