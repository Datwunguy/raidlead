-- ============================================================
-- Schema additions for automatic season/zone tracking + roster membership
-- history. This project has no migration runner -- run this once, by hand,
-- in the Supabase SQL editor, same as every other schema change to date.
-- Safe to re-run: every statement is idempotent.
--
-- A raid tier launches on one real, objective date -- every guild using
-- RaidLead should record the same date for that transition, not whichever
-- day their own officer happened to next load the page. global_zone_transitions
-- is the shared record: the first team anywhere in the app to detect a given
-- zone sets its first_detected_at once, and every team's own `seasons` row
-- for that same zone reads that one shared date (see api/roster.js's
-- advanceSeason action).
-- ============================================================

-- zone_name (not zone_id) is the identity key: Raider.io's per-region raid
-- launch dates are now the primary detection source (no WCL credentials
-- needed), and Raider.io's raid IDs are a completely different numbering
-- system from WCL's zone IDs -- there's no shared key between the two
-- services. zone_id is populated as a best-effort enrichment (by matching
-- this zone_name against the team's own WCL zone list, when they have WCL
-- credentials connected) so WCL-specific features (Scores, Mitigation)
-- keep working for teams that have it -- but it's optional, since a
-- credential-less team can have a perfectly good season with no WCL zone
-- number at all.
create table if not exists global_zone_transitions (
  zone_id           int,
  zone_name         text primary key,
  first_detected_at date not null default current_date,
  created_at        timestamptz not null default now()
);
-- The block above is a no-op against an already-existing table (Postgres
-- doesn't diff columns/constraints on IF NOT EXISTS) -- this repo's live
-- table still has zone_id as the primary key from the original version of
-- this file. Migrate it explicitly: drop that PK, free up zone_id to be
-- nullable, then make zone_name the real primary key.
alter table global_zone_transitions drop constraint if exists global_zone_transitions_pkey;
alter table global_zone_transitions alter column zone_id drop not null;
alter table global_zone_transitions add constraint global_zone_transitions_pkey primary key (zone_name);

-- One row per team per season. ended_at is null for the current season --
-- the partial unique index below guarantees a team can never have more than
-- one "current" season at a time, even if two officers' sessions race to
-- advance it at once (the loser's insert just fails).
create table if not exists seasons (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references teams(id) on delete cascade,
  zone_id    int,
  zone_name  text not null,
  started_at date not null,
  ended_at   date,
  created_at timestamptz not null default now()
);
alter table seasons alter column zone_id drop not null;

create unique index if not exists seasons_one_current_per_team
  on seasons(team_id) where ended_at is null;
create index if not exists seasons_team_id_idx on seasons(team_id);

-- One row per "stint" a character has on the roster -- authoritative answer
-- to "who was on the roster during Season X", independent of who actually
-- got scheduled into a raid_plan on any given night. Someone who leaves and
-- later rejoins gets a second row here rather than overwriting the first,
-- so their earlier stint's history stays intact.
create table if not exists character_membership_periods (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references teams(id) on delete cascade,
  character_id uuid not null references characters(id) on delete cascade,
  joined_at    date not null,
  left_at      date,
  created_at   timestamptz not null default now()
);

create index if not exists membership_periods_team_id_idx on character_membership_periods(team_id);
create index if not exists membership_periods_character_id_idx on character_membership_periods(character_id);
