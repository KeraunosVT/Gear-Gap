// backend/test/polls.test.js — the bot's private polls.
//
// The point of these polls is that members can't see who voted for what, so
// the test that matters most is that nothing a member sees — the post, the
// Polls page's list — carries a voter. The rest is the vote rules and the
// form's validation.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createPolls = require('../polls');
const { cleanPoll, toggleVote, tally, isOpen } = createPolls;
const { pollEmbed, pollComponents, pollWriteInModal, pollReport } = require('../discordGateway').__test;
const { permissionForPath } = require('../permissions');

const NOW = Date.parse('2026-11-18T12:00:00Z');
const CHANNEL = '123456789012345678';
const refused = (fn, re) => assert.throws(fn, (err) => err.status === 400 && re.test(err.message));

describe('cleanPoll', () => {
  test('a valid poll, with blank options dropped and a close time', () => {
    const p = cleanPoll({ question: ' Raid night? ', options: ['Fri', '', ' Sat '], channelId: CHANNEL, closesInHours: 24 }, NOW);
    assert.deepEqual(p, {
      question: 'Raid night?', options: ['Fri', 'Sat'], multi: false, writeIn: false,
      closesAt: new Date(NOW + 24 * 3_600_000).toISOString(), channelId: CHANNEL,
    });
    assert.equal(cleanPoll({ question: 'Q', options: ['a', 'b'], channelId: CHANNEL }, NOW).closesAt, null);
    assert.equal(cleanPoll({ question: 'Q', options: ['a', 'b'], channelId: CHANNEL, writeIn: true }, NOW).writeIn, true);
  });

  test('refuses what would make a broken poll', () => {
    refused(() => cleanPoll({ question: '', options: ['a', 'b'], channelId: CHANNEL }), /question/);
    refused(() => cleanPoll({ question: 'Q', options: ['a'], channelId: CHANNEL }), /at least two/);
    refused(() => cleanPoll({ question: 'Q', options: Array.from({ length: 11 }, (_, i) => `o${i}`), channelId: CHANNEL }), /at most 10/);
    refused(() => cleanPoll({ question: 'Q', options: ['Yes', 'yes'], channelId: CHANNEL }), /same/);
    refused(() => cleanPoll({ question: 'Q', options: ['a', 'b'] }), /channel/);
    refused(() => cleanPoll({ question: 'Q', options: ['a', 'b'], channelId: CHANNEL, closesInHours: -1 }), /positive/);
    refused(() => cleanPoll({ question: 'Q', options: ['a', 'b'], channelId: CHANNEL, closesInHours: 24 * 31 }), /30 days/);
  });
});

describe('toggleVote', () => {
  test('single choice: a click picks, another switches, the same again takes it back', () => {
    assert.deepEqual(toggleVote([], 1, false), [1]);
    assert.deepEqual(toggleVote([1], 2, false), [2]);
    assert.deepEqual(toggleVote([2], 2, false), []);
  });

  test('multiple choice: each click toggles that option', () => {
    assert.deepEqual(toggleVote([], 2, true), [2]);
    assert.deepEqual(toggleVote([2], 0, true), [0, 2]);
    assert.deepEqual(toggleVote([0, 2], 2, true), [0]);
  });
});

const poll = (extra = {}) => ({
  id: '11111111-2222-3333-4444-555555555555', question: 'Raid night?', options: ['Fri', 'Sat', 'Sun'],
  multi: true, status: 'open', closes_at: null, ...extra,
});
const votes = [
  { discord_id: '1', display_name: 'Ana', option_index: 0 },
  { discord_id: '1', display_name: 'Ana', option_index: 1 },
  { discord_id: '2', display_name: 'Bo', option_index: 1 },
];

describe('tally and isOpen', () => {
  test('counts per option, and each voter once', () => {
    assert.deepEqual(tally(poll(), votes), { counts: [1, 2, 0], writeIns: 0, voters: 2 });
  });

  test('closed by status or by its close time passing', () => {
    assert.equal(isOpen(poll(), NOW), true);
    assert.equal(isOpen(poll({ status: 'closed' }), NOW), false);
    assert.equal(isOpen(poll({ closes_at: new Date(NOW - 1000).toISOString() }), NOW), false);
    assert.equal(isOpen(poll({ closes_at: new Date(NOW + 1000).toISOString() }), NOW), true);
  });
});

