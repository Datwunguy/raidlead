-- ============================================================
-- Team Management -> Applicants: triage for a guild's existing Google Form
-- applications. The form's response Sheet stays the source of truth for
-- the answers (RaidLead reads it through a Google service account -- see
-- lib/googleSheets.js); this only stores which sheet to read and each
-- officer decision. No row in application_reviews = still needs a decision.
-- Run once, by hand, in the Supabase SQL editor. Safe to re-run.
-- ============================================================

alter table teams add column if not exists application_sheet_id   text;
alter table teams add column if not exists application_sheet_gid  text;
alter table teams add column if not exists application_column_map jsonb; -- officer overrides of auto-detected columns

create table if not exists application_reviews (
  id           uuid primary key default gen_random_uuid(),
  team_id      uuid not null references teams(id) on delete cascade,
  response_key text not null,                -- stable hash of the response's timestamp + contact + character
  decision     text not null,                -- promoted | rejected | resolved (handled outside RaidLead)
  recruit_id   uuid references recruits(id) on delete set null,
  reject_note  text,
  decided_by   uuid references accounts(id),
  decided_at   timestamptz not null default now()
);

-- One decision per application: two officers clicking at once can't both
-- promote (and create two recruits) -- the second insert just fails.
create unique index if not exists application_reviews_team_key
  on application_reviews(team_id, response_key);
