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
const { decrypt } = require('../lib/crypto');
const { assertTeamMembership } = require('../lib/teamAuth');
const { slugifyServer, serverDisplayFromSlug } = require('../lib/serverSlug');

// Cache listIlvl's live Raider.io results per team briefly, so several
// people opening the Roster tab around the same time don't each trigger a
// fresh batch of per-character lookups. A character's gear doesn't change
// fast enough to justify hitting Raider.io on every page load either way.
const ilvlCache = new Map(); // teamId -> { data: {name: ilvl}, fetchedAt }
const ILVL_CACHE_MS = 10 * 60 * 1000;

// Thrown when a request needs WCL access but the caller's guild hasn't connected its
// own Warcraft Logs API client yet -- callers check err.wclNotConfigured to show a
// distinct "connect your credentials" state instead of a generic error.
class WclNotConfiguredError extends Error {
  constructor() {
    super("Your guild hasn't connected Warcraft Logs API credentials yet. Add them in Guild Settings.");
    this.wclNotConfigured = true;
  }
}

// "Oceanic" is a RaidLead-only region choice (it only changes which Raider.io
// rankings pool the Progress tab compares against) -- Oceanic realms are
// still part of Blizzard's/WCL's "us" game region, so every WCL query needs
// the real Blizzard region code, never "oceanic" itself.
function toWclRegion(region) {
  return region === 'oceanic' ? 'us' : region;
}

// ── WCL token cache, keyed by client ID -- every guild brings its own WCL API client,
// so each guild's usage draws only on its own quota, never a shared app-wide one. ──
const wclTokenCache = new Map(); // clientId -> { token, exp }

