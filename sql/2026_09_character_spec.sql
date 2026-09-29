-- ============================================================
-- A roster character's spec. Add/Edit Character now picks a spec, and the
-- role comes from it (api/roster.js) -- so a Death Knight can't be saved as
-- Ranged. Stored so editing a character later shows their actual spec.
-- Characters added before this (or by the WowAudit import) have no spec
-- yet; their role is kept and the Edit dialog picks a matching spec.
--
-- Run once, by hand, in the Supabase SQL editor. Safe to re-run.
-- ============================================================
alter table characters add column if not exists spec text;
