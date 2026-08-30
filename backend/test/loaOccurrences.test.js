// backend/test/loaOccurrences.test.js — lifting ONE date out of a recurring LOA.
//
// The bug this covers: the LOA board projects a recurring entry onto every
// matching night, so each night looked like its own row with its own X — and
// clicking it cancelled the entire standing rule. "I can make it this week"
// destroyed "I'm out every Tuesday", with nothing to undo it.
//
// Two halves are tested here, and they matter for different reasons.
// setOccurrenceSkipped is the write: it must refuse the things that would leave
// a meaningless exception on a row. unavailableOn is the read, and it is the
// one that decides whether a member is counted absent tonight — every roster,
// signup sweep and attendance breakdown goes through it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createLoa = require('../loa');

// 2026-09-01 is a Tuesday; 2026-09-08 is the Tuesday after.
const TUE = '2026-09-01';
const NEXT_TUE = '2026-09-08';
const WED = '2026-09-02';

const RECURRING = {
  id: 'loa-1',
  discord_id: 'member-1',
  display_name: 'Ravager',
  type: 'recurring',
  day_of_week: 2, // Tuesday
  event_date: null,
  event_schedule_id: null,
  start_date: null,
  end_date: null,
  start_time: null,
  end_time: null,
  reason: 'work',
  skip_dates: [],
  discord_message_id: 'msg-1',
};

