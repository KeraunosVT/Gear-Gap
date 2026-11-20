// backend/test/raids.test.js — raid runs: a plan of modes and gates, a role
// picked at signup, fixed slots per role and a bench.
//
// The slot and bench rules themselves are SQL (migration 22's raid_join,
// raid_withdraw, raid_move), run in one locked transaction each. What's held
// here is everything around them: the plan is checked against the catalog
// before it's stored, a raid join can't happen without a role, War signups
// still take their own path, raids stay out of the War signup list, and the
// Discord post shows the roster the way the mockup does.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createEventSignups = require('../eventSignups');
const { raidOf, raidSegments, gatesText, hardestMode, RAIDS } = createEventSignups;
const gateway = require('../discordGateway');
const { raidEmbed, raidButtons, raidJoinReply, raidWhoText, signupMessage } = gateway.__test;

const ALTAR = raidOf('altar_of_calanthia');
const DAY = 86_400_000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

// Just enough of supabase-js: recorded filters, single/maybeSingle, insert,
// awaiting the builder, and rpc() answered from `rpcData`.
function fakeSupabase(tables, { rpcCalls = [], rpcData = {}, inserts = [] } = {}) {
  return {
    from(table) {
      const filters = [];
      const rows = () => (tables[table] || []).filter((r) => filters.every((f) => f(r)));
      let inserted = null;
      const q = {
        select: () => q,
        eq: (f, v) => { filters.push((r) => String(r[f]) === String(v)); return q; },
        in: (f, vs) => { filters.push((r) => vs.map(String).includes(String(r[f]))); return q; },
        gte: (f, v) => { filters.push((r) => r[f] >= v); return q; },
        lte: (f, v) => { filters.push((r) => r[f] <= v); return q; },
        order: () => q,
        insert: (row) => { inserted = { id: 'new-run', ...row }; inserts.push(inserted); return q; },
        single: async () => (inserted ? { data: inserted, error: null } : { data: rows()[0] || null, error: rows()[0] ? null : { message: 'none' } }),
        maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
        then: (resolve) => Promise.resolve({ data: rows(), error: null }).then(resolve),
      };
      return q;
    },
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      return { data: rpcData[name] || [], error: null };
    },
  };
}

const run = (over = {}) => ({
  id: 'run-1',
  raid_key: 'altar_of_calanthia',
  title: 'Altar of Calanthia',
  event_date: '2026-11-22',
  status: 'open',
  starts_at: new Date(Date.now() + 2 * DAY).toISOString(),
  created_by: 'lead-1',
  role_caps: { Tank: 2, DPS: 8, Healer: 2 },
  raid_segments: [{ mode: 'normal', gates: [1, 2, 3] }, { mode: 'nightmare', gates: [1] }],
  ...over,
});

describe('the catalog', () => {
  test('Altar of Calanthia: three modes of three gates, 2 tanks, 8 DPS, 2 healers', () => {
    assert.ok(RAIDS.length >= 1);
    assert.equal(ALTAR.name, 'Altar of Calanthia');
    assert.equal(ALTAR.gates, 3);
    assert.deepEqual(ALTAR.modes.map((m) => m.key), ['normal', 'difficult', 'nightmare']);
    assert.deepEqual(ALTAR.roles, { Tank: 2, DPS: 8, Healer: 2 });
  });
});

describe('raidSegments', () => {
  test('puts modes in catalog order, sorts gates and drops repeats', () => {
    assert.deepEqual(
      raidSegments(ALTAR, [{ mode: 'nightmare', gates: [1] }, { mode: 'normal', gates: [3, 1, 2, 2] }]),
      [{ mode: 'normal', gates: [1, 2, 3] }, { mode: 'nightmare', gates: [1] }],
    );
  });

  test('merges a mode given twice and drops one with no gates', () => {
    assert.deepEqual(
      raidSegments(ALTAR, [{ mode: 'difficult', gates: [2] }, { mode: 'difficult', gates: [1] }, { mode: 'normal', gates: [] }]),
      [{ mode: 'difficult', gates: [1, 2] }],
    );
  });

  test('refuses an unknown mode, a gate out of range, and a plan with no gates', () => {
    assert.throws(() => raidSegments(ALTAR, [{ mode: 'mythic', gates: [1] }]), (e) => e.status === 400);
    assert.throws(() => raidSegments(ALTAR, [{ mode: 'normal', gates: [4] }]), (e) => e.status === 400);
    assert.throws(() => raidSegments(ALTAR, [{ mode: 'normal', gates: [0] }]), (e) => e.status === 400);
    assert.throws(() => raidSegments(ALTAR, []), /at least one gate/);
    assert.throws(() => raidSegments(ALTAR, 'normal'), /at least one gate/);
  });
});

