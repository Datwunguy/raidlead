// ============================================================
//  recruiting.js — Team Management tab
//  Officer actions: listRecruits, addRecruit, updateRecruit, deleteRecruit,
//           lookupCharacter, refreshRecruitLookup, saveRecruitScores,
//           listTemplates, saveTemplate, deleteTemplate,
//           listApplications, getApplication, saveApplicationSheet,
//           saveApplicationColumnMap, promoteApplication,
//           rejectApplication, resolveApplications, undoApplicationDecision,
//           listSurveys, getSurveyResults, openSurvey, updateSurvey,
//           closeSurvey, reopenSurvey, deleteSurvey, getSurveyPrompt,
//           getJoinOrder, startJoinOrder, saveJoinOrder, addJoinOrderEntries,
//           removeJoinOrderEntry, restoreJoinOrderEntry
//  Raider actions (any team member but viewers): getSurvey,
//           submitSurveyResponse -- the Next Season survey itself.
//
//  This is the 12th and last serverless function the Vercel Hobby plan
//  allows -- future Team Management features (Applicants, Next Season) add
//  actions here rather than new files under api/.
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('../lib/session');
const { assertTeamMembership, getTeamRole, isOfficerRole } = require('../lib/teamAuth');
const { slugifyServer } = require('../lib/serverSlug');
const { resolveCurrentRaidByDate, fetchRaidCalendar, seasonTransitionFrom } = require('../lib/raiderioRaids');
const { fetchCharacterSummary, searchCharacters } = require('../lib/raiderioCharacter');
const { resolveCurrentCharacter, wclCharacterIdFromUrl } = require('../lib/wclClient');
const { canonicalSpec, roleForSpec, parseSpec } = require('../lib/wowSpecs');
const { normalizeSurveyDefinition, normalizeSurveyResponse, upgradeQuestions, upgradeResponse, surveyPromptFor } = require('../lib/seasonSurvey');
const { LIST_FIELDS: JOIN_LIST_FIELDS, listEntries: listJoinEntries, currentJoinOrder, createSurveyList, placeSurveyResponse, appendToJoinOrder } = require('../lib/joinOrder');
const { serviceAccountEmail, parseSheetUrl, readSheetTab } = require('../lib/googleSheets');
const { FIELDS: APPLICATION_FIELDS, detectColumnMap, mergeColumnMap, normalizeApplications } = require('../lib/applications');

const STATUSES     = ['contacted', 'no_response', 'not_interested', 'interested', 'joined', 'rejected']; // must match RECRUIT_STATUSES in app.js
const CHANNELS     = ['mail', 'whisper', 'discord', 'form', 'other'];
const ROLES        = ['tank', 'heal', 'melee', 'ranged'];
const { gameFor } = require('../lib/games');

const SURVEY_FIELDS          = 'id, title, intro, questions, opened_at, closed_at, created_at, updated_at';
const SURVEY_RESPONSE_FIELDS = `id, character_id, character_name, status, spec_choices, flex_roles, availability,
  acknowledgements, answers, comments, submitted_at, updated_at`;
// The Next Season survey is for every raider; the rest of this file is officer-only.
const MEMBER_ACTIONS = new Set(['getSurvey', 'submitSurveyResponse']);

const RECRUIT_FIELDS = `id, name, realm, realm_slug, class, spec, role, source, application_key,
  contacted_at, channel, status, notes, lookup, wcl_scores, created_at, updated_at,
  creator:accounts ( battletag, display_name )`;

// The current raid's slug only picks which progress line ("6/8 M") a
// Raider.io lookup shows -- cached per region so adding a batch of recruits
// doesn't re-hit Raider.io's static-data endpoint every time.
const raidSlugCache = new Map(); // region -> { slug, fetchedAt }
const RAID_SLUG_CACHE_MS = 60 * 60 * 1000;

async function currentRaidSlug(region) {
  const cached = raidSlugCache.get(region);
  if (cached && Date.now() - cached.fetchedAt < RAID_SLUG_CACHE_MS) return cached.slug;
  const raid = await resolveCurrentRaidByDate(region);
  const slug = raid?.raidSlug || null;
  raidSlugCache.set(region, { slug, fetchedAt: Date.now() });
  return slug;
}

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

// The Applicants tab, its pending-count badge, and the Recruits
// "Application" popup all read the same sheet within seconds of each other
// -- a short per-team cache keeps that to one Google call.
const sheetCache = new Map(); // teamId -> { sheetId, gid, data, fetchedAt }
const SHEET_CACHE_MS = 60 * 1000;

// responseKey (single) or responseKeys (bulk) from a request, validated
// against the shape lib/applications.js produces (24 hex chars).
function requestedKeys(body) {
  const raw = Array.isArray(body?.responseKeys) ? body.responseKeys : (body?.responseKey ? [body.responseKey] : []);
  return [...new Set(raw.filter(k => typeof k === 'string' && /^[a-f0-9]{24}$/.test(k)))].slice(0, 500);
}

