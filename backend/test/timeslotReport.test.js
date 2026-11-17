// backend/test/timeslotReport.test.js — attendance and LOA by hour of the night
// (guild clock: America/New_York, day_start 01:00 — guildConfig's defaults).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildTimeslotReport, UNKNOWN } = require('../timeslotReport');

const schedule = [
  { id: 'wargame', name: 'Wargame', event_time: '21:00' },
  { id: 'siege', name: 'Siege', event_time: '21:30' },
  { id: 'boss', name: 'Field Boss', event_time: '00:30' },
  { id: 'ab', name: 'Archboss', event_time: '20:00' },
];
const people = [{ id: 'ana', name: 'Ana' }, { id: 'bo', name: 'Bo' }, { id: 'cy', name: 'Cy' }];

const events = [
  { id: 1, title: 'Wargame', event_date: '2026-11-03', event_schedule_id: 'wargame' },
  { id: 2, title: 'Siege', event_date: '2026-11-05', event_schedule_id: 'siege' },
  { id: 3, title: 'Field Boss', event_date: '2026-11-07', event_schedule_id: 'boss' },
  // A one-off snapped at 10:40 PM ET that night (EST, UTC-5).
  { id: 4, title: 'Siege practice', event_date: '2026-11-08', event_schedule_id: null, created_at: '2026-11-09T03:40:00Z' },
  // A one-off logged two days later: no usable time.
  { id: 5, title: 'Pickup raid', event_date: '2026-11-10', event_schedule_id: null, created_at: '2026-11-12T20:00:00Z' },
  { id: 6, title: 'Archboss', event_date: '2026-11-11', event_schedule_id: 'ab' },
];
const attendance = [
  { event_id: 1, discord_id: 'ana' }, { event_id: 1, discord_id: 'bo' },
  { event_id: 2, discord_id: 'ana' },
  { event_id: 3, discord_id: 'cy' },
  { event_id: 4, discord_id: 'bo' },
  { event_id: 6, discord_id: 'ana' }, { event_id: 6, discord_id: 'bo' }, { event_id: 6, discord_id: 'cy' },
];

const report = (over = {}) => buildTimeslotReport({
  events, attendance, schedule, people,
  tenures: new Map(), loaByEvent: new Map([['2', new Set(['bo'])], ['3', new Set(['ana'])]]),
  ...over,
});
const slot = (slots, key) => slots.find((s) => s.key === key);

describe('buildTimeslotReport', () => {
  test('a 9:00 and a 9:30 start share the 9–10 PM hour', () => {
    const nine = slot(report(), '21');
    assert.equal(nine.nights, 2);
    assert.deepEqual(nine.events.map((e) => e.name).sort(), ['Siege', 'Wargame']);
    // Wargame: ana, bo there, cy missed. Siege: ana there, bo on LOA, cy missed.
    assert.deepEqual([nine.attended, nine.loa, nine.missed], [3, 1, 2]);
    assert.deepEqual([nine.attended_pct, nine.loa_pct, nine.missed_pct], [50, 17, 33]);
    assert.equal(nine.avg_present, 1.5);
  });

  test('hours run in night order: evening, then after midnight, unknown last', () => {
    assert.deepEqual(report().map((s) => s.key), ['20', '21', '22', '0', UNKNOWN]);
  });

  test('a one-off takes the hour attendance was taken, on the same night', () => {
    const ten = slot(report(), '22');
    assert.deepEqual(ten.events, [{ name: 'Siege practice', nights: 1 }]);
    assert.equal(ten.attended, 1);
  });

  test('a one-off logged on another day has no hour', () => {
    const unknown = slot(report(), UNKNOWN);
    assert.equal(unknown.hour, null);
    assert.deepEqual(unknown.events, [{ name: 'Pickup raid', nights: 1 }]);
    assert.equal(unknown.missed, 3);
  });

  test('nights before someone joined do not count for them, unless they attended', () => {
    const tenures = new Map([['cy', { since: '2026-11-04', until: null }]]);
    const nine = slot(report({ tenures }), '21');
    // cy's 3 Nov Wargame drops out; their 5 Nov Siege miss stays.
    assert.deepEqual([nine.attended, nine.loa, nine.missed], [3, 1, 1]);
  });

  test('per-member breakdown, most missed first', () => {
    const nine = slot(report(), '21');
    assert.deepEqual(nine.members.map((m) => m.discord_id), ['cy', 'bo', 'ana']);
    const bo = nine.members.find((m) => m.discord_id === 'bo');
    assert.deepEqual([bo.attended, bo.loa, bo.missed, bo.attended_pct], [1, 1, 0, 50]);
  });

  test('no events, no hours', () => {
    assert.deepEqual(report({ events: [] }), []);
  });
});