describe('gatesText and hardestMode', () => {
  test('reads gates the way people say them', () => {
    assert.equal(gatesText([2]), 'Gate 2');
    assert.equal(gatesText([1, 3]), 'Gates 1 & 3');
    assert.equal(gatesText([1, 2]), 'Gates 1 & 2');
    assert.equal(gatesText([3, 1, 2]), 'Gates 1–3');
  });

  test('the hardest mode in a run sets its colour', () => {
    assert.equal(hardestMode(run()).key, 'nightmare');
    assert.equal(hardestMode(run({ raid_segments: [{ mode: 'normal', gates: [1] }, { mode: 'difficult', gates: [1] }] })).key, 'difficult');
    assert.equal(hardestMode(run({ raid_segments: [{ mode: 'normal', gates: [1] }] })).key, 'normal');
    assert.equal(hardestMode({ title: 'War Games' }), null);
  });
});

describe('openRaid', () => {
  const tomorrow = isoDate(Date.now() + DAY);

  test('stores the plan, the slots and the lead', async () => {
    const inserts = [];
    const signups = createEventSignups(fakeSupabase({}, { inserts }));
    await signups.openRaid({
      raidKey: 'altar_of_calanthia', eventDate: tomorrow, eventTime: '21:00',
      segments: [{ mode: 'nightmare', gates: [1] }, { mode: 'normal', gates: [1, 2, 3] }],
      reminderMinutes: '1440', createdBy: 'member-7', createdByName: 'Brannoc',
    });
    const [row] = inserts;
    assert.equal(row.raid_key, 'altar_of_calanthia');
    assert.equal(row.title, 'Altar of Calanthia');
    assert.equal(row.category, 'raid');
    assert.deepEqual(row.raid_segments, [{ mode: 'normal', gates: [1, 2, 3] }, { mode: 'nightmare', gates: [1] }]);
    assert.deepEqual(row.role_caps, { Tank: 2, DPS: 8, Healer: 2 });
    assert.equal(row.created_by, 'member-7');
    assert.equal(row.raid_lead_name, 'Brannoc');
    assert.equal(row.reminder_minutes, 1440);
    assert.ok(row.starts_at);
  });

  test('needs a raid from the catalog, a start time, and a time still to come', async () => {
    const signups = createEventSignups(fakeSupabase({}));
    const base = { raidKey: 'altar_of_calanthia', eventDate: tomorrow, eventTime: '21:00', segments: [{ mode: 'normal', gates: [1] }] };
    await assert.rejects(signups.openRaid({ ...base, raidKey: 'nope' }), /Pick a raid/);
    await assert.rejects(signups.openRaid({ ...base, eventTime: '' }), /start time/);
    await assert.rejects(signups.openRaid({ ...base, eventDate: isoDate(Date.now() - 3 * DAY) }), (e) => e.status === 409);
    await assert.rejects(signups.openRaid({ ...base, eventDate: isoDate(Date.now() + 60 * DAY) }), /30 days/);
    await assert.rejects(signups.openRaid({ ...base, segments: [] }), /at least one gate/);
  });
});

