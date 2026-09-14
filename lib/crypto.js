// ============================================================
//  lib/crypto.js — symmetric encryption for secrets stored at rest
//  (per-guild WCL API client secrets)
//
//  Format: base64( iv[12] + authTag[16] + ciphertext )
//  Requires env var: WCL_CREDENTIALS_KEY (exactly 64 hex chars = 32 bytes)
// ============================================================
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.WCL_CREDENTIALS_KEY;
  if (!hex) throw new Error('WCL_CREDENTIALS_KEY env var is not set');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('WCL_CREDENTIALS_KEY must be 64 hex characters (32 bytes)');
  return key;
}

/** Encrypts a plaintext string. Returns a base64 string safe to store in a text column. */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/** Decrypts a value produced by encrypt(). Throws if the key is wrong or data is corrupt. */
function decrypt(encoded) {
  const key = getKey();
  const data = Buffer.from(encoded, 'base64');
  const iv         = data.subarray(0, 12);
  const authTag    = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
