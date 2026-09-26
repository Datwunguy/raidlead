// ============================================================
//  recruiting.js — Team Management tab (officers only)
//  Actions: listRecruits, addRecruit, updateRecruit, deleteRecruit,
//           lookupCharacter, saveRecruitScores,
//           listTemplates, saveTemplate, deleteTemplate
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

const STATUSES     = ['contacted', 'replied', 'interested', 'applied', 'trial', 'joined', 'declined', 'no_response'];
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

    return res.status(400).json({ error: 'Invalid action' });
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
};
