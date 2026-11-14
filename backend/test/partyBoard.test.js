// backend/test/partyBoard.test.js — the Parties board's pure helpers.
//
// The module is frontend ESM, loaded the same way lootCandidates.test.js loads
// its subject. These decide what an officer sees as a party's makeup, who is
// at the top of the pool, and whether the board says "Unsaved changes".

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pb;
before(async () => {
  pb = await import(pathToFileURL(path.join(__dirname, '../../frontend/src/partyBoard.js')).href);
});

describe('partyMakeup', () => {
  test('an empty party misses nothing and has six open seats', () => {
    const m = pb.partyMakeup([], {});
    assert.deepEqual(m.pips, []);
    assert.deepEqual(m.missing, []);
    assert.deepEqual(m.seats, [null, null, null, null, null, null]);
    assert.equal(m.full, false);
  });

  test('pips read tanks, healers, DPS, then no role', () => {
    const roles = { a: 'DPS', b: 'Healer', c: undefined, d: 'Tank' };
    assert.deepEqual(pb.partyMakeup(['a', 'b', 'c', 'd'], roles).pips, ['Tank', 'Healer', 'DPS', null]);
  });

  test('names the missing roles in the first free seats', () => {
    const m = pb.partyMakeup(['a', 'b'], { a: 'DPS', b: 'DPS' });
    assert.deepEqual(m.missing, ['Tank', 'Healer']);
    assert.deepEqual(m.seats, ['Tank', 'Healer', null, null]);
  });

  test('a full party with no healer still says so, with no seats left', () => {
    const roles = { a: 'Tank', b: 'DPS', c: 'DPS', d: 'DPS', e: 'DPS', f: 'DPS' };
    const m = pb.partyMakeup(['a', 'b', 'c', 'd', 'e', 'f'], roles);
    assert.equal(m.full, true);
    assert.deepEqual(m.missing, ['Healer']);
    assert.deepEqual(m.seats, []);
  });
});

describe('poolView', () => {
  const names = { a: 'Vexa', b: 'Ash', c: 'Morrow', d: 'Brenn' };
  const roles = { a: 'Tank', b: 'DPS', c: 'DPS' };
  const signups = { c: 'going', d: 'waitlist' };
  const opts = (extra = {}) => ({
    nameOf: (id) => names[id], roleOf: (id) => roles[id], signupOf: (id) => signups[id], ...extra,
  });

  test('going first, then waitlist, then everyone else by name', () => {
    assert.deepEqual(pb.poolView(['a', 'b', 'c', 'd'], opts()).list, ['c', 'd', 'b', 'a']);
  });

  test('role chip filters the list but counts cover every chip', () => {
    const v = pb.poolView(['a', 'b', 'c', 'd'], opts({ role: 'DPS' }));
    assert.deepEqual(v.list, ['c', 'b']);
    assert.deepEqual(v.counts, { all: 4, none: 1, Tank: 1, Healer: 0, DPS: 2 });
  });

  test('No role chip shows members without a role', () => {
    assert.deepEqual(pb.poolView(['a', 'b', 'c', 'd'], opts({ role: 'none' })).list, ['d']);
  });

  test('search and Signed up only narrow the counts too', () => {
    const v = pb.poolView(['a', 'b', 'c', 'd'], opts({ signedOnly: true, query: 'mor' }));
    assert.deepEqual(v.list, ['c']);
    assert.equal(v.counts.all, 1);
    assert.equal(v.counts.DPS, 1);
  });
});

describe('boardSignature', () => {
  const base = () => ({
    items: { pool: ['z'], absent: ['y'], p1: ['a', 'b'], p2: [] },
    partyIds: ['p1', 'p2'],
    partyNames: { p1: 'Party 1', p2: 'Party 2' },
    classAssignments: { pvp: { a: 'SnS' }, pve: {} },
    rosterName: 'Siege',
    date: '2026-11-15',
    event: '',
  });

  test('the pool does not count', () => {
    const b = base(); b.items = { ...b.items, pool: ['z', 'x'] };
    assert.equal(pb.boardSignature(b), pb.boardSignature(base()));
  });

  test('moving someone between parties does', () => {
    const b = base(); b.items = { ...b.items, p1: ['a'], p2: ['b'] };
    assert.notEqual(pb.boardSignature(b), pb.boardSignature(base()));
  });

  test('order within a party counts, as it does on the posted roster', () => {
    const b = base(); b.items = { ...b.items, p1: ['b', 'a'] };
    assert.notEqual(pb.boardSignature(b), pb.boardSignature(base()));
  });

  test('class picks compare by value, not by the order they were made', () => {
    const a = base(); a.classAssignments = { pvp: { a: 'SnS', b: 'Bow' }, pve: {} };
    const b = base(); b.classAssignments = { pvp: { b: 'Bow', a: 'SnS', c: '' }, pve: {} };
    assert.equal(pb.boardSignature(a), pb.boardSignature(b));
  });

  test('renaming the roster, a party, or moving the date counts', () => {
    const ref = pb.boardSignature(base());
    assert.notEqual(pb.boardSignature({ ...base(), rosterName: 'War' }), ref);
    assert.notEqual(pb.boardSignature({ ...base(), partyNames: { p1: 'Tanks', p2: 'Party 2' } }), ref);
    assert.notEqual(pb.boardSignature({ ...base(), date: '2026-11-16' }), ref);
  });
});
