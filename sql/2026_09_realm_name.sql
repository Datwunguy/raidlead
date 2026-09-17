-- ============================================================
-- Adds characters.realm_name -- already run by hand in Supabase
-- (2026-09-16, in the session working on the WoW addon's cross-realm
-- invite fix); this file just documents it in sql/ for consistency with
-- every other schema change in this project. Safe to re-run.
--
-- characters.server is a lowercase, hyphenated slug (see lib/serverSlug.js)
-- that Raider.io's API needs but that drops apostrophes and other
-- punctuation, so it can't be losslessly reconstructed back into a correct
-- WoW invite string for realms like Kel'Thuzad. realm_name stores the
-- realm exactly as an officer typed it or WowAudit reported it, alongside
-- the slug. Existing rows are left NULL -- api/roster.js's `list` action
-- already falls back to reconstructing a display name from the slug
-- wherever realm_name isn't set.
-- ============================================================

alter table characters add column if not exists realm_name text;
