-- ============================================================
-- Battle.net character connection. Sign-in now asks Battle.net for the
-- wow.profile permission, so RaidLead knows which WoW characters are on each
-- player's own Battle.net account, and connects matching roster characters
-- automatically (see lib/characterClaims.js). No more "claim your
-- character" screen.
--
-- This project has no migration runner -- run this once, by hand, in the
-- Supabase SQL editor, same as every other schema change to date. Safe to
-- re-run: every statement is idempotent.
-- ============================================================

-- The character list from the player's Battle.net account, refreshed each
-- time they sign in: [{ id, name, realmSlug, realmName, region, class, level }].
alter table accounts add column if not exists wow_characters jsonb;
alter table accounts add column if not exists wow_characters_synced_at timestamptz;

-- true when Blizzard confirmed this character is on the claiming account;
-- false for claims made by hand (a fallback, e.g. while Blizzard's data
-- catches up on a new character).
alter table characters add column if not exists claim_verified boolean not null default false;
