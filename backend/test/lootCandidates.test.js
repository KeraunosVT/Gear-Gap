// backend/test/lootCandidates.test.js — the Loot Council candidate ordering.
//
// The module is frontend ESM, loaded the same way timeUtils.test.js loads its
// subject. The order is what an officer reads top to bottom when choosing who
// gets an item, so a wrong comparison here quietly changes who looks owed.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let lc;

before(async () => {
  lc = await import(pathToFileURL(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'lootCandidates.js'),
  ).href);
});

const w = (discord_id, priority, added_at = '2026-10-01T00:00:00Z') => ({ discord_id, name: discord_id, priority, added_at });
const stats = (rows) => new Map(Object.entries(rows).map(([id, [rate, items]]) => [id, { rate, items, attended: 0, eligible: 0 }]));
const order = (rows) => rows.map((r) => r.discord_id);

describe('rankCandidates', () => {
  test('groups by build in priority order before anything else', () => {
    const rows = lc.rankCandidates(
      [w('pve', 'PvE'), w('second', 'Second Build'), w('pvp', 'PvP')],
      stats({ pve: [100, 0], second: [100, 0], pvp: [10, 9] }),
    );
    assert.deepEqual(order(rows), ['pvp', 'second', 'pve']);
  });

  test('within a build: attendance, then fewest items, then earliest wish', () => {
    const rows = lc.rankCandidates(
      [w('late', 'PvP', '2026-10-09T00:00:00Z'), w('early', 'PvP', '2026-10-02T00:00:00Z'),
        w('greedy', 'PvP'), w('absent', 'PvP')],
      stats({ late: [90, 0], early: [90, 0], greedy: [90, 3], absent: [40, 0] }),
    );
    assert.deepEqual(order(rows), ['early', 'late', 'greedy', 'absent']);
  });

  test('members without stats sort after those with them', () => {
    const rows = lc.rankCandidates([w('unknown', 'PvP'), w('known', 'PvP')], stats({ known: [20, 5] }));
    assert.deepEqual(order(rows), ['known', 'unknown']);
    assert.equal(rows[1].rate, null);
    assert.equal(rows[1].items, null);
  });

  test('marks most owed only when two or more want it for the top build', () => {
    const contested = lc.rankCandidates([w('a', 'PvP'), w('b', 'PvP')], stats({ a: [90, 0], b: [80, 0] }));
    assert.deepEqual(contested.map((r) => r.mostOwed), [true, false]);

    // Only one person wants it for PvP; the PvE pair below doesn't count,
    // because the star is about the build that's first in line.
    const alone = lc.rankCandidates([w('a', 'PvP'), w('b', 'PvE'), w('c', 'PvE')], stats({ a: [90, 0], b: [80, 0], c: [70, 0] }));
    assert.ok(alone.every((r) => !r.mostOwed));
  });

  test('no star without stats', () => {
    const rows = lc.rankCandidates([w('a', 'PvP'), w('b', 'PvP')], null);
    assert.ok(rows.every((r) => !r.mostOwed));
  });

  test('carries each member\'s last award', () => {
    const last = lc.lastAwardMap([
      { discord_id: 'a', awarded_at: '2026-10-01T00:00:00Z' },
      { discord_id: 'a', awarded_at: '2026-11-09T00:00:00Z' },
      { discord_id: 'a', awarded_at: '2026-10-20T00:00:00Z' },
    ]);
    const [row] = lc.rankCandidates([w('a', 'PvP')], null, last);
    assert.equal(row.lastAward, '2026-11-09T00:00:00Z');
  });
});
