// ============================================================
//  lib/serverSlug.js — realm-name <-> slug conversion, shared by anything
//  that writes or displays characters.server (currently: the WowAudit
//  import in api/wowaudit.js, and the manual add/edit actions in
//  api/roster.js). Keeps the stored slug format identical regardless of
//  which of those wrote it.
// ============================================================

/** "Twisting Nether" -> "twisting-nether" (lossy for punctuation, same tradeoff the old spreadsheet parser made -- this is what's stored and what Raider.io's realm param expects). */
function slugifyServer(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/'/g, '')
    .replace(/é/g, 'e')
    .replace(/[^a-z0-9-]/g, '');
}

/** "twisting-nether" -> "Twisting Nether", for display only -- can't recover punctuation the slug already dropped. */
function serverDisplayFromSlug(slug) {
  return String(slug || '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { slugifyServer, serverDisplayFromSlug };
