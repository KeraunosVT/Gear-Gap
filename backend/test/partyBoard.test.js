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

  test('pips read tanks, DPS, healers, then no role', () => {
    const roles = { a: 'Healer', b: 'DPS', c: undefined, d: 'Tank' };
    assert.deepEqual(pb.partyMakeup(['a', 'b', 'c', 'd'], roles).pips, ['Tank', 'DPS', 'Healer', null]);
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

  test('splits the pool into a box per role, with no role apart', () => {
    assert.deepEqual(pb.poolView(['a', 'b', 'c', 'd'], opts()), {
      Tank: ['a'], Healer: [], DPS: ['c', 'b'], none: ['d'],
    });
  });

  test('within a box, going first, then waitlist, then everyone else by name', () => {
    const r = { a: 'DPS', b: 'DPS', c: 'DPS', d: 'DPS' };
    const v = pb.poolView(['a', 'b', 'c', 'd'], opts({ roleOf: (id) => r[id] }));
    assert.deepEqual(v.DPS, ['c', 'd', 'b', 'a']);
  });

  test('search and Signed up only narrow every box', () => {
    const v = pb.poolView(['a', 'b', 'c', 'd'], opts({ signedOnly: true, query: 'mor' }));
    assert.deepEqual(v, { Tank: [], Healer: [], DPS: ['c'], none: [] });
  });
});

describe('rosterForOccasion', () => {
  const TUE = '2026-11-17';
  const SAT = '2026-11-21';
  // Newest first, as the API returns them.
  const saved = [
    { id: 'raid-copy', event_date: TUE, event_schedule_id: 'raid' },
    { id: 'raid', event_date: TUE, event_schedule_id: 'raid' },
    { id: 'boss', event_date: TUE, event_schedule_id: 'boss' },
    { id: 'fight', event_date: SAT, signup_event_id: 'ff' },
    { id: 'old', event_date: null },
  ];

  test('a weekly event opens the newest roster linked to it', () => {
    assert.equal(pb.rosterForOccasion(saved, TUE, 'raid').id, 'raid-copy');
    assert.equal(pb.rosterForOccasion(saved, TUE, 'boss').id, 'boss');
  });

  test('a one-off event opens its roster by signup id', () => {
    assert.equal(pb.rosterForOccasion(saved, SAT, 'signup:ff').id, 'fight');
    assert.equal(pb.rosterForOccasion(saved, SAT, 'signup:other'), null);
  });

  test('All events opens the only roster on a night, but not one of several', () => {
    assert.equal(pb.rosterForOccasion(saved, SAT, '').id, 'fight');
    assert.equal(pb.rosterForOccasion(saved, TUE, ''), null);
  });

  test('All events prefers a roster saved for the whole night', () => {
    const night = [...saved, { id: 'whole', event_date: TUE, event_schedule_id: null }];
    assert.equal(pb.rosterForOccasion(night, TUE, '').id, 'whole');
  });

  test('the same event on another night opens nothing', () => {
    assert.equal(pb.rosterForOccasion(saved, '2026-11-24', 'raid'), null);
    assert.equal(pb.rosterForOccasion(saved, '', ''), null);
  });
});

describe('loadsAsCopy', () => {
  const TUE = '2026-11-17';
  const raidTue = { id: 'r', event_date: TUE, event_schedule_id: 'raid' };

  test("an event's own roster opens as itself", () => {
    assert.equal(pb.loadsAsCopy(raidTue, TUE, 'raid'), false);
    assert.equal(pb.loadsAsCopy({ id: 'f', event_date: TUE, signup_event_id: 'ff' }, TUE, 'signup:ff'), false);
  });

  test('any other roster is copied into the picked event', () => {
    assert.equal(pb.loadsAsCopy(raidTue, TUE, 'boss'), true, 'another event that night');
    assert.equal(pb.loadsAsCopy(raidTue, '2026-11-24', 'raid'), true, 'the same event another week');
    assert.equal(pb.loadsAsCopy({ id: 'w', event_date: TUE, event_schedule_id: null }, TUE, 'raid'), true, 'a whole-night roster');
    assert.equal(pb.loadsAsCopy({ id: 'old', event_date: null }, TUE, 'raid'), true, 'saved with no occasion');
  });

  test('with All events picked, everything opens as itself', () => {
    assert.equal(pb.loadsAsCopy(raidTue, TUE, ''), false);
    assert.equal(pb.loadsAsCopy(raidTue, '2026-11-24', ''), false);
  });

  test('no roster, no copy', () => {
    assert.equal(pb.loadsAsCopy(undefined, TUE, 'raid'), false);
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
