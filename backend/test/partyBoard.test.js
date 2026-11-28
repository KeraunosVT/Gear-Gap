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

describe('boardFromLayout', () => {
  const PARTY_IDS = ['p1', 'p2', 'p12'];
  const layout = {
    parties: [
      { id: 'p1', name: 'Frontline', members: [{ id: 'a', name: 'Ann' }, { id: 'gone', name: 'Left Guild' }] },
      { id: 'p9', name: 'Not on this board', members: [{ id: 'b', name: 'Bo' }] },
    ],
    absent: [{ id: 'c', name: 'Cy', why: 'loa' }, { id: 'd', name: 'Di' }],
    classAssignments: { pvp: { a: 'Greatsword' }, pve: {} },
    rolesByMode: { pvp: { a: 'Tank' }, pve: { a: 'DPS' } },
  };
  const opts = (isOut) => ({ partyIds: PARTY_IDS, memberIds: ['a', 'b', 'c', 'd', 'e', 'f'], isOut });

  test('seats who the layout seated, and puts everyone else in the pool', () => {
    const b = pb.boardFromLayout(layout, opts());
    assert.deepEqual(b.items.p1, ['a', 'gone']);
    assert.deepEqual(b.items.p2, []);
    assert.deepEqual(b.items.absent, ['c', 'd']);
    // b was in a party this board doesn't have, so they're unplaced.
    assert.deepEqual(b.items.pool, ['b', 'e', 'f']);
    assert.deepEqual(b.names, { p1: 'Frontline' });
  });

  test('only members the layout left unplaced go to Absent for being out', () => {
    const b = pb.boardFromLayout(layout, opts((id) => id === 'a' || id === 'e'));
    assert.deepEqual(b.items.p1, ['a', 'gone']); // seated and out: left for the officer
    assert.deepEqual(b.items.absent, ['c', 'd', 'e']);
    assert.deepEqual(b.items.pool, ['b', 'f']);
  });

  test('someone no longer in the member list keeps their seat, flagged missing', () => {
    const b = pb.boardFromLayout(layout, opts());
    assert.deepEqual(b.extra, { gone: { id: 'gone', name: 'Left Guild', missing: true } });
  });

  test('Absent reasons, classes and per-mode roles come back with it', () => {
    const b = pb.boardFromLayout(layout, opts());
    assert.deepEqual(b.absentWhy, { c: 'loa', d: 'benched' });
    assert.deepEqual(b.classAssignments, layout.classAssignments);
    assert.deepEqual(b.rolesByMode, layout.rolesByMode);
  });

  test('a layout from before roles were split by mode applies its flat role to both', () => {
    const old = { parties: [{ id: 'p1', members: [{ id: 'a', role: 'Healer' }] }] };
    const b = pb.boardFromLayout(old, opts());
    assert.deepEqual(b.rolesByMode, { pvp: { a: 'Healer' }, pve: { a: 'Healer' } });
    assert.deepEqual(b.classAssignments, { pvp: {}, pve: {} });
  });

  test('no layout at all is an empty board with everyone in the pool', () => {
    const b = pb.boardFromLayout(undefined, opts());
    assert.deepEqual(b.items.pool, ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.deepEqual(b.items.absent, []);
  });
});

describe('layoutSummary', () => {
  test('counts people seated in parties, not the standby group', () => {
    const layout = {
      parties: [
        { id: 'p1', members: [{ id: 'a' }, { id: 'b' }] },
        { id: 'p2', members: [] },
        { id: 'p3', members: [{ id: 'c' }] },
        { id: 'p12', members: [{ id: 'd' }, { id: 'e' }] },
      ],
    };
    assert.deepEqual(pb.layoutSummary(layout, { fillId: 'p12' }), { seated: 3, parties: 2 });
  });

  test('a missing layout is empty', () => {
    assert.deepEqual(pb.layoutSummary(null, { fillId: 'p12' }), { seated: 0, parties: 0 });
  });
});

describe('fromDefaultName', () => {
  test('names the board for the event and the night', () => {
    assert.equal(pb.fromDefaultName({ eventName: 'Siege', modeLabel: 'PvP', date: '2026-11-28' }), 'Siege · Nov 28');
  });

  test('falls back to the mode with no event picked', () => {
    assert.equal(pb.fromDefaultName({ eventName: '', modeLabel: 'PvE', date: '2026-11-28' }), 'PvE · Nov 28');
  });
});