async function getWclToken(creds) {
  if (!creds?.clientId || !creds?.clientSecret) throw new WclNotConfiguredError();

  const cached = wclTokenCache.get(creds.clientId);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;

  const resp = await fetch('https://www.warcraftlogs.com/oauth/token', {
    method:  'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64'),
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error("Failed to get a WCL token -- check that your guild's WCL Client ID/Secret in Guild Settings are correct");

  const exp = Date.now() + ((data.expires_in || 3600) * 1000);
  wclTokenCache.set(creds.clientId, { token: data.access_token, exp });
  return data.access_token;
}

async function wclQuery(query, creds) {
  const token = await getWclToken(creds);
  const resp  = await fetch('https://www.warcraftlogs.com/api/v2/client', {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ query }),
  });
  return await resp.json();
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
        guildName: "${guildName}" guildServerSlug: "${serverSlug}"
        guildServerRegion: "${region}" zoneID: ${zoneId} limit: 50 page: ${page} ${tagParam}
      ) { data { code startTime fights(killType: All) { id encounterID name difficulty startTime endTime kill } } has_more_pages } }
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

  // Helper: resolve a specific team's own WCL API credentials (decrypted). Returns
  // null if that team hasn't set any up -- there is no shared/app-wide fallback, so
  // one team's usage can never draw on or be capped by another's WCL rate limit.
  async function resolveWclCredentials(teamId) {
    if (!teamId) return null;
    const { data: teamRow } = await supabase
      .from('teams')
      .select('wcl_client_id, wcl_client_secret_enc')
      .eq('id', teamId)
      .single();
    if (!teamRow?.wcl_client_id || !teamRow?.wcl_client_secret_enc) return null;
    try {
      return { clientId: teamRow.wcl_client_id, clientSecret: decrypt(teamRow.wcl_client_secret_enc) };
    } catch (e) {
      console.error('[wcl] failed to decrypt credentials for team', teamId, e.message);
      return null;
    }
  }

  // ── WCL ZONES (accessible to all members of the team) ──
  if (action === 'wclZones' || action === 'zones') {
    const teamId = req.query.teamId || req.body?.teamId;
    try {
      await assertTeamOwnership(teamId);
      const creds = await resolveWclCredentials(teamId);
      if (!creds) return res.status(200).json({ data: { worldData: { zones: [] } }, wclNotConfigured: true });
      const data = await wclQuery(`query { worldData { zones { id name frozen } } }`, creds);
      return res.status(200).json(data);
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── WCL QUERY PROXY (officers only) ──
  // ── DIAGNOSTIC: probe Summary table structure for a known fight ──
  // ── GET MITIGATION CACHE ──
  if (action === 'getMitigationCache') {
    const teamId = req.query.teamId || req.body?.teamId;
    const zoneId = req.query.zoneId || req.body?.zoneId;
    const diffId = req.query.diffId || req.body?.diffId || 5;
    if (!teamId) return res.status(200).json({ mitigationMap: {}, bossNames: [] });
    try {
      await assertTeamOwnership(teamId);
      const { data } = await supabase
        .from('wcl_scores').select('boss_scores, fetched_at')
        .eq('team_id', teamId).eq('zone_id', zoneId)
        .eq('character_name', '_mitig_cache_').eq('server', `mitig_${diffId}`)
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
            .eq('character_name', '_mitig_cache_').eq('server', `mitig_${diffId || 5}`);
        } catch(e) {}
      } else if (teamId) {
        try {
          const { data: cr } = await supabase.from('wcl_scores').select('boss_scores')
            .eq('team_id', teamId).eq('zone_id', zoneId)
            .eq('character_name', '_mitig_cache_').eq('server', `mitig_${diffId || 5}`).single();
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
      const mitigCacheKey = `mitig_${diffId || 5}`;
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

  // ── DIAGNOSTIC: probe DamageTaken table structure for mitigation ──
  if (action === 'diagMitigation') {
    const { teamId, reportCode, encounterID, targetName } = req.body || {};
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });
      const creds = await resolveWclCredentials(teamId);
      if (!creds) return res.status(400).json({ error: "Your guild hasn't connected Warcraft Logs API credentials yet. Add them in Guild Settings.", wclNotConfigured: true });

      // Get ALL fights for this encounter in the report
      const fightsResp = await wclQuery(`query {
        reportData {
          report(code: "${reportCode}") {
            fights(killType: All) { id encounterID name startTime endTime kill }
          }
        }
      }`, creds);
      const allFights = fightsResp?.data?.reportData?.report?.fights || [];
      const targetFights = encounterID
        ? allFights.filter(f => f.encounterID === parseInt(encounterID))
        : allFights;
      console.log('[diagMitigation] fights matched:', targetFights.length, 'of', allFights.length);

      const masterResp = await wclQuery(`query { reportData { report(code: "${reportCode}") { masterData { actors(type: "Player") { id name } } } } }`, creds);
      const actors = masterResp?.data?.reportData?.report?.masterData?.actors || [];
      const actorMap = {};
      actors.forEach(a => { actorMap[a.id] = a.name; });

      let mitigatedSum = 0, unmitigatedSum = 0, hitCount = 0, totalEvents = 0;

      for (const fight of targetFights) {
        let events = [];
        let nextTs = fight.startTime;
        let guard = 0;
        while (guard < 20) {
          const resp = await wclQuery(`query { reportData { report(code: "${reportCode}") {
            events(startTime: ${nextTs}, endTime: ${fight.endTime}, fightIDs: [${fight.id}], dataType: DamageTaken, limit: 10000) { data, nextPageTimestamp }
          } } }`, creds);
          const page = resp?.data?.reportData?.report?.events?.data || [];
          events = events.concat(page);
          nextTs = resp?.data?.reportData?.report?.events?.nextPageTimestamp;
          guard++;
          if (!nextTs) break;
        }
        totalEvents += events.length;

        for (const ev of events) {
          if (ev.type !== 'damage') continue;
          const name = actorMap[ev.targetID];
          if (targetName && name !== targetName) continue;
          if (!targetName && !name) continue;
          mitigatedSum   += ev.mitigated || 0;
          unmitigatedSum += ev.unmitigatedAmount != null ? ev.unmitigatedAmount : (ev.amount||0) + (ev.mitigated||0);
          hitCount++;
        }
      }

      const mitigPct = unmitigatedSum > 0 ? (mitigatedSum / unmitigatedSum) * 100 : null;

      return res.status(200).json({
        fightsChecked: targetFights.length,
        totalEvents, hitsForTarget: hitCount,
        mitigatedSum, unmitigatedSum,
        calculatedMitigPct: mitigPct != null ? mitigPct.toFixed(2) : null,
      });
    } catch(e) { return res.status(e.status || 500).json({ error: e.message }); }
  }

  if (action === 'diagSurvival') {
    const { teamId, reportCode, fightId, startTime, endTime } = req.body || {};
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });
      const creds = await resolveWclCredentials(teamId);
      if (!creds) return res.status(400).json({ error: "Your guild hasn't connected Warcraft Logs API credentials yet. Add them in Guild Settings.", wclNotConfigured: true });
      const q = `query {
        reportData {
          report(code: "${reportCode}") {
            table(startTime: ${startTime}, endTime: ${endTime}, fightIDs: [${fightId}], dataType: Summary)
          }
        }
      }`;
      const resp = await wclQuery(q, creds);
      const table  = resp?.data?.reportData?.report?.table;
      const parsed = typeof table === 'string' ? JSON.parse(table) : table;
      const data   = parsed?.data || parsed;
      return res.status(200).json({
        errors:            resp?.errors || null,
        dataKeys:          data ? Object.keys(data) : null,
        totalTime:         data?.totalTime,
        playerDetailsSample: data?.playerDetails ? JSON.stringify(data.playerDetails).slice(0, 1200) : null,
        deathEventsSample:   data?.deathEvents   ? JSON.stringify(data.deathEvents).slice(0, 1200)   : null,
        compositionSample:   data?.composition   ? JSON.stringify(data.composition).slice(0, 400)    : null,
      });
    } catch(e) { return res.status(e.status || 500).json({ error: e.message }); }
  }

  // ── GET SURVIVAL CACHE: read incremental survival cache from Supabase ──
  if (action === 'getSurvivalCache') {
    const teamId = req.query.teamId || req.body?.teamId;
    const zoneId = req.query.zoneId || req.body?.zoneId;
    const diffId = req.query.diffId || req.body?.diffId || 5;
    if (!teamId) return res.status(200).json({ survivorMap: {}, bossNames: [] });
    try {
      await assertTeamOwnership(teamId);
      const survCacheKey = `surv_${diffId}`;
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
      const survCacheKey = `surv_${diffId || 5}`;
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

  if (action === 'wclQuery' || action === 'query') {
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
        .select(`id, name, class, server, realm_name, primary_role, rank, account_id,
          flex_tank, flex_heal, flex_melee, flex_ranged,
          can_flex_tank, can_flex_heal, can_flex_melee, can_flex_ranged`)
        .eq('team_id', teamId)
        .eq('active', true);
      if (error) throw error;

      const players = (chars || []).map(c => ({
        id:              c.id,
        name:            c.name,
        class:           c.class,
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

      const cached = ilvlCache.get(teamId);
      if (!force && cached && Date.now() - cached.fetchedAt < ILVL_CACHE_MS) {
        return res.status(200).json({ ilvls: cached.data });
      }

      const { data: team } = await supabase
        .from('teams').select('id, guilds ( region )').eq('id', teamId).single();
      const region = team?.guilds?.region === 'oceanic' ? 'us' : (team?.guilds?.region || 'us');

      const { data: chars, error } = await supabase
        .from('characters').select('name, server').eq('team_id', teamId).eq('active', true);
      if (error) throw error;

      const entries = await Promise.all((chars || []).map(async c => {
        let ilvl = 0;
        try {
          const resp = await fetch(
            `https://raider.io/api/v1/characters/profile?region=${encodeURIComponent(region)}` +
            `&realm=${encodeURIComponent(c.server)}&name=${encodeURIComponent(c.name)}&fields=gear`
          );
          if (resp.ok) {
            const data = await resp.json();
            ilvl = data?.gear?.item_level_equipped || 0;
          }
        } catch (e) { /* leave ilvl at 0 */ }
        return [c.name, ilvl];
      }));

      const ilvls = Object.fromEntries(entries);
      ilvlCache.set(teamId, { data: ilvls, fetchedAt: Date.now() });
      return res.status(200).json({ ilvls });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── ADD CHARACTER (officer only): manually add one character to the roster ──
  if (action === 'addCharacter') {
    const { teamId, name, class: charClass, server, role, rank } = req.body;
    if (!teamId || !name || !charClass || !server || !role) {
      return res.status(400).json({ error: 'name, class, server, and role are required' });
    }
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

      const { data: existing } = await supabase
        .from('characters').select('id').eq('team_id', teamId).eq('active', true).ilike('name', name.trim()).maybeSingle();
      if (existing) return res.status(409).json({ error: `${name.trim()} is already on this roster.` });

      const { data, error } = await supabase
        .from('characters')
        .insert({
          team_id:      teamId,
          name:         name.trim(),
          class:        charClass.toLowerCase().trim(),
          server:       slugifyServer(server),
          realm_name:   server.trim(),
          primary_role: role.toLowerCase().trim(),
          rank:         rank || 'Main',
          active:       true,
        })
        .select('id').single();
      if (error) throw error;

      return res.status(200).json({ success: true, id: data.id });
    } catch (err) { return res.status(err.status || 500).json({ error: err.message }); }
  }

  // ── UPDATE CHARACTER (officer only): edit an existing roster row by id.
  // Renaming won't carry forward historical attendance -- attendance_marks
  // stores character_name as plain text with no foreign key to characters,
  // so a rename orphans past attendance under the old name (surfaced as a
  // warning in the UI, not blocked here). ──
  if (action === 'updateCharacter') {
    const { teamId, characterId, name, class: charClass, server, role, rank } = req.body;
    if (!teamId || !characterId) return res.status(400).json({ error: 'teamId and characterId required' });
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

      const updates = {};
      if (name)      updates.name         = name.trim();
      if (charClass) updates.class        = charClass.toLowerCase().trim();
      if (server)    updates.server       = slugifyServer(server);
      if (server)    updates.realm_name   = server.trim();
      if (role)      updates.primary_role = role.toLowerCase().trim();
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
  // intact and lets a mistaken removal be undone. Clears account_id so that
  // account is free to claim a different character, same as removeMember. ──
  if (action === 'removeCharacter') {
    const { teamId, characterId } = req.body;
    if (!teamId || !characterId) return res.status(400).json({ error: 'teamId and characterId required' });
    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

      const { error } = await supabase
        .from('characters').update({ active: false, account_id: null }).eq('id', characterId).eq('team_id', teamId);
      if (error) throw error;

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
