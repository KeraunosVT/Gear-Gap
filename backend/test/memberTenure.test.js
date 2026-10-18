// backend/test/memberTenure.test.js — when each member joined, which is where
// every attendance denominator starts.
//
// A wrong `since` doesn't error, it quietly rewrites someone's rate — so most
// of this is about which date wins on backfill, and when the sweep must NOT
// stamp someone as having left.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const createMemberTenure = require('../memberTenure');
const { countsFor } = createMemberTenure;

// Just enough of the supabase-js builder for member_tenure: a paged select,
// upsert on discord_id, and update().eq().
function fakeSupabase(tables) {
  return {
    from(name) {
      let op = 'select';
      let payload = null;
      const q = {
        select() { op = 'select'; return q; },
        order() { return q; },
        range(from, to) {
          return Promise.resolve({ data: tables[name].slice(from, to + 1), error: null });
        },
        upsert(rows) {
          rows.forEach((r) => {
            const i = tables[name].findIndex((x) => x.discord_id === r.discord_id);
            if (i >= 0) tables[name][i] = { ...tables[name][i], ...r };
            else tables[name].push({ ...r });
          });
          return Promise.resolve({ error: null });
        },
        update(obj) { op = 'update'; payload = obj; return q; },
        eq(col, val) {
          if (op === 'update') {
            tables[name].forEach((r, i) => { if (r[col] === val) tables[name][i] = { ...r, ...payload }; });
          }
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
  };
}

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();

let tables;
let members;
let grants;
let tenure;

beforeEach(() => {
  tables = { member_tenure: [] };
  members = [];
  grants = new Map();
  tenure = createMemberTenure(fakeSupabase(tables), async () => members, {
    fetchRoleGrants: async () => grants,
  });
});

const rowOf = (id) => tables.member_tenure.find((r) => r.discord_id === id);

describe('countsFor', () => {
  test('no tenure row means no cutoff', () => {
    assert.equal(countsFor(undefined, '2026-01-01'), true);
  });

  test('nights before joining do not count; the joining night does', () => {
    const t = { since: '2026-10-10', until: null };
    assert.equal(countsFor(t, '2026-10-09'), false);
    assert.equal(countsFor(t, '2026-10-10'), true);
    assert.equal(countsFor(t, '2026-10-16'), true);
  });

  test('nights after leaving do not count', () => {
    const t = { since: '2026-09-01', until: '2026-10-01' };
    assert.equal(countsFor(t, '2026-10-01'), true);
    assert.equal(countsFor(t, '2026-10-02'), false);
  });
});

describe('sweep: backfilling new members', () => {
  test('audit-log grant beats server join date, which beats now', async () => {
    const grantAt = Date.now() - 3 * DAY;
    const joinAt = Date.now() - 400 * DAY;
    grants.set('granted', grantAt);
    members = [
      { id: 'granted', joinedAt: iso(joinAt) }, // in Discord a year, role 3 days ago
      { id: 'joined', joinedAt: iso(joinAt) },
      { id: 'bare' },
    ];
    const before = Date.now();
    await tenure.sweep();

    assert.equal(rowOf('granted').since, iso(grantAt));
    assert.equal(rowOf('granted').source, 'audit_log');
    assert.equal(rowOf('joined').since, iso(joinAt));
    assert.equal(rowOf('joined').source, 'discord_join');
    assert.equal(rowOf('bare').source, 'sweep');
    assert.ok(new Date(rowOf('bare').since).getTime() >= before);
  });

  test('a known member is left alone', async () => {
    const since = iso(Date.now() - 50 * DAY);
    tables.member_tenure.push({ discord_id: 'a', since, source: 'discord_join', left_at: null });
    members = [{ id: 'a', joinedAt: iso(Date.now() - 900 * DAY) }];
    grants.set('a', Date.now() - DAY);
    await tenure.sweep();
    assert.equal(rowOf('a').since, since, 'an existing stretch is never re-dated');
  });

  test('an audit-log failure falls back instead of failing the sweep', async () => {
    const joinAt = Date.now() - 20 * DAY;
    tenure = createMemberTenure(fakeSupabase(tables), async () => [{ id: 'a', joinedAt: iso(joinAt) }], {
      fetchRoleGrants: async () => { throw new Error('rate limited'); },
    });
    await tenure.sweep();
    assert.equal(rowOf('a').source, 'discord_join');
  });
});

describe('sweep: leaving', () => {
  beforeEach(() => {
    ['a', 'b', 'c', 'd'].forEach((id) => tables.member_tenure.push({
      discord_id: id, since: iso(Date.now() - 100 * DAY), source: 'discord_join', left_at: null,
    }));
    members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  });

  test('one missed sweep is not leaving', async () => {
    members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    await tenure.sweep();
    assert.equal(rowOf('d').left_at, null);
  });

  test('two missed sweeps stamps left_at with the first miss', async () => {
    members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const firstMiss = Date.now();
    await tenure.sweep();
    const out = await tenure.sweep();
    assert.deepEqual(out.left, ['d']);
    const left = new Date(rowOf('d').left_at).getTime();
    assert.ok(left >= firstMiss && left <= firstMiss + 1000, 'stamped at the first miss, not the second');
  });

  test('coming back between sweeps resets the grace', async () => {
    members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    await tenure.sweep();
    members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    await tenure.sweep();
    members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    await tenure.sweep();
    assert.equal(rowOf('d').left_at, null, 'the role came back, so the clock restarted');
  });

  test('half the guild vanishing at once stamps nobody', async () => {
    members = [{ id: 'a' }];
    await tenure.sweep();
    const out = await tenure.sweep();
    assert.equal(out.skipped, 'mass departure');
    ['b', 'c', 'd'].forEach((id) => assert.equal(rowOf(id).left_at, null));
  });

  test('an empty member list changes nothing', async () => {
    members = [];
    await tenure.sweep();
    const out = await tenure.sweep();
    assert.equal(out.skipped, 'empty member list');
    tables.member_tenure.forEach((r) => assert.equal(r.left_at, null));
  });
});

describe('sweep: coming back', () => {
  const leftAt = Date.now() - 30 * DAY;
  beforeEach(() => {
    tables.member_tenure.push({
      discord_id: 'a', since: iso(Date.now() - 200 * DAY), source: 'discord_join', left_at: iso(leftAt),
    });
    members = [{ id: 'a', joinedAt: iso(Date.now() - 500 * DAY) }];
  });

  test('a grant after they left starts the new stretch', async () => {
    const regrant = leftAt + 5 * DAY;
    grants.set('a', regrant);
    await tenure.sweep();
    assert.equal(rowOf('a').since, iso(regrant));
    assert.equal(rowOf('a').left_at, null);
  });

  test('without one, the stretch starts now — never the old join date', async () => {
    grants.set('a', leftAt - DAY); // the old grant, from before they left
    const before = Date.now();
    await tenure.sweep();
    assert.ok(new Date(rowOf('a').since).getTime() >= before);
    assert.equal(rowOf('a').source, 'sweep');
  });
});
