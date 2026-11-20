const test = require('node:test');
const assert = require('node:assert/strict');
const { raids } = require('../src/catalog');
const { parsePlan, formatPlan, planLines, planSuggestions } = require('../src/plan');

const raid = raids[0];
const segs = (s) => {
  const r = parsePlan(raid, s);
  assert.ok(r.ok, `${s}: ${r.error}`);
  return r.segments;
};

test('one mode, with and without gates', () => {
  assert.deepEqual(segs('normal 1-3'), [{ mode: 'normal', gates: [1, 2, 3] }]);
  assert.deepEqual(segs('Difficult'), [{ mode: 'difficult', gates: [1, 2, 3] }]);
  assert.deepEqual(segs('nightmare 2'), [{ mode: 'nightmare', gates: [2] }]);
  assert.deepEqual(segs('hard 1,3'), [{ mode: 'difficult', gates: [1, 3] }]);
  assert.deepEqual(segs('normal gates 1 & 2'), [{ mode: 'normal', gates: [1, 2] }]);
  assert.deepEqual(segs('normal 1–3'), [{ mode: 'normal', gates: [1, 2, 3] }]);
});

test('aliases and unambiguous starts of names', () => {
  assert.deepEqual(segs('nm 1'), [{ mode: 'nightmare', gates: [1] }]);
  assert.deepEqual(segs('n1-2'), [{ mode: 'normal', gates: [1, 2] }]);
  assert.deepEqual(segs('diff 3'), [{ mode: 'difficult', gates: [3] }]);
  assert.deepEqual(segs('nightm 1'), [{ mode: 'nightmare', gates: [1] }]);
});

test('several modes come out in difficulty order, merged', () => {
  assert.deepEqual(segs('nightmare 1 + normal 1-3'), [
    { mode: 'normal', gates: [1, 2, 3] }, { mode: 'nightmare', gates: [1] },
  ]);
  assert.deepEqual(segs('n1-2, nm3 and normal 3'), [
    { mode: 'normal', gates: [1, 2, 3] }, { mode: 'nightmare', gates: [3] },
  ]);
});

test('says what is wrong', () => {
  assert.match(parsePlan(raid, 'normal 4').error, /1 to 3/);
  assert.match(parsePlan(raid, 'normal 3-1').error, /1 to 3/);
  assert.match(parsePlan(raid, 'foo 1').error, /"foo" isn't a mode.*Normal, Difficult, Nightmare/);
  assert.match(parsePlan(raid, '').error, /Couldn't read/);
  assert.match(parsePlan(raid, 'normal 1-3 !!').error, /Couldn't read/);
});

test('formatPlan reads back exactly', () => {
  for (const s of ['normal 1-3', 'nm 1', 'hard 1,3', 'n1-2 + nm 3', 'difficult 2-3 + nightmare']) {
    const once = segs(s);
    assert.deepEqual(segs(formatPlan(raid, once)), once, s);
  }
  assert.equal(formatPlan(raid, segs('normal + nm 1')), 'Normal 1-3 + Nightmare 1');
});

test('planLines for the post', () => {
  assert.deepEqual(planLines(raid, segs('normal + nm 1,3')), [
    '🟢 **Normal** · Gates 1–3', '🔴 **Nightmare** · Gates 1 & 3',
  ]);
});

test('suggestions lead with the typed plan, read back', () => {
  const [first] = planSuggestions(raid, 'nm 1');
  assert.equal(first.value, 'Nightmare 1');
  assert.match(first.name, /^✓ 🔴 Nightmare · Gate 1/);
  const blank = planSuggestions(raid, '');
  assert.ok(blank.some((c) => c.value === 'Normal 1-3'));
  assert.ok(blank.every((c) => segs(c.value)));
  assert.ok(blank.length <= 25);
});
