// backend/test/loaSignupOverride.test.js — a signup beats an LOA.
//
// Someone signed up for an event (going or waitlist) is coming to it, whatever
// LOA they have on file. unavailableOn and unavailableAcross are what every
// roster, signup sweep and attendance split asks, so this is where the rule
// has to hold.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createLoa = require('../loa');

const TUE = '2026-09-01'; // a Tuesday
const WED = '2026-09-02';

const loaRow = (over) => ({
  id: over.discord_id,
  display_name: over.discord_id,
  type: 'range',
  event_date: null,
  event_schedule_id: null,
  signup_event_id: null,
  start_date: '2026-08-30',
  end_date: '2026-09-05',
  day_of_week: null,
  start_time: null,
  end_time: null,
  reason: 'away',
  skip_dates: [],
  ...over,
});

// A PostgREST fake with just enough of select/in/order/range/eq for loa.js.
function fakeSupabase({ loas = [], events = [], entries = [], failSignups = false } = {}) {
  const tables = { loa_entries: loas, signup_events: events, signup_entries: entries };
  return {
    from(table) {
      if (table === 'event_schedule') {
        const q = {
          select: () => q,
          eq: () => ({ single: () => Promise.resolve({ data: { event_time: '21:00' } }) }),
          then: (res) => res({ data: [{ id: 'ev-raid', event_time: '21:00' }, { id: 'ev-boss', event_time: '23:00' }] }),
        };
        return q;
      }
      if (!(table in tables)) throw new Error(`unexpected table ${table}`);
      let rows = tables[table];
      const q = {
        select: () => q,
        order: () => q,
        in: (col, vals) => { rows = rows.filter((r) => vals.map(String).includes(String(r[col]))); return q; },
        range: (from, to) => (failSignups && table !== 'loa_entries'
          ? Promise.resolve({ data: null, error: new Error('signups unreadable') })
          : Promise.resolve({ data: rows.slice(from, to + 1), error: null })),
      };
      return q;
    },
  };
}

const ids = (out) => out.map((e) => e.discord_id).sort();

describe('unavailableOn — a signup beats an LOA', () => {
  const loas = [loaRow({ discord_id: 'signed' }), loaRow({ discord_id: 'waiting' }), loaRow({ discord_id: 'unsigned' })];
  const events = [
    { id: 'su-raid', event_date: TUE, event_schedule_id: 'ev-raid', status: 'open' },
    { id: 'su-boss', event_date: TUE, event_schedule_id: 'ev-boss', status: 'open' },
    { id: 'su-off', event_date: TUE, event_schedule_id: null, status: 'open' },
  ];
  const entries = [
    { signup_event_id: 'su-raid', discord_id: 'signed', status: 'going' },
    { signup_event_id: 'su-raid', discord_id: 'waiting', status: 'waitlist' },
  ];

  test('signed up or waitlisted for the event: not out for it', async () => {
    const loa = createLoa(fakeSupabase({ loas, events, entries }));
    assert.deepEqual(ids(await loa.unavailableOn({ date: TUE, eventScheduleId: 'ev-raid' })), ['unsigned']);
  });

  test('still out for a different event that night', async () => {
    const loa = createLoa(fakeSupabase({ loas, events, entries }));
    assert.deepEqual(ids(await loa.unavailableOn({ date: TUE, eventScheduleId: 'ev-boss' })), ['signed', 'unsigned', 'waiting']);
  });

  test('the whole night: a signup for any event counts', async () => {
    const loa = createLoa(fakeSupabase({ loas, events, entries }));
    assert.deepEqual(ids(await loa.unavailableOn({ date: TUE })), ['unsigned']);
  });

  test('a one-off by its signup id', async () => {
    const offEntries = [{ signup_event_id: 'su-off', discord_id: 'unsigned', status: 'going' }];
    const loa = createLoa(fakeSupabase({ loas, events, entries: offEntries }));
    const out = await loa.unavailableOn({ date: TUE, oneOff: true, signupEventId: 'su-off', eventTime: '20:00' });
    assert.deepEqual(ids(out), ['signed', 'waiting']);
  });

  test("another night's signup doesn't count", async () => {
    const loa = createLoa(fakeSupabase({ loas, events, entries }));
    assert.equal((await loa.unavailableOn({ date: WED })).length, 3);
  });

  test("a cancelled event's list doesn't count", async () => {
    const cancelled = events.map((e) => (e.id === 'su-raid' ? { ...e, status: 'cancelled' } : e));
    const loa = createLoa(fakeSupabase({ loas, events: cancelled, entries }));
    assert.equal((await loa.unavailableOn({ date: TUE, eventScheduleId: 'ev-raid' })).length, 3);
  });

  test('ignoreSignups returns the LOAs as filed', async () => {
    const loa = createLoa(fakeSupabase({ loas, events, entries }));
    const out = await loa.unavailableOn({ date: TUE, eventScheduleId: 'ev-raid', ignoreSignups: true });
    assert.deepEqual(ids(out), ['signed', 'unsigned', 'waiting']);
  });

  test('unreadable signups leave every LOA standing', async () => {
    const loa = createLoa(fakeSupabase({ loas, events, entries, failSignups: true }));
    assert.equal((await loa.unavailableOn({ date: TUE, eventScheduleId: 'ev-raid' })).length, 3);
  });
});

describe('unavailableAcross — the same rule for many nights', () => {
  test('each night only drops its own signups', async () => {
    const loas = [loaRow({ discord_id: 'a' }), loaRow({ discord_id: 'b' })];
    const events = [
      { id: 'su-tue', event_date: TUE, event_schedule_id: 'ev-raid', status: 'open' },
      { id: 'su-wed', event_date: WED, event_schedule_id: 'ev-raid', status: 'open' },
    ];
    const entries = [
      { signup_event_id: 'su-tue', discord_id: 'a', status: 'going' },
      { signup_event_id: 'su-wed', discord_id: 'b', status: 'going' },
    ];
    const loa = createLoa(fakeSupabase({ loas, events, entries }));
    const out = await loa.unavailableAcross([
      { key: 'tue', date: TUE, eventScheduleId: 'ev-raid' },
      { key: 'wed', date: WED, eventScheduleId: 'ev-raid' },
      { key: 'thu', date: '2026-09-03', eventScheduleId: 'ev-raid' },
    ]);
    assert.deepEqual([...out.get('tue')], ['b']);
    assert.deepEqual([...out.get('wed')], ['a']);
    assert.deepEqual([...out.get('thu')].sort(), ['a', 'b']);
  });
});
