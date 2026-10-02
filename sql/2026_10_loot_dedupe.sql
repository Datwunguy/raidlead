-- ============================================================
-- Loot from several raiders' addons, recorded once. Every raider running
-- the RaidLead addon records every drop (loot chat goes to the whole raid),
-- so one drop used to be saved once per uploader, each copy in its own run.
-- Uploads now merge copies of a drop into one record and one run
-- (lib/lootImport.js); this adds what that needs and cleans up the copies
-- already saved.
--
-- Run once, by hand, in the Supabase SQL editor -- BEFORE deploying the code
-- that uses these columns. Safe to re-run.
-- ============================================================

-- When the drop happened (the addon's capture time) -- loot is listed by
-- this now, not by when it was uploaded.
alter table loot_drops add column if not exists captured_at timestamptz;
-- The addon session that recorded the row. session_id is the run it's
-- listed under, which can be another uploader's when they caught the same night.
alter table loot_drops add column if not exists source_session_id text;
update loot_drops set source_session_id = session_id where source_session_id is null;
create index if not exists loot_drops_team_date_idx on loot_drops(team_id, raid_date);

-- Copies already saved: the same raid date, boss, difficulty, recipient and
-- item, from different runs. The earliest run keeps its record; the other
-- runs' copies are removed (and remembered as deleted, so the addon can't
-- upload them again), and the rest of each such run's drops -- the ones only
-- it caught -- join the earlier run. Repeats until nothing's left to merge,
-- so a night three raiders recorded ends up as one run too.
do $$
declare merged int;
begin
  loop
    with runs_started as (
      select team_id, session_id, min(created_at) as first_at
      from loot_drops group by team_id, session_id
    ),
    keyed as (
      select d.id, d.team_id, d.session_id, d.addon_record_id,
        first_value(d.session_id) over (
          partition by d.team_id, d.raid_date, coalesce(d.boss_name, ''), coalesce(d.difficulty, ''),
                       lower(d.recipient_name), d.item_id
          order by s.first_at, d.session_id) as kept_session
      from loot_drops d
      join runs_started s on s.team_id = d.team_id and s.session_id = d.session_id
      where d.captured_at is null
    ),
    copiers as (
      select distinct team_id, session_id, kept_session from keyed where session_id <> kept_session
    ),
    -- A run merges once every run it copied is final (not merging itself):
    -- C copied B while B copied A? B joins A first, C next time round. (The
    -- earliest run with copies always qualifies, so this always finishes.)
    ready as (
      select team_id, session_id from copiers
      except
      select c.team_id, c.session_id from copiers c
      join copiers k on k.team_id = c.team_id and k.session_id = c.kept_session
    ),
    copies as (
      select k.id, k.team_id, k.session_id, k.addon_record_id, k.kept_session
      from keyed k join ready r on r.team_id = k.team_id and r.session_id = k.session_id
      where k.session_id <> k.kept_session
    ),
    -- each run with copies joins the earliest run it copied
    joins as (
      select distinct on (c.team_id, c.session_id) c.team_id, c.session_id, c.kept_session
      from copies c
      join runs_started s on s.team_id = c.team_id and s.session_id = c.kept_session
      order by c.team_id, c.session_id, s.first_at, c.kept_session
    ),
    tombstoned as (
      insert into loot_deleted_records (team_id, addon_record_id)
      select team_id, addon_record_id from copies
      on conflict (team_id, addon_record_id) do nothing
    ),
    moved as (
      update loot_drops d set session_id = j.kept_session
      from joins j
      where d.team_id = j.team_id and d.session_id = j.session_id
        and d.id not in (select id from copies)
    )
    delete from loot_drops where id in (select id from copies);
    get diagnostics merged = row_count;
    exit when merged = 0;
  end loop;
end $$;
