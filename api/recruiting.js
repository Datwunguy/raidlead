// ============================================================
//  recruiting.js — Team Management tab (officers only)
//  Actions: listRecruits, addRecruit, updateRecruit, deleteRecruit,
//           lookupCharacter, saveRecruitScores,
//           listTemplates, saveTemplate, deleteTemplate,
//           listApplications, getApplication, saveApplicationSheet,
//           saveApplicationColumnMap, promoteApplication,
//           rejectApplication, resolveApplications, undoApplicationDecision
//
//  This is the 12th and last serverless function the Vercel Hobby plan
//  allows -- future Team Management features (Applicants, Next Season) add
//  actions here rather than new files under api/.
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('../lib/session');
const { assertTeamMembership } = require('../lib/teamAuth');
const { slugifyServer } = require('../lib/serverSlug');
const { resolveCurrentRaidByDate } = require('../lib/raiderioRaids');
const { fetchCharacterSummary } = require('../lib/raiderioCharacter');
const { serviceAccountEmail, parseSheetUrl, readSheetTab } = require('../lib/googleSheets');
const { FIELDS: APPLICATION_FIELDS, detectColumnMap, mergeColumnMap, normalizeApplications } = require('../lib/applications');

const STATUSES     = ['contacted', 'no_response', 'not_interested', 'interested', 'joined']; // must match RECRUIT_STATUSES in app.js
const CHANNELS     = ['mail', 'whisper', 'discord', 'form', 'other'];
const ROLES        = ['tank', 'heal', 'melee', 'ranged'];
const DIFFICULTIES = ['lfr', 'normal', 'heroic', 'mythic'];

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

  try {
    // Everything in this file is officer-only -- recruiting notes and
    // outreach history aren't something regular members should see.
    await assertTeamMembership(supabase, session.id, teamId, { requireOfficer: true });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  async function teamRegion() {
    const { data } = await supabase.from('teams').select('guilds ( region )').eq('id', teamId).single();
    return data?.guilds?.region || 'us';
  }

  async function lookup(name, realm) {
    const region = await teamRegion();
    return fetchCharacterSummary(region, realm, name, await currentRaidSlug(region));
  }

  async function findExisting(name, realmSlug) {
    const { data } = await supabase
      .from('recruits').select(RECRUIT_FIELDS)
      .eq('team_id', teamId).ilike('name', name.trim()).eq('realm_slug', realmSlug)
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
      const [summary, existing] = await Promise.all([lookup(name, realm), findExisting(name, slugifyServer(realm))]);
      return res.status(200).json({ summary, existing });
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
        if (!isValidDate(b.contactedAt)) return res.status(400).json({ error: 'Invalid contacted date' });
        updates.contacted_at = b.contactedAt;
      }
      if (b.notes !== undefined) updates.notes = (b.notes || '').trim() || null;
      if (b.class !== undefined) updates.class = b.class ? String(b.class).toLowerCase() : null;
      if (b.spec  !== undefined) updates.spec  = b.spec || null;

      const { data, error } = await supabase
        .from('recruits').update(updates)
        .eq('id', b.recruitId).eq('team_id', teamId)
        .select(RECRUIT_FIELDS).single();
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
      if (!DIFFICULTIES.includes(difficulty)) return res.status(400).json({ error: 'Invalid difficulty' });
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
        const summary   = await lookup(typedName, typedRealm);
        const name      = summary?.name || typedName;
        const realm     = summary?.realmName || typedRealm;
        const realmSlug = slugifyServer(realm);

        const linkExisting = async existing => {
          const { data, error } = await supabase
            .from('recruits')
            .update({ status: 'interested', application_key: responseKey, updated_at: new Date().toISOString() })
            .eq('id', existing.id).eq('team_id', teamId)
            .select(RECRUIT_FIELDS).single();
          if (error) throw error;
          return data;
        };

        let recruit = null, linked = false;
        const existing = await findExisting(name, realmSlug);
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
              class:           summary?.class || app.class || null,
              spec:            summary?.spec || null,
              role:            summary?.role || null,
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

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
};
