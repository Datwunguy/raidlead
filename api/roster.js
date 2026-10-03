// ============================================================
//  roster.js — handles roster/character/scores + WCL actions
//  Actions: list, listIlvl, addCharacter, updateCharacter, removeCharacter,
//           getFlex, updateFlex, saveScores, getScores, wclZones, wclQuery
//  (wcl.js is now consolidated here — wcl.js can be deleted)
//
//  The `characters` table is the roster's actual source of truth (populated
//  via api/wowaudit.js's on-demand import, or added to by hand here). `list`
//  is the read side -- a plain DB read, always fast. Item level is
//  deliberately NOT fetched there: it comes from a separate `listIlvl` call
//  (live Raider.io lookups, one per character), so a slow or degraded
//  Raider.io never blocks the roster itself from loading. See listIlvl.
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('../lib/session');
const { assertTeamMembership } = require('../lib/teamAuth');
const { slugifyServer, serverDisplayFromSlug } = require('../lib/serverSlug');
const { resolveCurrentRaidByDate, fetchRaidCalendar, raidLaunchDate } = require('../lib/raiderioRaids');
const { appendToJoinOrder, markLeftJoinOrder } = require('../lib/joinOrder');
const { linkRosterCharacters } = require('../lib/characterClaims');
const { detectCurrentWclZone, lookupWclZoneIdByName } = require('../lib/wclZone');
const { teamWclCredentials, wclRequest } = require('../lib/wclClient');
const { specsFor, canonicalSpec, roleForSpec } = require('../lib/wowSpecs');
const { teamGame, gameFor } = require('../lib/games');

// A roster character's role comes from its spec -- a Death Knight is never
// Ranged. With no spec (an older page), the role must still be one the class
// can fill. Specs and classes are the team's WoW version's (a Death Knight
// isn't a class in Classic Era). Returns { spec, role } or { error }.
function specAndRole(cls, spec, role, game) {
  const c = String(cls || '').toLowerCase().trim();
  const specs = specsFor(c, game);
  if (!specs.length) return { error: c ? `There are no ${c}s in ${gameFor(game?.id).label}` : 'Pick a class' };
  if (spec) {
    const name = canonicalSpec(c, spec, game);
    if (!name) return { error: `${spec} isn't a ${c} spec` };
    return { spec: name, role: roleForSpec(c, name, game) };
  }
  const r = String(role || '').toLowerCase().trim();
  if (!specs.some(([, specRole]) => specRole === r)) return { error: `A ${c} can't be ${r || 'that role'}` };
  return { spec: null, role: r };
}
const { fetchGuildRoster, fetchCharacterSpec, fetchCharacterProfile } = require('../lib/battleNet');

// Cache listIlvl's live Raider.io results per team briefly, so several
// people opening the Roster tab around the same time don't each trigger a
// fresh batch of per-character lookups. A character's gear doesn't change
// fast enough to justify hitting Raider.io on every page load either way.
// Only lookups that worked are cached -- a failed one (Raider.io busy or
// rate-limiting) is tried again on the next load instead of showing "—".
const ilvlCache = new Map(); // teamId -> Map("name|server" -> { ilvl, at })
const ILVL_CACHE_MS = 10 * 60 * 1000;
const ILVL_LOOKUPS_AT_ONCE = 5;
// If Raider.io rate limits ever become a real problem (roster ilvl stuck on
// "—", with "[listIlvl] ... status 429" in the Vercel logs): a free Raider.io
// API key raises the limit and ties it to us rather than Vercel's shared IPs.
// It's an `access_key=` query param on every raider.io call (here,
// api/raiderio.js, lib/raiderioCharacter.js, lib/raiderioRaids.js).

// Cache guildRoster's live Blizzard results per team briefly -- it's fetched
// once when the "Add From Guild" panel opens, not per keystroke, but two
// officers opening it around the same time shouldn't double the API calls.
const guildRosterCache = new Map(); // teamId -> { data: [...members], fetchedAt }
const GUILD_ROSTER_CACHE_MS = 10 * 60 * 1000;

// Thrown when a request needs WCL access but the caller's guild hasn't connected its
// own Warcraft Logs API client yet -- callers check err.wclNotConfigured to show a
// distinct "connect your credentials" state instead of a generic error.
class WclNotConfiguredError extends Error {
  constructor() {
    super("Your guild hasn't connected Warcraft Logs API credentials yet. Add them in Guild Settings.");
    this.wclNotConfigured = true;
  }
}

// Survival/Mitigation cache rows are per difficulty -- and per raid size for
// Classic ("5" for Retail Mythic, "4_25" for Classic 25-player Heroic).
const diffCacheSuffix = (diffId, size) => `${diffId || 5}${size ? '_' + size : ''}`;

// "Oceanic" is a RaidLead-only region choice (it only changes which Raider.io
// rankings pool the Progress tab compares against) -- Oceanic realms are
// still part of Blizzard's/WCL's "us" game region, so every WCL query needs
// the real Blizzard region code, never "oceanic" itself.
function toWclRegion(region) {
  return region === 'oceanic' ? 'us' : region;
}

// WCL's whole response for one query, via the shared client in lib/wclClient.js
// (tokens cached per team's own API client). Missing credentials and a
// refused token get errors the UI can explain.
async function wclQuery(query, creds) {
  if (!creds?.clientId || !creds?.clientSecret) throw new WclNotConfiguredError();
  try {
    return await wclRequest(creds, query);
  } catch (e) {
    if (e.tokenFailed) throw new Error("Failed to get a WCL token -- check that your guild's WCL Client ID/Secret in Guild Settings are correct");
    throw e;
  }
}

