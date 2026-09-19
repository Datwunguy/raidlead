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
  const { data: chars } = await supabase
    .from('characters')
    .select('id, name')
    .eq('team_id', teamId)
    .in('name', uniqueNames);
  const map = {};
  (chars || []).forEach(c => { if (!(c.name in map)) map[c.name] = c.id; });
  return map;
}

// Imports a batch of addon-shaped loot records into loot_drops, filtering out
// anything already tombstoned by a prior officer delete -- the addon's own
// local SavedVariables store has no idea a record was removed server-side,
// so it would otherwise keep re-exporting the same addon_record_id forever.
// Returns { imported: N }; throws with a `.status` the caller can map straight
// to an HTTP response.
async function importLootRecords(supabase, { teamId, records, reportedByAccountId }) {
  if (!teamId) throw Object.assign(new Error('teamId required'), { status: 400 });
  if (!Array.isArray(records) || records.length === 0) {
    throw Object.assign(new Error('records array required'), { status: 400 });
  }

  const nameMap = await resolveCharacterIds(supabase, teamId, records.map(r => r.recipientName));

  const rows = records
    .filter(r => r.addonRecordId && r.itemId && r.recipientName && r.sessionId)
    .map(r => ({
      team_id:                     teamId,
      raid_date:                   r.raidDate || null,
      encounter_id:                r.encounterId ?? null,
      boss_name:                   r.bossName || null,
      difficulty:                  r.difficulty || null,
      item_id:                     r.itemId,
      item_name:                   r.itemName || null,
      is_tier_token:               !!r.isTierToken,
      is_boe:                      !!r.isBoe,
      item_quality_track:          r.qualityTrack || null,
      upgrade_level:               r.upgradeLevel ?? null,
      upgrade_level_max:           r.upgradeLevelMax ?? null,
      item_slot:                   r.itemSlot || null,
      armor_type:                  r.armorType || null,
      bind_type:                   r.bindType || null,
      loot_method:                 r.lootMethod || 'personal',
      roll_type:                   r.rollType || null,
      roll_value:                  r.rollValue ?? null,
      roll_participants:           r.rollParticipants || null,
      recipient_name:              r.recipientName,
      recipient_character_id:      nameMap[r.recipientName] || null,
      current_holder_name:         r.recipientName,
      current_holder_character_id: nameMap[r.recipientName] || null,
      session_id:                  r.sessionId,
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
  const { data: tombstones } = await supabase
    .from('loot_deleted_records')
    .select('addon_record_id')
    .eq('team_id', teamId)
    .in('addon_record_id', rows.map(r => r.addon_record_id));
  const deletedIds = new Set((tombstones || []).map(t => t.addon_record_id));
  const liveRows = rows.filter(r => !deletedIds.has(r.addon_record_id));

  if (liveRows.length === 0) return { imported: 0 };

  // ignoreDuplicates -- a record that's already been uploaded is a silent no-op,
  // never an update, so a re-sent record can't stomp an officer's later reassign.
  const { error } = await supabase
    .from('loot_drops')
    .upsert(liveRows, { onConflict: 'team_id,addon_record_id', ignoreDuplicates: true });
  if (error) throw error;

  return { imported: liveRows.length };
}

module.exports = { resolveCharacterIds, importLootRecords };
