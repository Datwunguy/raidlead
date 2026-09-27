-- ============================================================
-- Recruit statuses trimmed to: contacted, no_response, not_interested,
-- interested, joined (see RECRUIT_STATUSES in public/app.js and STATUSES in
-- api/recruiting.js). Maps any row still using a removed status onto the
-- closest remaining one. Run once, by hand, in the Supabase SQL editor.
-- Safe to re-run: a no-op once nothing uses the old values.
-- ============================================================

update recruits set status = 'interested'     where status in ('replied', 'applied', 'trial');
update recruits set status = 'not_interested' where status = 'declined';