describe('joining and leaving a raid', () => {
  test('a raid join needs a role, and goes to raid_join with it', async () => {
    const rpcCalls = [];
    const signups = createEventSignups(fakeSupabase({ signup_events: [run()] }, {
      rpcCalls,
      rpcData: { raid_join: [{ entry_status: 'bench', entry_role: 'Tank', entry_bench_kind: 'overflow', bench_position: 1, changed: true }] },
    }));
    await assert.rejects(signups.join({ id: 'run-1', discordId: 'ana', displayName: 'Ana' }), /Pick a role/);
    await assert.rejects(signups.join({ id: 'run-1', discordId: 'ana', displayName: 'Ana', role: 'Bard' }), /Pick a role/);
    assert.equal(rpcCalls.length, 0);

    const result = await signups.join({ id: 'run-1', discordId: 'ana', displayName: 'Ana', role: 'Tank' });
    assert.equal(rpcCalls[0].name, 'raid_join');
    assert.equal(rpcCalls[0].args.p_role, 'Tank');
    assert.equal(rpcCalls[0].args.p_bench, false);
    assert.deepEqual(
      { status: result.status, role: result.role, benchKind: result.benchKind, position: result.position, wasNew: result.wasNew },
      { status: 'bench', role: 'Tank', benchKind: 'overflow', position: 1, wasNew: true },
    );
  });

  test('bench passes through, and a switch reports who moved up', async () => {
    const rpcCalls = [];
    const signups = createEventSignups(fakeSupabase({ signup_events: [run()] }, {
      rpcCalls,
      rpcData: { raid_join: [{ entry_status: 'bench', entry_role: 'DPS', entry_bench_kind: 'opt_in', changed: true, promoted_id: 'orrin', promoted_name: 'Orrin', promoted_role: 'Tank' }] },
    }));
    const result = await signups.join({ id: 'run-1', discordId: 'ana', displayName: 'Ana', role: 'DPS', bench: true });
    assert.equal(rpcCalls[0].args.p_bench, true);
    assert.deepEqual(result.promoted, { discord_id: 'orrin', display_name: 'Orrin', role: 'Tank' });
  });

  test('withdrawing from a raid goes to raid_withdraw and says who moved up, and in what role', async () => {
    const rpcCalls = [];
    const signups = createEventSignups(fakeSupabase({ signup_events: [run()] }, {
      rpcCalls,
      rpcData: { raid_withdraw: [{ removed: true, was_going: true, promoted_id: 'orrin', promoted_name: 'Orrin', promoted_role: 'Tank' }] },
    }));
    const result = await signups.withdraw({ id: 'run-1', discordId: 'ana' });
    assert.equal(rpcCalls[0].name, 'raid_withdraw');
    assert.deepEqual(result, { removed: true, wasGoing: true, promoted: { discord_id: 'orrin', display_name: 'Orrin', role: 'Tank' } });
  });

  test('War signups keep their own path, role or not', async () => {
    const rpcCalls = [];
    const war = { id: 'war-1', title: 'Guild War', status: 'open', starts_at: new Date(Date.now() + DAY).toISOString() };
    const signups = createEventSignups(fakeSupabase({ signup_events: [war] }, {
      rpcCalls,
      rpcData: { signup_join: [{ entry_status: 'going', going_count: 1, waitlist_count: 0, was_new: true }], signup_withdraw: [{ removed: true }] },
    }));
    await signups.join({ id: 'war-1', discordId: 'ana', displayName: 'Ana', role: 'Tank' });
    await signups.withdraw({ id: 'war-1', discordId: 'ana' });
    assert.deepEqual(rpcCalls.map((c) => c.name), ['signup_join', 'signup_withdraw']);
  });

  test('only the member who posted a run leads it', () => {
    const signups = createEventSignups(fakeSupabase({}));
    assert.equal(signups.isRaidLead(run(), 'lead-1'), true);
    assert.equal(signups.isRaidLead(run(), 'someone-else'), false);
    assert.equal(signups.isRaidLead(run({ created_by: null }), 'lead-1'), false);
    assert.equal(signups.isRaidLead({ id: 'war', created_by: 'lead-1' }, 'lead-1'), false, 'not a raid');
  });
});

describe('list', () => {
  const today = isoDate(Date.now());
  const tables = () => ({
    signup_events: [
      run({ id: 'run-1', event_date: today }),
      { id: 'war-1', title: 'Guild War', event_date: today, status: 'open' },
    ],
    signup_entries: [
      { signup_event_id: 'run-1', discord_id: 'a', status: 'going', role: 'Tank' },
      { signup_event_id: 'run-1', discord_id: 'b', status: 'going', role: 'Healer' },
      { signup_event_id: 'run-1', discord_id: 'me', status: 'bench', role: 'Tank', bench_kind: 'overflow' },
      { signup_event_id: 'war-1', discord_id: 'a', status: 'going' },
    ],
    member_roles: [],
  });

  test('raids and War signups are listed apart', async () => {
    const signups = createEventSignups(fakeSupabase(tables()));
    assert.deepEqual((await signups.list()).map((e) => e.id), ['war-1']);
    assert.deepEqual((await signups.list({ raids: true })).map((e) => e.id), ['run-1']);
  });

  test('a run counts by the role picked, with the bench apart', async () => {
    const signups = createEventSignups(fakeSupabase(tables()));
    const [row] = await signups.list({ raids: true, discordId: 'me' });
    assert.equal(row.going_count, 2);
    assert.equal(row.bench_count, 1);
    assert.equal(row.waitlist_count, 0);
    assert.deepEqual(row.role_counts, { Tank: 1, DPS: 0, Healer: 1, Unassigned: 0 });
    assert.equal(row.my_status, 'bench');
    assert.equal(row.my_role, 'Tank');
  });
});

