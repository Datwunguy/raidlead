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

create table if not exists global_zone_transitions (
  zone_id           int primary key,
  zone_name         text not null,
  first_detected_at date not null default current_date,
  created_at        timestamptz not null default now()
);

-- One row per team per season. ended_at is null for the current season --
-- the partial unique index below guarantees a team can never have more than
-- one "current" season at a time, even if two officers' sessions race to
-- advance it at once (the loser's insert just fails).
create table if not exists seasons (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references teams(id) on delete cascade,
  zone_id    int not null,
  zone_name  text not null,
  started_at date not null,
  ended_at   date,
  created_at timestamptz not null default now()
);

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
