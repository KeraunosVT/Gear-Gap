// backend/test/scheduleSkip.test.js — cancelling one night of a weekly event.
//
// The night stays on the calendar marked cancelled, so the signups already
// opened for it must be marked cancelled too, not deleted, and restoring the
// night must reopen exactly those. A signup the sweep already closed is left
// alone both ways.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const DISCORD = require.resolve('../discord');
require.cache[DISCORD] = {
  id: DISCORD,
  loaded: true,
  exports: {
    listMembers: async () => [],
    listRoles: async () => [],
    postEmbed: async () => null,
    postImage: async () => null,
  },
};

const createAdminRouter = require('../admin');

let TABLES;
let refreshed;

// Just enough of supabase-js for the route: select/update, chained eq filters,
// single(), and awaiting the builder.
function fakeSupabase() {
  return {
    from(name) {
      const rows = TABLES[name];
      const state = { patch: null, filters: [] };
      const matching = () => rows.filter((r) => state.filters.every(([f, v]) => String(r[f]) === String(v)));
      const run = () => {
        const hit = matching();
        if (state.patch) hit.forEach((r) => Object.assign(r, state.patch));
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const q = {
        select: () => q,
        update: (patch) => { state.patch = patch; return q; },
        eq: (f, v) => { state.filters.push([f, v]); return q; },
        single: () => {
          const { data } = run();
          return Promise.resolve(data.length ? { data: data[0], error: null } : { data: null, error: { message: 'none' } });
        },
        then: (resolve) => Promise.resolve(run()).then(resolve),
      };
      return q;
    },
  };
}

function skip(body, id = 'raid') {
  const gateway = { refreshSignupMessage: (sid) => refreshed.push(sid) };
  const router = createAdminRouter(fakeSupabase(), gateway, { priorities: new Set() }, { load: async () => ({}) });
  const handler = router.stack.find((l) => l.route?.path === '/event-schedule/:id/skip').route.stack[0].handle;
  return new Promise((resolve, reject) => {
    let status = 200;
    Promise.resolve(handler({ params: { id }, body, user: { id: 'o', permissions: ['schedule'] } }, {
      status(s) { status = s; return this; },
      json: (b) => resolve({ status, body: b }),
    })).catch(reject);
  });
}

const status = (id) => TABLES.signup_events.find((e) => e.id === id).status;

describe('POST /event-schedule/:id/skip', () => {
  beforeEach(() => {
    refreshed = [];
    TABLES = {
      event_schedule: [{ id: 'raid', name: 'Raid', skip_dates: [] }],
      signup_events: [
        { id: 'tonight', event_schedule_id: 'raid', event_date: '2026-11-05', status: 'open' },
        { id: 'nextweek', event_schedule_id: 'raid', event_date: '2026-11-12', status: 'open' },
        { id: 'other', event_schedule_id: 'boss', event_date: '2026-11-05', status: 'open' },
      ],
    };
  });

  test('cancelling a night marks its signups cancelled and nothing else', async () => {
    const res = await skip({ date: '2026-11-05', skip: true });
    assert.deepEqual(res.body.skip_dates, ['2026-11-05']);
    assert.equal(status('tonight'), 'cancelled');
    assert.equal(status('nextweek'), 'open', 'another week of the same event');
    assert.equal(status('other'), 'open', 'another event the same night');
    assert.deepEqual(refreshed, ['tonight'], 'its Discord post is redrawn');
  });

  test('restoring the night reopens them', async () => {
    await skip({ date: '2026-11-05', skip: true });
    refreshed = [];
    const res = await skip({ date: '2026-11-05', skip: false });
    assert.deepEqual(res.body.skip_dates, []);
    assert.equal(status('tonight'), 'open');
    assert.deepEqual(refreshed, ['tonight']);
  });

  test('a closed signup stays closed either way', async () => {
    TABLES.signup_events[0].status = 'closed';
    await skip({ date: '2026-11-05', skip: true });
    assert.equal(status('tonight'), 'closed');
    await skip({ date: '2026-11-05', skip: false });
    assert.equal(status('tonight'), 'closed');
  });

  test('a night with no signups opened still cancels', async () => {
    const res = await skip({ date: '2026-11-19', skip: true });
    assert.deepEqual(res.body.skip_dates, ['2026-11-19']);
    assert.deepEqual(refreshed, []);
  });
});
