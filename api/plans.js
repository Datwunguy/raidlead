// ============================================================
//  plans.js — handles raid plan actions
//  Actions: save, get, getPrevious, saveSwaps
// ============================================================
const { createClient } = require('@supabase/supabase-js');
const { getSession, setCommonHeaders } = require('./lib/session');
const { assertTeamMembership } = require('./lib/teamAuth');

module.exports = async (req, res) => {
  setCommonHeaders(res);

  const action  = req.query.action || req.body?.action;
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Helper: verify the caller belongs to teamId (optionally requiring officer/owner).
  async function assertTeamOwnership(teamId, opts) {
    return assertTeamMembership(supabase, session.id, teamId, opts);
  }

  // ── SAVE: save or publish a raid plan (officers only) ──
  if (action === 'save') {
    const { teamId, selectedPlayers, publish, planName, raidDate } = req.body;

    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

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
    if (!teamId) return res.status(200).json({ plan: null, isOfficer: false });

    try {
      const role = await assertTeamOwnership(teamId);
      const isOfficer = ['owner', 'officer'].includes(role);

      let query = supabase
        .from('raid_plans')
        .select(`id, name, published, updated_at, raid_date, swaps,
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
      if (plan) { try { plan.swaps = plan.swaps ? JSON.parse(plan.swaps) : []; } catch(e) { plan.swaps = []; } }
      return res.status(200).json({ plan, isOfficer });
    } catch (err) {
      return res.status(200).json({ plan: null, isOfficer: false });
    }
  }

  // ── GET PREVIOUS: most recent saved plan strictly before a given date (officers only) ──
  if (action === 'getPrevious') {
    const teamId    = req.query.teamId    || req.body?.teamId;
    const beforeDate = req.query.beforeDate || req.body?.beforeDate;
    if (!teamId) return res.status(200).json({ plan: null });

    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

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
      if (err.status) return res.status(err.status).json({ error: err.message });
      return res.status(200).json({ plan: null });
    }
  }

  // ── SAVE SWAPS: update the boss-by-boss OUT/IN swap list for an existing plan ──
  if (action === 'saveSwaps') {
    const { teamId, raidDate, swaps } = req.body || {};
    if (!teamId || !raidDate) return res.status(400).json({ error: 'teamId and raidDate required' });

    try {
      await assertTeamOwnership(teamId, { requireOfficer: true });

      const { data: existing } = await supabase
        .from('raid_plans')
        .select('id')
        .eq('team_id', teamId)
        .eq('raid_date', raidDate)
        .limit(1);
      const plan = existing?.[0];
      if (!plan) return res.status(404).json({ error: 'No raid plan exists for this date yet -- save or publish a roster first.' });

      const { error } = await supabase
        .from('raid_plans')
        .update({ swaps: JSON.stringify(swaps || []) })
        .eq('id', plan.id);
      if (error) throw error;

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'Invalid action' });
};