describe('the Discord post', () => {
  const going = [
    { discord_id: 'b', display_name: 'Brannoc', role: 'Tank', status: 'going' },
    { discord_id: 'v', display_name: 'Vex', role: 'DPS', status: 'going' },
    { discord_id: 'a', display_name: 'Aria', role: 'Healer', status: 'going' },
    { discord_id: 'm', display_name: 'Mirelle', role: 'Healer', status: 'going' },
  ];
  const bench = [
    { discord_id: 'o', display_name: 'Orrin', role: 'Tank', status: 'bench', bench_kind: 'overflow' },
    { discord_id: 'p', display_name: 'Pike', role: 'DPS', status: 'bench', bench_kind: 'opt_in' },
  ];

  test('a column per role with its open slots, then the bench', () => {
    const embed = raidEmbed({ event: run(), going, bench });
    assert.deepEqual(embed.fields.map((f) => f.name), ['🛡️ Tanks (1/2)', '⚔️ DPS (1/8)', '💚 Healers (2/2)', '🪑 Bench (2)']);
    assert.equal(embed.fields[0].value, 'Brannoc\n◻ *open*');
    assert.equal(embed.fields[1].value.split('\n').length, 8);
    assert.equal(embed.fields[2].value, 'Aria\nMirelle');
    assert.ok(embed.fields.slice(0, 3).every((f) => f.inline));
    assert.equal(embed.fields[3].value, '🛡️ Orrin · ⚔️ Pike *(opt-in)*');
  });

  test('the plan, the lead and the headcount are in the description', () => {
    const { description, title } = raidEmbed({ event: run(), going, bench });
    assert.equal(title, '⛩️ Altar of Calanthia');
    assert.match(description, /Led by <@lead-1>/);
    assert.match(description, /🟢 \*\*Normal\*\* · Gates 1–3/);
    assert.match(description, /🔴 \*\*Nightmare\*\* · Gate 1/);
    assert.match(description, /\*\*4\/12\*\* filled · 2 on the bench/);
  });

  test('coloured by the hardest mode; grey and buttonless once cancelled', () => {
    assert.equal(raidEmbed({ event: run(), going: [], bench: [] }).color, 0xd83c55);
    assert.equal(raidEmbed({ event: run({ raid_segments: [{ mode: 'normal', gates: [1] }] }), going: [], bench: [] }).color, 0x3ba55d);
    const cancelled = signupMessage({ event: run({ status: 'cancelled' }), going: [], bench: [], waitlist: [] });
    assert.equal(cancelled.embeds[0].color, 0x6b7280);
    assert.match(cancelled.embeds[0].title, /CANCELLED/);
    assert.deepEqual(cancelled.components, []);
  });

  test('buttons: a role each, Bench, Withdraw, then Who\'s coming? and LOA', () => {
    const ids = raidButtons('run-1', false).map((row) => row.toJSON().components.map((c) => c.custom_id));
    assert.deepEqual(ids, [
      ['rd:join:run-1:Tank', 'rd:join:run-1:DPS', 'rd:join:run-1:Healer', 'rd:bench:run-1', 'sg:leave:run-1'],
      ['sg:who:run-1', 'sg:loa:run-1'],
    ]);
    assert.deepEqual(raidButtons('run-1', true), []);
  });

  test('a War signup still gets the War post', () => {
    const msg = signupMessage({ event: { id: 'war-1', title: 'Guild War', status: 'open', event_date: '2026-11-22' }, going: [], waitlist: [] });
    assert.equal(msg.components[0].toJSON().components[0].custom_id, 'sg:join:war-1');
  });

  test('the private replies say where you landed', () => {
    assert.match(raidJoinReply({ wasNew: true, status: 'going', role: 'Tank' }), /You're in as 🛡️ \*\*Tank\*\*/);
    assert.match(raidJoinReply({ wasNew: true, status: 'bench', benchKind: 'overflow', position: 2, role: 'Healer' }),
      /\*\*Healers\*\* are full, so you're \*\*#2\*\* on the bench/);
    assert.match(raidJoinReply({ wasNew: true, status: 'bench', benchKind: 'opt_in', role: 'DPS' }), /available if needed/);
    assert.match(raidJoinReply({ wasNew: false, status: 'going', role: 'DPS' }), /already in/);
    assert.match(raidJoinReply({ wasNew: true, status: 'going', role: 'DPS', promoted: { display_name: 'Orrin', role: 'Tank' } }),
      /Orrin\*\* moved up from the bench into your old Tank slot/);
  });

  test('Who\'s coming? lists every name, the bench included', () => {
    const text = raidWhoText({ event: run(), going, bench });
    assert.match(text, /🛡️ Tanks \(1\/2\)\*\*\nBrannoc/);
    assert.match(text, /🪑 Bench \(2\)\*\*\n🛡️ Orrin\n⚔️ Pike \(opt-in\)/);
  });
});
