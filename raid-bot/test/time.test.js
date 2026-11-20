const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWhen, zonedToUtc, resolveTimeZone, zoneSuggestions, whenSuggestions, formatForInput, MAX_AHEAD_DAYS,
} = require('../src/time');

const NY = 'America/New_York';
// Friday 20 Nov 2026, 10:00 in New York.
const NOW = Date.parse('2026-11-20T15:00:00Z');
const at = (s, tz = NY, now = NOW) => {
  const r = parseWhen(s, { timeZone: tz, now });
  assert.ok(r.ok, `${s}: ${r.error}`);
  return r.date.toISOString();
};
const fails = (s, pattern, tz = NY, now = NOW) => {
  const r = parseWhen(s, { timeZone: tz, now });
  assert.equal(r.ok, false, `${s} should fail`);
  if (pattern) assert.match(r.error, pattern);
};

test('a bare time is today, or tomorrow once it has passed', () => {
  assert.equal(at('8pm'), '2026-11-21T01:00:00.000Z');
  assert.equal(at('20:00'), '2026-11-21T01:00:00.000Z');
  assert.equal(at('9am'), '2026-11-21T14:00:00.000Z');
  assert.equal(at('noon'), '2026-11-20T17:00:00.000Z');
});

test('weekdays are the next one, this week if still ahead', () => {
  assert.equal(at('fri 8pm'), '2026-11-21T01:00:00.000Z'); // tonight
  assert.equal(at('fri 9am'), '2026-11-27T14:00:00.000Z'); // passed → next week
  assert.equal(at('sat 8pm'), '2026-11-22T01:00:00.000Z');
  assert.equal(at('saturday at 8pm'), '2026-11-22T01:00:00.000Z');
  assert.equal(at('tues 7pm'), '2026-11-25T00:00:00.000Z');
  assert.equal(at('thursday 21:30'), '2026-11-27T02:30:00.000Z');
});

test('today and tomorrow, with the usual spellings', () => {
  assert.equal(at('today 9pm'), '2026-11-21T02:00:00.000Z');
  assert.equal(at('tonight 9pm'), '2026-11-21T02:00:00.000Z');
  assert.equal(at('tomorrow 20:30'), '2026-11-22T01:30:00.000Z');
  assert.equal(at('tmrw 8:30pm'), '2026-11-22T01:30:00.000Z');
  assert.equal(at('tomorrow@8pm'), '2026-11-22T01:00:00.000Z');
  fails('today 9am', /past/); // "today" means today, not the next 9am
});

test('dates: ISO, and month names either way round', () => {
  assert.equal(at('2026-11-21 20:00'), '2026-11-22T01:00:00.000Z');
  assert.equal(at('nov 21 9pm'), '2026-11-22T02:00:00.000Z');
  assert.equal(at('21 nov 9pm'), '2026-11-22T02:00:00.000Z');
  assert.equal(at('november 21st 9pm'), '2026-11-22T02:00:00.000Z');
  assert.equal(at('dec 25 noon'), '2026-12-25T17:00:00.000Z');
  // January from November is next January.
  assert.equal(at('jan 3 8pm'), '2027-01-04T01:00:00.000Z');
  fails('2026-02-30 8pm', /isn't a date/);
});

test('relative times and Discord timestamps', () => {
  assert.equal(at('in 2h'), '2026-11-20T17:00:00.000Z');
  assert.equal(at('in 1h 30m'), '2026-11-20T16:30:00.000Z');
  assert.equal(at('in 90 minutes'), '2026-11-20T16:30:00.000Z');
  assert.equal(at('in 1 hour and 15 minutes'), '2026-11-20T16:15:00.000Z');
  assert.equal(at('<t:1795737600:F>'), new Date(1795737600 * 1000).toISOString());
  assert.equal(at('1795737600'), new Date(1795737600 * 1000).toISOString());
  fails('in a bit', /in 2h/);
});

test('ambiguous or incomplete input asks instead of guessing', () => {
  fails('8', /8am or 8pm/);
  fails('nov 21', /Add a time/);
  fails('tomorrow', /Add a time/);
  fails('25pm', /isn't a time/);
  fails('13:75', /isn't a time/);
  fails('blursday 8pm', /day/);
  fails('', /Say when/);
});

test('refuses the past and the far future', () => {
  fails('<t:1700000000>', /past/);
  fails(`in ${MAX_AHEAD_DAYS + 1}d`, /days ahead/);
});

test('reads the time on the given clock', () => {
  assert.equal(at('8pm', 'Europe/Berlin'), '2026-11-20T19:00:00.000Z');
  assert.equal(at('8pm', 'Asia/Seoul', Date.parse('2026-11-20T01:00:00Z')), '2026-11-20T11:00:00.000Z');
  assert.equal(at('8pm', 'UTC'), '2026-11-20T20:00:00.000Z');
  // An unknown zone falls back to UTC rather than throwing.
  assert.equal(at('8pm', 'Not/AZone'), '2026-11-20T20:00:00.000Z');
});

test('zonedToUtc follows DST on both sides of a change', () => {
  // New York: EDT (UTC-4) until 1 Nov 2026, EST (UTC-5) after.
  assert.equal(new Date(zonedToUtc({ year: 2026, month: 10, day: 31, hour: 20, minute: 0 }, NY)).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(new Date(zonedToUtc({ year: 2026, month: 11, day: 2, hour: 20, minute: 0 }, NY)).toISOString(), '2026-11-03T01:00:00.000Z');
  // 02:30 on 8 Mar 2026 doesn't exist in New York; it lands on 03:30 EDT.
  assert.equal(new Date(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY)).toISOString(), '2026-03-08T07:30:00.000Z');
});

test('formatForInput reads back to the same instant', () => {
  const d = new Date('2026-11-22T01:30:00Z');
  assert.equal(formatForInput(d, NY), '2026-11-21 20:30');
  const back = parseWhen(formatForInput(d, NY), { timeZone: NY, now: NOW });
  assert.equal(back.date.toISOString(), d.toISOString());
});

test('timezone names, aliases and suggestions', () => {
  assert.equal(resolveTimeZone('EST'), NY);
  assert.equal(resolveTimeZone('pt'), 'America/Los_Angeles');
  assert.equal(resolveTimeZone('europe/berlin'), 'Europe/Berlin');
  assert.equal(resolveTimeZone('utc'), 'UTC');
  assert.equal(resolveTimeZone('Mars/Olympus'), null);
  assert.equal(resolveTimeZone(''), null);
  assert.ok(zoneSuggestions('').includes(NY));
  assert.ok(zoneSuggestions('berl').includes('Europe/Berlin'));
  assert.equal(zoneSuggestions('cst')[0], 'America/Chicago');
  assert.ok(zoneSuggestions('a').length <= 25);
});

test('when suggestions read the typed time back', () => {
  const [ok] = whenSuggestions('sat 8pm', NY, NOW);
  assert.equal(ok.value, 'sat 8pm');
  assert.match(ok.name, /^✓ .*Sat, Nov 21, 8:00 PM/);
  const [bad] = whenSuggestions('today 9am', NY, NOW);
  assert.equal(bad.name, "⚠ That's in the past.");
  const blank = whenSuggestions('', NY, NOW);
  assert.ok(blank.length >= 3);
  assert.ok(blank.every((c) => c.name.length <= 100 && c.value.length <= 100));
});
