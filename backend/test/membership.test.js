// backend/test/membership.test.js — the Members page's three lists: who's in
// now, who left, and who was in on a given night.
//
// The date view has to agree with attendance about who counted on a night, and
// the roster has to trust Discord over a tenure row that hasn't caught up yet.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { assemble, membersOn, compare } = require('../membership');
const { permissionForPath } = require('../permissions');

// Midday UTC lands on the same guild night whatever the guild's timezone and
// day-start, so these dates read back unchanged.
const at = (date) => `${date}T16:00:00.000Z`;
const row = (id, since, left = null, username = `user${id}`) => ({
  discord_id: id, since: at(since), left_at: left ? at(left) : null, source: 'sweep', discord_username: username,
});
const noAliases = (_id, fallback) => fallback;

describe('assemble', () => {
  test('the roster is the live Discord list, with join dates from tenure', () => {
    const members = [{ id: '2', name: 'Bea', username: 'bea' }, { id: '1', name: 'Ann', username: 'ann' }];
    const { active } = assemble(members, [row('1', '2026-09-01')], noAliases);
    assert.deepEqual(active.map((m) => [m.name, m.since]), [['Ann', '2026-09-01'], ['Bea', null]]);
  });

  test('a member back before the sweep has noticed gets no start date', () => {
    const members = [{ id: '1', name: 'Ann', username: 'ann' }];
    const { active, past } = assemble(members, [row('1', '2026-09-01', '2026-10-01')], noAliases);
    assert.equal(active[0].since, null);
    assert.deepEqual(past, [], 'not listed as a former member while in the live list');
  });

  test('former members, most recent departure first, named by alias over username', () => {
    const rows = [row('1', '2026-01-01', '2026-03-01'), row('2', '2026-01-01', '2026-06-01'), row('3', '2026-01-01')];
    const nameFor = (id, fallback) => (id === '2' ? 'Alias Two' : fallback);
    const { past } = assemble([{ id: '3', name: 'Cy' }], rows, nameFor);
    assert.deepEqual(past.map((p) => [p.name, p.until]), [['Alias Two', '2026-06-01'], ['user1', '2026-03-01']]);
  });

  test('without Discord, the roster falls back to the open tenure rows', () => {
    const rows = [row('1', '2026-01-01'), row('2', '2026-01-01', '2026-02-01')];
    const { active, past } = assemble(null, rows, noAliases);
    assert.deepEqual(active.map((m) => m.discord_id), ['1']);
    assert.deepEqual(past.map((m) => m.discord_id), ['2']);
  });
});

describe('membersOn', () => {
  const { entries } = assemble(null, [
    row('1', '2026-01-01'),
    row('2', '2026-01-01', '2026-03-01'),
    row('3', '2026-04-01'),
  ], noAliases);

  test('counts the join and leave nights themselves, like attendance does', () => {
    assert.deepEqual(membersOn(entries, '2026-01-01').map((m) => m.discord_id), ['1', '2']);
    assert.deepEqual(membersOn(entries, '2026-03-01').map((m) => m.discord_id), ['1', '2']);
    assert.deepEqual(membersOn(entries, '2026-03-02').map((m) => m.discord_id), ['1']);
    assert.deepEqual(membersOn(entries, '2026-04-01').map((m) => m.discord_id), ['1', '3']);
  });

  test('nobody before the first join', () => {
    assert.deepEqual(membersOn(entries, '2025-12-31'), []);
  });
});

describe('compare', () => {
  // On 2026-03-01: Ann, Bea, Cy. Now: Ann, Bea, Dee. Bea is back after a
  // return the sweep hasn't stamped, so her current row has no start date.
  const rows = [
    row('1', '2026-01-01', null, 'ann'),
    row('2', '2026-01-01', '2026-04-01', 'bea'),
    row('3', '2026-01-01', '2026-05-01', 'cy'),
    row('4', '2026-06-01', null, 'dee'),
  ];
  const members = [{ id: '1', name: 'ann' }, { id: '4', name: 'dee' }, { id: '2', name: 'bea' }];
  const { active, entries } = assemble(members, rows, noAliases);
  const result = compare(active, membersOn(entries, '2026-03-01'));

  test('changes first — left, then joined — then everyone on both', () => {
    assert.deepEqual(result.map((r) => [r.name, r.status]),
      [['cy', 'left'], ['dee', 'joined'], ['ann', 'stayed'], ['bea', 'stayed']]);
  });

  test('a member on both keeps their current row', () => {
    const ann = result.find((r) => r.name === 'ann');
    assert.equal(ann.since, '2026-01-01');
    assert.equal(ann.until, null);
  });

  test('a return not yet recorded borrows the night\'s start date and reads as still in', () => {
    const bea = result.find((r) => r.name === 'bea');
    assert.equal(bea.since, '2026-01-01');
    assert.equal(bea.until, null);
  });

  test('a member who left keeps the night\'s row, with when they left', () => {
    assert.equal(result.find((r) => r.name === 'cy').until, '2026-05-01');
  });

  test('a night before anyone joined makes everyone a joiner', () => {
    assert.ok(compare(active, membersOn(entries, '2025-12-01')).every((r) => r.status === 'joined'));
  });
});

test('/membership is gated on parties, not the shared /members read', () => {
  assert.equal(permissionForPath('/membership'), 'parties');
  assert.equal(permissionForPath('/members'), permissionForPath('/whoami'));
});
