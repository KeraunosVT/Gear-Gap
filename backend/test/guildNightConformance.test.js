// backend/test/guildNightConformance.test.js
//
// The guild-night rule exists twice: backend/loa.js and frontend/src/timeUtils.js.
// This drives BOTH over the same matrix and fails if they ever disagree.
//
// ── WHY THEY AREN'T ONE FILE ────────────────────────────────────────────────
// The obvious fix is a shared/guildNight.js that both sides read, the way both
// already read shared/stats.json. It doesn't work, and the failure is worse
// than the duplication:
//
//   - Written as CommonJS, `vite build` rejects it ("VALUE is not exported by
//     shared/…"). Adding build.commonjsOptions.include makes the BUILD pass —
//     but the dev server serves the file untransformed, so `module.exports`
//     reaches the browser and `npm run dev` breaks. Passing in production and
//     failing only in local dev is the worst split available.
//   - Written as ESM, the CommonJS backend can't require() it below Node 22.12,
//     and the README supports Node 18+.
//
// Both were tried. So the two implementations stay, each idiomatic to its
// runtime — and they differ for a real reason beyond syntax: the backend reads
// the rollover from guild_config on EVERY call (Guild Settings can change it
// mid-process), while the frontend reads module state that GuildProvider sets
// once from GET /api/guild before first render. A shared file would have to
// take the rollover as a parameter and both wrappers would survive anyway.
//
// Drift is the actual risk, and drift is what this catches.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const createLoa = require('../loa');

let fe; // the frontend module, imported dynamically (it is ESM)

before(async () => {
  fe = await import(pathToFileURL(
    path.join(__dirname, '..', '..', 'frontend', 'src', 'timeUtils.js'),
  ).href);
  // Match the backend's default rollover. guildConfig serves frozen DEFAULTS
  // without a database, and day_start there is 01:00.
  fe.configureGuildTime('America/New_York', '01:00');
});

// Every half hour of the clock, which is finer than any event time in use.
const CLOCK = Array.from({ length: 48 }, (_, i) => {
  const h = String(Math.floor(i / 2)).padStart(2, '0');
  return `${h}:${i % 2 ? '30' : '00'}`;
});

describe('backend and frontend agree on the guild night', () => {
  test('daySlot matches at every half hour', () => {
    const mismatches = CLOCK.filter((t) => createLoa.daySlot(t) !== fe.daySlot(t));
    assert.deepEqual(mismatches, []);
  });

  test('daySlot puts 00:30 after 21:00 in both', () => {
    // The whole point of the rule. As text, '00:30' < '21:00'.
    for (const impl of [createLoa, fe]) {
      assert.ok(impl.daySlot('00:30') > impl.daySlot('21:00'));
    }
  });

  test('guildDayOfWeek matches for every day and time', () => {
    const mismatches = [];
    for (let dow = 0; dow < 7; dow += 1) {
      for (const t of CLOCK) {
        if (createLoa.guildDayOfWeek(dow, t) !== fe.guildDayOfWeek(dow, t)) mismatches.push(`${dow} ${t}`);
      }
      if (createLoa.guildDayOfWeek(dow, null) !== fe.guildDayOfWeek(dow, null)) mismatches.push(`${dow} null`);
    }
    assert.deepEqual(mismatches, []);
  });

  test('a 00:30 Sunday event belongs to Saturday night in both', () => {
    assert.equal(createLoa.guildDayOfWeek(0, '00:30'), 6);
    assert.equal(fe.guildDayOfWeek(0, '00:30'), 6);
  });

  test('isAfterMidnight matches, including the empty cases', () => {
    const mismatches = [...CLOCK, null, undefined, ''].filter(
      (t) => createLoa.isAfterMidnight(t) !== fe.isAfterMidnight(t),
    );
    assert.deepEqual(mismatches, []);
  });

  test('todayInGuildTz agrees', () => {
    // Same instant, same timezone, same rollover — the strings must match.
    assert.equal(createLoa.todayInGuildTz(), fe.todayInGuildTz());
  });
});

