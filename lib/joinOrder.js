// ============================================================
//  lib/joinOrder.js — Join Order: the order raiders joined the team this
//  season (see sql/2026_09_join_order.sql). Shared by api/recruiting.js
//  (the survey and the officer's Join Order tab), api/roster.js (adding and
//  removing characters), and api/wowaudit.js (roster imports).
//
//  The hooks from other features (survey answers, roster changes) are
//  best-effort: they never throw, so a Join Order hiccup can't fail saving
//  a survey answer or adding a character.
// ============================================================

const LIST_FIELDS  = 'id, team_id, survey_id, title, created_at';
const ENTRY_FIELDS = 'id, join_order_id, character_id, account_id, character_name, position, joined_at, source, survey_status, left_at, left_reason';

const byPosition = (a, b) => a.position - b.position || String(a.joined_at).localeCompare(String(b.joined_at));

async function listEntries(supabase, listId) {
  const { data, error } = await supabase.from('join_order_entries').select(ENTRY_FIELDS).eq('join_order_id', listId);
  if (error) throw error;
  return (data || []).sort(byPosition);
}

// The entry for this raider, matched by character, or by account (so a
// raider who answers the survey on an alt still has just the one spot).
function findEntry(entries, { characterId, accountId }) {
  return entries.find(e => characterId && e.character_id === characterId)
    || entries.find(e => accountId && e.account_id === accountId)
    || null;
}

const nextPosition = active => (active.length ? active[active.length - 1].position : 0) + 1;

// A fresh order for a survey, filled from whatever answers it already has:
// Returning in the order they finished, then Not sure in the order they
// finished. (Not returning aren't numbered.)
async function createSurveyList(supabase, teamId, survey) {
  const { data: created, error } = await supabase
    .from('join_orders').insert({ team_id: teamId, survey_id: survey.id, title: survey.title })
    .select(LIST_FIELDS).single();
  if (error) {
    if (error.code !== '23505') throw error;
    // Created a moment ago by another request -- use that one.
    const { data: existing } = await supabase.from('join_orders').select(LIST_FIELDS).eq('survey_id', survey.id).maybeSingle();
    return existing;
  }
  const { data: responses } = await supabase
    .from('season_survey_responses').select('account_id, character_id, character_name, status, submitted_at')
    .eq('survey_id', survey.id);
  const bySubmitted = (a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at));
  const ordered = [
    ...(responses || []).filter(r => r.status === 'returning').sort(bySubmitted),
    ...(responses || []).filter(r => r.status === 'unsure').sort(bySubmitted),
  ];
  if (ordered.length) {
    const { error: insertErr } = await supabase.from('join_order_entries').insert(ordered.map((r, i) => ({
      join_order_id: created.id, team_id: teamId, character_id: r.character_id || null, account_id: r.account_id || null,
      character_name: r.character_name, position: i + 1, joined_at: r.submitted_at, source: 'survey', survey_status: r.status,
    })));
    if (insertErr) throw insertErr;
  }
  return created;
}

