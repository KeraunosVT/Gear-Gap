// backend/test/timeslotReport.test.js — attendance and LOA by weekly event slot.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildTimeslotReport, ONE_OFF } = require('../timeslotReport');

const schedule = [
  { id: 'sat-late', name: 'Field Boss', day_of_week: 0, event_time: '00:30' }, // Saturday night
  { id: 'tue', name: 'Wargame', day_of_week: 2, event_time: '21:00' },
  { id: 'tue-early', name: 'Archboss', day_of_week: 2, event_time: '19:00' },
];
const people = [{ id: 'ana', name: 'Ana' }, { id: 'bo', name: 'Bo' }, { id: 'cy', name: 'Cy' }];

const events = [
  { id: 1, title: 'Wargame', event_date: '2026-11-03', event_schedule_id: 'tue' },
  { id: 2, title: 'Wargame', event_date: '2026-11-10', event_schedule_id: 'tue' },
  { id: 3, title: 'Field Boss', event_date: '2026-11-07', event_schedule_id: 'sat-late' },
  { id: 4, title: 'Siege practice', event_date: '2026-11-08', event_schedule_id: null },
  { id: 5, title: 'Old raid', event_date: '2026-11-05', event_schedule_id: 'gone' },
];
const attendance = [
  { event_id: 1, discord_id: 'ana' }, { event_id: 1, discord_id: 'bo' },
  { event_id: 2, discord_id: 'ana' },
  { event_id: 3, discord_id: 'cy' },
  { event_id: 4, discord_id: 'bo' },
];

const report = (over = {}) => buildTimeslotReport({
  events, attendance, schedule, people,
  tenures: new Map(), loaByEvent: new Map([['2', new Set(['bo'])], ['3', new Set(['ana'])]]),
  ...over,
});
const slot = (slots, key) => slots.find((s) => s.key === key);

describe('buildTimeslotReport', () => {
  test('splits each slot into attended, LOA and missed member-nights', () => {
    const tue = slot(report(), 'tue');
    assert.equal(tue.nights, 2);
    // Night 1: ana, bo there, cy missed. Night 2: ana there, bo on LOA, cy missed.
    assert.deepEqual([tue.attended, tue.loa, tue.missed], [3, 1, 2]);
    assert.equal(tue.member_nights, 6);
    assert.deepEqual([tue.attended_pct, tue.loa_pct, tue.missed_pct], [50, 17, 33]);
    assert.equal(tue.avg_present, 1.5);
  });

  test('labels a slot by the guild night it belongs to', () => {
    const late = slot(report(), 'sat-late');
    assert.equal(late.night, 6, 'the 00:30 Sunday event is Saturday night');
    assert.equal(late.event_time, '00:30');
  });

  test('orders slots Monday first, then by time within the night, one-offs last', () => {
    assert.deepEqual(report().map((s) => s.key), ['tue', 'sat-late', 'gone', ONE_OFF]);
  });

  test('one-offs share a row; a deleted schedule entry keeps its own, flagged', () => {
    const slots = report();
    assert.equal(slot(slots, ONE_OFF).name, 'One-off events');
    assert.equal(slot(slots, ONE_OFF).attended, 1);
    const gone = slot(slots, 'gone');
    assert.equal(gone.retired, true);
    assert.equal(gone.name, 'Old raid');
    assert.equal(gone.missed, 3);
  });

  test('nights before someone joined do not count for them, unless they attended', () => {
    const tenures = new Map([['cy', { since: '2026-11-09', until: null }]]);
    const tue = slot(report({ tenures }), 'tue');
    // cy's 3 Nov night drops out; their 10 Nov miss stays.
    assert.deepEqual([tue.attended, tue.loa, tue.missed], [3, 1, 1]);
    const late = slot(report({ tenures }), 'sat-late');
    assert.equal(late.attended, 1, 'attended before joining still counts');
  });

  test('per-member breakdown, most missed first', () => {
    const tue = slot(report(), 'tue');
    assert.deepEqual(tue.members.map((m) => m.discord_id), ['cy', 'bo', 'ana']);
    const bo = tue.members.find((m) => m.discord_id === 'bo');
    assert.deepEqual([bo.attended, bo.loa, bo.missed, bo.attended_pct], [1, 1, 0, 50]);
  });

  test('a scheduled slot with no logged nights does not appear', () => {
    assert.equal(slot(report(), 'tue-early'), undefined);
  });

  test('no events, no slots', () => {
    assert.deepEqual(report({ events: [] }), []);
  });
});
