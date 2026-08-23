// backend/test/feudRoster.test.js — who gets marked as a threat, and why.
//
// The failure mode here is not an error, it is a badge on the wrong person.
// A sheet that marks half of every roster is worse than one that marks nobody,
// because it still looks like it is telling you something.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { foldRoster, median, STANDOUT_RATIO } = require('../feudRoster');

const ENEMY = 'Iron Covenant';
const classify = (w1, w2) => (w1 ? `${w1}/${w2}` : 'Unknown');

// One row per (player, own_guild, weapon pair) — what the SQL returns.
const row = (player, over = {}) => ({
  player_name: player,
  own_guild: ENEMY,
  weapon_1: 'Greatsword',
  weapon_2: 'Dagger',
  appearances: 10,
  kills: 100,
  damage_dealt: 10_000_000,
  damage_taken: 5_000_000,
  healing: 0,
  ...over,
});

const fold = (rows, opts = {}) => foldRoster(rows, { enemyGuild: ENEMY, classify, ...opts });
const byName = (out) => Object.fromEntries(out.players.map((p) => [p.player_name, p]));

describe('median', () => {
  test('odd and even counts', () => {
    assert.equal(median([1, 2, 3]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  test('an empty population is zero, not NaN', () => {
    assert.equal(median([]), 0);
  });

  test('one extreme value does not drag it', () => {
    // The whole reason this isn't a mean: with a mean of [1,1,1,1,100] = 20.8,
    // nobody else could ever clear 2x and the outlier hides everyone.
    assert.equal(median([1, 1, 1, 1, 100]), 1);
  });
});

describe('rates', () => {
  test('divide by appearances, not by the guild total', () => {
    const out = fold([
      row('Vex', { appearances: 10, kills: 100 }),
      row('Corvin', { appearances: 5, kills: 60 }),
    ]);
    const p = byName(out);
    assert.equal(p.Vex.per_match.kills, 10);
    assert.equal(p.Corvin.per_match.kills, 12, 'fewer matches, better rate');
  });

  test('totals are kept alongside the rates', () => {
    const out = fold([row('Vex', { appearances: 4, kills: 40, healing: 8 })]);
    const p = byName(out).Vex;
    assert.equal(p.kills, 40);
    assert.equal(p.appearances, 4);
    assert.equal(p.per_match.kills, 10);
  });

  test('a player who switched weapons folds into one row', () => {
    const out = fold([
      row('Vex', { weapon_1: 'Staff', weapon_2: 'Wand', appearances: 8, kills: 40 }),
      row('Vex', { weapon_1: 'Greatsword', weapon_2: 'Dagger', appearances: 2, kills: 20 }),
    ]);
    assert.equal(out.players.length, 1);
    const p = out.players[0];
    assert.equal(p.appearances, 10);
    assert.equal(p.kills, 60);
    assert.equal(p.main_class, 'Staff/Wand', 'the commonest pair, not the last seen');
  });
});

describe('who gets marked', () => {
  test('a guild where everyone is equal marks nobody', () => {
    // The case a leaderboard gets wrong: it would crown whoever sorted first.
    const out = fold(['A', 'B', 'C', 'D', 'E'].map((n) => row(n)));
    assert.deepEqual(out.players.filter((p) => p.standout).map((p) => p.player_name), []);
  });

  test('a guild with three carries marks all three', () => {
    const out = fold([
      row('Vex', { kills: 300 }), row('Corvin', { kills: 300 }), row('Rell', { kills: 280 }),
      row('D', { kills: 100 }), row('E', { kills: 100 }), row('F', { kills: 90 }), row('G', { kills: 100 }),
    ]);
    const marked = out.players.filter((p) => p.standout?.kills).map((p) => p.player_name).sort();
    assert.deepEqual(marked, ['Corvin', 'Rell', 'Vex']);
  });

  test('the ratio is reported, not just the fact', () => {
    const out = fold([
      row('Vex', { kills: 300 }),
      row('B', { kills: 100 }), row('C', { kills: 100 }), row('D', { kills: 100 }),
    ]);
    assert.equal(byName(out).Vex.standout.kills, 3, '30 k/match against a median of 10');
  });

  test('exactly at the threshold counts', () => {
    const out = fold([
      row('Vex', { kills: 200 }),
      row('B', { kills: 100 }), row('C', { kills: 100 }), row('D', { kills: 100 }),
    ]);
    assert.equal(byName(out).Vex.standout?.kills, STANDOUT_RATIO);
  });

  test('healing marks a healer even in a guild of none', () => {
    // The point of ranking on the stat rather than the class: only 11 of the
    // game's 45 classes have a role mapping anywhere in this app.
    const out = fold([
      row('Sable', { healing: 50_000_000 }),
      row('B', { healing: 1_000_000 }), row('C', { healing: 1_000_000 }), row('D', { healing: 1_000_000 }),
    ]);
    assert.ok(byName(out).Sable.standout?.healing);
    assert.ok(!byName(out).B.standout, 'the rest stay quiet');
  });

  test('a guild that does no healing produces no healing marks', () => {
    // Median zero would otherwise make every player Infinity times it.
    const out = fold(['A', 'B', 'C', 'D'].map((n) => row(n, { healing: 0 })));
    assert.equal(out.medians.healing, 0);
    assert.ok(out.players.every((p) => !p.standout?.healing));
  });
});

describe('the population the median describes', () => {
  test('a player under the appearance floor is listed but never marked', () => {
    const out = fold([
      row('Fluke', { appearances: 1, kills: 90 }), // 90 k/match, absurd
      row('B', { kills: 100 }), row('C', { kills: 100 }), row('D', { kills: 100 }),
    ], { minAppearances: 3 });
    const p = byName(out);
    assert.ok(p.Fluke, 'still listed');
    assert.equal(p.Fluke.standout, undefined, 'one match proves nothing');
  });

  test('one-match subs do not drag the median down', () => {
    // Without the floor, thirty players at 0.1 k/match make the median ~0.1
    // and every regular becomes an "outlier".
    const padding = Array.from({ length: 30 }, (_, i) => row(`Sub${i}`, { appearances: 1, kills: 0 }));
    const out = fold([
      ...padding,
      row('A', { kills: 100 }), row('B', { kills: 100 }), row('C', { kills: 100 }), row('D', { kills: 100 }),
    ]);
    assert.equal(out.eligible_count, 4, 'only the regulars set the standard');
    assert.equal(out.medians.kills, 10);
    assert.deepEqual(out.players.filter((p) => p.standout).map((p) => p.player_name), []);
  });

  test('a borrowed player does not move the median', () => {
    const own = ['A', 'B', 'C'].map((n) => row(n, { kills: 100 }));
    const withSub = fold([...own, row('Guest', { own_guild: 'Ashen Court', kills: 1000 })]);
    const withoutSub = fold(own);
    assert.equal(withSub.medians.kills, withoutSub.medians.kills);
    assert.equal(withSub.eligible_count, 3, 'the guest is not one of their standard');
  });

  test('a borrowed player can still be marked', () => {
    // "They borrowed someone who wrecked us" is worth knowing, and the sub tag
    // is right there for the reader to discount it.
    const out = fold([
      row('A', { kills: 100 }), row('B', { kills: 100 }), row('C', { kills: 100 }),
      row('Guest', { own_guild: 'Ashen Court', kills: 500 }),
    ]);
    const guest = byName(out).Guest;
    assert.equal(guest.sub_for, 'Ashen Court');
    assert.equal(guest.standout?.kills, 5);
  });

  test("a player of this guild has no sub tag", () => {
    assert.equal(byName(fold([row('Vex')])).Vex.sub_for, null);
  });
});

describe('the rest of the payload', () => {
  test('class mix counts appearances, commonest first', () => {
    const out = fold([
      row('A', { weapon_1: 'Staff', weapon_2: 'Wand', appearances: 10 }),
      row('B', { weapon_1: 'Staff', weapon_2: 'Wand', appearances: 5 }),
      row('C', { weapon_1: 'Greatsword', weapon_2: 'Dagger', appearances: 8 }),
    ]);
    assert.deepEqual(out.class_mix, [
      { name: 'Staff/Wand', count: 15 },
      { name: 'Greatsword/Dagger', count: 8 },
    ]);
  });

  test('players come back most-seen first', () => {
    const out = fold([
      row('Rare', { appearances: 2 }),
      row('Regular', { appearances: 20 }),
      row('Sometimes', { appearances: 9 }),
    ]);
    assert.deepEqual(out.players.map((p) => p.player_name), ['Regular', 'Sometimes', 'Rare']);
  });

  test('the threshold and population are reported so the page can explain itself', () => {
    const out = fold(['A', 'B', 'C'].map((n) => row(n)));
    assert.equal(out.standout_ratio, STANDOUT_RATIO);
    assert.equal(out.min_appearances, 3);
    assert.equal(out.eligible_count, 3);
  });

  test('no rows is empty, not an error', () => {
    const out = fold([]);
    assert.deepEqual(out.players, []);
    assert.deepEqual(out.class_mix, []);
    assert.equal(out.eligible_count, 0);
  });
});
