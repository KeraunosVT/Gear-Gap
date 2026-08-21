// backend/test/pagedRead.test.js — run with `npm test`.
//
// node:test is built into Node, so this suite needs no dependency and no
// config. The first tests in the repo are here rather than somewhere more
// glamorous because this is the helper standing between the app and a whole
// class of silently-wrong reads.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { fetchAll, MAX_ROWS } = require('../pagedRead');

// A stand-in for a PostgREST table: holds `total` rows and refuses to return
// more than `serverCap` of them at once, which is exactly what `max-rows` does.
function fakeTable({ total, serverCap = 1000 }) {
  const calls = [];
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const build = () => ({
    range(from, to) {
      const want = to - from + 1;
      calls.push({ from, want });
      const data = rows.slice(from, from + Math.min(want, serverCap));
      return Promise.resolve({ data, error: null });
    },
  });
  return { build, calls, rows };
}

describe('fetchAll', () => {
  test('empty table costs one request and returns nothing', async () => {
    const t = fakeTable({ total: 0 });
    assert.deepEqual(await fetchAll(t.build), []);
    assert.equal(t.calls.length, 1);
  });

  test('a partial page is returned whole', async () => {
    const t = fakeTable({ total: 7 });
    const out = await fetchAll(t.build, { pageSize: 1000 });
    assert.equal(out.length, 7);
  });

  test('reads past the 1,000-row cap — the bug this exists for', async () => {
    const t = fakeTable({ total: 2_500 });
    const out = await fetchAll(t.build);
    assert.equal(out.length, 2_500);
    assert.deepEqual(out.map((r) => r.id).slice(0, 3), [0, 1, 2]);
    assert.equal(out[2_499].id, 2_499);
  });

  test('no row is skipped or seen twice across page boundaries', async () => {
    const t = fakeTable({ total: 3_001 });
    const out = await fetchAll(t.build);
    assert.equal(new Set(out.map((r) => r.id)).size, 3_001);
    assert.deepEqual(out.map((r) => r.id), t.rows.map((r) => r.id));
  });

  test('exactly one full page still checks for a second', async () => {
    // The off-by-one that would drop everything after a page boundary if the
    // loop ever went back to stopping on a short page.
    const t = fakeTable({ total: 1_000 });
    const out = await fetchAll(t.build);
    assert.equal(out.length, 1_000);
    assert.equal(t.calls.length, 2, 'should confirm the end with an empty page');
  });

  test('server cap SMALLER than the page size does not truncate', async () => {
    // The trap: ask for 1,000 from a project configured with max-rows 500 and a
    // `length < pageSize` loop stops at 500, convinced it is done.
    const t = fakeTable({ total: 1_200, serverCap: 500 });
    const out = await fetchAll(t.build, { pageSize: 1000 });
    assert.equal(out.length, 1_200);
  });

  test('advances by rows actually received, never by the requested size', async () => {
    const t = fakeTable({ total: 900, serverCap: 400 });
    await fetchAll(t.build, { pageSize: 1000 });
    assert.deepEqual(t.calls.map((c) => c.from), [0, 400, 800, 900]);
  });

  test('a fresh builder is used per page', async () => {
    let built = 0;
    const rows = Array.from({ length: 1_500 }, (_, i) => ({ id: i }));
    const build = () => {
      built += 1;
      return { range: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }) };
    };
    await fetchAll(build);
    assert.equal(built, 3, 'reusing one builder would re-run an executed query');
  });

  test('an error propagates instead of returning a short list', async () => {
    const build = () => ({ range: () => Promise.resolve({ data: null, error: new Error('boom') }) });
    await assert.rejects(() => fetchAll(build), /boom/);
  });

  test('an error on a LATER page still throws', async () => {
    let n = 0;
    const rows = Array.from({ length: 2_000 }, (_, i) => ({ id: i }));
    const build = () => ({
      range: (from, to) => {
        n += 1;
        if (n === 2) return Promise.resolve({ data: null, error: new Error('late boom') });
        return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
      },
    });
    // Half a table is worse than no table: it looks like an answer.
    await assert.rejects(() => fetchAll(build), /late boom/);
  });

  test('a runaway read is refused rather than eating the process', async () => {
    const build = () => ({
      range: (from, to) => Promise.resolve({
        data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })),
        error: null,
      }),
    });
    await assert.rejects(
      () => fetchAll(build, { label: 'loa_entries' }),
      (err) => err.message.includes('loa_entries') && err.message.includes(MAX_ROWS.toLocaleString()),
    );
  });
});