// A fake PostgREST good enough for the two tables loa.js touches. Records the
// last update so a test can assert what was actually written, not just what was
// returned.
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
            eq: () => ({ single: () => Promise.resolve({ data: { name: 'Wargame' } }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { api, state };
}

const skipArgs = (over = {}) => ({
  id: 'loa-1', date: TUE, skip: true, discordId: 'member-1', isAdmin: false, ...over,
});

describe('loa.setOccurrenceSkipped', () => {
  test('removing one date leaves the series intact', async () => {
    const { api, state } = fakeSupabase(RECURRING);
    const loa = createLoa(api);

    const res = await loa.setOccurrenceSkipped(skipArgs());

    assert.equal(res.changed, true);
    assert.deepEqual(res.skipDates, [TUE]);
    // The entry itself is untouched apart from the exception list — no delete,
    // and day_of_week still says Tuesday.
    assert.deepEqual(state.updates, [{ skip_dates: [TUE] }]);
    assert.equal(state.row.type, 'recurring');
    assert.equal(state.row.day_of_week, 2);
  });

  test('a second date is added rather than replacing the first', async () => {
    const { api, state } = fakeSupabase({ ...RECURRING, skip_dates: [TUE] });
    const loa = createLoa(api);
    const res = await loa.setOccurrenceSkipped(skipArgs({ date: NEXT_TUE }));
    assert.deepEqual(res.skipDates, [TUE, NEXT_TUE]);
    assert.deepEqual(state.row.skip_dates, [TUE, NEXT_TUE]);
  });

  test('stored sorted, whatever order they were removed in', async () => {
    const { api } = fakeSupabase({ ...RECURRING, skip_dates: [NEXT_TUE] });
    const loa = createLoa(api);
    const res = await loa.setOccurrenceSkipped(skipArgs({ date: TUE }));
    assert.deepEqual(res.skipDates, [TUE, NEXT_TUE]);
  });

  test('restoring puts exactly that one back', async () => {
    const { api, state } = fakeSupabase({ ...RECURRING, skip_dates: [TUE, NEXT_TUE] });
    const loa = createLoa(api);
    const res = await loa.setOccurrenceSkipped(skipArgs({ date: TUE, skip: false }));
    assert.equal(res.changed, true);
    assert.deepEqual(res.skipDates, [NEXT_TUE]);
    assert.deepEqual(state.row.skip_dates, [NEXT_TUE]);
  });

  test('skipping an already-skipped date is a no-op, not an error', async () => {
    // A double-click, or a stale page. Reporting success for something that is
    // already true beats erroring at someone who wanted exactly this state.
    const { api, state } = fakeSupabase({ ...RECURRING, skip_dates: [TUE] });
    const loa = createLoa(api);
    const res = await loa.setOccurrenceSkipped(skipArgs());
    assert.equal(res.changed, false);
    assert.deepEqual(state.updates, [], 'nothing written');
  });

  test('restoring a date that was never removed is also a no-op', async () => {
    const { api, state } = fakeSupabase(RECURRING);
    const loa = createLoa(api);
    const res = await loa.setOccurrenceSkipped(skipArgs({ skip: false }));
    assert.equal(res.changed, false);
    assert.deepEqual(state.updates, []);
  });

  test('a date the rule does not land on is refused', async () => {
    // Otherwise the exception sits on the row forever looking like it does
    // something. A stale page whose day_of_week has since been edited is the
    // realistic way to get here.
    const { api, state } = fakeSupabase(RECURRING);
    const loa = createLoa(api);
    await assert.rejects(
      () => loa.setOccurrenceSkipped(skipArgs({ date: WED })),
      (err) => err.status === 400 && /isn't one this LOA covers/.test(err.message),
    );
    assert.deepEqual(state.updates, []);
  });

  test('a non-recurring LOA has no occurrences to remove', async () => {
    const { api, state } = fakeSupabase({
      ...RECURRING, type: 'event', event_date: TUE, day_of_week: null,
    });
    const loa = createLoa(api);
    await assert.rejects(
      () => loa.setOccurrenceSkipped(skipArgs()),
      (err) => err.status === 400 && /Cancel this one instead/.test(err.message),
    );
    assert.deepEqual(state.updates, []);
  });

  test("someone else's LOA is refused, and an officer's is not", async () => {
    const a = fakeSupabase(RECURRING);
    await assert.rejects(
      () => createLoa(a.api).setOccurrenceSkipped(skipArgs({ discordId: 'someone-else' })),
      (err) => err.status === 403,
    );
    assert.deepEqual(a.state.updates, []);

    const b = fakeSupabase(RECURRING);
    const res = await createLoa(b.api)
      .setOccurrenceSkipped(skipArgs({ discordId: 'an-officer', isAdmin: true }));
    assert.equal(res.changed, true);
  });

  test('a malformed date is rejected before anything is read', async () => {
    const { api, state } = fakeSupabase(RECURRING);
    await assert.rejects(
      () => createLoa(api).setOccurrenceSkipped(skipArgs({ date: 'next tuesday' })),
      (err) => err.status === 400,
    );
    assert.deepEqual(state.updates, []);
  });

  test('a missing entry is a 404', async () => {
    const { api } = fakeSupabase(null);
    await assert.rejects(
      () => createLoa(api).setOccurrenceSkipped(skipArgs()),
      (err) => err.status === 404,
    );
  });

  test('the entry comes back with its event name, for the Discord notice', async () => {
    const { api } = fakeSupabase({ ...RECURRING, event_schedule_id: 'ev-1' });
    const res = await createLoa(api).setOccurrenceSkipped(skipArgs());
    assert.equal(res.entry.event_name, 'Wargame');
  });
});

// ── The read side ───────────────────────────────────────────────────────────
// This is the one that decides whether a member is counted absent. A skip that
// the write path stores but unavailableOn ignores is worse than no feature: the
// page would show them as available and every roster would still exclude them.

function listSupabase(rows) {
  return {
    from(table) {
      if (table === 'loa_entries') {
        const q = {
          select: () => q,
          order: () => q,
          range: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
        };
        return q;
      }
      if (table === 'event_schedule') {
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: { event_time: '21:00' } }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

describe('loa.unavailableOn honours removed occurrences', () => {
  test('the removed Tuesday reports nobody out', async () => {
    const loa = createLoa(listSupabase([{ ...RECURRING, skip_dates: [TUE] }]));
    assert.deepEqual(await loa.unavailableOn({ date: TUE }), []);
  });

  test('every other Tuesday still does', async () => {
    const loa = createLoa(listSupabase([{ ...RECURRING, skip_dates: [TUE] }]));
    const out = await loa.unavailableOn({ date: NEXT_TUE });
    assert.equal(out.length, 1);
    assert.equal(out[0].discord_id, 'member-1');
  });

  test('with no exceptions the rule applies as before', async () => {
    const loa = createLoa(listSupabase([RECURRING]));
    assert.equal((await loa.unavailableOn({ date: TUE })).length, 1);
  });

  test('an exception beats the event scope and the time window', async () => {
    // Checked before either test, because a removed occurrence isn't in the
    // series for ANY event that night — not just the unscoped ones.
    const loa = createLoa(listSupabase([{
      ...RECURRING, event_schedule_id: 'ev-1', start_time: '20:00', skip_dates: [TUE],
    }]));
    assert.deepEqual(await loa.unavailableOn({ date: TUE, eventScheduleId: 'ev-1' }), []);
  });

  test('a member with a range LOA over the same night is still out', async () => {
    // The exception lifts one rule, not the member. Someone who removed a
    // Tuesday and is also on holiday that week is on holiday.
    const loa = createLoa(listSupabase([
      { ...RECURRING, skip_dates: [TUE] },
      {
        ...RECURRING, id: 'loa-2', type: 'range', day_of_week: null,
        start_date: '2026-08-30', end_date: '2026-09-05', skip_dates: [],
      },
    ]));
    const out = await loa.unavailableOn({ date: TUE });
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'range');
  });

  test('a row with no skip_dates at all still matches', async () => {
    // Every entry that predates the column reads as null until it is written.
    const { skip_dates, ...noColumn } = RECURRING;
    const loa = createLoa(listSupabase([noColumn]));
    assert.equal((await loa.unavailableOn({ date: TUE })).length, 1);
  });
});
