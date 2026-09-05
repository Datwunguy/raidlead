// ============================================================
//  plans.js — handles raid plan actions
//  Actions: save, get
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('./lib/session');

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data: membership } = await supabase
    .from('guild_members')
    .select('role, guild_id')
    .eq('account_id', session.id)
    .single();

  const isOfficer = ['owner', 'officer'].includes(membership?.role);
  const myGuildId = membership?.guild_id || null;

  // Helper: verify a teamId belongs to the caller's guild
  async function assertTeamOwnership(teamId) {
    if (!teamId) throw Object.assign(new Error('teamId required'), { status: 400 });
    const { data: team } = await supabase
      .from('teams')
      .select('id')
      .eq('id', teamId)
      .eq('guild_id', myGuildId)
      .single();
    if (!team) throw Object.assign(new Error('Team does not belong to your guild'), { status: 403 });
  }

  // ── SAVE: save or publish a raid plan ──
  if (action === 'save') {
    if (!isOfficer) return res.status(403).json({ error: 'Officers only' });
    const { teamId, selectedPlayers, publish, planName, raidDate } = req.body;

    try {
      await assertTeamOwnership(teamId);

      // Find existing plan for this specific raid date (or any plan if no date specified)
      let existingQuery = supabase
        .from('raid_plans')
        .select('id')
        .eq('team_id', teamId);
      if (raidDate) {
        existingQuery = existingQuery.eq('raid_date', raidDate);
      } else {
        existingQuery = existingQuery.order('updated_at', { ascending: false }).limit(1);
      }
      const { data: existingRows } = await existingQuery;
      const existing = existingRows?.[0] || null;

      let plan;
      if (existing) {
        const { data: updated, error: ue } = await supabase
          .from('raid_plans')
          .update({
            name:       planName || 'Raid Night',
            published:  publish  || false,
            raid_date:  raidDate || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id)
          .select()
          .single();
        if (ue) throw ue;
        plan = updated;
      } else {
        const { data: created, error: ce } = await supabase
          .from('raid_plans')
          .insert({
            team_id:    teamId,
            name:       planName || 'Raid Night',
            published:  publish  || false,
            raid_date:  raidDate || null,
            created_by: session.id,
          })
          .select()
          .single();
        if (ce) throw ce;
        plan = created;
      }

      // Delete existing members for this plan
      const { error: deleteError } = await supabase
        .from('raid_plan_members')
        .delete()
        .eq('plan_id', plan.id);
      if (deleteError) {
        console.error('[plans] delete error:', deleteError.message);
        throw deleteError;
      }

      if (selectedPlayers?.length > 0) {
        // selectedPlayers may be array of names, or array of player objects from the planner.
        // Deduplicate by name — same player can't appear twice
        const seen = new Set();
        const playerRecords = selectedPlayers
          .map(p => typeof p === 'string' ? { name: p } : p)
          .filter(p => {
            if (!p?.name || seen.has(p.name)) return false;
            seen.add(p.name);
            return true;
          });
        const playerNames = playerRecords.map(p => p.name);
        const flexRoles   = {};
        playerRecords.forEach(p => { flexRoles[p.name] = p.flexRole || 'primary'; });

        // Characters are managed by roster sync — no upsert needed here

        const { data: chars, error: charsError } = await supabase
          .from('characters')
          .select('id, name')
          .eq('team_id', teamId)
          .in('name', playerNames);
        if (charsError) throw charsError;

        if (chars?.length > 0) {
          // Deduplicate by name first (characters table may have duplicate name rows)
          // then by id — take only the first character row per name
          const seenNames = new Set();
          const seenIds   = new Set();
          const insertRows = [];
          for (const c of chars) {
            if (seenNames.has(c.name) || seenIds.has(c.id)) continue;
            seenNames.add(c.name);
            seenIds.add(c.id);
            insertRows.push({
              plan_id:       plan.id,
              character_id:  c.id,
              assigned_role: flexRoles[c.name] || 'primary',
            });
          }
          console.log('[plans] inserting', insertRows.length, 'members from', chars.length, 'chars, publish:', publish);
          const { error: insertError } = await supabase
            .from('raid_plan_members')
            .insert(insertRows);
          if (insertError) {
            console.error('[plans] insert error:', insertError.message, insertError.details);
            throw insertError;
          }
        } else {
          console.log('[plans] no characters found for names:', playerNames);
        }
      }

      return res.status(200).json({ success: true, plan, published: publish });
    } catch (err) {
      console.error('plans save error:', err);
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  // ── GET: return raid plan for a specific date (or most recent if no date given) ──
  if (action === 'get') {
    const teamId  = req.query.teamId  || req.body?.teamId;
    const raidDate = req.query.raidDate || req.body?.raidDate || null;
    if (!teamId) return res.status(200).json({ plan: null, isOfficer });

    try {
      await assertTeamOwnership(teamId);

      let query = supabase
        .from('raid_plans')
        .select(`id, name, published, updated_at, raid_date,
          raid_plan_members ( assigned_role, characters ( id, name, class, primary_role ) )`)
        .eq('team_id', teamId);

      if (raidDate) {
        // Fetch the plan for this specific date (published or draft)
        query = query.eq('raid_date', raidDate).limit(1);
      } else {
        // Fall back: most recently updated published plan
        query = query.eq('published', true).order('updated_at', { ascending: false }).limit(1);
      }

      const { data: plans } = await query;
      const plan = plans?.[0] || null;
      return res.status(200).json({ plan, isOfficer });
    } catch (err) {
      return res.status(200).json({ plan: null, isOfficer });
    }
  }

  // ── GET PREVIOUS: most recent saved plan strictly before a given date (officers only) ──
  if (action === 'getPrevious') {
    if (!isOfficer) return res.status(403).json({ error: 'Officers only' });
    const teamId    = req.query.teamId    || req.body?.teamId;
    const beforeDate = req.query.beforeDate || req.body?.beforeDate;
    if (!teamId) return res.status(200).json({ plan: null });

    try {
      await assertTeamOwnership(teamId);

      let query = supabase
        .from('raid_plans')
        .select(`id, name, published, updated_at, raid_date,
          raid_plan_members ( assigned_role, characters ( id, name, class, primary_role ) )`)
        .eq('team_id', teamId)
        .not('raid_date', 'is', null);

      if (beforeDate) query = query.lt('raid_date', beforeDate);
      query = query.order('raid_date', { ascending: false }).limit(1);

      const { data: plans } = await query;
      const plan = plans?.[0] || null;
      return res.status(200).json({ plan });
    } catch (err) {
      return res.status(200).json({ plan: null });
    }
  }

  res.status(400).json({ error: 'Invalid action' });
};