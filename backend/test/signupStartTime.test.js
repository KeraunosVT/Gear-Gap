// backend/test/signupStartTime.test.js — setting a one-off signup's start time.
//
// starts_at drives the reminder, the automatic close and Discord's countdown,
// so a time set or changed on the Signups page has to move it — and re-arm a
// reminder already sent for the old time. A weekly night's time belongs to the
// schedule and is refused here.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createEventSignups = require('../eventSignups');

function fakeSupabase(row, updates) {
  return {
    from() {
      let patch = null;
      const q = {
        select: () => q,
        update: (p) => { patch = p; updates.push(p); return q; },
        eq: () => q,
        single: async () => ({ data: patch ? { ...row, ...patch } : { ...row }, error: null }),
      };
      return q;
    },
  };
}

const oneOff = {
  id: 'ff', title: 'Fight Club', event_date: '2026-11-07', event_schedule_id: null,
  event_time: null, starts_at: null, reminder_sent_at: '2026-11-06T12:00:00Z',
};

describe('setDetails: start time', () => {
  test('setting a time sets starts_at and re-arms the reminder', async () => {
    const updates = [];
    const saved = await createEventSignups(fakeSupabase(oneOff, updates)).setDetails('ff', { eventTime: '21:00' });
    assert.equal(updates[0].event_time, '21:00');
    assert.equal(saved.starts_at, createEventSignups(null).resolveStartsAt('2026-11-07', '21:00').toISOString());
    assert.equal(updates[0].reminder_sent_at, null);
  });

  test('clearing the time clears starts_at', async () => {
    const updates = [];
    const timed = { ...oneOff, event_time: '21:00', starts_at: '2026-11-08T02:00:00.000Z' };
    await createEventSignups(fakeSupabase(timed, updates)).setDetails('ff', { eventTime: null });
    assert.equal(updates[0].event_time, null);
    assert.equal(updates[0].starts_at, null);
  });

  test('an unreadable time is refused', async () => {
    await assert.rejects(
      createEventSignups(fakeSupabase(oneOff, [])).setDetails('ff', { eventTime: 'tea time' }),
      (err) => err.status === 400,
    );
  });

  test("a weekly night's time is refused — it belongs to the schedule", async () => {
    const weekly = { ...oneOff, event_schedule_id: 'raid' };
    await assert.rejects(
      createEventSignups(fakeSupabase(weekly, [])).setDetails('ff', { eventTime: '21:00' }),
      (err) => err.status === 400 && /schedule/.test(err.message),
    );
  });
});
