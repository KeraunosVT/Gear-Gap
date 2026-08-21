// backend/test/lootFairness.test.js — the join behind the "who's owed" table.
//
// Drives the REAL route handler out of the admin router, against a fake
// Supabase and a stubbed Discord roster. The claims worth holding are the ones
// that produce a plausible wrong answer rather than an error:
//
//   - the window narrows BOTH halves, so a 30-day rate never sits beside an
//     all-time loot count;
//   - a member who attends and receives nothing still gets a row, since that
//     row is the entire reason the page exists;
//   - currency is omitted, not zeroed, for an officer without loot.currency.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const DISCORD = require.resolve('../discord');

// Stub Discord before admin.js pulls listMembers out of it.
require.cache[DISCORD] = {
  id: DISCORD,
  loaded: true,
  exports: {
    listMembers: async () => ([
      { id: 'ana', name: 'Ana' },
      { id: 'bo', name: 'Bo' },
      { id: 'cy', name: 'Cy' },
      { id: 'dee', name: 'Dee' }, // on the roster, nothing on either side
    ]),
    listRoles: async () => [],
    postEmbed: async () => null,
    postImage: async () => null,
  },
};

const createAdminRouter = require('../admin');

// ── the fake database ───────────────────────────────────────────────────────
// Dates are RELATIVE to today. Hardcoded ones would quietly change meaning as
// real time passed — a fixture dated "last week" becomes "last year" and the
// window assertions start testing something else without failing first.
const { todayInGuildTz } = require('../loa');
const ago = (n) => {
  const d = new Date(`${todayInGuildTz()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const RECENT = ago(1);
const OLD = ago(200); // outside every window the page offers

const EVENTS = [
  { id: 'e1', event_date: RECENT },
  { id: 'e2', event_date: ago(2) },
  { id: 'e3', event_date: OLD },
];
const ATTENDANCE = [
  { id: 1, event_id: 'e1', discord_id: 'ana' },
  { id: 2, event_id: 'e2', discord_id: 'ana' },
  { id: 3, event_id: 'e1', discord_id: 'bo' },
  { id: 4, event_id: 'e3', discord_id: 'cy' }, // only the old event
];
const AWARDS = [
  { id: 1, discord_id: 'bo', priority: 'PvP', awarded_at: `${RECENT}T00:00:00Z` },
  { id: 2, discord_id: 'bo', priority: null, awarded_at: `${RECENT}T00:00:00Z` }, // untagged
  { id: 3, discord_id: 'ana', priority: 'PvE', awarded_at: `${OLD}T00:00:00Z` }, // OUTSIDE
];
const CURRENCY = [
  { id: 1, discord_id: 'bo', currency: 'lucent', amount: 500, awarded_at: `${RECENT}T00:00:00Z` },
  { id: 2, discord_id: 'bo', currency: 'tevent_ashen', amount: 3, awarded_at: `${RECENT}T00:00:00Z` },
  { id: 3, discord_id: 'ana', currency: 'lucent', amount: 9999, awarded_at: `${OLD}T00:00:00Z` }, // OUTSIDE
];

function fakeSupabase(over = {}) {
  const table = (rows, dateField) => {
    const state = { gte: null, ids: null };
    const q = {
      select: () => q,
      order: () => q,
      gte: (_f, v) => { state.gte = v; return q; },
      in: (_f, v) => { state.ids = v; return q; },
      range: (from, to) => {
        let out = rows;
        if (state.gte && dateField) out = out.filter((r) => String(r[dateField]) >= state.gte);
        if (state.ids) out = out.filter((r) => state.ids.includes(r.event_id));
        return Promise.resolve({ data: out.slice(from, to + 1), error: null });
      },
      // `events` is read without paging, so it must also be awaitable directly.
      then: (resolve) => {
        let out = rows;
        if (state.gte && dateField) out = out.filter((r) => String(r[dateField]) >= state.gte);
        return Promise.resolve({ data: out, error: null }).then(resolve);
      },
    };
    return q;
  };
  return {
    from: (name) => {
      if (name === 'events') return table(over.events || EVENTS, 'event_date');
      if (name === 'event_attendance') return table(ATTENDANCE, null);
      if (name === 'loot_awards') return table(AWARDS, 'awarded_at');
      if (name === 'currency_awards') return table(CURRENCY, 'awarded_at');
      throw new Error(`unexpected table ${name}`);
    },
  };
}

const identities = {
  load: async () => ({ displayNameFor: (id, fallback) => fallback || id }),
};
const lootCatalog = { priorities: new Set(['PvP', 'Second Build', 'PvE']) };

let handler;

before(() => {
  const router = createAdminRouter(fakeSupabase(), {}, lootCatalog, identities);
  const layer = router.stack.find((l) => l.route?.path === '/loot/fairness' && l.route.methods.get);
  assert.ok(layer, 'GET /loot/fairness should be registered');
  handler = layer.route.stack[0].handle;
});

// Invokes the handler and resolves with whatever it sends.
function call({ window: win = '30', permissions = ['loot.awards', 'loot.currency'] } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); },
    };
    handler({ query: { window: win }, user: { id: 'officer', permissions } }, res)
      .catch(reject);
  });
}

const byId = (body) => Object.fromEntries(body.members.map((m) => [m.discord_id, m]));

describe('GET /loot/fairness', () => {
  test('counts attendance and awards inside the window', async () => {
    const { body } = await call({ window: 'all' });
    const m = byId(body);
    assert.equal(body.total_events, 3);
    assert.equal(m.ana.attended, 2);
    assert.equal(m.bo.attended, 1);
    assert.equal(m.bo.items, 2);
  });

  test('the window narrows BOTH halves', async () => {
    // Ana's only award and only Lucent grant are from January. A window that
    // filtered events but not awards would show her 100% attendance beside an
    // item she was given eight months earlier.
    const all = byId((await call({ window: 'all' })).body);
    assert.equal(all.ana.items, 1, 'all-time sees the old award');

    const res = await call({ window: '30' });
    const recent = byId(res.body);
    assert.equal(recent.ana.items, 0, 'a 30-day window must not');
    assert.equal(recent.ana.lucent, 0, 'nor the old Lucent grant');
    assert.equal(res.body.total_events, 2, 'and the old event drops out of the denominator');
  });

  test('a member who attends and receives nothing still gets a row', async () => {
    // The row the page exists for. Dropping zero-award members server-side
    // would remove exactly the people an officer is looking for.
    const m = byId((await call({ window: '30' })).body);
    assert.ok(m.ana, 'Ana attended twice and received nothing in this window');
    assert.equal(m.ana.items, 0);
    assert.equal(m.ana.rate, 100);
  });

  test('roster members with nothing on either side are still returned', async () => {
    // Whether to show them is the page's choice, not the API's.
    const m = byId((await call({ window: '30' })).body);
    assert.ok(m.dee);
    assert.equal(m.dee.attended, 0);
    assert.equal(m.dee.items, 0);
  });

  test('untagged awards are their own bucket and still count in the total', async () => {
    const m = byId((await call({ window: '30' })).body);
    assert.equal(m.bo.items, 2);
    assert.equal(m.bo.items_by_build.PvP, 1);
    assert.equal(m.bo.items_by_build.Untagged, 1);
    const summed = Object.values(m.bo.items_by_build).reduce((a, b) => a + b, 0);
    assert.equal(summed, m.bo.items, 'per-build columns must add up to the Items column');
  });

  test('lucent and shards are totalled separately', async () => {
    const m = byId((await call({ window: '30' })).body);
    assert.equal(m.bo.lucent, 500);
    assert.equal(m.bo.shards, 3);
  });

  test('currency is OMITTED, not zeroed, without loot.currency', async () => {
    // Zero would read as "they have been paid nothing", which is a wrong
    // answer rather than a withheld one.
    const { body } = await call({ window: '30', permissions: ['loot.awards'] });
    assert.equal(body.can_see_currency, false);
    const m = byId(body);
    assert.ok(!('lucent' in m.bo), 'lucent must not be present at all');
    assert.ok(!('shards' in m.bo), 'shards must not be present at all');
    assert.equal(m.bo.items, 2, 'the gear half still works');
  });

  test('rate is null rather than 0 when no events fall in the window', async () => {
    // 0% would say "never turned up"; null says "there was nothing to turn up
    // to". Driven from an empty events table rather than a narrow window,
    // because every window the page offers contains the recent fixtures.
    const empty = createAdminRouter(fakeSupabase({ events: [] }), {}, lootCatalog, identities);
    const h = empty.stack.find((l) => l.route?.path === '/loot/fairness' && l.route.methods.get).route.stack[0].handle;
    const body = await new Promise((resolve, reject) => {
      h({ query: {}, user: { id: 'o', permissions: ['loot.awards', 'loot.currency'] } },
        { status() { return this; }, json: resolve }).catch(reject);
    });
    assert.equal(body.total_events, 0);
    assert.ok(body.members.length > 0, 'roster members are still listed');
    body.members.forEach((m) => assert.equal(m.rate, null));
  });
});
