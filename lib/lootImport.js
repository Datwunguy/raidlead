// ============================================================
//  lib/lootImport.js — shared loot-import logic, used by both api/loot.js's
//  `import` action (legacy browser-driven path) and api/companion.js's
//  `uploadLoot` action (the Companion app's direct-upload path). One
//  implementation so the tombstone check below can't accidentally exist on
//  one path and not the other.
// ============================================================

// Resolves a batch of character names to { name -> id } for one team, best-effort --
// a name with no match (e.g. a brand new alt) simply has no entry, and callers
// keep the raw name for display rather than failing the whole import.
async function resolveCharacterIds(supabase, teamId, names) {
  const uniqueNames = [...new Set(names.filter(Boolean))];
  if (uniqueNames.length === 0) return {};
  const chars = await selectIn(supabase, 'characters', 'id, name', teamId, 'name', uniqueNames, 'id');
  const map = {};
  chars.forEach(c => { if (!(c.name in map)) map[c.name] = c.id; });
  return map;
}

// Imports a batch of addon-shaped loot records into loot_drops, filtering out
// anything already tombstoned by a prior officer delete -- the addon's own
// local SavedVariables store has no idea a record was removed server-side,
// so it would otherwise keep re-exporting the same addon_record_id forever.
// Returns { imported: N }; throws with a `.status` the caller can map straight
// to an HTTP response.
// Text and numbers as the addon writes them: short strings, whole numbers.
const text = (v, max) => (v == null || v === '' ? null : String(v).slice(0, max));
const whole = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
const dateText = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
// The addon's capturedAt (Unix seconds) as a timestamp -- null if it's not a plausible one.
const capturedTime = v => {
  const s = whole(v);
  return s && s > 1577836800 && s * 1000 < Date.now() + 86400000 ? new Date(s * 1000).toISOString() : null;
};
const MAX_RECORDS = 5000; // the addon keeps 45 days of drops
const IN_CHUNK = 200;     // values per .in() filter -- they travel in the request URL
const PAGE = 1000;        // Supabase returns at most this many rows per request

// Several raiders running the addon each record the same drop (loot chat goes
// to the whole raid), each under their own session. Copies of one drop: same
// recipient and item, captured within this long of each other by different
// sessions. (Boss and difficulty aren't compared -- a client that /reloaded
// or zoned in mid-fight may not know the boss.)
const SAME_DROP_WINDOW_MS = 3 * 60 * 1000;

// The team's rows matching .in(column, values) -- a chunk of values and a
// page of rows at a time. orderBy: a unique column, so pages don't overlap.
async function selectIn(supabase, table, columns, teamId, column, values, orderBy) {
  const out = [];
  for (let i = 0; i < values.length; i += IN_CHUNK) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from(table).select(columns)
        .eq('team_id', teamId).in(column, values.slice(i, i + IN_CHUNK))
        .order(orderBy).range(from, from + PAGE - 1);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
  }
  return out;
}

const dropKey = r => `${String(r.recipient_name).toLowerCase()}|${r.item_id}`;
const sourceOf = r => r.source_session_id || r.session_id;
// Two records of one drop? Captured within the window -- or, for rows saved
// before capture times were, the same raid date, boss and difficulty.
function sameDrop(a, b) {
  if (a.captured_at && b.captured_at) return Math.abs(Date.parse(a.captured_at) - Date.parse(b.captured_at)) <= SAME_DROP_WINDOW_MS;
  return a.raid_date === b.raid_date && (a.boss_name || null) === (b.boss_name || null) && (a.difficulty || null) === (b.difficulty || null);
}
const dayShift = (date, days) => new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);

