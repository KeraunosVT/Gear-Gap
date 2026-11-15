// backend/test/shardPriority.test.js — the Priority tab's rules: request keys,
// what survives a save, when a confirmation still holds, and the Discord post.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  keyOf, parseKey, cleanList, cleanWeaponOrder, cleanBossOrder, liveRequests, liveList, isConfirmed, escapeMd, buildPost,
} = require('../shardPriority');
const { permissionForPath } = require('../permissions');

const A = '111111111111111111';
const B = '222222222222222222';
const wish = (weapons) => ({ v: 2, weapons, unlinked: {} });
const W = (boss, weapon, build, need) => ({ boss, weapon, build, need, priority: '', updated: null });

describe('request keys', () => {
  test('a key is a member, a source and one of its weapons', () => {
    assert.deepEqual(parseKey(keyOf(A, 'Tevent', 'Inferno Fangs')), { discordId: A, boss: 'Tevent', weapon: 'Inferno Fangs' });
    assert.equal(parseKey(`${A}|Tevent|Heroic Orb`), null, 'weapon from another source');
    assert.equal(parseKey(`not-an-id|Tevent|Inferno Fangs`), null);
    assert.equal(parseKey(`${A}|Tevent`), null);
    assert.equal(parseKey(42), null);
  });

  test('cleanList keeps the given order, drops junk and repeats', () => {
    const k1 = keyOf(A, 'Tevent', 'Inferno Fangs');
    const k2 = keyOf(B, 'Heroic', 'Heroic Orb');
    assert.deepEqual(cleanList([k2, 'junk', k1, k2]), [k2, k1]);
    assert.deepEqual(cleanList('nope'), []);
  });
});

describe('table order', () => {
  test('weapon order keeps known bosses and only their own weapons', () => {
    assert.deepEqual(
      cleanWeaponOrder({ Tevent: ['Inferno Fangs', 'Heroic Orb', 'Inferno Fangs'], Nobody: ['x'], Heroic: 'Heroic Orb' }),
      { Tevent: ['Inferno Fangs'] },
    );
    assert.deepEqual(cleanWeaponOrder(['Tevent']), {});
  });

  test('boss order keeps known bosses once each', () => {
    assert.deepEqual(cleanBossOrder(['Heroic', 'Nobody', 'Tevent', 'Heroic']), ['Heroic', 'Tevent']);
  });
});

describe('live requests', () => {
  const live = liveRequests([
    { discordId: A, shards: wish([W('Tevent', 'Inferno Fangs', 'PvP', 62), W('Heroic', 'Heroic Orb', '', 60)]) },
    { discordId: B, shards: wish([W('Cordy', "Giant Cordy's Snowsoul Orb", 'PvE', 90)]) },
  ]);

  test('only PvP and PvE weapons are requests, each with its shard and cost', () => {
    assert.equal(live.size, 2);
    const snow = live.get(keyOf(B, 'Cordy', "Giant Cordy's Snowsoul Orb"));
    assert.equal(snow.shard, 'thunderstruck_giant_tree_branch');
    assert.equal(snow.cost, 90);
    assert.equal(live.has(keyOf(A, 'Heroic', 'Heroic Orb')), false, 'untagged build is on neither side');
  });

  test('a saved entry whose weapon was unlinked drops out of the list', () => {
    const gone = keyOf(B, 'Tevent', 'Inferno Fangs');
    assert.deepEqual(liveList([gone, keyOf(A, 'Tevent', 'Inferno Fangs')], live), [keyOf(A, 'Tevent', 'Inferno Fangs')]);
  });
});

describe('confirmations', () => {
  test('hold only for the need they confirmed', () => {
    assert.equal(isConfirmed({ need: 62 }, 62), true);
    assert.equal(isConfirmed({ need: 62 }, 40), false, 'member changed their number since');
    assert.equal(isConfirmed(undefined, 62), false);
    assert.equal(isConfirmed({ need: 0 }, null), false, 'an unset need cannot be confirmed');
  });
});

describe('the Discord post', () => {
  const kA = keyOf(A, 'Tevent', 'Inferno Fangs');
  const kB = keyOf(B, 'Heroic', 'Heroic Orb');
  const live = liveRequests([
    { discordId: A, shards: wish([W('Tevent', 'Inferno Fangs', 'PvP', 62)]) },
    { discordId: B, shards: wish([W('Heroic', 'Heroic Orb', 'PvE', 24)]) },
  ]);
  const names = { [A]: 'Sel_ka', [B]: 'Nyx' };
  const nameFor = (id) => names[id];

  test('one line per ranked request, in order, marking what is confirmed', () => {
    const { messages, count } = buildPost({
      list: [kB, kA], live, nameFor, confirmations: new Map([[kA, { need: 62 }], [kB, { need: 30 }]]),
    });
    assert.equal(count, 2);
    assert.equal(messages.length, 1);
    const lines = messages[0].content.split('\n');
    assert.match(lines[0], /Shard priority/);
    assert.equal(lines[1], "1. Nyx (PvE) · Otherworldly Mind's Eye · Heroic Orb · needs 24/60 · not confirmed");
    assert.equal(lines[2], '2. Sel\\_ka (PvP) · Tevent Ashen · Inferno Fangs · needs 62/90 ✓');
    assert.deepEqual(messages[0].allowed_mentions, { parse: [] }, 'nobody is pinged without mention');
  });

  test('mention pings exactly the members listed', () => {
    const { messages } = buildPost({ list: [kA], live, nameFor, confirmations: new Map(), mention: true });
    assert.match(messages[0].content, new RegExp(`<@${A}>`));
    assert.deepEqual(messages[0].allowed_mentions, { parse: [], users: [A] });
  });

  test('a long list is split under Discord\'s 2,000-character limit', () => {
    const many = [];
    const rows = [];
    for (let i = 0; i < 80; i++) {
      const id = String(300000000000000000n + BigInt(i));
      many.push({ discordId: id, shards: wish([W('Tevent', 'Inferno Fangs', 'PvP', 50)]) });
      rows.push(keyOf(id, 'Tevent', 'Inferno Fangs'));
    }
    const bigLive = liveRequests(many);
    const { messages, count } = buildPost({ list: rows, live: bigLive, nameFor: () => 'A Fairly Long Member Name', confirmations: new Map() });
    assert.equal(count, 80);
    assert.ok(messages.length > 1);
    messages.forEach((m) => assert.ok(m.content.length <= 2000));
    const total = messages.map((m) => m.content).join('\n').split('\n').filter((l) => /^\d+\. /.test(l)).length;
    assert.equal(total, 80, 'no line lost between messages');
  });

  test('markdown in names is escaped', () => {
    assert.equal(escapeMd('*a*_b_`c`'), '\\*a\\*\\_b\\_\\`c\\`');
  });
});

test('the routes are loot officers only', () => {
  assert.equal(permissionForPath('/shard-priority'), 'loot.awards');
  assert.equal(permissionForPath('/shard-priority/post'), 'loot.awards');
});
