-- ============================================================
-- Game versions. A guild now belongs to one World of Warcraft version --
-- retail, progression (Classic MoP/WoD), anniversary (TBC Anniversary),
-- era (Classic Era & Hardcore), or forever (World of Warcraft: Forever) --
-- and its teams follow it. The versions and their rules (classes, specs,
-- raid buffs, sizes, data sources) live in public/games.js.
--
-- Every existing guild becomes Retail, which is what they all are today.
-- A guild's identity is now name + server + game, so a Retail guild and a
-- Classic guild with the same name are separate guilds.
--
-- Run once, by hand, in the Supabase SQL editor. Safe to re-run.
-- ============================================================
alter table guilds add column if not exists game text not null default 'retail';
create index if not exists guilds_name_server_game_idx on guilds (lower(name), server, game);