describe('the Discord post', () => {
  test('shows counts and never a voter', () => {
    const embed = JSON.stringify(pollEmbed(poll(), votes));
    assert.match(embed, /1 vote/);
    assert.match(embed, /2 votes/);
    assert.match(embed, /2 voted/);
    assert.doesNotMatch(embed, /Ana|Bo\b/);
  });

  test('a button per option while open, plus Who voted; only Who voted once closed', () => {
    const ids = (rows) => rows.flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
    const p = poll();
    assert.deepEqual(ids(pollComponents(p)), [
      `pl:v:${p.id}:0`, `pl:v:${p.id}:1`, `pl:v:${p.id}:2`, `pl:who:${p.id}`,
    ]);
    assert.deepEqual(ids(pollComponents(poll({ status: 'closed' }))), [`pl:who:${p.id}`]);
  });

  test('ten options fit as two rows of five, with Who voted on a third', () => {
    const rows = pollComponents(poll({ options: Array.from({ length: 10 }, (_, i) => `o${i}`) }));
    assert.deepEqual(rows.map((r) => r.toJSON().components.length), [5, 5, 1]);
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

describe('voting and the Polls page list', () => {
  const setup = (extra = {}) => {
    const p = poll({ multi: false, ...extra });
    const tables = { polls: [p], poll_votes: [] };
    return { p, tables, polls: createPolls(fakeSupabase(tables)) };
  };

  test('a vote is saved; switching replaces it', async () => {
    const { p, tables, polls } = setup();
    await polls.vote(p.id, '1', 'Ana', 0);
    const { choices } = await polls.vote(p.id, '1', 'Ana', 2);
    assert.deepEqual(choices, [2]);
    assert.deepEqual(tables.poll_votes.map((v) => [v.discord_id, v.option_index]), [['1', 2]]);
  });

  test('a closed poll refuses votes, and so does an option that does not exist', async () => {
    const { p, polls } = setup({ status: 'closed' });
    await assert.rejects(polls.vote(p.id, '1', 'Ana', 0), (err) => err.status === 409);
    const open = setup();
    await assert.rejects(open.polls.vote(open.p.id, '1', 'Ana', 7), (err) => err.status === 400);
  });

  test("the page's list carries counts, never voters", async () => {
    const { p, polls } = setup();
    await polls.vote(p.id, '1', 'Ana', 1);
    await polls.vote(p.id, '2', 'Bo', 1);
    const [listed] = await polls.list();
    assert.deepEqual(listed.counts, [0, 2, 0]);
    assert.equal(listed.voter_count, 2);
    assert.doesNotMatch(JSON.stringify(listed), /Ana|"Bo"|discord_id/);
  });
});

describe('write-ins', () => {
  const writeIns = [
    { discord_id: '3', display_name: 'Cy', answer: 'Thursday' },
    { discord_id: '4', display_name: 'Di', answer: 'thursday' },
    { discord_id: '1', display_name: 'Ana', answer: 'Any night' },
  ];

  test('someone who only wrote in has voted; tally counts write-ins', () => {
    assert.deepEqual(tally(poll({ write_in: true }), votes, writeIns), { counts: [1, 2, 0], writeIns: 3, voters: 4 });
  });

  test('the page groups the same answer ignoring case, most common first', () => {
    assert.deepEqual(createPolls.groupWriteIns(writeIns), [{ answer: 'Thursday', count: 2 }, { answer: 'Any night', count: 1 }]);
  });

  test('the post shows a write-in count, never what was written or by whom', () => {
    const embed = JSON.stringify(pollEmbed(poll({ write_in: true }), votes, writeIns));
    assert.match(embed, /Written in\*\*\\n[▰▱]+ {2}3 votes/);
    assert.match(embed, /4 voted/);
    assert.match(embed, /write your own/);
    assert.doesNotMatch(embed, /Thursday|Any night|Cy|Di\b|Ana/);
    assert.doesNotMatch(JSON.stringify(pollEmbed(poll(), votes)), /Written in|write your own/);
  });

  test('a Write my own button while open, beside Who voted; gone once closed', () => {
    const ids = (rows) => rows.map((r) => r.toJSON().components.map((c) => c.custom_id));
    const p = poll({ write_in: true });
    assert.deepEqual(ids(pollComponents(p)).at(-1), [`pl:w:${p.id}`, `pl:who:${p.id}`]);
    assert.deepEqual(ids(pollComponents(poll({ write_in: true, status: 'closed' }))), [[`pl:who:${p.id}`]]);
    const ten = pollComponents(poll({ write_in: true, options: Array.from({ length: 10 }, (_, i) => `o${i}`) }));
    assert.deepEqual(ten.map((r) => r.toJSON().components.length), [5, 5, 2]);
  });

  test('the pop-up is filled with their earlier answer, and a long question fits the title', () => {
    const json = pollWriteInModal(poll({ question: 'x'.repeat(60) }), 'Thursday').toJSON();
    assert.equal(json.custom_id, `pl:wform:${poll().id}`);
    assert.equal(json.title.length, 45);
    assert.equal(json.components[0].components[0].value, 'Thursday');
    assert.equal(json.components[0].components[0].required, false);
  });

  const setup = (extra = {}) => {
    const p = poll({ multi: false, write_in: true, ...extra });
    const tables = { polls: [p], poll_votes: [], poll_write_ins: [] };
    return { p, tables, polls: createPolls(fakeSupabase(tables)) };
  };
  const state = (tables) => ({
    votes: tables.poll_votes.map((v) => [v.discord_id, v.option_index]),
    writeIns: tables.poll_write_ins.map((w) => [w.discord_id, w.answer]),
  });

  test('single choice: a write-in replaces the option vote, and an option replaces the write-in', async () => {
    const { p, tables, polls } = setup();
    await polls.vote(p.id, '1', 'Ana', 0);
    const { answer } = await polls.writeIn(p.id, '1', 'Ana', '  Thursday   after 9 ');
    assert.equal(answer, 'Thursday after 9');
    assert.deepEqual(state(tables), { votes: [], writeIns: [['1', 'Thursday after 9']] });
    await polls.vote(p.id, '1', 'Ana', 2);
    assert.deepEqual(state(tables), { votes: [['1', 2]], writeIns: [] });
  });

  test('multiple choice: a write-in sits beside option votes', async () => {
    const { p, tables, polls } = setup({ multi: true });
    await polls.vote(p.id, '1', 'Ana', 0);
    await polls.writeIn(p.id, '1', 'Ana', 'Thursday');
    await polls.vote(p.id, '1', 'Ana', 1);
    assert.deepEqual(state(tables), { votes: [['1', 0], ['1', 1]], writeIns: [['1', 'Thursday']] });
  });

  test('writing again replaces it, saving it empty takes it back, and the box is refilled', async () => {
    const { p, tables, polls } = setup();
    await polls.writeIn(p.id, '1', 'Ana', 'Thursday');
    await polls.writeIn(p.id, '1', 'Ana', 'Friday late');
    assert.deepEqual(state(tables).writeIns, [['1', 'Friday late']]);
    assert.equal((await polls.myWriteIn(p.id, '1')).answer, 'Friday late');
    assert.equal((await polls.writeIn(p.id, '1', 'Ana', '   ')).answer, '');
    assert.deepEqual(state(tables).writeIns, []);
    assert.equal((await polls.myWriteIn(p.id, '1')).answer, '');
  });

  test('refused when closed, or when the poll does not take write-ins', async () => {
    const closed = setup({ status: 'closed' });
    await assert.rejects(closed.polls.writeIn(closed.p.id, '1', 'Ana', 'x'), (err) => err.status === 409);
    const off = setup({ write_in: false });
    await assert.rejects(off.polls.writeIn(off.p.id, '1', 'Ana', 'x'), (err) => err.status === 400);
  });

  test('a poll without write-ins never reads the write-in table', async () => {
    const p = poll({ multi: false });
    const tables = { polls: [p], poll_votes: [] }; // no poll_write_ins: migration 20 not run
    const polls = createPolls(fakeSupabase(tables));
    await polls.vote(p.id, '1', 'Ana', 0);
    assert.deepEqual(await polls.writeInsFor(p), []);
    const [listed] = await polls.list();
    assert.equal(listed.write_in_count, 0);
  });

  test("the page's list carries write-in answers, never who wrote them", async () => {
    const { p, polls } = setup();
    await polls.vote(p.id, '2', 'Bo', 1);
    await polls.writeIn(p.id, '1', 'Ana', 'Thursday');
    const [listed] = await polls.list();
    assert.equal(listed.voter_count, 2);
    assert.equal(listed.write_in_count, 1);
    assert.deepEqual(listed.write_ins, [{ answer: 'Thursday', count: 1 }]);
    assert.doesNotMatch(JSON.stringify(listed), /Ana|"Bo"|discord_id/);
  });

  test("Who voted lists each write-in with its writer, and they count as voted", () => {
    const roster = [{ id: '1', name: 'Ana' }, { id: '2', name: 'Bo' }, { id: '5', name: 'Ed' }];
    const nameFor = (id) => ({ 1: 'Ana', 2: 'Bo', 5: 'Ed', 9: 'Guest' })[id];
    const [msg] = pollReport({
      question: 'Raid night?', roster, nameFor,
      answers: [{ text: 'Fri', voterIds: ['2'] }],
      writeIns: [{ id: '1', text: 'Thursday' }, { id: '9', text: 'Sunday' }],
    });
    assert.match(msg, /\*\*2 of 3\*\* members have voted/);
    assert.match(msg, /Written in \(2\)\*\*\nAna: “Thursday”\nGuest \*\(not a member\)\*: “Sunday”/);
    assert.match(msg, /Haven't voted \(1\)\*\*\nEd/);
    assert.doesNotMatch(pollReport({ question: 'Q', roster, nameFor, answers: [] })[0], /Written in/);
  });
});

test("the Polls page's routes need the 'polls' capability", () => {
  assert.equal(permissionForPath('/polls'), 'polls');
  assert.equal(permissionForPath('/polls/abc/close'), 'polls');
});
