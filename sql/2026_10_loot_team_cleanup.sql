-- ============================================================
-- Loot uploaded to the wrong team. The addon keeps every raid its player
-- recorded, and Companion uploaded all of it to whichever team it was set
-- to -- so a player on two teams (e.g. The Finer Things Club and Scott's
-- Tots) could hand one team the other team's raids. Uploads now leave those
-- out (lib/lootImport.js); this removes the ones already saved.
--
-- Same rule as uploads: for each team's loot, per addon session (one login,
-- in practice one raid), if more of its loot recipients are on another of the
-- uploader's teams' rosters than on this team's, it's that team's raid --
-- removed here, and remembered as deleted so the addon can't upload it again.
-- Raids no roster recognizes (pugs, alt runs) are left alone.
--
-- To see what it would remove first, run just the SELECT at the bottom
-- (commented out). Run once, by hand, in the Supabase SQL editor. Safe to re-run.
-- ============================================================
with sessions as (
  select d.team_id, coalesce(d.source_session_id, d.session_id) as src, d.reported_by_account_id as acct,
         array_agg(distinct d.recipient_name) as names
  from loot_drops d
  where d.reported_by_account_id is not null
  group by 1, 2, 3
),
scored as (
  select s.team_id, s.src,
    (select count(*) from unnest(s.names) n
       where exists (select 1 from characters c where c.team_id = s.team_id and c.name = n)) as here,
    (select coalesce(max(o.on_roster), 0) from (
       select (select count(*) from unnest(s.names) n
                 where exists (select 1 from characters c where c.team_id = tm.team_id and c.name = n)) as on_roster
       from team_members tm
       where tm.account_id = s.acct and tm.team_id <> s.team_id) o) as elsewhere
  from sessions s
),
misplaced as (
  select d.id, d.team_id, d.addon_record_id
  from loot_drops d
  join scored s on s.team_id = d.team_id and s.src = coalesce(d.source_session_id, d.session_id)
  where s.elsewhere > s.here
),
tombstoned as (
  insert into loot_deleted_records (team_id, addon_record_id)
  select team_id, addon_record_id from misplaced
  on conflict (team_id, addon_record_id) do nothing
)
delete from loot_drops where id in (select id from misplaced);

-- Preview (run on its own, before the delete above): which raids would go.
-- with sessions as (...same as above...), scored as (...same as above...)
-- select t.name as team, s.src as addon_session, s.here as recipients_on_this_team, s.elsewhere as on_other_team
-- from scored s join teams t on t.id = s.team_id where s.elsewhere > s.here;
