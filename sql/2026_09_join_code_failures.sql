-- ============================================================
-- Join-code guess limit. Join codes are 6 characters -- guessable with
-- enough tries -- so api/auth.js's join-guild counts wrong codes per
-- account and refuses more than 5 in an hour. Real joins are a paste or an
-- invite link, so nobody legitimate gets near that.
--
-- Run once, by hand, in the Supabase SQL editor. Safe to re-run. Until it's
-- run, joining still works; the limit just isn't enforced.
-- ============================================================
create table if not exists join_code_failures (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  failed_at  timestamptz not null default now()
);
create index if not exists join_code_failures_account_idx on join_code_failures(account_id, failed_at desc);

-- Server-only, like every other table (see 2026_09_enable_rls.sql).
alter table join_code_failures enable row level security;
