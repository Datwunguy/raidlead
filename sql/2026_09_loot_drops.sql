-- ============================================================
-- Schema additions for RaidLead loot tracking. This project has no
-- migration runner -- run this once, by hand, in the Supabase SQL editor,
-- same as every other schema change to date. Safe to re-run: every
-- statement is idempotent.
--
-- No separate sync-key table: loot import is authenticated by the normal
-- team session, since the browser (not a separate companion app) is what
-- reads the addon's SavedVariables file via the File System Access API and
-- posts it here as the logged-in user.
-- ============================================================

create table if not exists loot_drops (
  id                           uuid primary key default gen_random_uuid(),
  team_id                      uuid not null references teams(id) on delete cascade,
  raid_date                    date,
  encounter_id                 int,
  boss_name                    text,
  difficulty                   text,
  item_id                      int not null,
  item_name                    text,
  is_tier_token                boolean not null default false,
  is_boe                       boolean not null default false,

  -- Who the game assigned it to (addon-reported, never overwritten) vs. who
  -- actually has it now (defaults to the recipient; an Officer/Owner can move
  -- this after a trade). Both the raw addon-reported name and a best-effort
  -- resolved character id are kept, since the name may not match a known
  -- character row yet (e.g. a brand new alt).
  recipient_name               text not null,
  recipient_character_id       uuid references characters(id),
  current_holder_name          text not null,
  current_holder_character_id  uuid references characters(id),

  -- Groups every loot row from one game session together, so an Officer/Owner
  -- can bulk-remove an entire non-guild run in one action.
  session_id                   text not null,
  likely_pug                   boolean not null default false,

  addon_record_id              text not null,   -- addon-generated, unique per team; makes re-uploads idempotent
  reported_by_account_id       uuid references accounts(id),
  created_at                   timestamptz not null default now(),

  unique (team_id, addon_record_id)
);

create index if not exists loot_drops_team_id_idx on loot_drops(team_id);
create index if not exists loot_drops_session_id_idx on loot_drops(team_id, session_id);

-- Item metadata captured alongside each drop -- quality track/upgrade level
-- aren't in GetItemInfo, so the addon reads them off the item's tooltip
-- text (best-effort; null when it can't find them, never blocks the rest
-- of the row from being recorded).
alter table loot_drops add column if not exists item_quality_track text;   -- Veteran / Champion / Hero / Mythic
alter table loot_drops add column if not exists upgrade_level      int;    -- e.g. 4 (as in "4/8")
alter table loot_drops add column if not exists upgrade_level_max  int;    -- e.g. 8
alter table loot_drops add column if not exists item_slot          text;  -- e.g. "Head", "Neck", "Trinket"
alter table loot_drops add column if not exists armor_type         text;  -- Cloth / Leather / Mail / Plate (armor only)

-- Manual per-character checklist for "one tier token per member" tracking --
-- deliberately separate from the auto-captured is_tier_token drops, since
-- officers need to hand-confirm this regardless of what the addon saw (a
-- token awarded outside the addon's view, an out-of-game DKP-style trade,
-- etc). One row per character; absence of a row means unchecked. Not scoped
-- to a "tier"/season column (this app has no such concept anywhere else) --
-- officers reset it at the start of a new tier instead (see resetTierChecks
-- in api/loot.js), which keeps this table from needing tier bookkeeping.
create table if not exists tier_token_checks (
  id                     uuid primary key default gen_random_uuid(),
  team_id                uuid not null references teams(id) on delete cascade,
  character_id           uuid not null references characters(id) on delete cascade,
  checked_by_account_id  uuid references accounts(id),
  checked_at             timestamptz not null default now(),
  unique (team_id, character_id)
);

create index if not exists tier_token_checks_team_id_idx on tier_token_checks(team_id);

-- Deleting a loot_drops row (delete/deleteSession) doesn't stop the addon
-- from re-exporting the same addon_record_id next sync -- RaidLeadDB.lootRecords
-- on the WoW client is its own persistent local store (pruned only after 45
-- days), so it has no idea an officer removed something server-side, and
-- `import`'s ignoreDuplicates upsert only skips a record if a row with that
-- addon_record_id STILL exists -- once deleted, there's nothing to conflict
-- with, so it just silently reinserts. This tombstone table is what actually
-- makes a delete stick: `import` filters incoming records against it before
-- inserting, and delete/deleteSession add to it as they remove rows.
create table if not exists loot_deleted_records (
  team_id          uuid not null references teams(id) on delete cascade,
  addon_record_id  text not null,
  deleted_at       timestamptz not null default now(),
  primary key (team_id, addon_record_id)
);
