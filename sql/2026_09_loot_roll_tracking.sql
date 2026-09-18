-- ============================================================
-- Adds Group Loot (Need/Greed roll) tracking to loot_drops. This project
-- has no migration runner -- run this once, by hand, in the Supabase SQL
-- editor, same as every other schema change to date. Safe to re-run: every
-- statement is idempotent.
--
-- Until now loot_drops only ever recorded Personal Loot (the addon's
-- CHAT_MSG_LOOT capture) -- a raid using the older Group Loot method (drop
-- goes to a raid-wide Need/Greed roll, highest roll wins) produced no rows
-- at all for those drops. See addon/RaidLead/Loot.lua's
-- HandleLootHistoryDrop for the capture side.
-- ============================================================

alter table loot_drops add column if not exists loot_method text not null default 'personal';
  -- 'personal' (Personal Loot, existing CHAT_MSG_LOOT capture) or
  -- 'roll' (Group Loot, C_LootHistory capture, added by this migration).

alter table loot_drops add column if not exists roll_type text;
  -- 'need' / 'need-offspec' / 'transmog' / 'greed' / 'no-roll' / 'pass' --
  -- the WINNING roll's type. Null for loot_method = 'personal'.

alter table loot_drops add column if not exists roll_value int;
  -- The winning roll's numeric value (e.g. 97). Null for loot_method =
  -- 'personal', and also null if allPassed (item auto-assigned/disenchanted
  -- with nobody actually rolling).

alter table loot_drops add column if not exists roll_participants jsonb;
  -- Full roll breakdown for transparency/audit, from the same
  -- C_LootHistory read that found the winner: [{name, rollType, rollValue,
  -- isWinner}, ...] for every eligible player, not just the winner. Null
  -- for loot_method = 'personal'.
