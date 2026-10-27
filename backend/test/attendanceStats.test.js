// backend/test/attendanceStats.test.js — the officer Attendance rate table.
//
// Drives the real GET /attendance-stats handler against a fake Supabase and a
// stubbed Discord roster, the same way lootFairness.test.js does.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const DISCORD = require.resolve('../discord');
let roster = async () => [{ id: 'ana', name: 'Ana' }, { id: 'bo', name: 'Bo' }];
require.cache[DISCORD] = {
  id: DISCORD,
  loaded: true,
  exports: {
    listMembers: () => roster(),
    listRoles: async () => [],
    postEmbed: async () => null,
    postImage: async () => null,
  },
};

const createAdminRouter = require('../admin');
const { todayInGuildTz } = require('../loa');

const ago = (n) => {
  const d = new Date(`${todayInGuildTz()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const TABLES = {
  events: [{ id: 'e1', event_date: ago(1) }, { id: 'e2', event_date: ago(2) }],
  event_attendance: [
    { id: 1, event_id: 'e1', discord_id: 'ana', display_name: 'Ana' },
    { id: 2, event_id: 'e2', discord_id: 'ana', display_name: 'Ana' },
    { id: 3, event_id: 'e1', discord_id: 'gone', display_name: 'Gone' }, // left the guild
    { id: 4, event_id: 'e1', discord_id: 'bo', display_name: 'Bo' },
  ],
  attendance_history: [],
  member_tenure: [],
};

function fakeSupabase() {
  return {
    from(name) {
      const rows = TABLES[name];
      if (!rows) throw new Error(`unexpected table ${name}`);
      const state = { gte: null, ids: null, eq: null };
      const filtered = () => rows
        .filter((r) => !state.gte || String(r.event_date) >= state.gte)
        .filter((r) => !state.ids || state.ids.includes(r.event_id))
        .filter((r) => !state.eq || String(r[state.eq[0]]) === String(state.eq[1]));
      const q = {
        select: () => q,
        order: () => q,
        eq: (f, v) => { state.eq = [f, v]; return q; },
        gte: (_f, v) => { state.gte = v; return q; },
        in: (_f, v) => { state.ids = v; return q; },
        range: (from, to) => Promise.resolve({ data: filtered().slice(from, to + 1), error: null }),
        then: (resolve) => Promise.resolve({ data: filtered(), error: null }).then(resolve),
      };
      return q;
    },
  };
}

const identities = { load: async () => ({ displayNameFor: (id, fallback) => fallback || id }) };

function call(win = '30', path = '/attendance-stats', params = {}) {
  const router = createAdminRouter(fakeSupabase(), {}, { priorities: new Set() }, identities);
  const handler = router.stack.find((l) => l.route?.path === path && l.route.methods.get).route.stack[0].handle;
  return new Promise((resolve, reject) => {
    handler({ query: { window: win }, params, user: { id: 'o', permissions: ['attendance'] } }, {
      status() { return this; },
      json: resolve,
    }).catch(reject);
  });
}

describe('GET /attendance-stats', () => {
  test('lists current members only', async () => {
    const body = await call();
    const ids = body.members.map((m) => m.discord_id).sort();
    assert.deepEqual(ids, ['ana', 'bo'], 'someone who left is not in the table');
  });

  test('shows everyone when Discord cannot be reached', async () => {
    const saved = roster;
    roster = async () => { throw new Error('Discord down'); };
    try {
      const body = await call();
      assert.ok(body.members.some((m) => m.discord_id === 'gone'));
    } finally {
      roster = saved;
    }
  });

  test('measures each member on nights since they joined', async () => {
    TABLES.member_tenure.push({ discord_id: 'bo', since: `${ago(1)}T18:00:00Z`, left_at: null });
    try {
      const bo = (await call()).members.find((m) => m.discord_id === 'bo');
      assert.equal(bo.eligible, 1);
      assert.equal(bo.rate, 100);
    } finally {
      TABLES.member_tenure.pop();
    }
  });
});

describe('GET /attendance-stats/member/:id', () => {
  const member = (id) => call('30', '/attendance-stats/member/:id', { id });
  const statuses = (body) => Object.fromEntries(body.events.map((e) => [e.id, e.status]));

  test('marks each night attended or missed', async () => {
    assert.deepEqual(statuses(await member('bo')), { e1: 'attended', e2: 'missed' });
    assert.deepEqual(statuses(await member('ana')), { e1: 'attended', e2: 'attended' });
  });

  test('nights before they joined are not counted as missed', async () => {
    TABLES.member_tenure.push({ discord_id: 'bo', since: `${ago(1)}T18:00:00Z`, left_at: null });
    try {
      assert.deepEqual(statuses(await member('bo')), { e1: 'attended', e2: 'before_join' });
    } finally {
      TABLES.member_tenure.pop();
    }
  });
});

describe('GET /attendance-stats/missed', () => {
  const missed = async () => Object.fromEntries(
    (await call('30', '/attendance-stats/missed')).members.map((m) => [m.discord_id, m.missed]),
  );

  test('counts missed nights for every current member', async () => {
    assert.deepEqual(await missed(), { ana: 0, bo: 1 });
  });

  test('lists members with no attendance at all', async () => {
    const saved = roster;
    roster = async () => [...await saved(), { id: 'cy', name: 'Cy' }];
    try {
      assert.deepEqual(await missed(), { ana: 0, bo: 1, cy: 2 });
    } finally {
      roster = saved;
    }
  });

  test('nights before they joined are not missed', async () => {
    TABLES.member_tenure.push({ discord_id: 'bo', since: `${ago(1)}T18:00:00Z`, left_at: null });
    try {
      assert.equal((await missed()).bo, 0);
    } finally {
      TABLES.member_tenure.pop();
    }
  });

  test('sorts the most missed first', async () => {
    const body = await call('30', '/attendance-stats/missed');
    assert.deepEqual(body.members.map((m) => m.discord_id), ['bo', 'ana']);
  });
});
