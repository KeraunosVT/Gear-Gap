// backend/test/playerStats.test.js — the profile aggregation.
//
// The reported bug was "clicking a member doesn't show all their matches". The
// cause was a `.in('guild_name', ourNames)` filter in SQL: any row recorded
// under a spelling the alias list didn't carry was gone, and the profile came
// back short with nothing saying why. These hold the fixed behaviour — the rows
// are still not counted, but they are counted SEPARATELY and reported.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { aggregatePlayerRows } = require('../playerStats');

const OURS = new Set(['FTP', 'For The Plot']);
const classify = (w1, w2) => (w1 ? `${w1}/${w2}` : 'Unknown');

const row = (over = {}) => ({
  guild_name: 'FTP',
  rank: 1,
  weapon_1: 'Greatsword',
  weapon_2: 'Dagger',
  kills: 10,
  assists: 5,
  damage_dealt: 1_000_000,
  damage_taken: 500_000,
  healing: 0,
  wargame_matches: { id: 'm1', title: 'Siege', match_date: '2026-08-20' },
  ...over,
});

describe('aggregatePlayerRows', () => {
  test('sums the rows that are ours', () => {
    const out = aggregatePlayerRows([row(), row({ kills: 4 })], OURS, classify);
    assert.equal(out.matches, 2);
    assert.equal(out.kills, 14);
    assert.equal(out.assists, 10);
    assert.equal(out.damage_dealt, 2_000_000);
  });

  test('every alias counts, not just the current name', () => {
    const out = aggregatePlayerRows(
      [row(), row({ guild_name: 'For The Plot' })], OURS, classify,
    );
    assert.equal(out.matches, 2);
    assert.equal(out.excluded.other_guilds.length, 0);
  });

  test('a row under an unclaimed guild name is reported, not silently dropped', () => {
    // The bug. 'FTP ' with a trailing space is exactly what a misread
    // scoreboard produces, and it used to make the match disappear.
    const out = aggregatePlayerRows(
      [row(), row({ guild_name: 'FTP ' }), row({ guild_name: 'FTP ' })],
      OURS, classify,
    );
    assert.equal(out.matches, 1, 'totals still only count ours');
    assert.deepEqual(out.excluded.other_guilds, [{ guild_name: 'FTP ', matches: 2 }]);
  });

  test('several unclaimed spellings are listed commonest first', () => {
    const out = aggregatePlayerRows([
      row({ guild_name: 'Rival' }),
      row({ guild_name: 'FTP ' }),
      row({ guild_name: 'FTP ' }),
      row({ guild_name: 'FTP ' }),
    ], OURS, classify);
    assert.deepEqual(out.excluded.other_guilds, [
      { guild_name: 'FTP ', matches: 3 },
      { guild_name: 'Rival', matches: 1 },
    ]);
  });

  test('a null guild name is reported as Unknown rather than crashing', () => {
    const out = aggregatePlayerRows([row({ guild_name: null })], OURS, classify);
    assert.deepEqual(out.excluded.other_guilds, [{ guild_name: 'Unknown', matches: 1 }]);
  });

  test('a row whose match record is missing is skipped, not thrown on', () => {
    // The embed is a LEFT join, so this arrives as null. Reading `.id` off it
    // used to 500 the entire profile over one orphaned row.
    const out = aggregatePlayerRows(
      [row(), row({ wargame_matches: null })], OURS, classify,
    );
    assert.equal(out.matches, 1);
    assert.equal(out.excluded.orphaned, 1);
    assert.equal(out.kills, 10, 'the orphan contributes nothing to the totals');
  });

  test('match history is newest first', () => {
    const out = aggregatePlayerRows([
      row({ wargame_matches: { id: 'a', title: 'Old', match_date: '2026-01-01' } }),
      row({ wargame_matches: { id: 'b', title: 'New', match_date: '2026-08-01' } }),
      row({ wargame_matches: { id: 'c', title: 'Mid', match_date: '2026-05-01' } }),
    ], OURS, classify);
    assert.deepEqual(out.matchHistory.map((m) => m.title), ['New', 'Mid', 'Old']);
  });

  test('averages divide by matches counted, not rows received', () => {
    // Three rows in, one of them another guild's — the average must be over 2.
    const out = aggregatePlayerRows(
      [row({ kills: 10 }), row({ kills: 20 }), row({ kills: 999, guild_name: 'Rival' })],
      OURS, classify,
    );
    assert.equal(out.matches, 2);
    assert.equal(out.avg_kills, 15);
  });

  test('class breakdown counts only our rows, commonest first', () => {
    const out = aggregatePlayerRows([
      row({ weapon_1: 'Staff', weapon_2: 'Wand' }),
      row({ weapon_1: 'Staff', weapon_2: 'Wand' }),
      row({ weapon_1: 'Greatsword', weapon_2: 'Dagger' }),
      row({ weapon_1: 'Longbow', weapon_2: 'Dagger', guild_name: 'Rival' }),
    ], OURS, classify);
    assert.deepEqual(out.classBreakdown, [
      { name: 'Staff/Wand', count: 2 },
      { name: 'Greatsword/Dagger', count: 1 },
    ]);
  });

  test('a player with only other-guild rows reports them and totals nothing', () => {
    // Worth a profile rather than a 404: this is the state that tells an
    // officer the alias list is wrong.
    const out = aggregatePlayerRows([row({ guild_name: 'Rival' })], OURS, classify);
    assert.equal(out.matches, 0);
    assert.equal(out.kills, 0);
    assert.equal(out.avg_kills, 0, 'no division by zero');
    assert.equal(out.excluded.other_guilds[0].matches, 1);
  });

  test('no rows at all is empty, not an error', () => {
    const out = aggregatePlayerRows([], OURS, classify);
    assert.equal(out.matches, 0);
    assert.deepEqual(out.excluded, { other_guilds: [], orphaned: 0 });
  });
});
