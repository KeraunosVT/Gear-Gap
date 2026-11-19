// backend/test/shardWishlist.test.js — the weapon-linked shard wishlist, and
// the reading of old per-type rows into it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  read, normalize, keepPriorities, stampChanges, hidePriorities, cleanRanking, shardFor, costFor, applyGrant,
} = require('../shardWishlist');

const W = (boss, weapon, extra = {}) => ({ boss, weapon, build: '', ...extra });
const needOf = (s, weapon) => s.weapons.find((w) => w.weapon === weapon)?.need;

describe('shardFor / costFor', () => {
  test('Snowsoul weapons use their boss\'s Thunderstruck shard', () => {
    assert.equal(shardFor('Cordy', "Giant Cordy's Snowsoul Wand"), 'thunderstruck_giant_tree_branch');
    assert.equal(shardFor('Cordy', "Cordy's Source of Contagion"), 'scorched_branches');
    assert.equal(shardFor('Deluzhnoa', "Deluzhnoa's Snowsoul Bow"), 'thunderstruck_snow_flowers');
    assert.equal(shardFor('Deluzhnoa', "Deluzhnoa's Icy Grasp"), 'scorched_frostblooms');
  });

  test('archboss weapons cost 90, Heroic 60', () => {
    assert.equal(costFor('Tevent'), 90);
    assert.equal(costFor('Heroic'), 60);
    assert.equal(shardFor('Heroic', 'Heroic Orb'), 'otherworldly_minds_eye');
  });
});

describe('normalize', () => {
  test('caps need at the weapon\'s cost and drops unknown or repeated weapons', () => {
    const s = normalize({ weapons: [
      W('Tevent', 'Inferno Fangs', { need: 500 }),
      W('Heroic', 'Heroic Orb', { need: 80 }),
      W('Tevent', 'Inferno Fangs', { need: 10 }),
      W('Tevent', 'Not A Weapon', { need: 10 }),
    ] });
    assert.deepEqual(s.weapons.map((w) => [w.weapon, w.need]), [['Inferno Fangs', 90], ['Heroic Orb', 60]]);
  });

  test('keeps an unset need as null rather than 0', () => {
    assert.equal(normalize({ weapons: [W('Tevent', 'Inferno Fangs')] }).weapons[0].need, null);
  });

  test('priority is high, low or normal — anything else is normal', () => {
    const s = normalize({ weapons: [
      W('Tevent', 'Inferno Fangs', { priority: 'high' }),
      W('Heroic', 'Heroic Orb', { priority: 'low' }),
      W('Heroic', 'Heroic Staff', { priority: 'urgent' }),
    ] });
    assert.deepEqual(s.weapons.map((w) => w.priority), ['high', 'low', '']);
  });

  test('class is one of the Builds page\'s classes — anything else is blank', () => {
    const s = normalize({ weapons: [
      W('Tevent', 'Inferno Fangs', { class: 'Ravager' }),
      W('Heroic', 'Heroic Orb', { class: 'Not A Class' }),
      W('Heroic', 'Heroic Staff'),
    ] });
    assert.deepEqual(s.weapons.map((w) => w.class), ['Ravager', '', '']);
  });
});

describe('stampChanges', () => {
  const OLD = '2026-10-01T00:00:00.000Z';
  const NOW = '2026-10-23T12:00:00.000Z';
  const stored = { v: 2, unlinked: {}, weapons: [
    W('Tevent', 'Inferno Fangs', { need: 90, updated: OLD }),
    W('Heroic', 'Heroic Orb', { need: 60, updated: OLD }),
  ] };

  test('a changed need is stamped now; an unchanged one keeps its date', () => {
    const sent = normalize({ weapons: [
      W('Tevent', 'Inferno Fangs', { need: 45, updated: OLD }),
      W('Heroic', 'Heroic Orb', { need: 60, priority: 'high', updated: NOW }),
    ] });
    assert.deepEqual(stampChanges(sent, stored, NOW).weapons.map((w) => w.updated), [NOW, OLD]);
  });

  test('a newly linked weapon is stamped; the client\'s date is never trusted', () => {
    const sent = normalize({ weapons: [W('Tevent', 'Grasp of Cremation', { need: 90, updated: OLD })] });
    assert.equal(stampChanges(sent, stored, NOW).weapons[0].updated, NOW);
  });
});