// The team's current order: its newest one -- unless its newest survey is
// newer still and has no order yet (a survey opened before Join Order
// existed), in which case that survey's order is built now. null when the
// team has neither (a new setup: the officer can start one from the roster).
async function currentJoinOrder(supabase, teamId) {
  const [{ data: list }, { data: survey }] = await Promise.all([
    supabase.from('join_orders').select(LIST_FIELDS).eq('team_id', teamId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('season_surveys').select('id, title, opened_at').eq('team_id', teamId).order('opened_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (survey && (!list || (list.survey_id !== survey.id && Date.parse(survey.opened_at) > Date.parse(list.created_at)))) {
    const { data: own } = await supabase.from('join_orders').select(LIST_FIELDS).eq('survey_id', survey.id).maybeSingle();
    return own || createSurveyList(supabase, teamId, survey);
  }
  return list || null;
}

// A survey answer (new or edited). Returning goes at the end of the
// Returning group -- ahead of anyone Not sure -- and Not sure goes at the
// end. Someone already numbered keeps their spot (officers can move them);
// switching to Not returning takes them out of the order.
async function placeSurveyResponse(supabase, teamId, survey, response) {
  try {
    const current = await currentJoinOrder(supabase, teamId);
    if (!current || current.survey_id !== survey.id) return; // an older survey that isn't this season's
    const entries = await listEntries(supabase, current.id);
    const mine = findEntry(entries, { characterId: response.character_id, accountId: response.account_id });
    const now = new Date().toISOString();

    if (response.status === 'not_returning') {
      if (mine && !mine.left_at) {
        await supabase.from('join_order_entries').update({ left_at: now, left_reason: 'Answered Not returning' }).eq('id', mine.id);
      }
      return;
    }
    if (mine && !mine.left_at) {
      if (mine.source === 'survey' && mine.survey_status !== response.status) {
        await supabase.from('join_order_entries').update({ survey_status: response.status }).eq('id', mine.id);
      }
      return;
    }

    const active = entries.filter(e => !e.left_at);
    let position = null;
    if (response.status === 'returning') {
      const firstUnsure = active.findIndex(e => e.source === 'survey' && e.survey_status === 'unsure');
      if (firstUnsure === 0) position = active[0].position - 1;
      else if (firstUnsure > 0) position = (active[firstUnsure - 1].position + active[firstUnsure].position) / 2;
    }
    if (position == null) position = nextPosition(active);

    const fields = {
      character_id: response.character_id || mine?.character_id || null, account_id: response.account_id || null,
      character_name: response.character_name, position, source: 'survey', survey_status: response.status,
      left_at: null, left_reason: null,
    };
    if (mine) {
      await supabase.from('join_order_entries').update({ ...fields, joined_at: now }).eq('id', mine.id);
    } else {
      await supabase.from('join_order_entries').insert({ ...fields, join_order_id: current.id, team_id: teamId, joined_at: response.submitted_at || now });
    }
  } catch (e) { /* best-effort */ }
}

// Adds characters to the end of the current order (skipping anyone already
// in it). No-op when the team hasn't started an order yet. Returns how many
// were added. `throwErrors` is for the officer's own "add" buttons.
async function appendToJoinOrder(supabase, teamId, characters, source, { throwErrors = false, listId = null } = {}) {
  try {
    const list = listId ? { id: listId } : await currentJoinOrder(supabase, teamId);
    if (!list || !characters.length) return 0;
    const entries = await listEntries(supabase, list.id);
    const active = entries.filter(e => !e.left_at);
    let position = nextPosition(active);
    const now = new Date().toISOString();
    let added = 0;
    for (const c of characters) {
      const mine = findEntry(entries, { characterId: c.id, accountId: c.account_id });
      if (mine && !mine.left_at) continue;
      const fields = { character_id: c.id, character_name: c.name, position, source, survey_status: null, left_at: null, left_reason: null, joined_at: now };
      const { error } = mine
        ? await supabase.from('join_order_entries').update(fields).eq('id', mine.id)
        : await supabase.from('join_order_entries').insert({ ...fields, join_order_id: list.id, team_id: teamId, account_id: c.account_id || null });
      if (error) throw error;
      if (!mine) entries.push({ character_id: c.id, account_id: c.account_id });
      position += 1;
      added += 1;
    }
    return added;
  } catch (e) {
    if (throwErrors) throw e;
    return 0;
  }
}

// Takes a character out of the current order, keeping the row as history.
async function markLeftJoinOrder(supabase, teamId, characterId, reason) {
  try {
    const list = await currentJoinOrder(supabase, teamId);
    if (!list) return;
    await supabase.from('join_order_entries')
      .update({ left_at: new Date().toISOString(), left_reason: reason })
      .eq('join_order_id', list.id).eq('character_id', characterId).is('left_at', null);
  } catch (e) { /* best-effort */ }
}

module.exports = {
  LIST_FIELDS, ENTRY_FIELDS, listEntries, currentJoinOrder, createSurveyList,
  placeSurveyResponse, appendToJoinOrder, markLeftJoinOrder,
};
