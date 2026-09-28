-- ============================================================
-- Team Management: Join Order. The order raiders joined the team this
-- season -- when more than 30 (Heroic's cap) want to raid, #31 is next in
-- line if someone in the first 30 is missing.
--
-- One order per season: opening a Next Season survey starts a fresh one,
-- filled in the order raiders finish the survey (Returning first, then Not
-- sure). Anyone added to the roster later goes to the end. Officers can
-- reorder it by hand, and teams with no survey yet can start one from their
-- current roster. Older orders are kept as history.
--
-- This project has no migration runner -- run this once, by hand, in the
-- Supabase SQL editor, same as every other schema change to date. Safe to
-- re-run: every statement is idempotent.
-- ============================================================

-- One row per order. survey_id is the survey that started it (null for a
-- "Starting order" built from the roster, or once that survey is deleted).
-- The team's current order is its newest row.
create table if not exists join_orders (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references teams(id) on delete cascade,
  survey_id   uuid references season_surveys(id) on delete set null,
  title       text not null,
  created_at  timestamptz not null default now()
);
create unique index if not exists join_orders_one_per_survey on join_orders(survey_id) where survey_id is not null;
create index if not exists join_orders_team_idx on join_orders(team_id, created_at desc);

-- One row per raider in an order. Numbers aren't stored -- a raider's number
-- is their place among the entries that haven't left, sorted by position
-- (fractional, so someone can be slotted in between two others without
-- renumbering everyone). Leaving keeps the row, for history.
--   source:        survey | roster (added to the roster) | recruit (added
--                  from Team Management > Recruits) | manual (added by an
--                  officer on the Join Order tab)
--   survey_status: returning | unsure, for survey entries
create table if not exists join_order_entries (
  id              uuid primary key default gen_random_uuid(),
  join_order_id   uuid not null references join_orders(id) on delete cascade,
  team_id         uuid not null references teams(id) on delete cascade,
  character_id    uuid references characters(id) on delete set null,
  account_id      uuid references accounts(id) on delete set null,
  character_name  text not null,
  position        double precision not null,
  joined_at       timestamptz not null default now(),
  source          text not null check (source in ('survey', 'roster', 'recruit', 'manual')),
  survey_status   text check (survey_status in ('returning', 'unsure')),
  left_at         timestamptz,
  left_reason     text,
  created_at      timestamptz not null default now()
);
-- A character appears at most once per order (rejoining reuses their row).
create unique index if not exists join_order_entries_one_per_character
  on join_order_entries(join_order_id, character_id) where character_id is not null;
create index if not exists join_order_entries_order_idx on join_order_entries(join_order_id, position);
