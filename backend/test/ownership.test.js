// backend/test/ownership.test.js — a member can change their own things, and
// nobody else's without the matching officer capability.
//
// Three layers, because the rule lives in three places:
//   - canActFor(), behind every member route that takes a :discordId;
//   - the LOA and late-attendance modules, which check ownership themselves;
//   - server.js, which can't be loaded in a test (it listens on require), so a
//     source check makes sure no write route with a :discordId in its path
//     ships without calling the rule at all.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { canActFor } = require('../permissions');
const createLoa = require('../loa');
const createLateAttendance = require('../lateAttendance');

const member = (id, permissions = []) => ({ id, username: `u${id}`, permissions });

describe('canActFor', () => {
  test('your own record, always — no capability needed', () => {
    assert.equal(canActFor(member('111'), '111', 'builds'), true);
  });

  test('someone else\'s: refused without the capability', () => {
    assert.equal(canActFor(member('111'), '222', 'builds'), false);
  });

  test('someone else\'s: allowed with exactly that capability', () => {
    assert.equal(canActFor(member('111', ['builds']), '222', 'builds'), true);
  });

  test('a different capability doesn\'t count', () => {
    assert.equal(canActFor(member('111', ['gear', 'loot.catalog']), '222', 'builds'), false);
  });

  test('ids compare as strings, both ways', () => {
    assert.equal(canActFor({ id: 111, permissions: [] }, '111', 'builds'), true);
    assert.equal(canActFor(member('111'), 111, 'builds'), true);
    assert.equal(canActFor({ id: 111, permissions: [] }, '1110', 'builds'), false);
  });

  test('no user, no id or no target is a refusal, never a match', () => {
    assert.equal(canActFor(null, '111', 'builds'), false);
    assert.equal(canActFor({ permissions: [] }, undefined, 'builds'), false, 'missing id must not equal missing target');
    assert.equal(canActFor(member('111'), '', 'builds'), false);
    assert.equal(canActFor(member('111'), null, 'builds'), false);
  });

  test('no capability named means owner-only', () => {
    assert.equal(canActFor(member('111', ['builds']), '222', null), false);
  });
});

// ── A small in-memory Supabase ──────────────────────────────────────────────
let TABLES;
function fakeSupabase() {
  return {
    from(name) {
      const rows = (TABLES[name] ||= []);
      const state = { op: 'select', filters: [], payload: null };
      const matching = () => rows.filter((r) => state.filters.every(([f, v]) => String(r[f]) === String(v)));
      const run = () => {
        if (state.op === 'insert') {
          [].concat(state.payload).forEach((r) => rows.push({ ...r }));
          return { data: null, error: null };
        }
        const hit = matching();
        if (state.op === 'delete') hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const one = () => {
        const { data } = run();
        return Promise.resolve({ data: data[0] || null, error: null });
      };
      const q = {
        select: () => q,
        insert: (payload) => { state.op = 'insert'; state.payload = payload; return q; },
        delete: () => { state.op = 'delete'; return q; },
        eq: (f, v) => { state.filters.push([f, v]); return q; },
        in: () => q,
        order: () => q,
        single: one,
        maybeSingle: one,
        then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
      };
      return q;
    },
  };
}

describe('LOA cancel', () => {
  let loa;
  beforeEach(() => {
    TABLES = {
      loa_entries: [{ id: 'mine', discord_id: '111', type: 'range', start_date: '2026-11-10', end_date: '2026-11-12' }],
    };
    loa = createLoa(fakeSupabase());
  });

  test('another member cannot cancel it, and it stays', async () => {
    await assert.rejects(loa.cancel('mine', '222', false), (err) => err.status === 403);
    assert.equal(TABLES.loa_entries.length, 1);
  });

  test('its owner can', async () => {
    await loa.cancel('mine', '111', false);
    assert.equal(TABLES.loa_entries.length, 0);
  });

  test('an officer with loa.admin can', async () => {
    await loa.cancel('mine', '999', true);
    assert.equal(TABLES.loa_entries.length, 0);
  });
});

describe('late attendance withdraw', () => {
  let late;
  beforeEach(() => {
    TABLES = {
      late_attendance_requests: [
        { id: 'r1', discord_id: '111', event_id: 'e1', status: 'pending' },
        { id: 'r2', discord_id: '111', event_id: 'e2', status: 'approved' },
      ],
      audit_log: [],
    };
    late = createLateAttendance(fakeSupabase());
  });

  test('another member\'s request: refused, and it stays', async () => {
    await assert.rejects(late.cancel('r1', '222'), (err) => err.status === 404);
    assert.ok(TABLES.late_attendance_requests.some((r) => r.id === 'r1'));
  });

  test('your own pending request: withdrawn', async () => {
    await late.cancel('r1', '111');
    assert.ok(!TABLES.late_attendance_requests.some((r) => r.id === 'r1'));
  });

  test('already decided: can\'t be withdrawn, even by its owner', async () => {
    await assert.rejects(late.cancel('r2', '111'), (err) => err.status === 404);
    assert.ok(TABLES.late_attendance_requests.some((r) => r.id === 'r2'));
  });
});

// ── server.js: every :discordId write route checks ownership ────────────────
// A source check, because server.js starts listening when required. Crude by
// design: it looks for the call, not at what the call decides — canActFor's own
// tests above cover that. What it catches is a new route that forgets the check
// entirely, which is the realistic way this breaks.
describe('server.js member routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const ROUTE = /^app\.(get|put|post|patch|delete)\('(\/api\/[^']*:discordId[^']*)'/gm;
  const routes = [...src.matchAll(ROUTE)].map((m) => {
    // The handler runs to the next top-level route; the check must come in its
    // first few lines, before any read or write.
    const rest = src.slice(m.index);
    const next = rest.slice(1).search(/^app\.(get|put|post|patch|delete|use)\(/m);
    const handler = next === -1 ? rest : rest.slice(0, next + 1);
    return { method: m[1], path: m[2], head: handler.split('\n').slice(0, 8).join('\n') };
  });

  // Reads that are deliberately open to every member — the whole guild sees
  // every build, like the shard tracker. Anything else with :discordId must check.
  const OPEN_READS = new Set(['GET /api/builds/:discordId']);

  test('found the routes (the pattern still matches server.js)', () => {
    assert.ok(routes.length >= 5, `only found ${routes.length}`);
  });

  test('each one checks who is asking before doing anything', () => {
    const unchecked = routes
      .filter((r) => !OPEN_READS.has(`${r.method.toUpperCase()} ${r.path}`))
      .filter((r) => !/canActFor\(req\.user|userHas\(req\.user/.test(r.head))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);
    assert.deepEqual(unchecked, []);
  });
});
