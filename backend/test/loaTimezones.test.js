// backend/test/loaTimezones.test.js — LOA times typed on a member's own clock
// land on the guild's (America/New_York, day_start 01:00 — guildConfig's
// defaults without a database).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createLoa = require('../loa');
const gateway = require('../discordGateway');

const { localToGuildTime, guildToLocalTime, nextNightOn, zoneLabel, isValidTimeZone } = createLoa;
const { resolveTimezoneInput, timezoneChoices, loaAnnouncement } = gateway.__test;

const SAT = '2026-11-21';

describe('localToGuildTime', () => {
  test('converts an evening from the other US zones', () => {
    assert.equal(localToGuildTime('20:00', 'America/Chicago', SAT), '21:00');
    assert.equal(localToGuildTime('18:00', 'America/Los_Angeles', SAT), '21:00');
    assert.equal(localToGuildTime('8:00 PM', 'America/Chicago', SAT), '21:00', 'accepts a 12-hour time');
  });

  test('leaves guild time, no zone, a bad zone or no night alone', () => {
    assert.equal(localToGuildTime('21:00', 'America/New_York', SAT), '21:00');
    assert.equal(localToGuildTime('21:00', null, SAT), '21:00');
    assert.equal(localToGuildTime('21:00', 'Not/A_Zone', SAT), '21:00');
    assert.equal(localToGuildTime('20:00', 'America/Chicago', null), '20:00');
  });

  test('rejects an unreadable time', () => {
    assert.equal(localToGuildTime('later', 'America/Chicago', SAT), null);
  });

  test("an after-midnight local time lands inside that guild night", () => {
    // 2am Sunday in London is 9pm Saturday ET — Saturday night, as picked.
    assert.equal(localToGuildTime('02:00', 'Europe/London', SAT), '21:00');
    // 11am Sunday in Sydney is 7pm Saturday ET.
    assert.equal(localToGuildTime('11:00', 'Australia/Sydney', SAT), '19:00');
  });

  test('uses the offset of the night given, across DST changes', () => {
    // 14 March: the US has moved to EDT, the UK is still on GMT — 4 hours apart.
    assert.equal(localToGuildTime('01:30', 'Europe/London', '2026-03-14'), '21:30');
    // 21 November: both on standard time — 5 hours apart.
    assert.equal(localToGuildTime('02:30', 'Europe/London', SAT), '21:30');
  });

  test('guildToLocalTime undoes it', () => {
    for (const [tz, t] of [['America/Chicago', '20:00'], ['Europe/London', '02:00'], ['Australia/Sydney', '11:00'], ['Asia/Kolkata', '07:30']]) {
      assert.equal(guildToLocalTime(localToGuildTime(t, tz, SAT), tz, SAT), t, tz);
    }
    // 00:30 ET belongs to Saturday night but falls on Sunday — 23:30 in Chicago.
    assert.equal(guildToLocalTime('00:30', 'America/Chicago', SAT), '23:30');
  });
});

describe('nextNightOn', () => {
  test('is tonight or the next one on that weekday', () => {
    // 16 November 2026 is a Monday.
    assert.equal(nextNightOn(1, '2026-11-16'), '2026-11-16');
    assert.equal(nextNightOn(2, '2026-11-16'), '2026-11-17');
    assert.equal(nextNightOn(0, '2026-11-16'), '2026-11-22');
  });
});

describe('zone names', () => {
  test('collapse US standard/daylight names', () => {
    assert.equal(zoneLabel('America/New_York', Date.parse('2026-11-21T17:00:00Z')), 'ET');
    assert.equal(zoneLabel('America/New_York', Date.parse('2026-07-04T17:00:00Z')), 'ET');
    assert.equal(zoneLabel('America/Chicago'), 'CT');
    assert.equal(zoneLabel('Not/A_Zone'), '');
  });

  test('isValidTimeZone', () => {
    assert.equal(isValidTimeZone('Europe/Paris'), true);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
    assert.equal(isValidTimeZone(''), false);
    assert.equal(isValidTimeZone(null), false);
  });
});

describe('/loa timezone option', () => {
  test('reads what people type', () => {
    assert.equal(resolveTimezoneInput('America/Chicago'), 'America/Chicago');
    assert.equal(resolveTimezoneInput('america/chicago'), 'America/Chicago');
    assert.equal(resolveTimezoneInput('CST'), 'America/Chicago');
    assert.equal(resolveTimezoneInput('pt'), 'America/Los_Angeles');
    assert.equal(resolveTimezoneInput('Central'), 'America/Chicago');
    assert.equal(resolveTimezoneInput('london'), 'Europe/London');
    assert.equal(resolveTimezoneInput('Sao Paulo'), 'America/Sao_Paulo');
    assert.equal(resolveTimezoneInput('nowhere at all'), null);
    assert.equal(resolveTimezoneInput(''), null);
  });

  test('autocomplete leads with the common zones and searches the rest', () => {
    const none = timezoneChoices('');
    assert.equal(none[0].value, 'America/New_York');
    assert.ok(none.length <= 25);
    assert.equal(timezoneChoices('cst')[0].value, 'America/Chicago');
    assert.ok(timezoneChoices('berlin').some((c) => c.value === 'Europe/Berlin'));
    for (const c of timezoneChoices('a')) assert.ok(c.name.length <= 100);
  });
});

describe('LOA channel post', () => {
  test('labels times with the guild zone', () => {
    const text = loaAnnouncement({
      type: 'event', displayName: 'Sam', eventDate: SAT, startTime: '21:00', endTime: '22:30',
    });
    assert.match(text, /from \*\*9:00 PM ET\*\* to \*\*10:30 PM ET\*\*/);
    const weekly = loaAnnouncement({ type: 'recurring', displayName: 'Sam', dayOfWeek: 2, startTime: '20:00' });
    assert.match(weekly, /every \*\*Tuesday\*\* from \*\*8:00 PM ET\*\*/);
  });

  test('says nothing about time when there is none', () => {
    const text = loaAnnouncement({ type: 'event', displayName: 'Sam', eventDate: SAT, eventName: 'Siege' });
    assert.doesNotMatch(text, /from/);
  });
});
