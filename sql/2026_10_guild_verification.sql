-- ============================================================
-- Guilds are checked against Blizzard before RaidLead puts their name on a
-- team (lib/guildVerification.js): the person's highest-ranked character in
-- that guild must be the Guild Master or one of the next two ranks. Creating
-- a guild, starting a team under one, and changing a guild's name, server or
-- region all check it. These columns record how each guild was checked:
--
--   verification        'blizzard'      confirmed against Blizzard's roster
--                       'not_available' a WoW version Blizzard's API doesn't
--                                       cover yet (e.g. Forever) -- allowed,
--                                       shown as not verified
--                       null            created before the check existed
--                                       (left as they are)
--   verified_at         when
--   verified_character  the character that qualified (e.g. 'Datwunguy')
--   verified_rank       its guild rank (0 = Guild Master)
--
-- Run once in the Supabase SQL editor. Safe to re-run.
-- ============================================================

alter table guilds add column if not exists verification text;
alter table guilds add column if not exists verified_at timestamptz;
alter table guilds add column if not exists verified_character text;
alter table guilds add column if not exists verified_rank int;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'guilds_verification_check') then
    alter table guilds add constraint guilds_verification_check
      check (verification is null or verification in ('blizzard', 'not_available'));
  end if;
end $$;