describe('withinLoaWindow is identical on both sides', () => {
  // start/end pairs covering: no window, open-ended cutoff, a bounded window,
  // and one that wraps past the rollover.
  const WINDOWS = [
    { start_time: null, end_time: null },
    { start_time: '21:00', end_time: null },
    { start_time: '19:00', end_time: '20:00' },
    { start_time: '23:00', end_time: '01:00' },
    { start_time: '00:15', end_time: '02:00' },
    { start_time: '12:00', end_time: '12:00' },
  ];

  test('every window against every event time', () => {
    const mismatches = [];
    for (const w of WINDOWS) {
      for (const t of [...CLOCK, null]) {
        const a = createLoa.withinLoaWindow(w, t);
        const b = fe.withinLoaWindow(w, t);
        if (a !== b) mismatches.push(`${w.start_time}-${w.end_time} @ ${t}: backend=${a} frontend=${b}`);
      }
    }
    assert.deepEqual(mismatches, []);
  });

  test('"out from 9pm" covers the 00:30 event in both', () => {
    const w = { start_time: '21:00', end_time: null };
    assert.equal(createLoa.withinLoaWindow(w, '00:30'), true);
    assert.equal(fe.withinLoaWindow(w, '00:30'), true);
  });

  test('"out 11pm to 1am" wraps the rollover in both', () => {
    const w = { start_time: '23:00', end_time: '01:00' };
    for (const impl of [createLoa, fe]) {
      assert.equal(impl.withinLoaWindow(w, '00:30'), true, 'inside');
      assert.equal(impl.withinLoaWindow(w, '21:00'), false, 'before it starts');
      assert.equal(impl.withinLoaWindow(w, '02:00'), false, 'after it ends');
    }
  });
});

describe('loaSkipsDate is identical on both sides', () => {
  // A drift here doesn't error: it lists someone as absent on a night they told
  // us they'd be there, or hides someone who is genuinely out. Both sides read
  // the same date[] off the row, so the only way they can disagree is over what
  // counts as a series to except a date from.
  const DATE = '2026-09-01';
  const CASES = [
    { type: 'recurring', day_of_week: 2, skip_dates: [DATE] },
    { type: 'recurring', day_of_week: 2, skip_dates: ['2026-09-08'] },
    { type: 'recurring', day_of_week: 2, skip_dates: [] },
    { type: 'recurring', day_of_week: 2, skip_dates: null },
    { type: 'recurring', day_of_week: 2 },
    // Only recurring has a series. An event LOA carrying the column anyway
    // (nothing stops a hand-written row) must not be read as excepted.
    { type: 'event', event_date: DATE, skip_dates: [DATE] },
    { type: 'range', start_date: DATE, end_date: DATE, skip_dates: [DATE] },
  ];

  test('every entry shape agrees', () => {
    const mismatches = CASES.filter(
      (e) => createLoa.loaSkipsDate(e, DATE) !== fe.loaSkipsDate(e, DATE),
    ).map((e) => JSON.stringify(e));
    assert.deepEqual(mismatches, []);
  });

  test('a recurring entry excepting this date is skipped by both', () => {
    const e = { type: 'recurring', day_of_week: 2, skip_dates: ['2026-08-25', DATE] };
    assert.equal(createLoa.loaSkipsDate(e, DATE), true);
    assert.equal(fe.loaSkipsDate(e, DATE), true);
    assert.equal(createLoa.loaSkipsDate(e, '2026-09-08'), false);
    assert.equal(fe.loaSkipsDate(e, '2026-09-08'), false);
  });

  test('neither throws on a missing or malformed entry', () => {
    for (const impl of [createLoa, fe]) {
      assert.equal(impl.loaSkipsDate(null, DATE), false);
      assert.equal(impl.loaSkipsDate(undefined, DATE), false);
      assert.equal(impl.loaSkipsDate({ type: 'recurring', skip_dates: 'nope' }, DATE), false);
    }
  });
});

describe('a non-default rollover moves both the same way', () => {
  // Guild Settings can change day_start, and the two sides learn about it by
  // completely different routes — guild_config on the backend, GET /api/guild
  // on the frontend. This is the case where a hardcoded copy would drift.
  test('at day_start 04:00 both treat 02:00 as the previous night', async () => {
    const cfgPath = require.resolve('../guildConfig');
    const real = require.cache[cfgPath];
    require.cache[cfgPath] = {
      id: cfgPath,
      loaded: true,
      exports: { get: () => ({ timezone: 'America/New_York', day_start: '04:00' }) },
    };
    // loa.js reads guildConfig at call time, so it picks the stub up without
    // being reloaded — which is itself the property worth having.
    delete require.cache[require.resolve('../loa')];
    const loaWithStub = require('../loa');
    fe.configureGuildTime('America/New_York', '04:00');

    try {
      assert.equal(loaWithStub.isAfterMidnight('02:00'), true);
      assert.equal(fe.isAfterMidnight('02:00'), true);
      assert.equal(loaWithStub.daySlot('02:00'), fe.daySlot('02:00'));
      assert.equal(loaWithStub.guildDayOfWeek(0, '02:00'), fe.guildDayOfWeek(0, '02:00'));
      // 05:00 is now past the rollover, so it starts a new night on both.
      assert.equal(loaWithStub.isAfterMidnight('05:00'), false);
      assert.equal(fe.isAfterMidnight('05:00'), false);
    } finally {
      if (real) require.cache[cfgPath] = real; else delete require.cache[cfgPath];
      delete require.cache[require.resolve('../loa')];
      fe.configureGuildTime('America/New_York', '01:00');
    }
  });
});
