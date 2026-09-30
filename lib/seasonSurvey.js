// ============================================================
//  lib/seasonSurvey.js — the Next Season survey's rules: cleaning up an
//  officer's survey definition before it's saved, and checking a raider's
//  answers against the survey they're answering. Pure functions (no DB),
//  used by api/recruiting.js.
//
//  A survey's `questions` has two parts:
//    fixed: the questions every survey asks, because the results page is
//           built on them -- which character, returning or not, class/spec
//           choices -- plus flex roles and comments. Officers can reword
//           them, ask for 1-3 spec choices, and switch flex/comments off.
//    items: the officer's own questions, in order. Each has a type
//           (single = multiple choice, checkboxes, short, paragraph,
//           scale), required or not, and an audience: people returning or
//           unsure, people not returning, or everyone. A multiple-choice
//           answer can be marked `flag`, which flags whoever picks it.
//  Answers to items are keyed by item id (choice answers by option id), so
//  officers can reword questions after people have answered.
// ============================================================
const crypto = require('crypto');
const { specsFor, canonicalSpec, roleForSpec } = require('./wowSpecs');

const STATUSES       = ['returning', 'unsure', 'not_returning'];
const FLEX_ROLES     = ['tank', 'heal', 'melee', 'ranged'];
const WEEKDAYS       = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const QUESTION_TYPES = ['single', 'checkboxes', 'short', 'paragraph', 'scale'];
const AUDIENCES      = ['returning', 'everyone', 'not_returning']; // 'returning' = returning or unsure
const MAX_SPEC_CHOICES = 3;

const LIMITS = {
  title: 120, intro: 4000, fixedPrompt: 300, fixedHint: 500, statusLabel: 80,
  items: 25, itemPrompt: 4000, options: 20, optionLabel: 200, scaleLabel: 60,
  characterName: 40, short: 300, paragraph: 2000, comments: 2000,
};

// Must match SURVEY_FIXED_DEFAULTS in public/app.js.
const FIXED_DEFAULTS = {
  character: { prompt: 'Character' },
  returning: {
    prompt: 'Are you coming back next season?',
    labels: { returning: "Yes, I'm returning", unsure: 'Not sure yet', not_returning: "No, I'm not returning" },
  },
  specs: {
    count: 3,
    prompts: ['First choice class and spec', 'Second choice class and spec', 'Third choice class and spec'],
    hints: [
      '',
      "Optional. Only pick one you'd be happy to play if we asked. You don't need to list other specs of your class that fill the same role -- you can swap between those freely.",
      "Optional. Same idea: only if you'd be happy to play it.",
    ],
  },
  flex:     { enabled: true, prompt: 'Can you flex into another role?' },
  comments: { enabled: true, prompt: 'Any other feedback or comments?' },
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const text  = (v, max) => String(v ?? '').trim().slice(0, max);
const newId = () => crypto.randomBytes(4).toString('hex');
// Item ids / option ids: our random hex, or the fixed ones older surveys used
// ('availability', 'agree', 'exception', day names).
const validId = v => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(v) ? v : null);
const shortPrompt = p => `"${p.length > 60 ? p.slice(0, 57) + '...' : p}"`;

function normalizeFixed(input) {
  const f = input || {};
  const d = FIXED_DEFAULTS;
  const count = [1, 2, 3].includes(Number(f.specs?.count)) ? Number(f.specs.count) : d.specs.count;
  return {
    character: { prompt: text(f.character?.prompt, LIMITS.fixedPrompt) || d.character.prompt },
    returning: {
      prompt: text(f.returning?.prompt, LIMITS.fixedPrompt) || d.returning.prompt,
      labels: Object.fromEntries(STATUSES.map(s => [s, text(f.returning?.labels?.[s], LIMITS.statusLabel) || d.returning.labels[s]])),
    },
    specs: {
      count,
      prompts: [0, 1, 2].map(i => text(f.specs?.prompts?.[i], LIMITS.fixedPrompt) || d.specs.prompts[i]),
      hints:   [0, 1, 2].map(i => (f.specs?.hints?.[i] !== undefined ? text(f.specs.hints[i], LIMITS.fixedHint) : d.specs.hints[i])),
    },
    flex:     { enabled: f.flex?.enabled !== false,     prompt: text(f.flex?.prompt, LIMITS.fixedPrompt) || d.flex.prompt },
    comments: { enabled: f.comments?.enabled !== false, prompt: text(f.comments?.prompt, LIMITS.fixedPrompt) || d.comments.prompt },
  };
}

