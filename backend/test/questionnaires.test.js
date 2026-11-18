// backend/test/questionnaires.test.js — the bot's questionnaires.
//
// As with polls, what matters most is that nothing a member sees, and nothing
// the website gets, carries who answered what. The rest is the form's
// validation, the answer rules, and the Discord form itself.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createQuestionnaires = require('../questionnaires');
const { cleanQuestionnaire, cleanAnswers, summarize } = createQuestionnaires;
const {
  questionnaireEmbed, questionnaireComponents, questionnaireModal, readQuestionnaireForm, questionnaireReport,
} = require('../discordGateway').__test;
const { permissionForPath } = require('../permissions');

const NOW = Date.parse('2026-11-18T12:00:00Z');
const CHANNEL = '123456789012345678';
const refused = (fn, re) => assert.throws(fn, (err) => err.status === 400 && re.test(err.message));

const role = { type: 'choice', text: 'Main role?', options: ['Tank', 'Healer', 'DPS'] };
const nights = { type: 'choice', text: 'Nights free?', options: ['Fri', 'Sat', 'Sun'], multi: true, required: false };
const notes = { type: 'text', text: 'Anything we should know?', required: false };

describe('cleanQuestionnaire', () => {
  test('a valid one: questions required unless said, choices tidied, a close time', () => {
    const q = cleanQuestionnaire({
      title: ' Raid survey ', intro: 'Quick one.\n\n\n\nThanks!', channelId: CHANNEL, closesInHours: 48,
      questions: [{ ...role, options: [' Tank ', '', 'Healer', 'DPS'] }, nights, notes],
    }, NOW);
    assert.equal(q.title, 'Raid survey');
    assert.equal(q.intro, 'Quick one.\n\nThanks!');
    assert.deepEqual(q.questions, [
      { type: 'choice', text: 'Main role?', required: true, options: ['Tank', 'Healer', 'DPS'], multi: false },
      { type: 'choice', text: 'Nights free?', required: false, options: ['Fri', 'Sat', 'Sun'], multi: true },
      { type: 'text', text: 'Anything we should know?', required: false },
    ]);
    assert.equal(q.closesAt, new Date(NOW + 48 * 3_600_000).toISOString());
    assert.equal(q.channelId, CHANNEL);
  });

  test('refuses what would make a broken questionnaire', () => {
    const base = { title: 'T', channelId: CHANNEL, questions: [role] };
    refused(() => cleanQuestionnaire({ ...base, title: '' }), /title/);
    refused(() => cleanQuestionnaire({ ...base, questions: [] }), /at least one question/);
    refused(() => cleanQuestionnaire({ ...base, questions: Array(6).fill(notes) }), /at most 5/);
    refused(() => cleanQuestionnaire({ ...base, questions: [{ ...notes, type: 'scale' }] }), /Question 1 needs a type/);
    refused(() => cleanQuestionnaire({ ...base, questions: [notes, { ...notes, text: ' ' }] }), /Write question 2/);
    refused(() => cleanQuestionnaire({ ...base, questions: [{ ...role, options: ['Tank'] }] }), /at least two choices/);
    refused(() => cleanQuestionnaire({ ...base, questions: [{ ...role, options: Array.from({ length: 26 }, (_, i) => `o${i}`) }] }), /at most 25/);
    refused(() => cleanQuestionnaire({ ...base, questions: [{ ...role, options: ['Tank', 'tank'] }] }), /same/);
    refused(() => cleanQuestionnaire({ ...base, channelId: '' }), /channel/);
    refused(() => cleanQuestionnaire({ ...base, closesInHours: 24 * 31 }), /30 days/);
  });
});

const questionnaire = (extra = {}) => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Raid survey', intro: '', status: 'open', closes_at: null,
  questions: cleanQuestionnaire({ title: 'T', channelId: CHANNEL, questions: [role, nights, notes] }).questions,
  ...extra,
});

describe('cleanAnswers', () => {
  test('picks become sorted numbers, text is tidied but keeps its lines', () => {
    assert.deepEqual(cleanAnswers(questionnaire(), [['2'], ['2', '0', '0'], '  Late   on Fri \r\n\r\n\r\nthanks ']),
      [[2], [0, 2], 'Late on Fri\n\nthanks']);
  });

  test('optional questions can be blank; required ones cannot', () => {
    assert.deepEqual(cleanAnswers(questionnaire(), [['0']]), [[0], [], '']);
    refused(() => cleanAnswers(questionnaire(), [[], ['1'], 'x']), /Answer question 1/);
  });

  test('refuses two picks for a pick-one question, and a choice that does not exist', () => {
    refused(() => cleanAnswers(questionnaire(), [['0', '1']]), /Pick only one answer for question 1/);
    refused(() => cleanAnswers(questionnaire(), [['0'], ['7']]), /Question 2 has a choice that no longer exists/);
  });
});