async function importLootRecords(supabase, { teamId, records, reportedByAccountId }) {
  if (!teamId) throw Object.assign(new Error('teamId required'), { status: 400 });
  if (!Array.isArray(records) || records.length === 0) {
    throw Object.assign(new Error('records array required'), { status: 400 });
  }
  if (records.length > MAX_RECORDS) throw Object.assign(new Error(`At most ${MAX_RECORDS} records per upload`), { status: 400 });
  records = records.filter(r => r && typeof r === 'object').map(r => ({
    ...r,
    recipientName: text(r.recipientName, 64), sessionId: text(r.sessionId, 100), addonRecordId: text(r.addonRecordId, 100),
    itemId: whole(r.itemId),
  }));

  const nameMap = await resolveCharacterIds(supabase, teamId, records.map(r => r.recipientName));

  const rows = records
    .filter(r => r.addonRecordId && r.itemId && r.recipientName && r.sessionId)
    .map(r => ({
      team_id:                     teamId,
      raid_date:                   dateText(r.raidDate),
      encounter_id:                whole(r.encounterId),
      boss_name:                   text(r.bossName, 100),
      difficulty:                  text(r.difficulty, 40),
      item_id:                     r.itemId,
      item_name:                   text(r.itemName, 120),
      is_tier_token:               !!r.isTierToken,
      is_boe:                      !!r.isBoe,
      item_quality_track:          text(r.qualityTrack, 20),
      upgrade_level:               whole(r.upgradeLevel),
      upgrade_level_max:           whole(r.upgradeLevelMax),
      item_slot:                   text(r.itemSlot, 40),
      armor_type:                  text(r.armorType, 20),
      bind_type:                   text(r.bindType, 40),
      loot_method:                 text(r.lootMethod, 20) || 'personal',
      roll_type:                   text(r.rollType, 20),
      roll_value:                  whole(r.rollValue),
      roll_participants:           Array.isArray(r.rollParticipants) ? r.rollParticipants.slice(0, 40) : null,
      recipient_name:              r.recipientName,
      recipient_character_id:      nameMap[r.recipientName] || null,
      current_holder_name:         r.recipientName,
      current_holder_character_id: nameMap[r.recipientName] || null,
      session_id:                  r.sessionId,  // the run it's listed under (may become another uploader's, below)
      source_session_id:           r.sessionId,  // the addon session that recorded it
      captured_at:                 capturedTime(r.capturedAt),
      likely_pug:                  !!r.likelyPug,
      addon_record_id:             r.addonRecordId,
      reported_by_account_id:      reportedByAccountId,
    }));

  if (rows.length === 0) throw Object.assign(new Error('No valid records in payload'), { status: 400 });

  // The addon's own local SavedVariables store keeps every record it's ever
  // captured (pruned only after 45 days) and has no idea an officer later
  // deleted one server-side -- it just re-exports the same addon_record_id
  // again next sync. ignoreDuplicates only protects against re-uploading a
  // record that's STILL there; once deleted, there's no row left to
  // conflict with, so it would otherwise silently reinsert. This tombstone
  // check is what makes a delete actually stick.
  const ids = rows.map(r => r.addon_record_id);
  const [tombstones, uploaded] = await Promise.all([
    selectIn(supabase, 'loot_deleted_records', 'addon_record_id', teamId, 'addon_record_id', ids, 'addon_record_id'),
    selectIn(supabase, 'loot_drops', 'addon_record_id', teamId, 'addon_record_id', ids, 'addon_record_id'),
  ]);
  // Every sync re-sends the addon's whole store: only what's new matters.
  const skip = new Set([...tombstones, ...uploaded].map(t => t.addon_record_id));
  const newRows = rows.filter(r => !skip.has(r.addon_record_id));
  if (newRows.length === 0) return { imported: 0, merged: 0 };

  const { insert, merged, fillIns } = await mergeCopies(supabase, teamId, newRows);
  if (insert.length) {
    // ignoreDuplicates -- a record that's already been uploaded is a silent no-op,
    // never an update, so a re-sent record can't stomp an officer's later reassign.
    const { error } = await supabase
      .from('loot_drops')
      .upsert(insert, { onConflict: 'team_id,addon_record_id', ignoreDuplicates: true });
    if (error) throw error;
  }
  // A copy that knew the boss fills it in on the record that didn't.
  for (const { id, fields } of fillIns) await supabase.from('loot_drops').update(fields).eq('id', id);

  return { imported: insert.length, merged };
}

// Drops another raider's addon already reported aren't saved twice: each new
// record is matched against saved ones from other sessions (and against
// each other) one-to-one, closest capture time first. A session with copies
// joins the run it copied -- so the drops only it caught land in that same
// run, and one raid night is one run however many raiders recorded it.
async function mergeCopies(supabase, teamId, newRows) {
  const dates = [...new Set(newRows.map(r => r.raid_date).filter(Boolean))];
  let saved = [];
  if (dates.length) {
    // ±1 day: raiders' clocks can disagree on the date of a drop near midnight.
    const near = [...new Set(dates.flatMap(d => [dayShift(d, -1), d, dayShift(d, 1)]))];
    saved = await selectIn(supabase, 'loot_drops',
      'id, session_id, source_session_id, recipient_name, item_id, raid_date, boss_name, encounter_id, difficulty, captured_at',
      teamId, 'raid_date', near, 'id');
  }
  const pool = new Map(); // dropKey -> records of that recipient + item
  const addToPool = r => { const k = dropKey(r); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(r); };
  saved.forEach(addToPool);

  const claimed = new Map(); // source session -> records it has matched (one copy each)
  const runVotes = new Map(); // source session -> { run session -> copies matched in it }
  const insert = [], fillIns = [];
  let merged = 0;
  const byTime = (a, b) => (a.captured_at || '').localeCompare(b.captured_at || '');
  for (const r of [...newRows].sort(byTime)) {
    const src = r.source_session_id;
    if (!claimed.has(src)) claimed.set(src, new Set());
    const mine = claimed.get(src);
    const gap = c => (r.captured_at && c.captured_at ? Math.abs(Date.parse(r.captured_at) - Date.parse(c.captured_at)) : 0);
    const copy = (pool.get(dropKey(r)) || [])
      .filter(c => sourceOf(c) !== src && !mine.has(c) && sameDrop(r, c))
      .sort((a, b) => gap(a) - gap(b))[0];
    if (copy) {
      mine.add(copy);
      merged++;
      const votes = runVotes.get(src) || new Map();
      votes.set(copy.session_id, (votes.get(copy.session_id) || 0) + 1);
      runVotes.set(src, votes);
      if (!copy.boss_name && r.boss_name) {
        const fields = { boss_name: r.boss_name, encounter_id: r.encounter_id, difficulty: copy.difficulty || r.difficulty };
        Object.assign(copy, fields); // a row from this same upload is saved with it
        if (copy.id) fillIns.push({ id: copy.id, fields });
      }
      continue;
    }
    insert.push(r);
    addToPool(r);
  }
  // Each session that had copies joins the run most of them were in.
  for (const r of insert) {
    const votes = runVotes.get(r.source_session_id);
    if (votes) r.session_id = [...votes].sort((a, b) => b[1] - a[1])[0][0];
  }
  return { insert, merged, fillIns };
}

module.exports = { resolveCharacterIds, importLootRecords };
