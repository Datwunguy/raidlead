-- ============================================================
-- Row-level security on every table in the public schema.
--
-- RaidLead's server talks to the database with the service-role key, which
-- bypasses RLS, so nothing on the site changes. What this closes: with RLS
-- off, anyone holding the project's anon (public) key can read and write
-- every table directly through Supabase's REST API. RaidLead never uses that
-- key, so with RLS on and no policies, it can do nothing at all.
--
-- BEFORE RUNNING: make sure SUPABASE_SERVICE_KEY in Vercel really is the
-- service_role key (Supabase: Project Settings > API keys). Signed in as the
-- site owner, https://raidlead.vercel.app/api/members?action=diagKey should
-- show "role": "service_role". If it's the anon key, every API call would
-- start failing after this runs.
--
-- Run once, by hand, in the Supabase SQL editor. Safe to re-run; it also
-- covers tables added later if you run it again.
-- ============================================================
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;
