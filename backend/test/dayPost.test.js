// backend/test/dayPost.test.js — rendering one night's events for Discord.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildDayPost, unixFor } = require('../dayPost');

const NIGHT = '2026-10-24'; // a Saturday

describe('buildDayPost', () => {
  test('times become Discord timestamps, earliest first, untimed last', () => {
    const { embeds } = buildDayPost({
      date: NIGHT,
      events: [
        { name: 'Field Boss', time: '00:30' },
        { name: 'Untimed', time: null },
        { name: 'Riftstone', time: '21:00' },
      ],
    });
    const lines = embeds[0].description.split('\n').slice(2);
    assert.match(lines[0], new RegExp(`<t:${unixFor(NIGHT, '21:00')}:t> — \\*\\*Riftstone\\*\\* · <t:\\d+:R>`));
    assert.match(lines[1], /Field Boss/);
    assert.equal(lines[2], 'Time TBA — **Untimed**');
    assert.match(embeds[0].title, /Saturday/);
  });

  test('an after-midnight time lands on the next calendar day', () => {
    assert.ok(unixFor(NIGHT, '00:30') > unixFor(NIGHT, '23:00'));
  });

  test('blank names are dropped; nothing left is an error', () => {
    assert.throws(() => buildDayPost({ date: NIGHT, events: [{ name: '  ', time: '21:00' }] }), /at least one/);
  });

  test('a bad date or time is refused', () => {
    assert.throws(() => buildDayPost({ date: 'tomorrow', events: [{ name: 'X' }] }), /YYYY-MM-DD/);
    assert.throws(() => buildDayPost({ date: NIGHT, events: [{ name: 'X', time: '25:00' }] }), /invalid time/);
  });

  test('the note goes in content, blank means none', () => {
    assert.equal(buildDayPost({ date: NIGHT, events: [{ name: 'X' }], note: ' @here ' }).content, '@here');
    assert.equal(buildDayPost({ date: NIGHT, events: [{ name: 'X' }], note: '' }).content, undefined);
  });
});
