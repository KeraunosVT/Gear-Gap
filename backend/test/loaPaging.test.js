// backend/test/loaPaging.test.js — the fix, at the call site that mattered most.
//
// pagedRead.test.js proves the helper pages. This proves loa.unavailableOn
// actually uses it, against a fake Supabase holding more entries than the
// 1,000-row cap. Before the fix, an LOA sitting past that line was invisible:
// the member was counted a no-show, left in the signup reminder sweep, and
// DMed asking why they hadn't answered — with nothing anywhere reporting a
// fault. That is the exact scenario asserted below.
//
// guildConfig needs no stub: without a database it serves its frozen DEFAULTS,
// which carry the 01:00 rollover this relies on.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createLoa = require('../loa');

// Enough rows that the one we care about can only be reached by paging.
const TOTAL = 2_500;
const NEEDLE_INDEX = 2_400;
const NIGHT = '2026-08-22'; // a Saturday

function fakeSupabase({ serverCap = 1000 } = {}) {
  const rows = Array.from({ length: TOTAL }, (_, i) => ({
    id: i,
    discord_id: `member-${i}`,
    display_name: `Member ${i}`,
    // Filler is a range LOA far in the past, so only the needle matches NIGHT.
    type: 'range',
    event_date: null,
    event_schedule_id: null,
    start_date: '2020-01-01',
    end_date: '2020-01-02',
    day_of_week: null,
    start_time: null,
    end_time: null,
    reason: 'filler',
  }));
  rows[NEEDLE_INDEX] = {
    ...rows[NEEDLE_INDEX],
    type: 'event',
    event_date: NIGHT,
    start_date: null,
    end_date: null,
    // "Out from 9pm" — which must also cover the 00:30 event on the same night.
    start_time: '21:00',
    reason: 'work',
  };

  const state = { pages: 0 };
  const api = {
    from(table) {
      if (table === 'loa_entries') {
        const q = {
          select: () => q,
          order: () => q,
          range: (from, to) => {
            state.pages += 1;
            return Promise.resolve({
              data: rows.slice(from, from + Math.min(to - from + 1, serverCap)),
              error: null,
            });
          },
        };
        return q;
      }
      if (table === 'event_schedule') {
        return {
          select: () => ({
            eq: () => ({ single: () => Promise.resolve({ data: { event_time: '00:30' } }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { api, state, needle: rows[NEEDLE_INDEX] };
}

describe('loa.unavailableOn past the row cap', () => {
  test('finds an absence filed beyond the first 1,000 rows', async () => {
    const { api, state } = fakeSupabase();
    const loa = createLoa(api);

    const out = await loa.unavailableOn({ date: NIGHT });

    assert.ok(state.pages > 1, 'should have paged rather than issuing one read');
    assert.equal(out.length, 1);
    assert.equal(out[0].discord_id, `member-${NEEDLE_INDEX}`);
  });

  test('still finds it when the server cap is below the page size', async () => {
    // The variant a `length < pageSize` loop gets wrong while looking correct.
    const { api } = fakeSupabase({ serverCap: 400 });
    const loa = createLoa(api);
    const out = await loa.unavailableOn({ date: NIGHT });
    assert.equal(out.length, 1);
  });

  test('"out from 9pm" covers the 00:30 event on the same night', async () => {
    // Guards the guild-night rule at the same time: compared as clock strings,
    // '00:30' < '21:00' and this absence would be dropped.
    const { api } = fakeSupabase();
    const loa = createLoa(api);
    const out = await loa.unavailableOn({ date: NIGHT, eventScheduleId: 'ev-late' });
    assert.equal(out.length, 1, 'the 00:30 event is inside an "out from 21:00" window');
  });

  test('a read error surfaces instead of returning a short list', async () => {
    const api = {
      from: () => ({
        select: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: new Error('nope') }) }) }),
      }),
    };
    const loa = createLoa(api);
    await assert.rejects(() => loa.unavailableOn({ date: NIGHT }), (err) => err.status === 500);
  });
});
