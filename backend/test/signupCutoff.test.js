// backend/test/signupCutoff.test.js — signups that close before the start.
//
// War Games signups close three hours early; everything else at the start.
// A wrong answer here doesn't error: it either lets someone onto a roster
// that's already set, or shuts a raid's signups hours too soon.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const createEventSignups = require('../eventSignups');
const { closeEarlyMinutes, closesAt } = createEventSignups;

const HOUR = 3_600_000;
const iso = (ms) => new Date(ms).toISOString();

describe('closeEarlyMinutes', () => {
  test('War Games close 3 hours early, by type or by name', () => {
    assert.equal(closeEarlyMinutes({ title: 'Saturday fight', category: 'war_games' }), 180);
    assert.equal(closeEarlyMinutes({ title: 'War Games' }), 180);
    assert.equal(closeEarlyMinutes({ title: 'Wargame vs Red' }), 180);
  });

  test('everything else closes at the start', () => {
    assert.equal(closeEarlyMinutes({ title: 'Arch Boss — Morokai' }), 0);
    assert.equal(closeEarlyMinutes({ title: 'Guild War' }), 0);
    assert.equal(closeEarlyMinutes({ title: 'Siege' }), 0);
  });

  test('a type that was picked wins over the name', () => {
    assert.equal(closeEarlyMinutes({ title: 'War Games warm-up raid', category: 'raid' }), 0);
  });

  test('closesAt is the start minus the lead, or null with no start', () => {
    assert.equal(closesAt({ title: 'War Games', starts_at: '2026-11-07T01:00:00Z' }).toISOString(), '2026-11-06T22:00:00.000Z');
    assert.equal(closesAt({ title: 'Raid', starts_at: '2026-11-07T01:00:00Z' }).toISOString(), '2026-11-07T01:00:00.000Z');
    assert.equal(closesAt({ title: 'War Games', starts_at: null }), null);
  });
});

// The calendar types an untyped event by its name; the cutoff must agree on
// which names are War Games.
describe('name matching agrees with the calendar', () => {
  let categoryOf;
  before(async () => {
    const file = path.join(__dirname, '..', '..', 'frontend', 'src', 'eventCategories.js');
    ({ categoryOf } = await import(pathToFileURL(file).href));
  });

  for (const title of ['War Games', 'war game', 'Wargames', 'Wargame vs Red', 'Guild War', 'Siege', 'Arch Boss', 'Riftstone']) {
    test(title, () => {
      assert.equal(closeEarlyMinutes({ title }) > 0, categoryOf(title).key === 'war_games');
    });
  }
});

// Just enough of supabase-js: chained filters that are recorded and applied,
// maybeSingle(), awaiting the builder, and rpc().
function fakeSupabase(rows, rpcCalls = []) {
  return {
    from() {
      const filters = [];
      const matching = () => rows.filter((r) => filters.every((f) => f(r)));
      const q = {
        select: () => q,
        eq: (f, v) => { filters.push((r) => String(r[f]) === String(v)); return q; },
        not: (f) => { filters.push((r) => r[f] != null); return q; },
        lte: (f, v) => { filters.push((r) => r[f] <= v); return q; },
        maybeSingle: async () => ({ data: matching()[0] || null, error: null }),
        then: (resolve) => Promise.resolve({ data: matching(), error: null }).then(resolve),
      };
      return q;
    },
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      return { data: [{ entry_status: 'going', going_count: 1, waitlist_count: 0, was_new: true }], error: null };
    },
  };
}

describe('dueToClose', () => {
  test('closes War Games inside 3 hours and everything else at the start', async () => {
    const now = Date.now();
    const rows = [
      { id: 'wg-soon', title: 'War Games', status: 'open', starts_at: iso(now + 2 * HOUR) },
      { id: 'wg-later', title: 'War Games', status: 'open', starts_at: iso(now + 4 * HOUR) },
      { id: 'raid-soon', title: 'Raid', status: 'open', starts_at: iso(now + 2 * HOUR) },
      { id: 'raid-started', title: 'Raid', status: 'open', starts_at: iso(now - 60_000) },
      { id: 'wg-closed', title: 'War Games', status: 'closed', starts_at: iso(now + HOUR) },
    ];
    const due = await createEventSignups(fakeSupabase(rows)).dueToClose();
    assert.deepEqual(due.map((r) => r.id).sort(), ['raid-started', 'wg-soon']);
  });
});

describe('join', () => {
  test('refuses War Games past the cutoff, before the sweep has closed it', async () => {
    const rpcCalls = [];
    const rows = [{ id: 'wg', title: 'War Games', status: 'open', starts_at: iso(Date.now() + 2 * HOUR) }];
    const signups = createEventSignups(fakeSupabase(rows, rpcCalls));
    await assert.rejects(
      signups.join({ id: 'wg', discordId: 'ana', displayName: 'Ana' }),
      (err) => err.status === 409 && /closed 3 hours before it starts/.test(err.message),
    );
    assert.equal(rpcCalls.length, 0);
  });

  test('lets members in before the cutoff, and other events up to the start', async () => {
    const rpcCalls = [];
    const rows = [
      { id: 'wg', title: 'War Games', status: 'open', starts_at: iso(Date.now() + 4 * HOUR) },
      { id: 'raid', title: 'Raid', status: 'open', starts_at: iso(Date.now() + 30 * 60_000) },
    ];
    const signups = createEventSignups(fakeSupabase(rows, rpcCalls));
    await signups.join({ id: 'wg', discordId: 'ana', displayName: 'Ana' });
    await signups.join({ id: 'raid', discordId: 'ana', displayName: 'Ana' });
    assert.equal(rpcCalls.length, 2);
  });
});