// One officer-written question -> stored form, or null if its text is blank.
function normalizeItem(raw) {
  const prompt = text(raw?.prompt, LIMITS.itemPrompt);
  if (!prompt) return null;
  const type = QUESTION_TYPES.includes(raw?.type) ? raw.type : 'paragraph';
  const item = {
    id:       validId(raw?.id) || newId(),
    type,
    prompt,
    required: !!raw?.required,
    audience: AUDIENCES.includes(raw?.audience) ? raw.audience : 'returning',
  };
  if (type === 'single' || type === 'checkboxes') {
    const seen = new Set();
    item.options = (Array.isArray(raw.options) ? raw.options : []).slice(0, LIMITS.options).map(o => {
      let id = validId(o?.id) || newId();
      while (seen.has(id)) id = newId();
      seen.add(id);
      const opt = { id, label: text(o?.label, LIMITS.optionLabel) };
      if (type === 'single' && o?.flag) opt.flag = true;
      return opt;
    }).filter(o => o.label);
    const min = type === 'single' ? 2 : 1;
    if (item.options.length < min) throw badRequest(`${shortPrompt(prompt)} needs at least ${min === 2 ? 'two answers' : 'one answer'} to pick from.`);
  }
  if (type === 'scale') {
    item.max       = Number(raw.max) === 10 ? 10 : 5;
    item.lowLabel  = text(raw.lowLabel, LIMITS.scaleLabel);
    item.highLabel = text(raw.highLabel, LIMITS.scaleLabel);
  }
  return item;
}

// Officer-edited definition -> what's stored. Keeps ids (so rewording after
// people have answered doesn't orphan their answers) and gives new ones.
function normalizeSurveyDefinition(input) {
  const title = text(input?.title, LIMITS.title);
  if (!title) throw badRequest('Give the survey a title.');
  const intro = text(input?.intro, LIMITS.intro) || null;
  const q = input?.questions || {};
  const rawItems = Array.isArray(q.items) ? q.items : [];
  if (rawItems.length > LIMITS.items) throw badRequest(`At most ${LIMITS.items} questions.`);
  const items = rawItems.map(normalizeItem).filter(Boolean);
  const seen = new Set();
  for (const item of items) {
    while (seen.has(item.id)) item.id = newId();
    seen.add(item.id);
  }
  return { title, intro, questions: { fixed: normalizeFixed(q.fixed), items } };
}

// Surveys saved before question types existed stored acknowledgements /
// availability / extraQuestions. Read them as items, with ids chosen so the
// answers those surveys already have line up (see upgradeResponse).
function upgradeQuestions(q) {
  const src = q || {};
  if (Array.isArray(src.items)) return { fixed: normalizeFixed(src.fixed), items: src.items };
  const items = [];
  for (const a of src.acknowledgements || []) {
    items.push({ id: a.id, type: 'single', prompt: a.prompt, required: true, audience: 'returning',
      options: [{ id: 'agree', label: a.agreeLabel || 'Yes' }, { id: 'exception', label: a.exceptionLabel, flag: true }] });
  }
  if (src.availability?.days?.length) {
    items.push({ id: 'availability', type: 'checkboxes', prompt: src.availability.prompt, required: false, audience: 'returning',
      options: src.availability.days.map(d => ({ id: d, label: d })) });
  }
  for (const e of src.extraQuestions || []) {
    items.push({ id: e.id, type: 'paragraph', prompt: e.prompt, required: false, audience: 'returning' });
  }
  return { fixed: normalizeFixed(src.fixed), items };
}

// Folds an older response's acknowledgements / availability into `answers`.
function upgradeResponse(r) {
  if (!r) return r;
  const { acknowledgements, availability, ...rest } = r;
  const answers = { ...(r.answers || {}) };
  for (const [id, v] of Object.entries(acknowledgements || {})) if (answers[id] === undefined) answers[id] = v;
  if ((availability || []).length && answers.availability === undefined) answers.availability = availability;
  return { ...rest, answers };
}

// "Shaman|Restoration" or { class, spec } -> { class, spec, role }, or null.
// Classes and specs are the team's WoW version's (Retail if not given).
function parseSpecChoice(v, game) {
  const [cls, spec] = typeof v === 'string' ? v.split('|') : [v?.class, v?.spec];
  const clsKey = String(cls || '').toLowerCase();
  if (!specsFor(clsKey, game).length) return null;
  const canonical = canonicalSpec(clsKey, spec, game);
  return canonical ? { class: clsKey, spec: canonical, role: roleForSpec(clsKey, canonical, game) } : null;
}

