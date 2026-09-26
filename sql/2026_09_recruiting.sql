-- ============================================================
-- Team Management -> Recruits: officer-only tracking of prospective raiders
-- (people an officer reached out to, and later, applicants promoted out of
-- the Applicants triage inbox) plus reusable outreach message templates.
-- This project has no migration runner -- run this once, by hand, in the
-- Supabase SQL editor. Safe to re-run: every statement is idempotent.
-- ============================================================

create table if not exists recruits (
  id              uuid primary key default gen_random_uuid(),
  team_id         uuid not null references teams(id) on delete cascade,
  name            text not null,
  realm           text not null,          -- as typed, e.g. "Mal'Ganis"
  realm_slug      text not null,          -- lib/serverSlug.js slugifyServer(realm)
  class           text,                   -- lowercase, matches CLASS_COLORS keys
  spec            text,
  role            text,                   -- tank | heal | melee | ranged
  source          text not null default 'outreach',  -- outreach | application
  application_key text,                   -- links back to a Google Form response (Applicants phase)
  contacted_at    date not null default current_date,
  channel         text,                   -- mail | whisper | discord | form | other
  status          text not null default 'contacted',
  notes           text,
  lookup          jsonb,                  -- Raider.io snapshot: ilvl, M+ score, raid progress, fetchedAt
  wcl_scores      jsonb,                  -- per difficulty: { mythic: { zoneId, bossNames, result, fetchedAt }, ... }
  created_by      uuid references accounts(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- One row per character per team, so two officers can't both mail the same
-- person without noticing (addRecruit turns a violation into a "who already
-- contacted them, and when" message). Deliberately an EXACT match, not
-- accent-stripped: Häzey and Hazey are two different characters, and
-- folding them together is exactly the bug the Discord bot had.
create unique index if not exists recruits_team_char
  on recruits(team_id, lower(name), realm_slug);
create index if not exists recruits_team_id_idx on recruits(team_id);

create table if not exists recruit_templates (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid not null references teams(id) on delete cascade,
  title      text not null,
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recruit_templates_team_id_idx on recruit_templates(team_id);
