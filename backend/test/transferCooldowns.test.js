// backend/test/transferCooldowns.test.js — server transfer cooldowns.
//
// Members type the days and hours the game shows; what matters is that it
// becomes the right end time, that nothing over 30 days gets in, and that a
// member only ever writes their own row.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createTransferCooldowns = require('../transferCooldowns');
const { cooldownEnd } = createTransferCooldowns;

const NOW = Date.parse('2026-11-07T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const refused = (fn, re) => assert.throws(fn, (err) => err.status === 400 && re.test(err.message));

describe('cooldownEnd', () => {
  test('days and hours left become an end time', () => {
    assert.equal(cooldownEnd({ days: 12, hours: 5 }, NOW).getTime(), NOW + 12 * DAY + 5 * HOUR);
    assert.equal(cooldownEnd({ days: '3', hours: '' }, NOW).getTime(), NOW + 3 * DAY);
    assert.equal(cooldownEnd({ hours: 7 }, NOW).getTime(), NOW + 7 * HOUR);
  });

  test('30 days is allowed; a minute more is not', () => {
    assert.equal(cooldownEnd({ days: 30 }, NOW).getTime(), NOW + 30 * DAY);
    refused(() => cooldownEnd({ days: 30, hours: 1 }, NOW), /more than 30 days/);
    refused(() => cooldownEnd({ days: 31 }, NOW), /more than 30 days/);
  });

  test('nothing left, fractions, negatives and hours past 23 are refused', () => {
    refused(() => cooldownEnd({ days: 0, hours: 0 }, NOW), /how long is left/);
    refused(() => cooldownEnd({}, NOW), /how long is left/);
    refused(() => cooldownEnd({ days: 1.5 }, NOW), /whole numbers/);
    refused(() => cooldownEnd({ days: -2 }, NOW), /whole numbers/);
    refused(() => cooldownEnd({ days: 'soon' }, NOW), /whole numbers/);
    refused(() => cooldownEnd({ hours: 24 }, NOW), /23 or less/);
  });
});

// Records every write so a test can see whose row it touched.
function fakeSupabase(writes) {
  return {
    from() {
      const q = {
        upsert: (row) => { writes.push({ op: 'upsert', row }); q._row = row; return q; },
        delete: () => { writes.push({ op: 'delete' }); return q; },
        eq: (f, v) => { writes[writes.length - 1].where = [f, v]; return q; },
        select: () => q,
        single: async () => ({ data: q._row, error: null }),
        then: (resolve) => Promise.resolve({ error: null }).then(resolve),
      };
      return q;
    },
  };
}

describe('setMine / clearMine', () => {
  test("saves the member's own row with the computed end", async () => {
    const writes = [];
    const saved = await createTransferCooldowns(fakeSupabase(writes)).setMine('111', 'Ana', { days: 2, hours: 3 }, NOW);
    assert.equal(writes[0].row.discord_id, '111');
    assert.equal(saved.ends_at, new Date(NOW + 2 * DAY + 3 * HOUR).toISOString());
  });

  test('refuses over 30 days without writing anything', async () => {
    const writes = [];
    await assert.rejects(
      createTransferCooldowns(fakeSupabase(writes)).setMine('111', 'Ana', { days: 45 }, NOW),
      (err) => err.status === 400,
    );
    assert.equal(writes.length, 0);
  });

  test('clears only the given member', async () => {
    const writes = [];
    await createTransferCooldowns(fakeSupabase(writes)).clearMine('111');
    assert.deepEqual(writes[0].where, ['discord_id', '111']);
  });

  test('no signed-in member, no write', async () => {
    const writes = [];
    const tc = createTransferCooldowns(fakeSupabase(writes));
    await assert.rejects(tc.setMine(undefined, 'x', { days: 1 }), (err) => err.status === 401);
    await assert.rejects(tc.clearMine(undefined), (err) => err.status === 401);
    assert.equal(writes.length, 0);
  });
});