function friendlySheetError(err, email) {
  // A 403 also comes back when the Sheets API isn't enabled on the Google
  // Cloud project -- that one's for the site admin, so pass it through.
  if (err.status === 403 && !/has not been used|is disabled/i.test(err.message)) {
    return `RaidLead can't open that sheet yet. Share it with ${email} as a Viewer, then try again.`;
  }
  if (err.status === 404) return "That spreadsheet wasn't found. Check the link.";
  return err.message;
}

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const teamId   = req.query.teamId || req.body?.teamId;

  let myRole;
  try {
    // Officer-only apart from the survey itself -- recruiting notes,
    // outreach history, and everyone's survey answers aren't something
    // regular members should see.
    myRole = await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: !MEMBER_ACTIONS.has(action) });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  async function openSurvey() {
    const { data, error } = await supabase
      .from('season_surveys').select(SURVEY_FIELDS)
      .eq('team_id', teamId).is('closed_at', null).maybeSingle();
    if (error) throw error;
    return upgradedSurvey(data);
  }

  // Surveys and responses always go out in the current question format
  // (see upgradeQuestions / upgradeResponse in lib/seasonSurvey.js).
  const upgradedSurvey = s => (s ? { ...s, questions: upgradeQuestions(s.questions) } : null);

  // What a raider sees of a survey (no bookkeeping fields).
  const publicSurvey = s => ({ id: s.id, title: s.title, intro: s.intro, questions: s.questions, openedAt: s.opened_at });

  // This team's region and WoW version (its guild's) -- looked up once per request.
  let teamInfoPromise = null;
  function teamInfo() {
    teamInfoPromise ||= supabase.from('teams').select('guilds ( server, region, game )').eq('id', teamId).single()
      .then(({ data }) => ({ region: data?.guilds?.region || 'us', server: data?.guilds?.server || '', game: gameFor(data?.guilds?.game) }));
    return teamInfoPromise;
  }
  const teamRegion = async () => (await teamInfo()).region;

  // Raider.io only knows a character by its current name and realm, so
  // anyone who renamed or transferred since applying comes back empty.
  // Warcraft Logs keeps one identity across both -- when Raider.io misses,
  // ask WCL (the team's own credentials) who this character is now, then
  // retry Raider.io under that name. A summary found that way carries
  // renamedFrom: { name, realm } and the WCL id. Pass the applicant's WCL
  // link (wclUrl) or a saved wclId when known: an id link resolves even if
  // the name they typed is stale.
  async function lookup(name, realm, { wclUrl, wclId } = {}) {
    const { region, game } = await teamInfo();
    // Raider.io's raid calendar is Retail's; Classic's progress just lists what it has.
    const raidSlug = game.sources.raiderio?.calendar ? await currentRaidSlug(region) : null;
    const direct   = await fetchCharacterSummary(region, realm, name, raidSlug, game);
    if (direct) return direct;

    const current = await resolveCurrentCharacter(supabase, teamId, {
      region, name: name.trim(), realmSlug: slugifyServer(realm),
      wclCharacterId: wclId || wclCharacterIdFromUrl(wclUrl),
    });
    if (!current) return null;
    const moved = current.name.toLowerCase() !== name.trim().toLowerCase()
      || slugifyServer(current.realmName) !== slugifyServer(realm);
    if (!moved) return null; // same character -- Raider.io just doesn't have it

    const summary = await fetchCharacterSummary(region, current.realmName, current.name, raidSlug, game);
    return {
      ...(summary || {
        name: current.name, realmName: current.realmName, class: null, spec: null, role: null,
        ilvl: null, mplusScore: null, raidProgress: null, profileUrl: null, fetchedAt: new Date().toISOString(),
      }),
      renamedFrom: { name: name.trim(), realm },
      wclId:       current.wclId,
    };
  }

  async function findExisting(name, realmSlug) {
    const { data } = await supabase
      .from('recruits').select(RECRUIT_FIELDS)
      .eq('team_id', teamId).ilike('name', name.trim().replace(/[\\%_]/g, '\\$&')).eq('realm_slug', realmSlug)
      .maybeSingle();
    return data || null;
  }

  async function readTeamSheet(cfg, force) {
    const cached = sheetCache.get(teamId);
    if (!force && cached && cached.sheetId === cfg.application_sheet_id && cached.gid === cfg.application_sheet_gid
        && Date.now() - cached.fetchedAt < SHEET_CACHE_MS) {
      return cached.data;
    }
    const data = await readSheetTab(cfg.application_sheet_id, cfg.application_sheet_gid);
    sheetCache.set(teamId, { sheetId: cfg.application_sheet_id, gid: cfg.application_sheet_gid, data, fetchedAt: Date.now() });
    return data;
  }

  // Everything the Applicants tab needs in one payload: connection state,
  // column mapping, and every response merged with its officer decision
  // (no application_reviews row = still pending).
  async function loadApplications(force) {
    const email = serviceAccountEmail();
    const { data: cfg } = await supabase
      .from('teams').select('application_sheet_id, application_sheet_gid, application_column_map')
      .eq('id', teamId).single();
    const base = { serviceEmail: email, serverReady: !!email, configured: !!cfg?.application_sheet_id, applications: [] };
    if (!base.configured || !base.serverReady) return base;

    let sheet;
    try {
      sheet = await readTeamSheet(cfg, force);
    } catch (err) {
      return { ...base, error: friendlySheetError(err, email) };
    }

    const headers   = (sheet.rows[0] || []).map(h => String(h ?? ''));
    const detected  = detectColumnMap(headers);
    const columnMap = mergeColumnMap(detected, cfg.application_column_map);
    const apps      = normalizeApplications(sheet.rows, columnMap);

    const { data: reviews, error } = await supabase
      .from('application_reviews')
      .select('response_key, decision, recruit_id, reject_note, decided_at, decider:accounts ( battletag, display_name )')
      .eq('team_id', teamId);
    if (error) throw error;
    const byKey = new Map((reviews || []).map(r => [r.response_key, r]));
    for (const a of apps) {
      const r = byKey.get(a.key);
      a.decision   = r?.decision || 'pending';
      a.recruitId  = r?.recruit_id || null;
      a.rejectNote = r?.reject_note || null;
      a.decidedAt  = r?.decided_at || null;
      a.decidedBy  = r?.decider?.display_name || r?.decider?.battletag || null;
    }
    return {
      ...base,
      sheet: { title: sheet.spreadsheetTitle, tab: sheet.tabTitle },
      headers,
      columnMap,
      detectedColumnMap: detected,
      applications: apps,
    };
  }

  try {
    // ── LIST RECRUITS ──
    if (action === 'listRecruits') {
      const { data, error } = await supabase
        .from('recruits').select(RECRUIT_FIELDS)
        .eq('team_id', teamId)
        .order('contacted_at', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ recruits: data || [] });
    }

    // ── LOOKUP CHARACTER: Raider.io preview while an officer is typing,
    // plus whether this character is already being tracked, so the
    // duplicate warning shows before they even hit Add. ──
    if (action === 'lookupCharacter') {
      const name  = (req.query.name  || req.body?.name  || '').trim();
      const realm = (req.query.realm || req.body?.realm || '').trim();
      if (!name || !realm) return res.status(400).json({ error: 'name and realm required' });
      const summary = await lookup(name, realm, { wclUrl: req.body?.wclUrl });
      // A renamed character may already be tracked under either name.
      const existing = (summary?.renamedFrom && await findExisting(summary.name, slugifyServer(summary.realmName)))
        || await findExisting(name, slugifyServer(realm));
      return res.status(200).json({ summary, existing });
    }

    // ── SEARCH CHARACTERS: name suggestions as an officer types (Add
    // Character's name box) -- this team's region, its own realm first. ──
    if (action === 'searchCharacters') {
      const term = String(req.query.term || req.body?.term || '').trim();
      if (term.length < 2 || term.length > 24) return res.status(200).json({ results: [] });
      const { region, server, game } = await teamInfo();
      const results = await searchCharacters(term, region, slugifyServer(server), game);
      return res.status(200).json({ results });
    }

    // ── ADD RECRUIT ──
    if (action === 'addRecruit') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const b = req.body || {};
      const typedName  = (b.name  || '').trim();
      const typedRealm = (b.realm || '').trim();
      if (!typedName || !typedRealm) return res.status(400).json({ error: 'Name and realm are required' });
      if (b.channel && !CHANNELS.includes(b.channel)) return res.status(400).json({ error: 'Invalid channel' });
      if (b.role && !ROLES.includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
      if (b.contactedAt && !isValidDate(b.contactedAt)) return res.status(400).json({ error: 'Invalid contacted date' });

      // Raider.io's copy of the name/realm is canonical (correct casing,
      // accents, and the realm's real punctuation, e.g. "Mal'Ganis" even if
      // typed "malganis") -- prefer it whenever the lookup finds them.
      const summary   = await lookup(typedName, typedRealm);
      const name      = summary?.name || typedName;
      const realm     = summary?.realmName || typedRealm;
      const realmSlug = slugifyServer(realm);

      const { data, error } = await supabase
        .from('recruits')
        .insert({
          team_id:      teamId,
          name,
          realm,
          realm_slug:   realmSlug,
          class:        b.class || summary?.class || null,
          spec:         b.spec  || summary?.spec  || null,
          role:         b.role  || summary?.role  || null,
          source:       'outreach',
          contacted_at: b.contactedAt || new Date().toISOString().slice(0, 10),
          channel:      b.channel || null,
          status:       'contacted',
          notes:        (b.notes || '').trim() || null,
          lookup:       summary,
          created_by:   session.id,
        })
        .select(RECRUIT_FIELDS).single();

      if (error) {
        if (error.code === '23505') {
          const existing = await findExisting(name, realmSlug);
          return res.status(409).json({ error: 'Already tracked', existing });
        }
        throw error;
      }
      return res.status(200).json({ recruit: data });
    }

    // ── UPDATE RECRUIT: status, notes, channel, contacted date, and
    // class/spec/role corrections -- only the fields actually sent change. ──
    if (action === 'updateRecruit') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const b = req.body || {};
      if (!b.recruitId) return res.status(400).json({ error: 'recruitId required' });

      const updates = { updated_at: new Date().toISOString() };
      if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
        updates.status = b.status;
      }
      if (b.channel !== undefined) {
        if (b.channel && !CHANNELS.includes(b.channel)) return res.status(400).json({ error: 'Invalid channel' });
        updates.channel = b.channel || null;
      }
      if (b.role !== undefined) {
        if (b.role && !ROLES.includes(b.role)) return res.status(400).json({ error: 'Invalid role' });
        updates.role = b.role || null;
      }
      if (b.contactedAt !== undefined) {
        if (!isValidDate(b.contactedAt) || b.contactedAt < '2004-01-01') return res.status(400).json({ error: 'Invalid contacted date' });
        // Any past date is fine (fixing a wrong one); the future isn't. A day of
        // slack covers officers whose local "today" is already tomorrow in UTC.
        if (b.contactedAt > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) {
          return res.status(400).json({ error: "The contacted date can't be in the future" });
        }
        updates.contacted_at = b.contactedAt;
      }
      if (b.notes !== undefined) updates.notes = (b.notes || '').trim() || null;
      if (b.class !== undefined) updates.class = b.class ? String(b.class).toLowerCase() : null;

      if (b.spec !== undefined || updates.role !== undefined || updates.class !== undefined) {
        const { data: current, error: readErr } = await supabase
          .from('recruits').select('class, role').eq('id', b.recruitId).eq('team_id', teamId).single();
        if (readErr) throw readErr;
        const cls = updates.class !== undefined ? updates.class : current.class;
        if (b.spec !== undefined) {
          // A known spec also sets the role, unless one was sent explicitly.
          const { game } = await teamInfo();
          updates.spec = b.spec ? (canonicalSpec(cls, b.spec, game) || String(b.spec).trim().slice(0, 40)) : null;
          const specRole = roleForSpec(cls, updates.spec, game);
          if (b.role === undefined && specRole) updates.role = specRole;
        }
        // WCL scores are fetched by role -- healers by HPS, everyone else by
        // DPS -- so crossing that line makes the saved ones the wrong metric.
        if (updates.role !== undefined && (updates.role === 'heal') !== (current.role === 'heal')) updates.wcl_scores = {};
      }

      const { data, error } = await supabase
        .from('recruits').update(updates)
        .eq('id', b.recruitId).eq('team_id', teamId)
        .select(RECRUIT_FIELDS).single();
      if (error) throw error;
      return res.status(200).json({ recruit: data });
    }

    // ── REFRESH RECRUIT LOOKUP: re-pulls a recruit's Raider.io snapshot.
    // Raider.io misses renamed or transferred characters, so the recruit
    // row follows WCL to the current name and realm instead of keeping a
    // dead link. The UI runs this quietly for missing or stale snapshots. ──
    if (action === 'refreshRecruitLookup') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { recruitId } = req.body || {};
      if (!recruitId) return res.status(400).json({ error: 'recruitId required' });
      const { data: current, error: readErr } = await supabase
        .from('recruits').select('id, name, realm, class, spec, role, lookup')
        .eq('id', recruitId).eq('team_id', teamId).single();
      if (readErr) throw readErr;

      const summary = await lookup(current.name, current.realm, { wclId: current.lookup?.wclId });
      // Keep "formerly X" (and the WCL id) once they're found by their new name.
      if (summary && !summary.renamedFrom && current.lookup?.renamedFrom) {
        summary.renamedFrom = current.lookup.renamedFrom;
        summary.wclId = summary.wclId || current.lookup.wclId;
      }
      // Not found anywhere: remember when we checked, so it isn't retried every visit.
      const updates = { lookup: summary || { notFound: true, fetchedAt: new Date().toISOString() } };
      if (summary) {
        if (!current.class && summary.class) updates.class = summary.class;
        if (!current.spec  && summary.spec)  updates.spec  = summary.spec;
        if (!current.role  && summary.role)  updates.role  = summary.role;
      }
      const renamed = summary && (summary.name !== current.name || summary.realmName !== current.realm);
      const save = u => supabase.from('recruits').update(u)
        .eq('id', recruitId).eq('team_id', teamId).select(RECRUIT_FIELDS).single();

      let { data, error } = await save(renamed
        ? { ...updates, name: summary.name, realm: summary.realmName, realm_slug: slugifyServer(summary.realmName), updated_at: new Date().toISOString() }
        : updates);
      // Someone's already tracking them under the new name -- keep both rows, just refresh the snapshot.
      if (error && error.code === '23505') ({ data, error } = await save(updates));
      if (error) throw error;
      return res.status(200).json({ recruit: data });
    }

    // ── DELETE RECRUIT ──
    if (action === 'deleteRecruit') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { recruitId } = req.body || {};
      if (!recruitId) return res.status(400).json({ error: 'recruitId required' });
      const { error } = await supabase.from('recruits').delete().eq('id', recruitId).eq('team_id', teamId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ── SAVE RECRUIT SCORES: WCL scores are fetched client-side (through
    // the same officer-gated WCL proxy the roster's WCL Scores tab uses) and
    // stored per recruit, per difficulty, so every officer sees them without
    // refetching. Merges into wcl_scores rather than overwriting, so a
    // Heroic refresh doesn't wipe the Mythic numbers. ──
    if (action === 'saveRecruitScores') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { recruitId, difficulty, entry } = req.body || {};
      if (!recruitId || !entry) return res.status(400).json({ error: 'recruitId and entry required' });
      // This version's difficulties (Retail LFR..Mythic, Classic 10/25, Era 20/40, ...).
      if (!(await teamInfo()).game.difficulties.some(d => d.key === difficulty)) return res.status(400).json({ error: 'Invalid difficulty' });
      if (JSON.stringify(entry).length > 50000) return res.status(400).json({ error: 'Score data too large' });

      const { data: current, error: readErr } = await supabase
        .from('recruits').select('wcl_scores').eq('id', recruitId).eq('team_id', teamId).single();
      if (readErr) throw readErr;

      const wclScores = { ...(current?.wcl_scores || {}), [difficulty]: { ...entry, fetchedAt: Date.now() } };
      const { error } = await supabase
        .from('recruits').update({ wcl_scores: wclScores })
        .eq('id', recruitId).eq('team_id', teamId);
      if (error) throw error;
      return res.status(200).json({ wclScores });
    }

    // ── TEMPLATES ──
    if (action === 'listTemplates') {
      const { data, error } = await supabase
        .from('recruit_templates').select('id, title, body, created_at, updated_at')
        .eq('team_id', teamId).order('created_at', { ascending: true });
      if (error) throw error;
      return res.status(200).json({ templates: data || [] });
    }

    if (action === 'saveTemplate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { templateId } = req.body || {};
      const title = (req.body?.title || '').trim();
      const body  = (req.body?.body  || '').trim();
      if (!title || !body) return res.status(400).json({ error: 'Title and message are required' });
      if (title.length > 100 || body.length > 2000) return res.status(400).json({ error: 'Template is too long' });

      const query = templateId
        ? supabase.from('recruit_templates').update({ title, body, updated_at: new Date().toISOString() })
            .eq('id', templateId).eq('team_id', teamId)
        : supabase.from('recruit_templates').insert({ team_id: teamId, title, body });
      const { data, error } = await query.select('id, title, body, created_at, updated_at').single();
      if (error) throw error;
      return res.status(200).json({ template: data });
    }

    if (action === 'deleteTemplate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { templateId } = req.body || {};
      if (!templateId) return res.status(400).json({ error: 'templateId required' });
      const { error } = await supabase.from('recruit_templates').delete().eq('id', templateId).eq('team_id', teamId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ── APPLICATIONS (the guild's Google Form responses) ──
    if (action === 'listApplications') {
      const force = req.query.force === 'true' || req.body?.force === true;
      return res.status(200).json(await loadApplications(force));
    }

    if (action === 'getApplication') {
      const key = req.query.responseKey || req.body?.responseKey;
      if (!key) return res.status(400).json({ error: 'responseKey required' });
      const loaded = await loadApplications();
      if (loaded.error) return res.status(400).json({ error: loaded.error });
      const application = loaded.applications.find(a => a.key === key);
      if (!application) return res.status(404).json({ error: "That application isn't in the sheet anymore." });
      return res.status(200).json({ application });
    }

    // Connect (or, with an empty url, disconnect) the response sheet. Reads
    // it once before saving, so a wrong link or a missing share fails right
    // here with a useful message rather than on every later page load.
    if (action === 'saveApplicationSheet') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const url = (req.body?.url || '').trim();
      if (!url) {
        const { error } = await supabase.from('teams')
          .update({ application_sheet_id: null, application_sheet_gid: null, application_column_map: null })
          .eq('id', teamId);
        if (error) throw error;
        sheetCache.delete(teamId);
        return res.status(200).json(await loadApplications());
      }

      const email = serviceAccountEmail();
      if (!email) return res.status(400).json({ error: 'Google Sheets access is not set up on this RaidLead server yet.' });
      const parsed = parseSheetUrl(url);
      if (!parsed) {
        return res.status(400).json({ error: /\/forms\//.test(url)
          ? "That's the form itself -- paste the link to its responses spreadsheet instead (in the form: Responses → View in Sheets)."
          : "That doesn't look like a Google Sheets link." });
      }

      // Every guild shares its sheet with the same RaidLead Google account, so
      // a sheet already connected elsewhere stays there -- unless you're an
      // officer on that team too (one guild running two teams off one form).
      const { data: holders } = await supabase
        .from('teams').select('id').eq('application_sheet_id', parsed.id).neq('id', teamId);
      for (const h of holders || []) {
        if (!isOfficerRole(await getTeamRole(supabase, session.id, h.id))) {
          return res.status(409).json({ error: 'That spreadsheet is already connected to another team. An officer of that team would need to disconnect it first.' });
        }
      }

      let sheet;
      try {
        sheet = await readSheetTab(parsed.id, parsed.gid);
      } catch (err) {
        return res.status(400).json({ error: friendlySheetError(err, email) });
      }
      const { error } = await supabase.from('teams')
        .update({ application_sheet_id: parsed.id, application_sheet_gid: sheet.gid, application_column_map: null })
        .eq('id', teamId);
      if (error) throw error;
      sheetCache.set(teamId, { sheetId: parsed.id, gid: sheet.gid, data: sheet, fetchedAt: Date.now() });
      return res.status(200).json(await loadApplications());
    }

    // Officer corrections to the auto-detected columns. -1 = "no such column".
    if (action === 'saveApplicationColumnMap') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const input = req.body?.columnMap || {};
      const clean = {};
      for (const f of APPLICATION_FIELDS) {
        if (input[f] === undefined) continue;
        if (!Number.isInteger(input[f]) || input[f] < -1 || input[f] > 500) return res.status(400).json({ error: `Invalid column for ${f}` });
        clean[f] = input[f];
      }
      const { error } = await supabase.from('teams').update({ application_column_map: clean }).eq('id', teamId);
      if (error) throw error;
      return res.status(200).json(await loadApplications());
    }

    // "Add to Recruitment": creates a recruit from the application (or links
    // an existing outreach recruit for the same character) and records the
    // decision. name/realm in the body override the parsed answer, for
    // responses whose "Name-Realm" couldn't be read.
    if (action === 'promoteApplication') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { responseKey } = req.body || {};
      if (!responseKey) return res.status(400).json({ error: 'responseKey required' });

      const loaded = await loadApplications();
      if (loaded.error) return res.status(400).json({ error: loaded.error });
      const app = loaded.applications.find(a => a.key === responseKey);
      if (!app) return res.status(404).json({ error: "That application isn't in the sheet anymore." });
      if (app.decision !== 'pending') return res.status(409).json({ error: 'This application already has a decision.' });

      const typedName  = (req.body?.name  || app.name  || '').trim();
      const typedRealm = (req.body?.realm || app.realm || '').trim();
      if (!typedName || !typedRealm) {
        return res.status(400).json({ error: 'Enter their character name and realm.', needsCharacter: true });
      }

      // Claim the decision FIRST -- the unique index is the lock, so two
      // officers clicking at once can't both create a recruit.
      const { data: review, error: claimErr } = await supabase
        .from('application_reviews')
        .insert({ team_id: teamId, response_key: responseKey, decision: 'promoted', decided_by: session.id })
        .select('id').single();
      if (claimErr) {
        if (claimErr.code === '23505') return res.status(409).json({ error: 'Another officer just made a decision on this application.' });
        throw claimErr;
      }

      try {
        // Their WCL link only speaks for the character they applied with --
        // not for one an officer typed in by hand.
        const overridden = !!(req.body?.name || req.body?.realm);
        const summary   = await lookup(typedName, typedRealm, { wclUrl: overridden ? null : app.links?.wcl });
        const name      = summary?.name || typedName;
        const realm     = summary?.realmName || typedRealm;
        const realmSlug = slugifyServer(realm);

        // Linking also moves an entry saved under their old name over to
        // the current one.
        const linkExisting = async existing => {
          const updates = { status: 'interested', application_key: responseKey, updated_at: new Date().toISOString() };
          if (summary) Object.assign(updates, { name, realm, realm_slug: realmSlug, lookup: summary });
          const { data, error } = await supabase
            .from('recruits')
            .update(updates)
            .eq('id', existing.id).eq('team_id', teamId)
            .select(RECRUIT_FIELDS).single();
          if (error) throw error;
          return data;
        };

        // The spec they applied as beats Raider.io's, which is just whatever
        // spec they last logged out in.
        const cls         = summary?.class || app.class || null;
        const { game } = await teamInfo();
        const appliedSpec = parseSpec(app.classSpec, cls, game);

        let recruit = null, linked = false;
        const existing = await findExisting(name, realmSlug)
          || (summary?.renamedFrom ? await findExisting(typedName, slugifyServer(typedRealm)) : null);
        if (existing) {
          recruit = await linkExisting(existing);
          linked = true;
        } else {
          const { data, error } = await supabase
            .from('recruits')
            .insert({
              team_id:         teamId,
              name,
              realm,
              realm_slug:      realmSlug,
              class:           cls,
              spec:            appliedSpec || summary?.spec || null,
              role:            (appliedSpec && roleForSpec(cls, appliedSpec, game)) || summary?.role || null,
              source:          'application',
              application_key: responseKey,
              contacted_at:    app.submittedDate || new Date().toISOString().slice(0, 10),
              channel:         'form',
              status:          'interested',
              lookup:          summary,
              created_by:      session.id,
            })
            .select(RECRUIT_FIELDS).single();
          if (error && error.code === '23505') {
            // Someone added them as an outreach recruit a moment ago.
            recruit = await linkExisting(await findExisting(name, realmSlug));
            linked = true;
          } else if (error) {
            throw error;
          } else {
            recruit = data;
          }
        }

        await supabase.from('application_reviews').update({ recruit_id: recruit.id }).eq('id', review.id);
        return res.status(200).json({ recruit, linked });
      } catch (err) {
        // Put the application back to pending rather than leaving it
        // "promoted" with no recruit behind it.
        await supabase.from('application_reviews').delete().eq('id', review.id);
        throw err;
      }
    }

    // Reject, or Resolve ("handled outside RaidLead" -- already on the
    // roster, or long gone -- with no recruit created and nobody rejected).
    // Takes one responseKey or a responseKeys array for bulk selection;
    // applications that already have a decision are skipped, not failed.
    if (action === 'rejectApplication' || action === 'resolveApplications') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const keys = requestedKeys(req.body);
      if (keys.length === 0) return res.status(400).json({ error: 'responseKey or responseKeys required' });
      const decision = action === 'rejectApplication' ? 'rejected' : 'resolved';
      const note = decision === 'rejected' ? (String(req.body?.note || '').trim().slice(0, 500) || null) : null;

      const { data, error } = await supabase.from('application_reviews')
        .upsert(
          keys.map(k => ({ team_id: teamId, response_key: k, decision, reject_note: note, decided_by: session.id })),
          { onConflict: 'team_id,response_key', ignoreDuplicates: true })
        .select('response_key');
      if (error) throw error;
      const decided = (data || []).map(r => r.response_key);
      if (keys.length === 1 && decided.length === 0) {
        return res.status(409).json({ error: 'This application already has a decision.' });
      }
      return res.status(200).json({ decided, skipped: keys.filter(k => !decided.includes(k)) });
    }

    // Undo a Reject or Resolve (back to "Needs decision"). A promoted
    // applicant is a recruit now, and is managed from the Recruits list.
    if (action === 'undoApplicationDecision') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const [key] = requestedKeys(req.body);
      if (!key) return res.status(400).json({ error: 'responseKey required' });
      const { error } = await supabase.from('application_reviews').delete()
        .eq('team_id', teamId).eq('response_key', key).in('decision', ['rejected', 'resolved']);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ══ NEXT SEASON SURVEY ══
    // Raiders answer on-site; officers build the survey and read the results.

    // ── GET SURVEY (any raider): this team's open survey, if any, plus the
    // caller's own answers so they can edit them. Viewers aren't raiders,
    // so they never get asked. ──
    if (action === 'getSurvey') {
      if (myRole === 'viewer') return res.status(200).json({ survey: null, response: null });
      const survey = await openSurvey();
      if (!survey) return res.status(200).json({ survey: null, response: null });
      const { data: response, error } = await supabase
        .from('season_survey_responses').select(SURVEY_RESPONSE_FIELDS)
        .eq('survey_id', survey.id).eq('account_id', session.id).maybeSingle();
      if (error) throw error;
      return res.status(200).json({ survey: publicSurvey(survey), response: upgradeResponse(response) || null });
    }

    // ── SUBMIT SURVEY RESPONSE (any raider): one per account, editable
    // until the survey closes. ──
    if (action === 'submitSurveyResponse') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (myRole === 'viewer') return res.status(403).json({ error: "Viewers don't answer the season survey." });
      const b = req.body || {};
      const survey = await openSurvey();
      if (!survey || survey.id !== b.surveyId) {
        return res.status(409).json({ error: 'This survey has closed. Refresh to see if there\'s a new one.' });
      }

      // Their pick must be a roster character this account has claimed.
      let character = null;
      if (b.characterId) {
        const { data } = await supabase
          .from('characters').select('id, name')
          .eq('id', b.characterId).eq('team_id', teamId).eq('account_id', session.id).eq('active', true)
          .maybeSingle();
        if (!data) return res.status(400).json({ error: "That character isn't one you've claimed on this team." });
        character = data;
      }

      const fields = normalizeSurveyResponse(b, survey, character, (await teamInfo()).game);
      const now = new Date().toISOString();
      const { data: existing } = await supabase
        .from('season_survey_responses').select('id')
        .eq('survey_id', survey.id).eq('account_id', session.id).maybeSingle();
      const write = existing
        ? supabase.from('season_survey_responses').update({ ...fields, updated_at: now }).eq('id', existing.id)
        : supabase.from('season_survey_responses').insert({ ...fields, survey_id: survey.id, team_id: teamId, account_id: session.id });
      let { data, error } = await write.select(SURVEY_RESPONSE_FIELDS).single();
      if (error && error.code === '23505') {
        // Double-submitted from two tabs at once -- the other one won; update it.
        ({ data, error } = await supabase.from('season_survey_responses').update({ ...fields, updated_at: now })
          .eq('survey_id', survey.id).eq('account_id', session.id).select(SURVEY_RESPONSE_FIELDS).single());
      }
      if (error) throw error;
      await placeSurveyResponse(supabase, teamId, survey, { ...data, account_id: session.id });
      return res.status(200).json({ response: upgradeResponse(data) });
    }

    // ── SURVEY PROMPT (officers): "the season is ending -- survey your
    // raiders?" From 6 weeks before the current raid tier's announced end
    // until 2 weeks after the next starts (Raider.io's per-region dates),
    // unless this team has already opened a survey in that stretch. ──
    if (action === 'getSurveyPrompt') {
      const now = Date.now();
      const { region, game } = await teamInfo();
      const prompt = game.sources.raiderio?.calendar
        ? surveyPromptFor(seasonTransitionFrom(await fetchRaidCalendar(region), now), now)
        : null;
      if (!prompt) return res.status(200).json({ prompt: null });
      const { data: latest, error } = await supabase
        .from('season_surveys').select('opened_at, closed_at')
        .eq('team_id', teamId).order('opened_at', { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      if (latest && (!latest.closed_at || Date.parse(latest.opened_at) >= prompt.windowStart)) {
        return res.status(200).json({ prompt: null });
      }
      const { windowStart, ...rest } = prompt;
      return res.status(200).json({ prompt: rest });
    }

    // ── LIST SURVEYS (officers): every survey this team has run, newest first. ──
    if (action === 'listSurveys') {
      const { data, error } = await supabase
        .from('season_surveys').select(SURVEY_FIELDS)
        .eq('team_id', teamId).order('opened_at', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ surveys: (data || []).map(upgradedSurvey) });
    }

    // ── SURVEY RESULTS (officers): one survey and every response to it. ──
    if (action === 'getSurveyResults') {
      const { surveyId } = req.body || {};
      if (!surveyId) return res.status(400).json({ error: 'surveyId required' });
      const { data: survey, error: surveyErr } = await supabase
        .from('season_surveys').select(SURVEY_FIELDS).eq('id', surveyId).eq('team_id', teamId).maybeSingle();
      if (surveyErr) throw surveyErr;
      if (!survey) return res.status(404).json({ error: 'Survey not found' });
      const { data: responses, error } = await supabase
        .from('season_survey_responses')
        .select(`${SURVEY_RESPONSE_FIELDS}, account_id, account:accounts ( battletag, display_name )`)
        .eq('survey_id', surveyId).order('submitted_at', { ascending: true });
      if (error) throw error;
      return res.status(200).json({ survey: upgradedSurvey(survey), responses: (responses || []).map(upgradeResponse) });
    }

    // ── OPEN SURVEY (officers): creates a new survey, open right away. ──
    if (action === 'openSurvey') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const def = normalizeSurveyDefinition(req.body);
      const { data, error } = await supabase
        .from('season_surveys')
        .insert({ team_id: teamId, ...def, created_by: session.id })
        .select(SURVEY_FIELDS).single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'This team already has an open survey. Close it first.' });
        throw error;
      }
      // A new survey starts this season's Join Order, filled as raiders answer.
      try { await createSurveyList(supabase, teamId, data); } catch (e) { /* built on first use instead */ }
      return res.status(200).json({ survey: upgradedSurvey(data) });
    }

    // ── UPDATE SURVEY (officers): title, intro, and questions. Answers are
    // keyed by question id, so rewording keeps them; a removed question's
    // answers just stop being shown. ──
    if (action === 'updateSurvey') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { surveyId } = req.body || {};
      if (!surveyId) return res.status(400).json({ error: 'surveyId required' });
      const def = normalizeSurveyDefinition(req.body);
      const { data, error } = await supabase
        .from('season_surveys').update({ ...def, updated_at: new Date().toISOString() })
        .eq('id', surveyId).eq('team_id', teamId)
        .select(SURVEY_FIELDS).single();
      if (error) throw error;
      return res.status(200).json({ survey: upgradedSurvey(data) });
    }

    // ── CLOSE / REOPEN SURVEY (officers). Reopening fails if another
    // survey has been opened since (one open survey per team). ──
    if (action === 'closeSurvey' || action === 'reopenSurvey') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { surveyId } = req.body || {};
      if (!surveyId) return res.status(400).json({ error: 'surveyId required' });
      const closedAt = action === 'closeSurvey' ? new Date().toISOString() : null;
      const { data, error } = await supabase
        .from('season_surveys').update({ closed_at: closedAt, updated_at: new Date().toISOString() })
        .eq('id', surveyId).eq('team_id', teamId)
        .select(SURVEY_FIELDS).single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'Another survey is open. Close it before reopening this one.' });
        throw error;
      }
      return res.status(200).json({ survey: upgradedSurvey(data) });
    }

    // ── DELETE SURVEY (officers): the survey and all its responses. ──
    if (action === 'deleteSurvey') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { surveyId } = req.body || {};
      if (!surveyId) return res.status(400).json({ error: 'surveyId required' });
      const { error } = await supabase.from('season_surveys').delete().eq('id', surveyId).eq('team_id', teamId);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ══ JOIN ORDER (officers) ══
    // The order raiders joined this season -- #31 is next in when someone in
    // the first 30 (Heroic's cap) is missing. See lib/joinOrder.js.

    // ── GET JOIN ORDER: an order (the current one unless listId is given)
    // with all its entries, plus every order for the history dropdown. ──
    if (action === 'getJoinOrder') {
      const { listId } = req.body || {};
      const current = await currentJoinOrder(supabase, teamId);
      const { data: lists, error } = await supabase
        .from('join_orders').select(JOIN_LIST_FIELDS).eq('team_id', teamId).order('created_at', { ascending: false });
      if (error) throw error;
      const list = listId ? (lists || []).find(l => l.id === listId) : current;
      if (listId && !list) return res.status(404).json({ error: 'That order no longer exists.' });
      return res.status(200).json({
        lists: lists || [], currentId: current?.id || null, list: list || null,
        entries: list ? await listJoinEntries(supabase, list.id) : [],
      });
    }

    // ── START JOIN ORDER: for teams with no order yet (no survey run):
    // every roster Main, in the order they were added to RaidLead, for the
    // officer to rearrange. ──
    if (action === 'startJoinOrder') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (await currentJoinOrder(supabase, teamId)) return res.status(409).json({ error: 'This team already has a Join Order.' });
      const { data: chars, error: charsErr } = await supabase
        .from('characters').select('id, name, account_id, rank, created_at').eq('team_id', teamId).eq('active', true);
      if (charsErr) throw charsErr;
      const mains = (chars || []).filter(c => (c.rank || 'Main') === 'Main')
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.name.localeCompare(b.name));
      const { data: list, error } = await supabase
        .from('join_orders').insert({ team_id: teamId, title: 'Starting order' }).select(JOIN_LIST_FIELDS).single();
      if (error) throw error;
      await appendToJoinOrder(supabase, teamId, mains, 'manual', { throwErrors: true, listId: list.id });
      return res.status(200).json({ list, entries: await listJoinEntries(supabase, list.id) });
    }

    // Only the current order can be changed; past seasons are history.
    async function editableJoinOrder(listId) {
      const current = await currentJoinOrder(supabase, teamId);
      if (!current || current.id !== listId) {
        throw Object.assign(new Error("Only this season's order can be changed. Refresh to see it."), { status: 409 });
      }
      return current;
    }

    // ── SAVE JOIN ORDER: the officer's rearranged order, as the ids of
    // every entry still in it, top to bottom. ──
    if (action === 'saveJoinOrder') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { listId, order } = req.body || {};
      if (!listId || !Array.isArray(order)) return res.status(400).json({ error: 'listId and order required' });
      await editableJoinOrder(listId);
      const entries = await listJoinEntries(supabase, listId);
      const active = entries.filter(e => !e.left_at);
      const activeIds = new Set(active.map(e => e.id));
      const ids = [...new Set(order)].filter(id => activeIds.has(id));
      if (ids.length !== active.length) {
        return res.status(409).json({ error: 'The order changed while you were editing it (someone answered the survey or joined the roster). Refresh and try again.' });
      }
      const byId = new Map(active.map(e => [e.id, e]));
      await Promise.all(ids.map((id, i) => (byId.get(id).position === i + 1 ? null
        : supabase.from('join_order_entries').update({ position: i + 1 }).eq('id', id).eq('join_order_id', listId))));
      return res.status(200).json({ entries: await listJoinEntries(supabase, listId) });
    }

    // ── ADD TO JOIN ORDER: roster characters, to the end, in the order given. ──
    if (action === 'addJoinOrderEntries') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { listId, characterIds } = req.body || {};
      if (!listId || !Array.isArray(characterIds) || !characterIds.length) return res.status(400).json({ error: 'listId and characterIds required' });
      await editableJoinOrder(listId);
      const { data: chars, error } = await supabase
        .from('characters').select('id, name, account_id').eq('team_id', teamId).eq('active', true).in('id', characterIds.slice(0, 200));
      if (error) throw error;
      const ordered = characterIds.map(id => (chars || []).find(c => c.id === id)).filter(Boolean);
      const added = await appendToJoinOrder(supabase, teamId, ordered, 'manual', { throwErrors: true, listId });
      return res.status(200).json({ added, entries: await listJoinEntries(supabase, listId) });
    }

    // ── REMOVE FROM / RESTORE TO JOIN ORDER: taking someone out keeps their
    // row (history); restoring puts them back at the end. ──
    if (action === 'removeJoinOrderEntry' || action === 'restoreJoinOrderEntry') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { entryId } = req.body || {};
      if (!entryId) return res.status(400).json({ error: 'entryId required' });
      const { data: entry, error } = await supabase
        .from('join_order_entries').select('id, join_order_id').eq('id', entryId).eq('team_id', teamId).maybeSingle();
      if (error) throw error;
      if (!entry) return res.status(404).json({ error: 'Not found' });
      await editableJoinOrder(entry.join_order_id);
      let updates;
      if (action === 'removeJoinOrderEntry') {
        updates = { left_at: new Date().toISOString(), left_reason: 'Taken out by an officer' };
      } else {
        const active = (await listJoinEntries(supabase, entry.join_order_id)).filter(e => !e.left_at);
        updates = { left_at: null, left_reason: null, position: (active.length ? active[active.length - 1].position : 0) + 1 };
      }
      const { error: updErr } = await supabase.from('join_order_entries').update(updates).eq('id', entryId);
      if (updErr) throw updErr;
      return res.status(200).json({ entries: await listJoinEntries(supabase, entry.join_order_id) });
    }

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
};