// Fetches ALL reports for a guild+zone by paginating through WCL's reports connection.
// A single page is capped at 50 by WCL, and a guild can easily have logged more than
// that for one zone/tier -- callers that need the true earliest report (to compute
// accurate first-kill boundaries for survival/mitigation) must page through the full
// list rather than only ever seeing the most recent 50.
async function fetchAllZoneReports({ guildName, serverSlug, region, zoneId, tagParam, maxPages = 40, creds }) {
  let allReports  = [];
  let page        = 1;
  let hitMaxPages = false;
  while (page <= maxPages) {
    const resp = await wclQuery(`query {
      reportData { reports(
        guildName: ${JSON.stringify(String(guildName))} guildServerSlug: ${JSON.stringify(String(serverSlug))}
        guildServerRegion: ${JSON.stringify(String(region))} zoneID: ${Number(zoneId) || 0} limit: 50 page: ${page} ${tagParam}
      ) { data { code startTime fights(killType: All) { id encounterID name difficulty size startTime endTime kill } } has_more_pages } }
    }`, creds);
    if (resp?.errors) { console.error('[fetchAllZoneReports] page', page, 'error:', resp.errors[0]?.message); break; }
    const pageInfo    = resp?.data?.reportData?.reports;
    const pageReports = pageInfo?.data || [];
    if (page === 1) {
      console.log('[fetchAllZoneReports] page1 keys:', pageInfo ? Object.keys(pageInfo).join(',') : 'null', '| has_more_pages:', pageInfo?.has_more_pages);
    }
    if (pageReports.length === 0) break;
    allReports = allReports.concat(pageReports);
    if (!pageInfo?.has_more_pages) break;
    if (page === maxPages) hitMaxPages = true;
    page++;
  }
  console.log('[fetchAllZoneReports]', guildName, 'zone', zoneId, '-- total reports:', allReports.length, 'across', page, 'page(s)', hitMaxPages ? '(hit max page cap)' : '');
  return { reports: allReports, hitMaxPages };
}

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Helper: verify the caller belongs to teamId (optionally requiring officer/owner).
  // Thin wrapper so the many call sites below didn't all need to change shape.
  async function assertTeamOwnership(teamId, opts) {
    return assertTeamMembership(supabase, session.id, teamId, opts);
  }

  // This team's own WCL API credentials -- no shared/app-wide fallback, so one
  // team's usage can never draw on or be capped by another's WCL rate limit.
  const resolveWclCredentials = teamId => teamWclCredentials(supabase, teamId);

  // ── WCL ZONES (accessible to all members of the team) ──
  if (action === 'wclZones') {
    const teamId = req.query.teamId || req.body?.teamId;
    try {
      await assertTeamOwnership(teamId);
      const creds = await resolveWclCredentials(teamId);
      if (!creds) return res.status(200).json({ data: { worldData: { zones: [] } }, wclNotConfigured: true });
      const data = await wclQuery(`query { worldData { zones { id name frozen } } }`, creds);
      return res.status(200).json(data);
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── ADVANCE SEASON (officer only): fully self-contained -- called
  // silently on every officer page load with nothing but a teamId, and
  // decides everything itself:
  //   1. Raider.io's static-data (primary) -- no WCL credentials needed,
  //      and its per-region start/end dates are real Blizzard-confirmed
  //      dates, not a guess based on who happened to notice first.
  //   2. Fill in that raid's WCL zone_id (needed for Scores/Mitigation) --
  //      see resolveZoneId. A team that's on the right raid but has no
  //      zone_id yet gets one as soon as one's available, not only when
  //      the next raid launches.
  //   3. If Raider.io itself can't resolve anything (network hiccup, or a
  //      brand-new expansion not in its static data yet) and the team has
  //      WCL credentials, fall back to the WCL-only PTR/season-filtered
  //      detection as a last resort.
  // zone_name is the identity key throughout (see sql/2026_09_seasons.sql
  // for why) -- zone_id is populated opportunistically, never required.
  // Seasons recorded before advanceSeason used Raider.io's launch dates were
  // stamped with the day someone first noticed the new zone (and shared
  // across regions). Re-dates each of this team's seasons to its raid's real
  // launch in the team's region, and ends each closed season the day the
  // next one started. Only writes rows that are actually off, so it's cheap
  // to run on every advanceSeason call; seasons whose zone Raider.io doesn't
  // list keep their dates. Best-effort -- never fails the caller.
  // WCL's zone IDs are the same for every guild, so a raid's ID comes from
  // this team's own WCL zone list (by name) or, without WCL credentials,
  // from any other team already on that raid. null if nobody knows it yet.
  async function resolveZoneId(teamId, zoneName, detectedId) {
    if (detectedId) return detectedId;
    try {
      const own = await lookupWclZoneIdByName(supabase, teamId, zoneName);
      if (own) return own;
    } catch (e) { /* no credentials or WCL unavailable: try the others */ }
    try {
      const { data: others } = await supabase
        .from('teams').select('zone_id').eq('zone_name', zoneName).not('zone_id', 'is', null).limit(1);
      if (others?.[0]?.zone_id) return others[0].zone_id;
      const { data: known } = await supabase
        .from('global_zone_transitions').select('zone_id').eq('zone_name', zoneName).not('zone_id', 'is', null).limit(1);
      return known?.[0]?.zone_id ?? null;
    } catch (e) { return null; } // never blocks a season change
  }

  async function repairSeasonDates(teamId, region) {
    try {
      const raids = await fetchRaidCalendar(region);
      if (!raids.length) return;
      const { data: seasons, error } = await supabase
        .from('seasons').select('id, zone_name, started_at, ended_at')
        .eq('team_id', teamId).order('started_at', { ascending: true });
      if (error || !seasons?.length) return;

      const fixed = seasons
        .map(s => ({ ...s, started_at: raidLaunchDate(raids, s.zone_name) || s.started_at }))
        .sort((a, b) => a.started_at.localeCompare(b.started_at));
      fixed.forEach((s, i) => {
        if (s.ended_at && fixed[i + 1]) s.ended_at = fixed[i + 1].started_at;
      });
      for (const s of fixed) {
        const before = seasons.find(o => o.id === s.id);
        if (before.started_at === s.started_at && before.ended_at === s.ended_at) continue;
        await supabase.from('seasons').update({ started_at: s.started_at, ended_at: s.ended_at })
          .eq('id', s.id).eq('team_id', teamId);
      }
    } catch (e) { /* dates stay as they were */ }
  }

  if (action === 'advanceSeason') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { teamId } = req.body || {};
    if (!teamId) return res.status(400).json({ error: 'teamId required' });

    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

      const { data: team } = await supabase
        .from('teams').select('zone_name, zone_id, guilds ( region, game )').eq('id', teamId).single();
      if (!team) return res.status(404).json({ error: 'Team not found' });

      const region = team.guilds?.region || 'us';
      // Raider.io's raid calendar covers Retail only; other versions go by the
      // newest raid on their own Warcraft Logs site (needs WCL credentials).
      const hasCalendar = !!gameFor(team.guilds?.game).sources.raiderio?.calendar;
      const repairDates = () => (hasCalendar ? repairSeasonDates(teamId, region) : null);
      let detected = hasCalendar ? await resolveCurrentRaidByDate(region) : null;
      if (!detected) detected = await detectCurrentWclZone(supabase, teamId);
      if (!detected) return res.status(200).json({ success: true, changed: false, reason: 'no_source_available' });

      const zoneName = detected.zoneName;
      if (zoneName === team.zone_name) {
        await repairDates();
        // Same raid, but no WCL zone ID on file yet (e.g. no WCL credentials
        // when it started): fill it in now -- no new season.
        if (!team.zone_id) {
          const zoneId = await resolveZoneId(teamId, zoneName, detected.zoneId);
          if (zoneId) {
            await supabase.from('teams').update({ zone_id: zoneId }).eq('id', teamId);
            await supabase.from('seasons').update({ zone_id: zoneId })
              .eq('team_id', teamId).eq('zone_name', zoneName).is('zone_id', null);
            return res.status(200).json({ success: true, changed: false, zoneIdFilled: true, zoneId, zoneName });
          }
        }
        return res.status(200).json({ success: true, changed: false });
      }

      const zoneId = await resolveZoneId(teamId, zoneName, detected.zoneId);

      // A raid tier launches on one real date per region -- the season
      // boundary is that date, not whichever day an officer next happened
      // to load the page. Raider.io's per-region launch time is the source
      // ("2026-08-18" in the US, "2026-08-19" in the EU).
      //
      // global_zone_transitions is only the fallback now, for a zone found
      // through WCL when Raider.io couldn't answer: the first team anywhere
      // to notice a zone sets that date once (upsert with ignoreDuplicates
      // so a later team's advance doesn't overwrite it).
      const today = new Date().toISOString().slice(0, 10);
      const launchDate = detected.startsAt ? new Date(detected.startsAt).toISOString().slice(0, 10) : null;
      await supabase
        .from('global_zone_transitions')
        .upsert({ zone_id: zoneId, zone_name: zoneName, first_detected_at: today }, { onConflict: 'zone_name', ignoreDuplicates: true });
      const { data: transition } = await supabase
        .from('global_zone_transitions').select('first_detected_at').eq('zone_name', zoneName).single();
      const transitionDate = launchDate || transition?.first_detected_at || today;

      // Close the current season (if one exists yet -- a brand-new team may
      // not have one at all, in which case there's nothing to close). The
      // `neq('zone_name', zoneName)` guard matters for the race case below:
      // if a second officer session's request lands after the first one
      // already advanced, "the open season" is now the brand-new one for
      // this same zone -- without this guard, a blind `ended_at IS NULL`
      // match would immediately re-close the season the first request just
      // opened.
      await supabase
        .from('seasons').update({ ended_at: transitionDate })
        .eq('team_id', teamId).is('ended_at', null).neq('zone_name', zoneName);

      // Open the new one. The partial unique index (one open season per
      // team) makes this safe if two officer sessions race -- the loser's
      // insert just fails harmlessly since the winner already holds the slot.
      const { error: insertErr } = await supabase
        .from('seasons')
        .insert({ team_id: teamId, zone_id: zoneId, zone_name: zoneName, started_at: transitionDate });
      if (insertErr && insertErr.code !== '23505') throw insertErr; // 23505 = unique_violation (lost the race, fine)

      await supabase.from('teams').update({ zone_id: zoneId, zone_name: zoneName }).eq('id', teamId);
      await repairDates();

      return res.status(200).json({ success: true, changed: true, zoneId, zoneName, startedAt: transitionDate });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── GET SEASONS (any team member): this team's season history, newest
  // first, for the read-only history dropdown. ──
  if (action === 'getSeasons') {
    const teamId = req.query.teamId || req.body?.teamId;
    try {
      await assertTeamOwnership(teamId);
      const { data, error } = await supabase
        .from('seasons').select('id, zone_id, zone_name, started_at, ended_at')
        .eq('team_id', teamId).order('started_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ seasons: data || [] });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── GET SEASON ROSTER (any team member): every character with a
  // membership period overlapping the given season's date range --
  // read-only, no editing surfaced through this action. ──
  if (action === 'getSeasonRoster') {
    const teamId   = req.query.teamId   || req.body?.teamId;
    const seasonId = req.query.seasonId || req.body?.seasonId;
    if (!seasonId) return res.status(400).json({ error: 'seasonId required' });
    try {
      await assertTeamOwnership(teamId);

      const { data: season, error: seasonErr } = await supabase
        .from('seasons').select('id, zone_id, zone_name, started_at, ended_at')
        .eq('id', seasonId).eq('team_id', teamId).single();
      if (seasonErr || !season) return res.status(404).json({ error: 'Season not found' });

      const rangeEnd = season.ended_at || new Date().toISOString().slice(0, 10);
      const { data: periods, error: periodsErr } = await supabase
        .from('character_membership_periods')
        .select('joined_at, left_at, characters ( id, name, class, primary_role, server, realm_name, rank )')
        .eq('team_id', teamId)
        .lte('joined_at', rangeEnd)
        .or(`left_at.is.null,left_at.gte.${season.started_at}`);
      if (periodsErr) throw periodsErr;

      const roster = (periods || [])
        .filter(p => p.characters)
        .map(p => p.characters);

      return res.status(200).json({ season, roster });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── GET MITIGATION CACHE ──
  if (action === 'getMitigationCache') {
    const teamId = req.query.teamId || req.body?.teamId;
    const zoneId = req.query.zoneId || req.body?.zoneId;
    const diffId = req.query.diffId || req.body?.diffId || 5;
    const size   = parseInt(req.query.size || req.body?.size) || null;
    if (!teamId) return res.status(200).json({ mitigationMap: {}, bossNames: [] });
    try {
      await assertTeamOwnership(teamId);
      const { data } = await supabase
        .from('wcl_scores').select('boss_scores, fetched_at')
        .eq('team_id', teamId).eq('zone_id', zoneId)
        .eq('character_name', '_mitig_cache_').eq('server', `mitig_${diffCacheSuffix(diffId, size)}`)
        .single();
      if (!data?.boss_scores) return res.status(200).json({ mitigationMap: {}, bossNames: [] });
      const parsed = JSON.parse(data.boss_scores);
      return res.status(200).json({ mitigationMap: parsed.mitigationMap || {}, bossNames: parsed.bossNames || [], savedAt: parsed.savedAt || 0 });
    } catch(e) { return res.status(200).json({ mitigationMap: {}, bossNames: [] }); }
  }

  // ── GET MITIGATION DATA ──
  if (action === 'getMitigation') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { guildName, serverSlug, region: rawRegion, zoneId, diffId, guildTagID, memberNames, validBossIds, teamId } = req.body || {};
    const size = parseInt(req.body?.size) || null; // Classic raid size (10/25, 20/40); Retail sends none
    if (!guildName || !serverSlug || !rawRegion || !zoneId) return res.status(400).json({ error: 'missing params' });
    const region = toWclRegion(rawRegion);

    const memberSet    = new Set((memberNames || []).map(n => n.toLowerCase()));
    const validBossSet = new Set((validBossIds || []).map(id => parseInt(id)));
    const tagId        = guildTagID ? parseInt(guildTagID) : null;
    const tagParam     = tagId ? `guildTagID: ${tagId}` : '';
    console.log('[mitigation] guildTagID:', tagId, '| diffId:', diffId);

    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });
      const creds = await resolveWclCredentials(teamId);
      if (!creds) return res.status(200).json({ mitigationMap: {}, bossNames: [], wclNotConfigured: true, error: "Your guild hasn't connected Warcraft Logs API credentials yet. Add them in Guild Settings." });
      let allReports, mitigHitMaxPages;
      try {
        const result = await fetchAllZoneReports({ guildName, serverSlug, region, zoneId, tagParam, creds });
        allReports = result.reports;
        mitigHitMaxPages = result.hitMaxPages;
      } catch(e) {
        console.error('[mitigation] fetchAllZoneReports threw:', e.message);
        return res.status(200).json({ mitigationMap: {}, bossNames: [], error: e.message });
      }
      allReports.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
      console.log('[mitigation] reports:', allReports.length, mitigHitMaxPages ? '(hit max page cap)' : '');
      console.log('[mitigation] first 3 startTimes:', allReports.slice(0,3).map(r => r.code + ':' + r.startTime).join(', '));
      console.log('[mitigation] last 3 startTimes:', allReports.slice(-3).map(r => r.code + ':' + r.startTime).join(', '));

      // Load existing incremental cache. A `reset` request discards it and reprocesses
      // every report from scratch -- used to recover from a stale/corrupted cache
      // (e.g. a boss that got marked "killed" before a fix without any data recorded).
      let existingCache = null, lastReportTime = 0;
      if (teamId && req.body?.reset) {
        try {
          await supabase.from('wcl_scores').delete()
            .eq('team_id', teamId).eq('zone_id', zoneId)
            .eq('character_name', '_mitig_cache_').eq('server', `mitig_${diffCacheSuffix(diffId, size)}`);
        } catch(e) {}
      } else if (teamId) {
        try {
          const { data: cr } = await supabase.from('wcl_scores').select('boss_scores')
            .eq('team_id', teamId).eq('zone_id', zoneId)
            .eq('character_name', '_mitig_cache_').eq('server', `mitig_${diffCacheSuffix(diffId, size)}`).single();
          if (cr?.boss_scores) { existingCache = JSON.parse(cr.boss_scores); lastReportTime = existingCache.lastReportTime || 0; }
        } catch(e) {}
      }

      const reportsToProcess = lastReportTime > 0 ? allReports.filter(r => (r.startTime||0) > lastReportTime) : allReports;
      console.log('[mitigation] to process:', reportsToProcess.length, '| skip:', allReports.length - reportsToProcess.length);

      // mitigData[player][boss] = { mitigated: total, unmitigated: total }
      const mitigData  = {};
      const bossSet    = new Set(existingCache?.bossNames || []);
      if (existingCache?.mitigRaw) {
        for (const [p, bosses] of Object.entries(existingCache.mitigRaw)) {
          mitigData[p] = {};
          for (const [b, v] of Object.entries(bosses)) { mitigData[p][b] = v; bossSet.add(b); }
        }
      }

      const killedBosses = new Set(existingCache?.killedBossIds || []);
      const startedAt = Date.now();
      const MAX_MS = 50000;
      let newestReportTime = lastReportTime;

      for (const report of reportsToProcess) {
        if (!report.fights?.length) continue;
        if (Date.now() - startedAt > MAX_MS) { console.log('[mitigation] timeout guard hit'); break; }
        if ((report.startTime||0) > newestReportTime) newestReportTime = report.startTime;

        // Get actor id -> name map for this report
        const masterResp = await wclQuery(`query { reportData { report(code: "${report.code}") { masterData { actors(type: "Player") { id name } } } } }`, creds);
        const actors = masterResp?.data?.reportData?.report?.masterData?.actors || [];
        const actorMap = {};
        actors.forEach(a => { actorMap[a.id] = a.name; });

        const fightsByEncounter = {};
        for (const fight of report.fights) {
          if (validBossSet.size > 0 && !validBossSet.has(fight.encounterID)) continue;
          if (killedBosses.has(fight.encounterID)) continue;
          const fightDiff = fight.difficulty ? parseInt(fight.difficulty) : null;
          const reqDiff   = diffId ? parseInt(diffId) : null;
          if (fightDiff && reqDiff && fightDiff !== reqDiff) continue;
          if (size && fight.size && parseInt(fight.size) !== size) continue; // Classic: 10 vs 25, 20 vs 40
          if (!fight.encounterID || fight.encounterID === 0) continue;
          if (!fightsByEncounter[fight.encounterID]) fightsByEncounter[fight.encounterID] = { name: fight.name, fights: [], firstKillTime: null };
          const enc = fightsByEncounter[fight.encounterID];
          enc.fights.push(fight);
          bossSet.add(fight.name);
          if (fight.kill && (!enc.firstKillTime || fight.startTime < enc.firstKillTime)) enc.firstKillTime = fight.startTime;
        }

        for (const [encId, encData] of Object.entries(fightsByEncounter)) {
          // Wipes and the first kill are meaningful (that's the progression effort);
          // reclears -- any kill after the first -- are not, so they're excluded.
          const fightsToUse = encData.firstKillTime
            ? encData.fights.filter(f => f.startTime <= encData.firstKillTime)
            : encData.fights.filter(f => !f.kill);

          for (const fight of fightsToUse) {
            try {
              // Fetch raw damage-taken events for this fight (has mitigated + unmitigatedAmount per hit)
              const resp = await wclQuery(`query { reportData { report(code: "${report.code}") {
                events(startTime: ${fight.startTime} endTime: ${fight.endTime} fightIDs: [${fight.id}] dataType: DamageTaken, limit: 10000) { data, nextPageTimestamp }
              } } }`, creds);
              let events = resp?.data?.reportData?.report?.events?.data || [];
              let nextTs = resp?.data?.reportData?.report?.events?.nextPageTimestamp;

              // Paginate within the fight if there are more events than the page limit
              let guard = 0;
              while (nextTs && guard < 10) {
                const pageResp = await wclQuery(`query { reportData { report(code: "${report.code}") {
                  events(startTime: ${nextTs} endTime: ${fight.endTime} fightIDs: [${fight.id}] dataType: DamageTaken, limit: 10000) { data, nextPageTimestamp }
                } } }`, creds);
                const pageEvents = pageResp?.data?.reportData?.report?.events?.data || [];
                events = events.concat(pageEvents);
                nextTs = pageResp?.data?.reportData?.report?.events?.nextPageTimestamp;
                guard++;
              }

              // Aggregate mitigated/unmitigated per target (player) for this pull
              const perTarget = {};
              for (const ev of events) {
                if (ev.type !== 'damage') continue;
                const tId = ev.targetID;
                const name = actorMap[tId];
                if (!name) continue; // not a tracked player (could be a pet/NPC)
                if (memberSet.size > 0 && !memberSet.has(name.toLowerCase())) continue;
                const mitigated   = ev.mitigated || 0;
                const unmitigated = ev.unmitigatedAmount != null ? ev.unmitigatedAmount : (ev.amount || 0) + mitigated;
                if (!perTarget[name]) perTarget[name] = { mitigated: 0, unmitigated: 0 };
                perTarget[name].mitigated   += mitigated;
                perTarget[name].unmitigated += unmitigated;
              }

              // Roll this pull's totals into the player's boss aggregate
              for (const [name, vals] of Object.entries(perTarget)) {
                if (vals.unmitigated <= 0) continue;
                if (!mitigData[name]) mitigData[name] = {};
                if (!mitigData[name][encData.name]) mitigData[name][encData.name] = { mitigated: 0, unmitigated: 0 };
                mitigData[name][encData.name].mitigated   += vals.mitigated;
                mitigData[name][encData.name].unmitigated += vals.unmitigated;
              }
            } catch(e) { console.error('[mitigation] error', report.code, fight.id, e.message); }
          }

          if (encData.firstKillTime !== null) killedBosses.add(parseInt(encId));
          if (fightsToUse.length > 0) console.log('[mitigation] report', report.code, 'boss', encData.name, '| fights:', fightsToUse.length);
        }
      }

      // Compute final mitigated % per player per boss = total mitigated / total unmitigated
      const mitigationMap = {};
      for (const [player, bosses] of Object.entries(mitigData)) {
        mitigationMap[player] = {};
        for (const [boss, { mitigated, unmitigated }] of Object.entries(bosses)) {
          if (unmitigated > 0) mitigationMap[player][boss] = parseFloat(((mitigated / unmitigated) * 100).toFixed(1));
        }
      }
      const bossNames = [...bossSet];
      console.log('[mitigation] complete | players:', Object.keys(mitigationMap).length, '| bosses:', bossNames.length);

      // Re-read the cache fresh right before writing and merge into that (rather than
      // the possibly-stale snapshot read at the start of this request) so a slower/
      // rate-limited overlapping request can only ever add to what's persisted, never
      // regress it -- see the identical comment in getSurvival for the full rationale.
      let finalMitigationMap = mitigationMap;
      let finalBossNames     = bossNames;
      const mitigCacheKey = `mitig_${diffCacheSuffix(diffId, size)}`;
      if (teamId && Object.keys(mitigData).length > 0) {
        try {
          const finalMitigData    = { ...mitigData };
          const finalBossSet      = new Set(bossSet);
          const finalKilledBosses = new Set(killedBosses);
          let   finalNewestTime   = newestReportTime;

          const { data: freshRow } = await supabase.from('wcl_scores').select('boss_scores')
            .eq('team_id', teamId).eq('zone_id', zoneId)
            .eq('character_name', '_mitig_cache_').eq('server', mitigCacheKey).single();
          if (freshRow?.boss_scores) {
            const fresh = JSON.parse(freshRow.boss_scores);
            if ((fresh.lastReportTime || 0) > lastReportTime) {
              console.log('[mitigation] fresher cache found at save time (lastReportTime', fresh.lastReportTime, '> our', lastReportTime, ') -- merging instead of overwriting');
              for (const [player, playerBosses] of Object.entries(fresh.mitigRaw || {})) {
                if (!finalMitigData[player]) finalMitigData[player] = {};
                for (const [boss, val] of Object.entries(playerBosses)) {
                  const existing = finalMitigData[player][boss];
                  if (!existing || (val.unmitigated || 0) > (existing.unmitigated || 0)) finalMitigData[player][boss] = val;
                }
              }
              (fresh.bossNames || []).forEach(b => finalBossSet.add(b));
              (fresh.killedBossIds || []).forEach(id => finalKilledBosses.add(id));
              finalNewestTime = Math.max(finalNewestTime, fresh.lastReportTime || 0);
            }
          }

          finalMitigationMap = {};
          for (const [player, playerBosses] of Object.entries(finalMitigData)) {
            finalMitigationMap[player] = {};
            for (const [boss, { mitigated, unmitigated }] of Object.entries(playerBosses)) {
              if (unmitigated > 0) finalMitigationMap[player][boss] = parseFloat(((mitigated / unmitigated) * 100).toFixed(1));
            }
          }
          finalBossNames = [...finalBossSet];

          await supabase.from('wcl_scores').upsert({
            team_id: teamId, zone_id: zoneId, character_name: '_mitig_cache_', server: mitigCacheKey,
            boss_scores: JSON.stringify({ mitigationMap: finalMitigationMap, mitigRaw: finalMitigData, bossNames: finalBossNames, killedBossIds: [...finalKilledBosses], lastReportTime: finalNewestTime, savedAt: Date.now() }),
            fetched_at: new Date().toISOString(),
          }, { onConflict: 'team_id,zone_id,character_name,server', ignoreDuplicates: false });
          console.log('[mitigation] cache saved | lastReportTime:', finalNewestTime, '| bosses:', finalBossNames.length);
        } catch(e) { console.error('[mitigation] cache save error:', e.message); }
      }

      return res.status(200).json({ mitigationMap: finalMitigationMap, bossNames: finalBossNames });
    } catch(err) { console.error('[mitigation] error:', err.message); return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── GET SURVIVAL CACHE: read incremental survival cache from Supabase ──
  if (action === 'getSurvivalCache') {
    const teamId = req.query.teamId || req.body?.teamId;
    const zoneId = req.query.zoneId || req.body?.zoneId;
    const diffId = req.query.diffId || req.body?.diffId || 5;
    const size   = parseInt(req.query.size || req.body?.size) || null;
    if (!teamId) return res.status(200).json({ survivorMap: {}, bossNames: [] });
    try {
      await assertTeamOwnership(teamId);
      const survCacheKey = `surv_${diffCacheSuffix(diffId, size)}`;
      const { data } = await supabase
        .from('wcl_scores')
        .select('boss_scores, fetched_at')
        .eq('team_id', teamId)
        .eq('zone_id', zoneId)
        .eq('character_name', '_surv_cache_')
        .eq('server', survCacheKey)
        .single();
      if (!data?.boss_scores) return res.status(200).json({ survivorMap: {}, bossNames: [] });
      const parsed = JSON.parse(data.boss_scores);
      return res.status(200).json({
        survivorMap: parsed.survivorMap || {},
        bossNames:   parsed.bossNames   || [],
        savedAt:     parsed.savedAt     || 0,
      });
    } catch(e) {
      return res.status(200).json({ survivorMap: {}, bossNames: [] });
    }
  }

  // ── GET SURVIVAL DATA: per-player survival % per boss using Summary table deathEvents ──
  if (action === 'getSurvival') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { guildName, serverSlug, region: rawRegion, zoneId, diffId, guildTagID, memberNames, validBossIds } = req.body || {};
    const size = parseInt(req.body?.size) || null;
    const region = toWclRegion(rawRegion);
    const validBossSet = new Set((validBossIds || []).map(id => parseInt(id)));
    if (!guildName || !serverSlug || !rawRegion || !zoneId) {
      return res.status(400).json({ error: 'guildName, serverSlug, region, zoneId required' });
    }

    const memberSet = new Set((memberNames || []).map(n => n.toLowerCase()));
    const tagId     = guildTagID ? parseInt(guildTagID) : null;
    const tagParam  = tagId ? `guildTagID: ${tagId}` : '';
    console.log('[survival] guildTagID:', tagId, '| diffId:', diffId);

    try {
      await assertTeamOwnership(req.body?.teamId, { requireOfficer: true });
      const creds = await resolveWclCredentials(req.body?.teamId);
      if (!creds) return res.status(200).json({ survivorMap: {}, bossNames: [], wclNotConfigured: true, error: "Your guild hasn't connected Warcraft Logs API credentials yet. Add them in Guild Settings." });
      // Step 1: Get ALL reports for this zone + team tag (paginated -- see fetchAllZoneReports)
      // The difficulty filter on fights is done below; reports API doesn't filter by difficulty
      let allReports, survHitMaxPages;
      try {
        const result = await fetchAllZoneReports({ guildName, serverSlug, region, zoneId, tagParam, creds });
        allReports = result.reports;
        survHitMaxPages = result.hitMaxPages;
      } catch(e) {
        console.error('[survival] fetchAllZoneReports threw:', e.message);
        return res.status(200).json({ survivorMap: {}, bossNames: [], error: e.message });
      }
      console.log('[survival] reports found:', allReports.length, survHitMaxPages ? '(hit max page cap)' : '');
      if (allReports.length === 0) return res.status(200).json({ survivorMap: {}, bossNames: [] });

      // Sort oldest first
      allReports.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

      // Load existing survival cache from Supabase — merge incrementally. A `reset`
      // request discards it and reprocesses every report from scratch -- used to
      // recover from a stale/corrupted cache (e.g. a boss that got marked "killed"
      // before a fix without any data recorded).
      const survCacheKey = `surv_${diffCacheSuffix(diffId, size)}`;
      let existingCache  = null;
      let lastReportTime = 0;
      if (req.body?.teamId && req.body?.reset) {
        try {
          await supabase.from('wcl_scores').delete()
            .eq('team_id', req.body.teamId).eq('zone_id', zoneId)
            .eq('character_name', '_surv_cache_').eq('server', survCacheKey);
        } catch(e) {}
      } else if (req.body?.teamId) {
        try {
          const { data: cacheRow } = await supabase
            .from('wcl_scores')
            .select('boss_scores, fetched_at')
            .eq('team_id', req.body.teamId)
            .eq('zone_id', zoneId)
            .eq('character_name', '_surv_cache_')
            .eq('server', survCacheKey)
            .single();
          if (cacheRow?.boss_scores) {
            existingCache  = JSON.parse(cacheRow.boss_scores);
            lastReportTime = existingCache.lastReportTime || 0;
            console.log('[survival] existing cache: players:', Object.keys(existingCache.survivorMap || {}).length, '| lastReportTime:', lastReportTime);
          }
        } catch(e) { /* no cache yet */ }
      }

      // Only process reports newer than what we've already cached
      const reportsToProcess = lastReportTime > 0
        ? allReports.filter(r => (r.startTime || 0) > lastReportTime)
        : allReports;
      console.log('[survival] reports to process:', reportsToProcess.length, '(skipping', allReports.length - reportsToProcess.length, 'already cached)');

      // Start with existing cached data
      const survivorData = {};
      const bossSet      = new Set(existingCache?.bossNames || []);

      // Merge existing cached survivorMap into survivorData as weighted totals
      // We store {total, count} in cache so we can merge properly
      if (existingCache?.survivorRaw) {
        for (const [player, bosses] of Object.entries(existingCache.survivorRaw)) {
          survivorData[player] = {};
          for (const [boss, { total, count }] of Object.entries(bosses)) {
            survivorData[player][boss] = { total, count };
            bossSet.add(boss);
          }
        }
      }

      // Track which bosses have been killed
      const killedBosses = new Set(existingCache?.killedBossIds || []);
      const startedAt    = Date.now();
      const MAX_MS       = 50000;
      let   newestReportTime = lastReportTime;

      for (const report of reportsToProcess) {
        if (!report.fights?.length) continue;
        if (Date.now() - startedAt > MAX_MS) {
          console.log('[survival] timeout guard hit');
          break;
        }
        // Track newest report processed
        if ((report.startTime || 0) > newestReportTime) newestReportTime = report.startTime;

        // Group fights by encounter, filter by difficulty, stop at first kill
        const fightsByEncounter = {};
        for (const fight of report.fights) {
          const fightDiff = fight.difficulty ? parseInt(fight.difficulty) : null;
          const reqDiff   = diffId ? parseInt(diffId) : null;
          if (fightDiff && reqDiff && fightDiff !== reqDiff) continue;
          if (size && fight.size && parseInt(fight.size) !== size) continue; // Classic: 10 vs 25, 20 vs 40
          if (!fight.encounterID || fight.encounterID === 0) continue;
          // Skip non-zone bosses (M+ dungeons etc)
          if (validBossSet.size > 0 && !validBossSet.has(fight.encounterID)) continue;
          // Skip bosses already killed in an earlier report
          if (killedBosses.has(fight.encounterID)) continue;
          if (!fightsByEncounter[fight.encounterID]) {
            fightsByEncounter[fight.encounterID] = { name: fight.name, fights: [], firstKillTime: null };
          }
          const enc = fightsByEncounter[fight.encounterID];
          enc.fights.push(fight);
          bossSet.add(fight.name);
          if (fight.kill && (!enc.firstKillTime || fight.startTime < enc.firstKillTime)) {
            enc.firstKillTime = fight.startTime;
          }
        }

        // For each encounter, fetch Summary table per fight (has deathTime pre-calculated)
        for (const [encId, encData] of Object.entries(fightsByEncounter)) {
          // Wipes and the first kill are meaningful (that's the progression effort);
          // reclears -- any kill after the first -- are not, so they're excluded.
          const fightsToUse = encData.firstKillTime
            ? encData.fights.filter(f => f.startTime <= encData.firstKillTime)
            : encData.fights.filter(f => !f.kill);

          for (const fight of fightsToUse) {
            const fightDuration = fight.endTime - fight.startTime;
            if (fightDuration <= 0) continue;

            const summaryQ = `query {
              reportData {
                report(code: "${report.code}") {
                  table(
                    startTime: ${fight.startTime}
                    endTime: ${fight.endTime}
                    fightIDs: [${fight.id}]
                    dataType: Summary
                  )
                }
              }
            }`;

            try {
              const summaryResp = await wclQuery(summaryQ, creds);
              const table       = summaryResp?.data?.reportData?.report?.table;
              const parsed      = typeof table === 'string' ? JSON.parse(table) : table;
              const data        = parsed?.data || parsed;
              const totalTime   = data?.totalTime || fightDuration;
              const deathEvents = data?.deathEvents || [];   // [{name, deathTime, ...}]
              const composition = data?.composition || [];   // [{name, ...}] = who was in fight

              if (composition.length === 0) continue;

              // Build death time map by player name
              const deathMap = {};
              for (const ev of deathEvents) {
                if (ev.name && ev.deathTime != null) {
                  deathMap[ev.name] = ev.deathTime;
                }
              }

              // Calculate survival % for each player in composition
              for (const player of composition) {
                const name = player.name;
                if (!name) continue;
                if (memberSet.size > 0 && !memberSet.has(name.toLowerCase())) continue;

                const deathTime = deathMap[name];
                const survPct   = deathTime != null
                  ? Math.min(100, (deathTime / totalTime) * 100)
                  : 100; // not in deathEvents = survived full pull

                if (!survivorData[name]) survivorData[name] = {};
                if (!survivorData[name][encData.name]) {
                  survivorData[name][encData.name] = { total: 0, count: 0 };
                }
                survivorData[name][encData.name].total += survPct;
                survivorData[name][encData.name].count += 1;
              }
            } catch(e) {
              console.error('[survival] summary error', report.code, fight.id, e.message);
            }
          }
          if (fightsToUse.length > 0) {
            console.log('[survival] report', report.code, 'boss', encData.name, '| fights used:', fightsToUse.length);
          }
          // If this boss was killed in this report, mark it so we skip it in subsequent reports
          if (encData.firstKillTime !== null) {
            killedBosses.add(parseInt(encId));
          }
        }
      }

      // Average survival % per player per boss
      const survivorMap = {};
      for (const [player, bosses] of Object.entries(survivorData)) {
        survivorMap[player] = {};
        for (const [boss, { total, count }] of Object.entries(bosses)) {
          survivorMap[player][boss] = parseFloat((total / count).toFixed(1));
        }
      }

      const bossNames = [...bossSet];
      console.log('[survival] complete | players:', Object.keys(survivorMap).length, '| bosses:', bossNames.length);
      if (Object.keys(survivorMap).length > 0) {
        const first = Object.entries(survivorMap)[0];
        console.log('[survival] sample:', first[0], JSON.stringify(first[1]));
      }

      // Save incremental cache to Supabase for next fetch. A slower/rate-limited
      // request can finish after a concurrent overlapping one already advanced the
      // cache further -- re-read it fresh right before writing and merge into that
      // (rather than the possibly-stale snapshot read at the start of this request)
      // so this can only ever add to what's persisted, never regress it.
      let finalSurvivorMap = survivorMap;
      let finalBossNames   = bossNames;
      if (req.body?.teamId && Object.keys(survivorData).length > 0) {
        try {
          const finalSurvivorData = { ...survivorData };
          const finalBossSet      = new Set(bossSet);
          const finalKilledBosses = new Set(killedBosses);
          let   finalNewestTime   = newestReportTime;

          const { data: freshRow } = await supabase.from('wcl_scores').select('boss_scores')
            .eq('team_id', req.body.teamId).eq('zone_id', zoneId)
            .eq('character_name', '_surv_cache_').eq('server', survCacheKey).single();
          if (freshRow?.boss_scores) {
            const fresh = JSON.parse(freshRow.boss_scores);
            if ((fresh.lastReportTime || 0) > lastReportTime) {
              console.log('[survival] fresher cache found at save time (lastReportTime', fresh.lastReportTime, '> our', lastReportTime, ') -- merging instead of overwriting');
              for (const [player, playerBosses] of Object.entries(fresh.survivorRaw || {})) {
                if (!finalSurvivorData[player]) finalSurvivorData[player] = {};
                for (const [boss, val] of Object.entries(playerBosses)) {
                  const existing = finalSurvivorData[player][boss];
                  if (!existing || (val.count || 0) > (existing.count || 0)) finalSurvivorData[player][boss] = val;
                }
              }
              (fresh.bossNames || []).forEach(b => finalBossSet.add(b));
              (fresh.killedBossIds || []).forEach(id => finalKilledBosses.add(id));
              finalNewestTime = Math.max(finalNewestTime, fresh.lastReportTime || 0);
            }
          }

          finalSurvivorMap = {};
          for (const [player, playerBosses] of Object.entries(finalSurvivorData)) {
            finalSurvivorMap[player] = {};
            for (const [boss, { total, count }] of Object.entries(playerBosses)) {
              finalSurvivorMap[player][boss] = parseFloat((total / count).toFixed(1));
            }
          }
          finalBossNames = [...finalBossSet];

          const cachePayload = JSON.stringify({
            survivorMap:    finalSurvivorMap,
            survivorRaw:    finalSurvivorData,    // raw totals for future merging
            bossNames:      finalBossNames,
            killedBossIds:  [...finalKilledBosses],
            lastReportTime: finalNewestTime,
            savedAt:        Date.now(),
          });
          await supabase.from('wcl_scores').upsert({
            team_id:        req.body.teamId,
            zone_id:        zoneId,
            character_name: '_surv_cache_',
            server:         survCacheKey,
            boss_scores:    cachePayload,
            fetched_at:     new Date().toISOString(),
          }, { onConflict: 'team_id,zone_id,character_name,server', ignoreDuplicates: false });
          console.log('[survival] cache saved | lastReportTime:', finalNewestTime, '| bosses:', finalBossNames.length);
        } catch(e) {
          console.error('[survival] cache save error:', e.message);
        }
      }

      console.log('[survival] complete | players:', Object.keys(finalSurvivorMap).length, '| bosses:', finalBossNames.length);
      return res.status(200).json({ survivorMap: finalSurvivorMap, bossNames: finalBossNames });
    } catch(err) {
      console.error('[survival] error:', err.message);
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  if (action === 'wclQuery') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { teamId, query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'query required' });
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });
      const creds = await resolveWclCredentials(teamId);
      if (!creds) return res.status(400).json({ error: "Your guild hasn't connected Warcraft Logs API credentials yet. Add them in Guild Settings.", wclNotConfigured: true });
      const data = await wclQuery(query, creds);
      return res.status(200).json(data);
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── LIST: the roster, read straight from `characters` (the source of
  // truth) -- a plain DB read, always fast regardless of how many
  // characters there are or what Raider.io is doing. ilvl comes back as 0
  // placeholder here; the frontend backfills it via a separate listIlvl
  // call so this never has to wait on an external service. Any team member
  // can view it. ──
  if (action === 'list') {
    const teamId = req.query.teamId || req.body?.teamId;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });
    try {
      await assertTeamOwnership(teamId);

      const { data: chars, error } = await supabase
        .from('characters')
        .select(`id, name, class, spec, server, realm_name, primary_role, rank, account_id,
          flex_tank, flex_heal, flex_melee, flex_ranged,
          can_flex_tank, can_flex_heal, can_flex_melee, can_flex_ranged`)
        .eq('team_id', teamId)
        .eq('active', true);
      if (error) throw error;

      const players = (chars || []).map(c => ({
        id:              c.id,
        name:            c.name,
        class:           c.class,
        spec:            c.spec || null,
        server:          c.server,
        serverDisplay:   c.realm_name || serverDisplayFromSlug(c.server),
        role:            c.primary_role,
        rank:            c.rank || 'Main',
        account_id:      c.account_id,
        ilvl:            0, // filled in by listIlvl
        flex_tank:       c.flex_tank       || false,
        flex_heal:       c.flex_heal       || false,
        flex_melee:      c.flex_melee      || false,
        flex_ranged:     c.flex_ranged     || false,
        can_flex_tank:   c.can_flex_tank   || false,
        can_flex_heal:   c.can_flex_heal   || false,
        can_flex_melee:  c.can_flex_melee  || false,
        can_flex_ranged: c.can_flex_ranged || false,
      }));

      return res.status(200).json({ players });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── LIST ILVL: live item level per character from Raider.io, deliberately
  // split out of `list` above -- one Raider.io lookup per character, in
  // parallel, so a slow or degraded Raider.io (verified live this project
  // has hit both) only delays the ilvl numbers, never the roster itself.
  // Cached ~10 min; pass force=true (the Roster tab's "Refresh" button) to
  // bypass the cache. A 400 (character Raider.io hasn't indexed yet) or any
  // network hiccup just leaves that one character's ilvl at 0. ──
  if (action === 'listIlvl') {
    const teamId = req.query.teamId || req.body?.teamId;
    const force  = req.query.force === 'true' || req.body?.force === true;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });
    try {
      await assertTeamOwnership(teamId);

      const { data: team } = await supabase
        .from('teams').select('id, guilds ( region, game )').eq('id', teamId).single();
      const region = team?.guilds?.region === 'oceanic' ? 'us' : (team?.guilds?.region || 'us');
      const game = gameFor(team?.guilds?.game);
      const rio = game.sources.raiderio;
      // Raider.io where it covers the version (Retail, Classic Progression),
      // Blizzard's profile API otherwise, nothing for a version neither covers yet.
      const lookupIlvl = rio
        ? async c => {
            const resp = await fetch(
              `https://${rio.host}/api/v1/characters/profile?region=${encodeURIComponent(region)}` +
              `&realm=${encodeURIComponent(c.server)}&name=${encodeURIComponent(c.name)}&fields=gear`
            );
            return { ilvl: resp.ok ? (await resp.json())?.gear?.item_level_equipped || 0 : 0, status: resp.status };
          }
        : game.sources.blizzardNs !== null
          ? async c => ({ ilvl: (await fetchCharacterProfile(region, c.server, c.name, game))?.ilvl || 0, status: 'blizzard' })
          : null;

      const { data: chars, error } = await supabase
        .from('characters').select('name, server').eq('team_id', teamId).eq('active', true);
      if (error) throw error;

      const cache = ilvlCache.get(teamId) || new Map();
      ilvlCache.set(teamId, cache);
      const key = c => `${c.name}|${c.server}`;
      const stale = !lookupIlvl ? [] : (chars || []).filter(c => force || !(Date.now() - (cache.get(key(c))?.at || 0) < ILVL_CACHE_MS));

      // A few at a time, not the whole roster at once.
      for (let i = 0; i < stale.length; i += ILVL_LOOKUPS_AT_ONCE) {
        await Promise.all(stale.slice(i, i + ILVL_LOOKUPS_AT_ONCE).map(async c => {
          try {
            const { ilvl, status } = await lookupIlvl(c);
            if (ilvl) cache.set(key(c), { ilvl, at: Date.now() });
            else console.warn('[listIlvl] no item level for', c.name, c.server, 'status', status);
          } catch (e) { console.warn('[listIlvl] lookup failed for', c.name, e.message); }
        }));
      }

      const ilvls = Object.fromEntries((chars || []).map(c => [c.name, cache.get(key(c))?.ilvl || 0]));
      return res.status(200).json({ ilvls });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── GUILD ROSTER (officer only): the guild's real Blizzard roster, so the
  // Add Character modal can offer a pick-list instead of relying on someone
  // typing a name (and its accent marks) correctly by hand. Cached briefly
  // per team, same pattern as ilvlCache above -- fetched once when the
  // "Add From Guild" panel opens, not on every keystroke. ──
  if (action === 'guildRoster') {
    const teamId = req.query.teamId || req.body?.teamId;
    const force  = req.query.force === 'true' || req.body?.force === true;
    if (!teamId) return res.status(400).json({ error: 'teamId required' });
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

      const cached = guildRosterCache.get(teamId);
      if (!force && cached && Date.now() - cached.fetchedAt < GUILD_ROSTER_CACHE_MS) {
        return res.status(200).json({ members: cached.data });
      }

      const { data: team } = await supabase
        .from('teams').select('id, guilds ( name, server, region, game )').eq('id', teamId).single();
      const guild = team?.guilds;
      if (!guild?.name || !guild?.server) {
        return res.status(200).json({ members: [], error: "This team's guild name/server isn't set yet -- check Guild Settings." });
      }

      const members = await fetchGuildRoster(guild.region || 'us', guild.server, guild.name, guild.game);
      if (members === null) {
        return res.status(200).json({ members: [], error: "Couldn't reach Blizzard's guild roster for this guild/server -- check the guild name/server in Guild Settings." });
      }

      guildRosterCache.set(teamId, { data: members, fetchedAt: Date.now() });
      return res.status(200).json({ members });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── GUILD CHARACTER SPEC (officer only): active spec for one character,
  // looked up lazily -- guildRoster's response has no spec field (it's a
  // separate Blizzard endpoint per character), and fetching it for an
  // entire guild up front would be slow and mostly wasted. Best-effort: a
  // character that hasn't logged in recently enough for Blizzard to have it
  // cached just comes back with spec: null, never an error.
  //
  // realmSlug is the character's OWN realm (as returned per-member by
  // guildRoster), not necessarily the guild's realm -- a guild's members
  // can be spread across its whole connected-realm group. Falls back to the
  // guild's own realm only if the caller doesn't have a per-member one. ──
  if (action === 'guildCharacterSpec') {
    const teamId          = req.query.teamId          || req.body?.teamId;
    const characterName   = req.query.characterName   || req.body?.characterName;
    const realmSlugParam  = req.query.realmSlug        || req.body?.realmSlug;
    if (!teamId || !characterName) return res.status(400).json({ error: 'teamId and characterName required' });
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

      const { data: team } = await supabase
        .from('teams').select('id, guilds ( server, region, game )').eq('id', teamId).single();
      const guild = team?.guilds;
      const realmSlug = realmSlugParam || guild?.server;
      if (!realmSlug) return res.status(200).json({ spec: null });

      const spec = await fetchCharacterSpec(guild?.region || 'us', realmSlug, characterName, guild?.game);
      return res.status(200).json({ spec });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── ADD CHARACTER (officer only): manually add one character to the roster ──
  if (action === 'addCharacter') {
    const { teamId, name, class: charClass, server, role, spec, rank } = req.body;
    if (!teamId || !name || !charClass || !server || !(spec || role)) {
      return res.status(400).json({ error: 'name, class, server, and spec are required' });
    }
    if (name.trim().length > 24 || server.trim().length > 64) return res.status(400).json({ error: 'That name or realm is too long' });
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });
      const specRole = specAndRole(charClass, spec, role, await teamGame(supabase, teamId));
      if (specRole.error) return res.status(400).json({ error: specRole.error });

      // `characters` has a plain unique(team_id, name) with no carve-out for
      // inactive rows, so someone who left and is being re-added under their
      // exact old name would otherwise hit that constraint and fail outright.
      // Look up any existing row (active or not) instead of blind-inserting.
      const { data: existing } = await supabase
        .from('characters').select('id, active').eq('team_id', teamId).ilike('name', name.trim().replace(/[\\%_]/g, '\\$&')).maybeSingle();
      if (existing?.active) return res.status(409).json({ error: `${name.trim()} is already on this roster.` });

      let characterId;
      if (existing) {
        // Reactivate in place -- keeps the original id (and any loot history
        // already tied to it) instead of creating a duplicate identity.
        const { error: reactivateErr } = await supabase
          .from('characters')
          .update({
            class:        charClass.toLowerCase().trim(),
            server:       slugifyServer(server),
            realm_name:   server.trim(),
            primary_role: specRole.role,
            spec:         specRole.spec,
            rank:         rank || 'Main',
            active:       true,
          })
          .eq('id', existing.id);
        if (reactivateErr) throw reactivateErr;
        characterId = existing.id;
      } else {
        const { data, error } = await supabase
          .from('characters')
          .insert({
            team_id:      teamId,
            name:         name.trim(),
            class:        charClass.toLowerCase().trim(),
            server:       slugifyServer(server),
            realm_name:   server.trim(),
            primary_role: specRole.role,
            spec:         specRole.spec,
            rank:         rank || 'Main',
            active:       true,
          })
          .select('id').single();
        if (error) throw error;
        characterId = data.id;
      }

      // Opens a new membership "stint" -- someone who left and rejoins gets
      // a second row here rather than losing/overwriting their earlier one.
      const { error: periodErr } = await supabase
        .from('character_membership_periods')
        .insert({ team_id: teamId, character_id: characterId, joined_at: new Date().toISOString().slice(0, 10) });
      if (periodErr) throw periodErr;

      // A new Main joins the end of this season's Join Order (alts share
      // their main's spot). Added from Team Management > Recruits when
      // joinSource says so.
      if ((rank || 'Main') === 'Main') {
        await appendToJoinOrder(supabase, teamId, [{ id: characterId, name: name.trim(), account_id: null }],
          req.body.joinSource === 'recruit' ? 'recruit' : 'roster');
      }
      // Connected to whichever team member's Battle.net account has it.
      await linkRosterCharacters(supabase, teamId, [characterId]);

      return res.status(200).json({ success: true, id: characterId });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── UPDATE CHARACTER (officer only): edit an existing roster row by id.
  // Renaming won't carry forward historical attendance -- attendance_marks
  // stores character_name as plain text with no foreign key to characters,
  // so a rename orphans past attendance under the old name (surfaced as a
  // warning in the UI, not blocked here). ──
  if (action === 'updateCharacter') {
    const { teamId, characterId, name, class: charClass, server, role, spec, rank } = req.body;
    if (!teamId || !characterId) return res.status(400).json({ error: 'teamId and characterId required' });
    if ((name && name.trim().length > 24) || (server && server.trim().length > 64)) return res.status(400).json({ error: 'That name or realm is too long' });
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

      const updates = {};
      if (name)      updates.name         = name.trim();
      if (charClass) updates.class        = charClass.toLowerCase().trim();
      if (server)    updates.server       = slugifyServer(server);
      if (server)    updates.realm_name   = server.trim();
      if (spec || role || charClass) {
        // Role follows spec, checked against the class being saved (or the one on file).
        let cls = charClass;
        if (!cls) {
          const { data: current } = await supabase.from('characters').select('class').eq('id', characterId).eq('team_id', teamId).maybeSingle();
          cls = current?.class;
        }
        if (spec || role) {
          const specRole = specAndRole(cls, spec, role, await teamGame(supabase, teamId));
          if (specRole.error) return res.status(400).json({ error: specRole.error });
          updates.primary_role = specRole.role;
          updates.spec = specRole.spec;
        }
      }
      if (rank)      updates.rank         = rank;

      const { error } = await supabase
        .from('characters').update(updates).eq('id', characterId).eq('team_id', teamId);
      if (error) throw error;

      return res.status(200).json({ success: true });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── REMOVE CHARACTER (officer only): soft delete -- loot_drops references
  // characters(id) with no ON DELETE clause, so a hard delete would fail for
  // anyone with loot history; this also keeps past raid plans/attendance
  // intact and lets a mistaken removal be undone. Clears account_id so the
  // character isn't left connected to anyone, same as removeMember. ──
  if (action === 'removeCharacter') {
    const { teamId, characterId } = req.body;
    if (!teamId || !characterId) return res.status(400).json({ error: 'teamId and characterId required' });
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

      const { data: removed, error } = await supabase
        .from('characters').update({ active: false, account_id: null, claim_verified: false })
        .eq('id', characterId).eq('team_id', teamId).select('id, name');
      if (error) throw error;
      if (!removed?.length) return res.status(404).json({ error: 'Character not found on this team' });

      // Their upcoming "out" marks go too: they're not on the roster for those
      // nights any more, and with no one connected to the character, nobody
      // but an officer could clear them. (Past marks stay, as history.)
      const today = new Date().toISOString().slice(0, 10);
      const { error: marksErr } = await supabase.from('attendance_marks').delete()
        .eq('team_id', teamId).eq('character_name', removed[0].name).gte('raid_date', today);
      if (marksErr) console.error('[removeCharacter] upcoming marks:', marksErr.message);

      // Close their open membership period, if any -- best-effort: a
      // character added before this feature existed may have no period rows
      // at all yet, which is fine, there's just nothing to close.
      await supabase
        .from('character_membership_periods')
        .update({ left_at: new Date().toISOString().slice(0, 10) })
        .eq('character_id', characterId).is('left_at', null);
      await markLeftJoinOrder(supabase, teamId, characterId, 'Removed from the roster');

      return res.status(200).json({ success: true });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── GET FLEX ──
  if (action === 'getFlex') {
    const teamId = req.query.teamId || req.body?.teamId;
    try {
      await assertTeamOwnership(teamId);
      const { data: chars, error } = await supabase
        .from('characters')
        .select('name, flex_tank, flex_heal, flex_melee, flex_ranged, can_flex_tank, can_flex_heal, can_flex_melee, can_flex_ranged')
        .eq('team_id', teamId);
      if (error) throw error;
      const flexData = {};
      (chars || []).forEach(c => {
        if (c.flex_tank || c.flex_heal || c.flex_melee || c.flex_ranged
          || c.can_flex_tank || c.can_flex_heal || c.can_flex_melee || c.can_flex_ranged) {
          flexData[c.name] = {
            flex_tank:       c.flex_tank       || false,
            flex_heal:       c.flex_heal       || false,
            flex_melee:      c.flex_melee      || false,
            flex_ranged:     c.flex_ranged     || false,
            can_flex_tank:   c.can_flex_tank   || false,
            can_flex_heal:   c.can_flex_heal   || false,
            can_flex_melee:  c.can_flex_melee  || false,
            can_flex_ranged: c.can_flex_ranged || false,
          };
        }
      });
      return res.status(200).json({ flexData });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── UPDATE FLEX (officer only) ──
  if (action === 'updateFlex') {
    const { teamId, playerName, flex_tank, flex_heal, flex_melee, flex_ranged } = req.body;
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });
      const { error } = await supabase
        .from('characters')
        .update({
          flex_tank:   flex_tank   || false,
          flex_heal:   flex_heal   || false,
          flex_melee:  flex_melee  || false,
          flex_ranged: flex_ranged || false,
        })
        .eq('team_id', teamId)
        .eq('name', playerName);
      if (error) throw error;
      return res.status(200).json({ success: true });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── SAVE SCORES (officer only) ──
  if (action === 'saveScores') {
    const { teamId, zoneId, scores, bossNames, fetchedAt, difficulty } = req.body;
    if (!scores?.length) return res.status(400).json({ error: 'teamId and scores required' });
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });
      // Use difficulty as part of the server key so each difficulty has its own row
      const cacheKey = `cache_${difficulty || 'mythic'}`;
      const { error } = await supabase.from('wcl_scores').upsert({
        team_id:        teamId,
        zone_id:        zoneId || 0,
        character_name: '_cache_',
        server:         cacheKey,
        boss_scores:    JSON.stringify({ scores, bossNames, fetchedAt, difficulty }),
        fetched_at:     new Date(fetchedAt || Date.now()).toISOString(),
      }, { onConflict: 'team_id,zone_id,character_name,server', ignoreDuplicates: false });
      if (error) throw error;
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('saveScores error:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── GET SCORES ──
  if (action === 'getScores') {
    const teamId    = req.query.teamId    || req.body?.teamId;
    const zoneId    = parseInt(req.query.zoneId || req.body?.zoneId || '0');
    const difficulty = req.query.difficulty || req.body?.difficulty || 'mythic';
    const cacheKey  = `cache_${difficulty}`;
    try {
      await assertTeamOwnership(teamId);
      const { data, error } = await supabase
        .from('wcl_scores')
        .select('boss_scores, fetched_at')
        .eq('team_id', teamId)
        .eq('zone_id', zoneId)
        .eq('character_name', '_cache_')
        .eq('server', cacheKey)
        .single();
      if (error || !data) return res.status(200).json({ scores: [], bossNames: [] });
      const cache = JSON.parse(data.boss_scores || '{}');
      return res.status(200).json({
        scores:    cache.scores    || [],
        bossNames: cache.bossNames || [],
        fetchedAt: new Date(data.fetched_at).getTime(),
      });
    } catch (err) { return res.status(200).json({ scores: [], bossNames: [] }); }
  }

  res.status(400).json({ error: 'Invalid action' });
};
