-- ============================================================
-- Schema additions for the officer-owned roster (characters table becomes
-- the source of truth, populated by hand and/or via WowAudit API import,
-- instead of being silently overwritten from a spreadsheet on every load).
-- This project has no migration runner -- run this once, by hand, in the
-- Supabase SQL editor, same as every other schema change to date. Safe to
-- re-run: every statement is idempotent.
--
-- `characters` predates this repo's sql/ convention and was never checked
-- in, so its shape below is inferred from every INSERT/SELECT against it
-- across api/*.js. The `create table if not exists` is a no-op against the
-- live table (Postgres doesn't diff columns on IF NOT EXISTS) -- it only
-- matters for bootstrapping a brand new environment. The `alter table`
-- statements below are what actually change the live table.
-- ============================================================

create table if not exists characters (
  id                           uuid primary key default gen_random_uuid(),
  team_id                      uuid not null references teams(id) on delete cascade,
  name                         text not null,
  class                        text not null default 'unknown',
  server                       text not null default '',
  primary_role                 text not null default 'ranged',
  account_id                   uuid references accounts(id),
  flex_tank                    boolean not null default false,
  flex_heal                    boolean not null default false,
  flex_melee                   boolean not null default false,
  flex_ranged                  boolean not null default false,
  can_flex_tank                boolean not null default false,
  can_flex_heal                boolean not null default false,
  can_flex_melee               boolean not null default false,
  can_flex_ranged              boolean not null default false,
  created_at                   timestamptz not null default now(),
  unique (team_id, name)
);

-- Soft-delete flag -- "Remove Character" sets this to false rather than
-- deleting the row, since loot_drops.recipient_character_id/
-- current_holder_character_id reference characters(id) with no ON DELETE
-- clause (a hard delete would fail for anyone with loot history), and this
-- also keeps past raid plans/attendance intact and makes a mistaken removal
-- reversible. Existing rows backfill to true via the default.
alter table characters add column if not exists active boolean not null default true;

-- Main/Alt, as reported by WowAudit's API on import; also editable by hand.
-- Not used for any filtering logic yet -- just captured since it's now
-- available and shown on the roster.
alter table characters add column if not exists rank text not null default 'Main';

create index if not exists characters_team_id_active_idx on characters(team_id, active);

-- This team's WowAudit API key (Settings > API in WowAudit), used by
-- api/wowaudit.js's on-demand import action. Optional -- unlike the old
-- wowaudit_url spreadsheet link, a team works fine with no key at all.
-- Encrypted the same way wcl_client_secret_enc already is (lib/crypto.js).
-- The hash is a one-way sha256 of the plaintext key, kept only to detect
-- two teams accidentally sharing one WowAudit key -- never decryptable.
alter table teams add column if not exists wowaudit_api_key_enc text;
alter table teams add column if not exists wowaudit_api_key_hash text;
