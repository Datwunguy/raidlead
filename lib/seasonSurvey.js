// ============================================================
//  lib/seasonSurvey.js — the Next Season survey's rules: cleaning up an
//  officer's survey definition before it's saved, and checking a raider's
//  answers against the survey they're answering. Pure functions (no DB),
//  used by api/recruiting.js.
// ============================================================
const crypto = require('crypto');
const { CLASS_SPECS, canonicalSpec, roleForSpec } = require('./wowSpecs');

const STATUSES   = ['returning', 'unsure', 'not_returning'];
const FLEX_ROLES = ['tank', 'heal', 'melee', 'ranged'];
const WEEKDAYS   = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MAX_SPEC_CHOICES = 3;

const LIMITS = {
  title: 120, intro: 4000,
  acknowledgements: 10, ackPrompt: 4000, ackLabel: 120,
  availabilityPrompt: 1000,
  extraQuestions: 10, extraPrompt: 1000,
  characterName: 40, answer: 2000, comments: 2000,
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const text = (v, max) => String(v ?? '').trim().slice(0, max);
const newId = () => crypto.randomBytes(4).toString('hex');

// Officer-edited definition -> what's stored. Keeps each question's id (so
// editing wording after people have answered doesn't orphan their answers)
// and gives new questions one.
function normalizeSurveyDefinition(input) {
  const title = text(input?.title, LIMITS.title);
  if (!title) throw badRequest('Give the survey a title.');
  const intro = text(input?.intro, LIMITS.intro) || null;
  const q = input?.questions || {};

  const rawAcks = Array.isArray(q.acknowledgements) ? q.acknowledgements : [];
  if (rawAcks.length > LIMITS.acknowledgements) throw badRequest(`At most ${LIMITS.acknowledgements} acknowledgements.`);
  const acknowledgements = rawAcks.map(a => ({
    id:             /^[a-z0-9]{1,16}$/.test(a?.id || '') ? a.id : newId(),
    prompt:         text(a?.prompt, LIMITS.ackPrompt),
    agreeLabel:     text(a?.agreeLabel, LIMITS.ackLabel) || 'Yes',
    exceptionLabel: text(a?.exceptionLabel, LIMITS.ackLabel),
  })).filter(a => a.prompt);
  for (const a of acknowledgements) {
    if (!a.exceptionLabel) throw badRequest('Every acknowledgement needs an answer for people who can\'t agree.');
  }

  let availability = null;
  if (q.availability && Array.isArray(q.availability.days)) {
    const days = WEEKDAYS.filter(d => q.availability.days.includes(d));
    if (days.length) availability = { prompt: text(q.availability.prompt, LIMITS.availabilityPrompt) || 'Which days would work for you?', days };
  }

  const rawExtra = Array.isArray(q.extraQuestions) ? q.extraQuestions : [];
  if (rawExtra.length > LIMITS.extraQuestions) throw badRequest(`At most ${LIMITS.extraQuestions} extra questions.`);
  const extraQuestions = rawExtra.map(e => ({
    id:     /^[a-z0-9]{1,16}$/.test(e?.id || '') ? e.id : newId(),
    prompt: text(e?.prompt, LIMITS.extraPrompt),
  })).filter(e => e.prompt);

  // Ids must be unique across both lists (answers are keyed by them).
  const seen = new Set();
  for (const item of [...acknowledgements, ...extraQuestions]) {
    while (seen.has(item.id)) item.id = newId();
    seen.add(item.id);
  }
  return { title, intro, questions: { acknowledgements, availability, extraQuestions } };
}

// "Shaman|Restoration" or { class, spec } -> { class, spec, role }, or null.
function parseSpecChoice(v) {
  const [cls, spec] = typeof v === 'string' ? v.split('|') : [v?.class, v?.spec];
  const clsKey = String(cls || '').toLowerCase();
  if (!CLASS_SPECS[clsKey]) return null;
  const canonical = canonicalSpec(clsKey, spec);
  return canonical ? { class: clsKey, spec: canonical, role: roleForSpec(clsKey, canonical) } : null;
}

// A raider's submission -> the columns to save (minus survey/team/account
// ids, which the caller adds). `character` is the claimed roster character
// they picked, already verified by the caller -- or null, in which case a
// typed characterName is required (officers who haven't claimed one).
function normalizeSurveyResponse(body, survey, character) {
  const b = body || {};
  const status = b.status;
  if (!STATUSES.includes(status)) throw badRequest('Let us know whether you\'re returning.');

  const characterName = character ? character.name : text(b.characterName, LIMITS.characterName);
  if (!characterName) throw badRequest('Which character is this for?');

  const row = {
    character_id:     character ? character.id : null,
    character_name:   characterName,
    status,
    spec_choices:     [],
    flex_roles:       [],
    availability:     [],
    acknowledgements: {},
    answers:          {},
    comments:         text(b.comments, LIMITS.comments) || null,
  };
  // Not coming back: nothing else to ask.
  if (status === 'not_returning') return row;

  const q = survey.questions || {};
  const choices = [];
  for (const raw of (Array.isArray(b.specChoices) ? b.specChoices : []).slice(0, MAX_SPEC_CHOICES)) {
    if (raw == null || raw === '') continue;
    const choice = parseSpecChoice(raw);
    if (!choice) throw badRequest('One of your spec choices isn\'t a real class and spec.');
    if (!choices.some(c => c.class === choice.class && c.spec === choice.spec)) choices.push(choice);
  }
  if (choices.length === 0) throw badRequest('Pick your first-choice class and spec.');
  row.spec_choices = choices;

  row.flex_roles = FLEX_ROLES.filter(r => (b.flexRoles || []).includes(r));
  const days = q.availability?.days || [];
  row.availability = days.filter(d => (b.availability || []).includes(d));

  for (const a of q.acknowledgements || []) {
    const answer = b.acknowledgements?.[a.id];
    if (answer !== 'agree' && answer !== 'exception') throw badRequest('Answer every acknowledgement question.');
    row.acknowledgements[a.id] = answer;
  }
  for (const e of q.extraQuestions || []) {
    const answer = text(b.answers?.[e.id], LIMITS.answer);
    if (answer) row.answers[e.id] = answer;
  }
  return row;
}

module.exports = {
  STATUSES, FLEX_ROLES, WEEKDAYS, MAX_SPEC_CHOICES,
  normalizeSurveyDefinition, normalizeSurveyResponse, parseSpecChoice,
};