const responses = [
  { discord_id: '1', display_name: 'Ana', answers: [[0], [0, 1], 'Late on Fri'] },
  { discord_id: '2', display_name: 'Bo', answers: [[2], [1], ''] },
  { discord_id: '9', display_name: 'Guest', answers: [[2], [], 'Hi\nthere'] },
];

describe('summarize', () => {
  test('counts per choice and typed answers, never who gave them', () => {
    const s = summarize(questionnaire(), responses);
    assert.deepEqual(s, {
      respondents: 3,
      results: [{ counts: [1, 0, 2] }, { counts: [1, 2, 0] }, { answers: ['Late on Fri', 'Hi\nthere'] }],
    });
    assert.doesNotMatch(JSON.stringify(s), /Ana|"Bo"|Guest|discord_id/);
  });
});

describe('the Discord post', () => {
  test('lists the questions and a response count, never an answer', () => {
    const embed = questionnaireEmbed(questionnaire({ intro: 'Help us plan.' }), 3);
    const text = JSON.stringify(embed);
    assert.match(embed.title, /📋 Raid survey/);
    assert.match(embed.description, /^Help us plan\./);
    assert.match(embed.description, /\*\*1\. Main role\?\*\*\n-# pick one: Tank · Healer · DPS/);
    assert.match(embed.description, /-# pick any · optional: Fri · Sat · Sun/);
    assert.match(embed.description, /\*\*3\. Anything we should know\?\*\*\n-# typed answer · optional/);
    assert.match(embed.description, /3 responded/);
    assert.doesNotMatch(text, /Late on Fri|Ana/);
  });

  test('Fill in while open, beside Responses; only Responses once closed', () => {
    const ids = (rows) => rows.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
    const q = questionnaire();
    assert.deepEqual(ids(questionnaireComponents(q)), [`qn:fill:${q.id}`, `qn:who:${q.id}`]);
    assert.deepEqual(ids(questionnaireComponents(questionnaire({ status: 'closed' }))), [`qn:who:${q.id}`]);
  });
});

describe('the Discord form', () => {
  test('a dropdown or text box per question, filled with their earlier answers', () => {
    const json = questionnaireModal(questionnaire(), [[2], [0, 1], 'Late on Fri']).toJSON();
    assert.equal(json.custom_id, `qn:form:${questionnaire().id}`);
    const [a, b, c] = json.components;
    assert.equal(a.label, 'Main role?');
    assert.equal(a.description, 'Pick one');
    assert.deepEqual({ min: a.component.min_values, max: a.component.max_values, required: a.component.required }, { min: 1, max: 1, required: true });
    assert.deepEqual(a.component.options.map((o) => [o.label, o.value, o.default]), [['Tank', '0', false], ['Healer', '1', false], ['DPS', '2', true]]);
    assert.deepEqual({ min: b.component.min_values, max: b.component.max_values, required: b.component.required }, { min: 0, max: 3, required: false });
    assert.deepEqual(b.component.options.filter((o) => o.default).map((o) => o.value), ['0', '1']);
    assert.equal(c.component.custom_id, 'q2');
    assert.equal(c.component.value, 'Late on Fri');
    assert.equal(c.component.required, false);
  });

  test('a long question is cut to fit the label and written out beneath; a long title fits', () => {
    const long = 'Which of the guild content types would you like to see more of next season?';
    const q = questionnaire({ title: 'x'.repeat(80), questions: [{ type: 'text', text: long, required: true }] });
    const json = questionnaireModal(q).toJSON();
    assert.equal(json.title.length, 45);
    assert.equal(json.components[0].label.length, 45);
    assert.equal(json.components[0].description, long);
    assert.equal(json.components[0].component.value, undefined);
  });

  test('reads the submission, treating a question left out as blank', () => {
    const fields = {
      getStringSelectValues: (id) => { if (id === 'q0') return ['1']; throw new Error('missing'); },
      getTextInputValue: () => 'hello',
    };
    assert.deepEqual(readQuestionnaireForm(questionnaire(), fields), [['1'], [], 'hello']);
  });
});

describe("the officers' Responses report", () => {
  test('who picked each choice, each typed answer with its writer, and who has not responded', () => {
    const roster = [{ id: '1', name: 'Ana' }, { id: '2', name: 'Bo' }, { id: '5', name: 'Ed' }];
    const nameFor = (id) => ({ 1: 'Ana', 2: 'Bo', 5: 'Ed', 9: 'Guest' })[id];
    const [msg, ...rest] = questionnaireReport({ title: 'Raid survey', questions: questionnaire().questions, responses, roster, nameFor });
    assert.equal(rest.length, 0);
    assert.match(msg, /\*\*2 of 3\*\* members have responded/);
    assert.match(msg, /• \*\*Tank\*\* \(1\): Ana\n• \*\*Healer\*\* \(0\): —\n• \*\*DPS\*\* \(2\): Bo, Guest \*\(not a member\)\*/);
    assert.match(msg, /• \*\*Sat\*\* \(2\): Ana, Bo/);
    assert.match(msg, /Anything we should know\?\*\*\nAna: “Late on Fri”\nGuest \*\(not a member\)\*: “Hi \/ there”/);
    assert.match(msg, /Haven't responded \(1\)\*\*\nEd$/);
  });
});

// A small in-memory supabase for the module's own queries.
function fakeSupabase(tables) {
  return {
    from(name) {
      const rows = tables[name];
      const filters = [];
      let patch = null;
      let removing = false;
      let inserting = null;
      const matching = () => rows.filter((r) => filters.every((f) => f(r)));
      const run = () => {
        if (inserting) { rows.push(...inserting); return inserting; }
        const hit = matching();
        if (patch) hit.forEach((r) => Object.assign(r, patch));
        if (removing) hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return hit;
      };
      const q = {
        select: () => q,
        order: () => q,
        limit: () => q,
        eq: (f, v) => { filters.push((r) => String(r[f]) === String(v)); return q; },
        in: (f, vs) => { filters.push((r) => vs.includes(r[f])); return q; },
        update: (p) => { patch = p; return q; },
        delete: () => { removing = true; return q; },
        insert: (r) => { inserting = Array.isArray(r) ? r : [r]; return q; },
        maybeSingle: async () => ({ data: run()[0] || null, error: null }),
        single: async () => ({ data: run()[0] || null, error: null }),
        then: (resolve) => Promise.resolve({ data: run(), error: null }).then(resolve),
      };
      return q;
    },
  };
}

describe('responding and the Polls page list', () => {
  const setup = (extra = {}) => {
    const q = questionnaire(extra);
    const tables = { questionnaires: [q], questionnaire_responses: [] };
    return { q, tables, store: createQuestionnaires(fakeSupabase(tables)) };
  };

  test('a response is saved, answering again replaces it, and the form is refilled', async () => {
    const { q, tables, store } = setup();
    await store.respond(q.id, '1', 'Ana', [['0'], [], '']);
    await store.respond(q.id, '1', 'Ana', [['2'], ['1'], 'Late']);
    assert.deepEqual(tables.questionnaire_responses.map((r) => [r.discord_id, r.answers]), [['1', [[2], [1], 'Late']]]);
    assert.deepEqual((await store.myResponse(q.id, '1')).answers, [[2], [1], 'Late']);
    assert.equal((await store.myResponse(q.id, '2')).answers, null);
  });

  test('an all-blank form takes the response back', async () => {
    const optional = questionnaire().questions.map((x) => ({ ...x, required: false }));
    const { q, tables, store } = setup({ questions: optional });
    await store.respond(q.id, '1', 'Ana', [['0'], [], '']);
    const { removed } = await store.respond(q.id, '1', 'Ana', [[], [], '  ']);
    assert.equal(removed, true);
    assert.deepEqual(tables.questionnaire_responses, []);
  });

  test('a closed questionnaire refuses responses, and a bad one keeps the old response', async () => {
    const closed = setup({ status: 'closed' });
    await assert.rejects(closed.store.respond(closed.q.id, '1', 'Ana', [['0']]), (err) => err.status === 409);
    const { q, tables, store } = setup();
    await store.respond(q.id, '1', 'Ana', [['0']]);
    await assert.rejects(store.respond(q.id, '1', 'Ana', [[]]), (err) => err.status === 400);
    assert.equal(tables.questionnaire_responses.length, 1);
  });

  test("the page's list carries counts and typed answers, never names", async () => {
    const { q, store } = setup();
    await store.respond(q.id, '1', 'Ana', [['0'], ['0', '2'], 'Late on Fri']);
    await store.respond(q.id, '2', 'Bo', [['0'], [], '']);
    const [listed] = await store.list();
    assert.equal(listed.open, true);
    assert.equal(listed.respondents, 2);
    assert.deepEqual(listed.results, [{ counts: [2, 0, 0] }, { counts: [1, 0, 1] }, { answers: ['Late on Fri'] }]);
    assert.doesNotMatch(JSON.stringify(listed), /Ana|"Bo"|discord_id/);
  });
});

test("the questionnaire routes need the 'polls' capability", () => {
  assert.equal(permissionForPath('/polls/questionnaires'), 'polls');
  assert.equal(permissionForPath('/polls/questionnaires/abc/close'), 'polls');
});
