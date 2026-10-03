// ============================================================
//  lib/codes.js — the short codes people read and type: team join codes
//  (api/guild.js), Discord link codes (api/members.js) and RaidLead
//  Companion's login code (api/companion.js). Six characters from an
//  alphabet with no look-alikes (no 0/O, 1/I/L), since these get read
//  aloud and typed by hand.
// ============================================================
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/** A random code. */
function randomCode() {
  return Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
}

/** A code made from bytes (e.g. an HMAC): the same bytes always give the same code. */
function codeFromBytes(bytes) {
  return Array.from(bytes.subarray(0, CODE_LENGTH), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

module.exports = { CODE_ALPHABET, CODE_LENGTH, randomCode, codeFromBytes };
