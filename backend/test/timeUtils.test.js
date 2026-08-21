// backend/test/timeUtils.test.js — the frontend's pure date helpers.
//
// Lives under backend/test because that is where `npm test` looks; the module
// under test is ESM, so it comes in through a dynamic import. Nothing here
// touches the DOM or the network.
//
// Covers the helpers that were duplicated across pages until they moved here —
// getting one of these wrong doesn't throw, it shows a member the wrong count
// or the wrong night.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let tu;

before(async () => {
  tu = await import(pathToFileURL(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'timeUtils.js'),
  ).href);
  tu.configureGuildTime('America/New_York', '01:00');
});

describe('addDays', () => {
  test('walks forward and back', () => {
    assert.equal(tu.addDays('2026-08-22', 1), '2026-08-23');
    assert.equal(tu.addDays('2026-08-22', -1), '2026-08-21');
    assert.equal(tu.addDays('2026-08-22', 0), '2026-08-22');
  });

  test('crosses month and year boundaries', () => {
    assert.equal(tu.addDays('2026-08-31', 1), '2026-09-01');
    assert.equal(tu.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(tu.addDays('2027-01-01', -1), '2026-12-31');
  });

  test('handles a leap day', () => {
    assert.equal(tu.addDays('2028-02-28', 1), '2028-02-29');
    assert.equal(tu.addDays('2028-02-29', 1), '2028-03-01');
  });

  test('crossing a DST boundary does not lose or gain a day', () => {
    // The reason it is anchored at noon UTC. US DST springs forward on
    // 2026-03-08; a midnight anchor can land on the wrong side of it.
    assert.equal(tu.addDays('2026-03-07', 1), '2026-03-08');
    assert.equal(tu.addDays('2026-03-08', 1), '2026-03-09');
    assert.equal(tu.addDays('2026-11-01', 1), '2026-11-02');
  });

  test('seven single steps equal one step of seven', () => {
    let a = '2026-08-22';
    for (let i = 0; i < 7; i += 1) a = tu.addDays(a, 1);
    assert.equal(a, tu.addDays('2026-08-22', 7));
  });
});

describe('loaStillApplies', () => {
  const TODAY = '2026-08-22';

  test('a recurring absence never expires', () => {
    // It has no end date by design, so anything looking for one drops it.
    assert.equal(tu.loaStillApplies({ type: 'recurring', day_of_week: 3 }, TODAY), true);
  });

  test('a single event counts today and later, not yesterday', () => {
    assert.equal(tu.loaStillApplies({ type: 'event', event_date: TODAY }, TODAY), true);
    assert.equal(tu.loaStillApplies({ type: 'event', event_date: '2026-08-23' }, TODAY), true);
    assert.equal(tu.loaStillApplies({ type: 'event', event_date: '2026-08-21' }, TODAY), false);
  });

  test('a range counts while today is on or before its last day', () => {
    assert.equal(tu.loaStillApplies({ type: 'range', start_date: '2026-08-01', end_date: TODAY }, TODAY), true);
    assert.equal(tu.loaStillApplies({ type: 'range', start_date: '2026-09-01', end_date: '2026-09-05' }, TODAY), true);
    assert.equal(tu.loaStillApplies({ type: 'range', start_date: '2026-08-01', end_date: '2026-08-21' }, TODAY), false);
  });

  test('a missing date is treated as expired, not as forever', () => {
    assert.equal(tu.loaStillApplies({ type: 'event' }, TODAY), false);
    assert.equal(tu.loaStillApplies({ type: 'range' }, TODAY), false);
    assert.equal(tu.loaStillApplies({ type: 'nonsense' }, TODAY), false);
  });
});

describe('eventsForGuildDay', () => {
  // Saturday = 6. The 00:30 event is STORED on Sunday (0) but belongs to
  // Saturday night, which is the whole reason this isn't a day_of_week filter.
  const SCHEDULE = [
    { id: 'a', name: 'Riftstone', day_of_week: 6, event_time: '21:00' },
    { id: 'b', name: 'Field Boss', day_of_week: 0, event_time: '00:30' },
    { id: 'c', name: 'Sunday Siege', day_of_week: 0, event_time: '20:00' },
    { id: 'd', name: 'Untimed', day_of_week: 6, event_time: null },
  ];

  test('Saturday night pulls in the Sunday 00:30 row', () => {
    const ids = tu.eventsForGuildDay(SCHEDULE, 6).map((e) => e.id);
    assert.deepEqual(ids, ['d', 'a', 'b'], 'untimed first, then 21:00, then 00:30');
  });

  test('Sunday night excludes the 00:30 row it stores', () => {
    const ids = tu.eventsForGuildDay(SCHEDULE, 0).map((e) => e.id);
    assert.deepEqual(ids, ['c']);
  });

  test('00:30 sorts after 21:00, not before', () => {
    const times = tu.eventsForGuildDay(SCHEDULE, 6).map((e) => e.event_time);
    assert.deepEqual(times, [null, '21:00', '00:30']);
  });

  test('an empty schedule is not an error', () => {
    assert.deepEqual(tu.eventsForGuildDay([], 6), []);
    assert.deepEqual(tu.eventsForGuildDay(null, 6), []);
  });
});