describe('keepPriorities', () => {
  test('a member\'s save can\'t change priority, add it, or carry it to a new weapon', () => {
    const stored = { v: 2, weapons: [W('Tevent', 'Inferno Fangs', { need: 90, priority: 'low' })], unlinked: {} };
    const sent = normalize({ weapons: [
      W('Tevent', 'Inferno Fangs', { need: 40, priority: 'high' }),
      W('Heroic', 'Heroic Orb', { need: 60, priority: 'high' }),
    ] });
    const s = keepPriorities(sent, stored);
    assert.deepEqual(s.weapons.map((w) => [w.weapon, w.need, w.priority]), [['Inferno Fangs', 40, 'low'], ['Heroic Orb', 60, '']]);
  });

  test('hidePriorities blanks every priority and touches nothing else', () => {
    const s = normalize({ weapons: [W('Tevent', 'Inferno Fangs', { need: 30, priority: 'high' })] });
    assert.deepEqual(hidePriorities(s).weapons[0], { ...s.weapons[0], priority: '' });
  });

  test('no stored row means everything is normal', () => {
    const s = keepPriorities(normalize({ weapons: [W('Tevent', 'Inferno Fangs', { priority: 'high' })] }), null);
    assert.equal(s.weapons[0].priority, '');
  });
});

describe('read — old rows', () => {
  test('a count with one weapon to claim it goes onto that weapon', () => {
    const s = read({ tevent_ashen: 60, weapons: [W('Tevent', 'Inferno Fangs', { build: 'PvP' })] });
    assert.equal(needOf(s, 'Inferno Fangs'), 60);
    assert.equal(s.weapons[0].build, 'PvP');
    assert.deepEqual(s.unlinked, {});
  });

  test('anything over that weapon\'s cost stays unlinked', () => {
    const s = read({ thunderstruck_snow_flowers: 200, weapons: [W('Deluzhnoa', "Deluzhnoa's Snowsoul Bow")] });
    assert.equal(needOf(s, "Deluzhnoa's Snowsoul Bow"), 90);
    assert.deepEqual(s.unlinked, { thunderstruck_snow_flowers: 110 });
  });

  test('several weapons filled exactly by the count are each full', () => {
    const s = read({ tevent_ashen: 180, weapons: [W('Tevent', 'Inferno Fangs'), W('Tevent', 'Grasp of Cremation')] });
    assert.equal(needOf(s, 'Inferno Fangs'), 90);
    assert.equal(needOf(s, 'Grasp of Cremation'), 90);
    assert.deepEqual(s.unlinked, {});
  });

  test('several weapons and a count that could split either way: left for the member', () => {
    const s = read({ tevent_ashen: 60, weapons: [W('Tevent', 'Inferno Fangs'), W('Tevent', 'Grasp of Cremation')] });
    assert.equal(needOf(s, 'Inferno Fangs'), null);
    assert.equal(needOf(s, 'Grasp of Cremation'), null);
    assert.deepEqual(s.unlinked, { tevent_ashen: 60 });
  });

  test('a count with no weapon to claim it stays unlinked', () => {
    const s = read({ otherworldly_minds_eye: 40, queen_ashen_carapace: 0, weapons: [] });
    assert.deepEqual(s.unlinked, { otherworldly_minds_eye: 40 });
  });

  test('Snowsoul and Scorched counts are not confused for one another', () => {
    const s = read({ scorched_branches: 30, weapons: [W('Cordy', "Giant Cordy's Snowsoul Orb")] });
    assert.equal(needOf(s, "Giant Cordy's Snowsoul Orb"), null);
    assert.deepEqual(s.unlinked, { scorched_branches: 30 });
  });

  test('a v2 row is read as it is', () => {
    const stored = { v: 2, weapons: [W('Heroic', 'Heroic Staff', { need: 25 })], unlinked: { tevent_ashen: 5 } };
    assert.deepEqual(read(stored), normalize(stored));
    assert.equal(needOf(read(stored), 'Heroic Staff'), 25);
  });
});

