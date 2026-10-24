// backend/test/loaEdit.test.js — editing an LOA in place.
//
// Officers need to fix someone else's LOA (wrong night, wrong event, a typo in
// the dates) without cancelling it and filing a new one on their behalf, which
// deletes the channel post, DMs a cancellation and loses the filed-on date.
//
// update() goes through the same validation as a fresh submission, so most of
// what's worth checking here is what's specific to editing: who may do it,
// that the type stays fixed, and what happens to a recurring rule's skipped
// dates when it moves to a different weekday.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createLoa = require('../loa');

// 2026-09-01 is a Tuesday; 2026-09-02 a Wednesday.
const TUE = '2026-09-01';
const WED = '2026-09-02';

const EVENTS = {
  'ev-tue': { id: 'ev-tue', name: 'Tuesday Wargame', day_of_week: 2, event_time: '21:00:00' },
  'ev-wed': { id: 'ev-wed', name: 'Wednesday Boss', day_of_week: 3, event_time: '20:00:00' },
};

const base = {
  id: 'loa-1',
  discord_id: 'member-1',
  display_name: 'Ravager',
  event_date: null,
  event_schedule_id: null,
  start_date: null,
  end_date: null,
  day_of_week: null,
  start_time: null,
  end_time: null,
  reason: 'work',
  skip_dates: [],
  discord_message_id: 'msg-1',
};

const EVENT = { ...base, type: 'event', event_date: TUE, event_schedule_id: 'ev-tue' };
const RANGE = { ...base, type: 'range', start_date: '2026-09-01', end_date: '2026-09-05' };
const RECURRING = { ...base, type: 'recurring', day_of_week: 2, skip_dates: ['2026-09-08'] };

// Just enough PostgREST for loa_entries and event_schedule lookups by id.
function fakeSupabase(entry) {
  const state = { row: entry ? { ...entry } : null, updates: [] };
  const api = {
    from(table) {
      if (table === 'loa_entries') {
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: state.row, error: null }) }),
          }),
          update: (patch) => ({
            eq: () => {
              state.updates.push(patch);
              state.row = { ...state.row, ...patch };
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === 'event_schedule') {
        return {
          select: () => ({
            eq: (_col, id) => ({
              single: () => Promise.resolve(EVENTS[id] ? { data: EVENTS[id], error: null } : { data: null, error: { message: 'none' } }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { api, state };
}

const editArgs = (fields, over = {}) => ({ id: 'loa-1', discordId: 'member-1', isAdmin: false, fields, ...over });

describe('loa.update — who can edit', () => {
  test('an officer can edit someone else\'s LOA', async () => {
    const { api, state } = fakeSupabase(RANGE);
    const loa = createLoa(api);
    await loa.update(editArgs(
      { startDate: '2026-09-02', endDate: '2026-09-06', reason: 'trip moved' },
      { discordId: 'officer-1', isAdmin: true },
    ));
    assert.equal(state.row.start_date, '2026-09-02');
    assert.equal(state.row.end_date, '2026-09-06');
    assert.equal(state.row.reason, 'trip moved');
    // Still theirs, not the officer's.
    assert.equal(state.row.discord_id, 'member-1');
  });

  test('a member can edit their own', async () => {
    const { api, state } = fakeSupabase(RANGE);
    const loa = createLoa(api);
    await loa.update(editArgs({ startDate: '2026-09-01', endDate: '2026-09-03', reason: 'work' }));
    assert.equal(state.row.end_date, '2026-09-03');
  });

  test('a member cannot edit someone else\'s', async () => {
    const { api, state } = fakeSupabase(RANGE);
    const loa = createLoa(api);
    await assert.rejects(
      loa.update(editArgs({ startDate: '2026-09-01', endDate: '2026-09-03', reason: 'x' }, { discordId: 'member-2' })),
      { status: 403 },
    );
    assert.deepEqual(state.updates, [], 'nothing written');
  });

  test('a missing LOA is a 404', async () => {
    const { api } = fakeSupabase(null);
    const loa = createLoa(api);
    await assert.rejects(loa.update(editArgs({}, { isAdmin: true })), { status: 404 });
  });
});

describe('loa.update — validation', () => {
  test('held to the same rules as a fresh submission', async () => {
    const { api, state } = fakeSupabase(RANGE);
    const loa = createLoa(api);
    await assert.rejects(
      loa.update(editArgs({ startDate: '2026-09-05', endDate: '2026-09-01', reason: 'x' })),
      { status: 400, message: 'End date must be after start date.' },
    );
    await assert.rejects(
      loa.update(editArgs({ startDate: '2026-09-01', endDate: '2026-09-05', reason: '  ' })),
      { status: 400, message: 'Reason is required.' },
    );
    assert.deepEqual(state.updates, []);
  });

  test('an event moved to a night it isn\'t on is refused', async () => {
    const { api, state } = fakeSupabase(EVENT);
    const loa = createLoa(api);
    await assert.rejects(
      loa.update(editArgs({ eventDate: WED, eventScheduleId: 'ev-tue', reason: 'work' })),
      { status: 400, message: "That event isn't scheduled on that date." },
    );
    assert.deepEqual(state.updates, []);
  });

  test('the type stays what it was, whatever the body says', async () => {
    // update() picks the validator from the stored row, so a range can't be
    // turned into a single event by sending event fields — they're ignored and
    // the range's own fields are required.
    const { api, state } = fakeSupabase(RANGE);
    const loa = createLoa(api);
    await assert.rejects(
      loa.update(editArgs({ eventDate: TUE, eventScheduleId: 'ev-tue', reason: 'work' })),
      { status: 400 },
    );
    assert.equal(state.row.type, 'range');
  });

  test('an event edit can move night, event and times together', async () => {
    const { api, state } = fakeSupabase(EVENT);
    const loa = createLoa(api);
    const res = await loa.update(editArgs({ eventDate: WED, eventScheduleId: 'ev-wed', startTime: '9pm', endTime: '10pm', reason: 'late shift' }));
    assert.equal(state.row.event_date, WED);
    assert.equal(state.row.event_schedule_id, 'ev-wed');
    // Stored cleaned, like a submission.
    assert.equal(state.row.start_time, '21:00');
    assert.equal(state.row.end_time, '22:00');
    // before/after are what the Discord post and the DM are built from.
    assert.equal(res.before.event_name, 'Tuesday Wargame');
    assert.equal(res.after.event_name, 'Wednesday Boss');
    assert.equal(res.messageId, 'msg-1');
  });
});

describe('loa.update — recurring', () => {
  test('moving to another weekday drops the skipped dates', async () => {
    // They name Tuesdays. On a Wednesday rule they'd describe nothing, and
    // setOccurrenceSkipped would refuse to put them back.
    const { api, state } = fakeSupabase(RECURRING);
    const loa = createLoa(api);
    await loa.update(editArgs({ dayOfWeek: 3, reason: 'work' }));
    assert.equal(state.row.day_of_week, 3);
    assert.deepEqual(state.row.skip_dates, []);
  });

  test('staying on the same weekday keeps them', async () => {
    const { api, state } = fakeSupabase(RECURRING);
    const loa = createLoa(api);
    await loa.update(editArgs({ dayOfWeek: 2, startTime: '21:00', reason: 'gym' }));
    assert.equal(state.row.start_time, '21:00');
    assert.deepEqual(state.row.skip_dates, ['2026-09-08']);
    assert.ok(!('skip_dates' in state.updates[0]), 'skip_dates not written at all');
  });
});
