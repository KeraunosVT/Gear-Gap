// backend/test/loaDateChoices.test.js — the date dropdown on /loa event.
//
// Discord has no date-picker option, so this list is how members pick a date.
// A wrong label or an off-by-one here files leave against the wrong night,
// and nothing errors.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { loaDateChoices } = require('../discordGateway').__test;

describe('loaDateChoices', () => {
  test('starts tonight and runs 25 nights', () => {
    const c = loaDateChoices('2026-11-02');
    assert.equal(c.length, 25);
    assert.deepEqual(c[0], { name: 'Today — Mon, Nov 2', value: '2026-11-02' });
    assert.deepEqual(c[1], { name: 'Tomorrow — Tue, Nov 3', value: '2026-11-03' });
    assert.deepEqual(c[2], { name: 'Wed, Nov 4', value: '2026-11-04' });
    assert.equal(c[24].value, '2026-11-26');
  });

  test('finds dates by weekday, month name, M/D or ISO date', () => {
    const values = (q) => loaDateChoices('2026-11-02', q).map((c) => c.value);
    assert.deepEqual(values('fri'), ['2026-11-06', '2026-11-13', '2026-11-20']);
    assert.deepEqual(values('Friday'), ['2026-11-06', '2026-11-13', '2026-11-20']);
    assert.deepEqual(values('nov 14'), ['2026-11-14']);
    assert.deepEqual(values('11/14'), ['2026-11-14']);
    assert.deepEqual(values('2026-11-14'), ['2026-11-14']);
  });

  test('a full date beyond the list is offered as typed', () => {
    assert.deepEqual(loaDateChoices('2026-11-02', '2026-12-25'), [{ name: '2026-12-25', value: '2026-12-25' }]);
  });

  test('crosses month and year ends, naming the year when it changes', () => {
    const c = loaDateChoices('2026-12-30');
    assert.equal(c[2].value, '2027-01-01');
    assert.equal(c[2].name, 'Fri, Jan 1, 2027');
    assert.equal(c[1].name, 'Tomorrow — Thu, Dec 31');
  });
});