// Whether a question is asked of someone with this returning status.
function itemAskedFor(item, status) {
  if (item.audience === 'everyone') return true;
  return (item.audience === 'not_returning') === (status === 'not_returning');
}

// A raider's submission -> the columns to save (minus survey/team/account
// ids, which the caller adds). `survey.questions` must already be upgraded.
// `character` is the claimed roster character they picked, verified by the
// caller -- or null, in which case a typed characterName is required
// (officers who haven't claimed one).
function normalizeSurveyResponse(body, survey, character, game) {
  const b = body || {};
  const { fixed, items } = survey.questions;
  const status = b.status;
  if (!STATUSES.includes(status)) throw badRequest("Let us know whether you're returning.");

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
    comments:         fixed.comments.enabled ? (text(b.comments, LIMITS.comments) || null) : null,
  };

  if (status !== 'not_returning') {
    const choices = [];
    for (const raw of (Array.isArray(b.specChoices) ? b.specChoices : []).slice(0, fixed.specs.count)) {
      if (raw == null || raw === '') continue;
      const choice = parseSpecChoice(raw, game);
      if (!choice) throw badRequest("One of your spec choices isn't a real class and spec.");
      if (!choices.some(c => c.class === choice.class && c.spec === choice.spec)) choices.push(choice);
    }
    if (choices.length === 0) throw badRequest('Pick your first-choice class and spec.');
    row.spec_choices = choices;
    if (fixed.flex.enabled) row.flex_roles = FLEX_ROLES.filter(r => (b.flexRoles || []).includes(r));
  }

  for (const item of items) {
    if (!itemAskedFor(item, status)) continue;
    const v = b.answers?.[item.id];
    const blank = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (blank) {
      if (item.required) throw badRequest(`Answer ${shortPrompt(item.prompt)}.`);
      continue;
    }
    if (item.type === 'single') {
      if (!item.options.some(o => o.id === v)) throw badRequest(`That isn't one of the answers to ${shortPrompt(item.prompt)}.`);
      row.answers[item.id] = v;
    } else if (item.type === 'checkboxes') {
      const picked = Array.isArray(v) ? item.options.filter(o => v.includes(o.id)).map(o => o.id) : [];
      if (picked.length) row.answers[item.id] = picked;
      else if (item.required) throw badRequest(`Answer ${shortPrompt(item.prompt)}.`);
    } else if (item.type === 'scale') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > item.max) throw badRequest(`Pick a number from 1 to ${item.max} for ${shortPrompt(item.prompt)}.`);
      row.answers[item.id] = n;
    } else {
      const t = text(v, item.type === 'short' ? LIMITS.short : LIMITS.paragraph);
      if (t) row.answers[item.id] = t;
      else if (item.required) throw badRequest(`Answer ${shortPrompt(item.prompt)}.`);
    }
  }
  return row;
}

// When to nudge officers to run a survey: from 6 weeks before the current
// raid tier ends (once Blizzard has announced the date) until 2 weeks after
// the next one starts. `transition` comes from lib/raiderioRaids.js's
// seasonTransitionFrom. windowStart is when this round of asking began --
// a survey opened since then means the team already asked.
const DAY_MS = 86400000;
const PROMPT_DAYS_BEFORE_END   = 42;
const PROMPT_DAYS_AFTER_START  = 14;
function surveyPromptFor(transition, now = Date.now()) {
  if (!transition) return null;
  const { current, next } = transition;
  const endsAt = current?.endsAt || next?.startsAt || null;
  if (endsAt && endsAt > now && endsAt - now <= PROMPT_DAYS_BEFORE_END * DAY_MS) {
    return { kind: 'ending', zoneName: current?.name || null, nextName: next?.name || null,
      date: new Date(endsAt).toISOString(), windowStart: endsAt - PROMPT_DAYS_BEFORE_END * DAY_MS };
  }
  if (current?.startsAt && now - current.startsAt <= PROMPT_DAYS_AFTER_START * DAY_MS) {
    return { kind: 'started', zoneName: current.name, nextName: null,
      date: new Date(current.startsAt).toISOString(), windowStart: current.startsAt - PROMPT_DAYS_BEFORE_END * DAY_MS };
  }
  return null;
}

module.exports = {
  STATUSES, FLEX_ROLES, WEEKDAYS, QUESTION_TYPES, AUDIENCES, MAX_SPEC_CHOICES, FIXED_DEFAULTS,
  normalizeSurveyDefinition, normalizeSurveyResponse, upgradeQuestions, upgradeResponse,
  parseSpecChoice, itemAskedFor, surveyPromptFor,
};