describe('cleanRanking', () => {
  test('keeps real weapons in the order given, across bosses', () => {
    const ranking = ['Cordy|' + require('../../shared/archbossWeapons.json').Cordy[0], 'Tevent|Warblade of Incineration'];
    assert.deepEqual(cleanRanking(ranking), ranking);
  });

  test('drops unknown weapons, repeats and non-strings', () => {
    assert.deepEqual(
      cleanRanking(['Tevent|Warblade of Incineration', 'Tevent|Not A Weapon', 'Tevent|Warblade of Incineration', 7, null]),
      ['Tevent|Warblade of Incineration'],
    );
  });

  test('anything that isn\'t a list is an empty ranking', () => {
    assert.deepEqual(cleanRanking(undefined), []);
    assert.deepEqual(cleanRanking('Tevent|Warblade of Incineration'), []);
  });
});

// Shards an officer gives come off the member's list. Two Tevent weapons share
// Tevent Ashen; Queen Bellandir's weapon takes a different shard.
describe('applyGrant', () => {
  const NOW = '2026-11-16T12:00:00.000Z';
  const list = () => ({
    v: 2,
    weapons: [
      W('Tevent', 'Warblade of Incineration', { need: 60 }),
      W('Tevent', 'Inferno Fangs', { need: 30 }),
      W('Queen Bellandir', 'Incandescent Blade', { need: 90 }),
    ],
    unlinked: {},
  });
  const give = (amount, target = null, stored = list()) => applyGrant(stored, { shard: 'tevent_ashen', amount, target }, NOW);

  test('comes off the picked weapon and stamps it', () => {
    const r = give(20, 'Tevent|Inferno Fangs');
    assert.equal(needOf(r.shards, 'Inferno Fangs'), 10);
    assert.equal(needOf(r.shards, 'Warblade of Incineration'), 60);
    assert.equal(r.shards.weapons.find((w) => w.weapon === 'Inferno Fangs').updated, NOW);
    assert.deepEqual(r.applied, [{ boss: 'Tevent', weapon: 'Inferno Fangs', from: 30, to: 10 }]);
  });

  test('a weapon brought to 0 comes off the list', () => {
    const r = give(30, 'Tevent|Inferno Fangs');
    assert.equal(r.shards.weapons.some((w) => w.weapon === 'Inferno Fangs'), false);
    assert.deepEqual(r.removed, [{ boss: 'Tevent', weapon: 'Inferno Fangs' }]);
    assert.equal(r.shards.weapons.length, 2);
  });

  test('more than the picked weapon needs spills onto their other weapons on that shard', () => {
    const r = give(50, 'Tevent|Inferno Fangs');
    assert.equal(r.shards.weapons.some((w) => w.weapon === 'Inferno Fangs'), false);
    assert.equal(needOf(r.shards, 'Warblade of Incineration'), 40);
    assert.equal(r.unused, 0);
  });

  test('with no pick, it goes down the list in order', () => {
    const r = give(10);
    assert.equal(needOf(r.shards, 'Warblade of Incineration'), 50);
    assert.equal(needOf(r.shards, 'Inferno Fangs'), 30);
  });

  test("never touches a weapon on another shard, and reports what nothing needed", () => {
    const r = give(200);
    assert.equal(needOf(r.shards, 'Incandescent Blade'), 90);
    assert.deepEqual(r.shards.weapons.map((w) => w.weapon), ['Incandescent Blade']);
    assert.equal(r.unused, 110);
  });

  test('an unset need is left alone; an unlinked count takes what the weapons did not', () => {
    const stored = { v: 2, weapons: [W('Tevent', 'Inferno Fangs', { need: null })], unlinked: { tevent_ashen: 25 } };
    const r = give(10, null, stored);
    assert.equal(needOf(r.shards, 'Inferno Fangs'), null);
    assert.equal(r.shards.unlinked.tevent_ashen, 15);
    assert.equal(r.fromUnlinked, 10);
  });
});
