-- ============================================================
-- Team Management, Phase 3: Next Season survey. Replaces the Google Form
-- sent to current raiders each season ("are you coming back, and on what
-- spec?"). Raiders answer on-site, signed in, so every response maps to an
-- account (and usually a roster character) and officers can see who hasn't
-- answered yet.
--
-- This project has no migration runner -- run this once, by hand, in the
-- Supabase SQL editor, same as every other schema change to date. Safe to
-- re-run: every statement is idempotent.
-- ============================================================

-- One row per survey. closed_at is null while it's open; the partial unique
-- index means a team can only ever have one open survey (two officers
-- opening one at the same moment can't both succeed).
--
-- questions holds the officer-editable parts (the fixed ones -- returning,
-- character, spec choices, flex roles, comments -- are always asked):
--   { acknowledgements: [{ id, prompt, agreeLabel, exceptionLabel }],
--     availability:     { prompt, days: ['Monday', ...] } | null,
--     extraQuestions:   [{ id, prompt }] }
create table if not exists season_surveys (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references teams(id) on delete cascade,
  title       text not null,
  intro       text,
  questions   jsonb not null default '{}'::jsonb,
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,
  created_by  uuid references accounts(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists season_surveys_one_open_per_team
  on season_surveys(team_id) where closed_at is null;
create index if not exists season_surveys_team_idx on season_surveys(team_id, opened_at desc);

-- One response per account per survey (editable until the survey closes).
--   status:           returning | unsure | not_returning
--   spec_choices:     [{ class, spec, role }] in preference order, up to 3
--   flex_roles:       any of tank / heal / melee / ranged
--   availability:     day names picked from the survey's availability days
--   acknowledgements: acknowledgement id -> 'agree' | 'exception'
--   answers:          extra question id -> free text
create table if not exists season_survey_responses (
  id               uuid primary key default gen_random_uuid(),
  survey_id        uuid not null references season_surveys(id) on delete cascade,
  team_id          uuid not null references teams(id) on delete cascade,
  account_id       uuid not null references accounts(id) on delete cascade,
  character_id     uuid references characters(id) on delete set null,
  character_name   text not null,
  status           text not null check (status in ('returning', 'unsure', 'not_returning')),
  spec_choices     jsonb not null default '[]'::jsonb,
  flex_roles       text[] not null default '{}',
  availability     text[] not null default '{}',
  acknowledgements jsonb not null default '{}'::jsonb,
  answers          jsonb not null default '{}'::jsonb,
  comments         text,
  submitted_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (survey_id, account_id)
);
create index if not exists season_survey_responses_survey_idx on season_survey_responses(survey_id);
