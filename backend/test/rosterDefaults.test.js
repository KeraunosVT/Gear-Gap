// backend/test/rosterDefaults.test.js — the PvP and PvE default rosters.
//
// The defaults live in `rosters` beside every other roster, under fixed ids.
// What has to hold is that they stay out of everything that treats rosters as
// a night's roster — the saved-roster list, and the generic edit and delete
// routes that could give one a night — while their own routes read and write
// them. Driven over real HTTP against the parties router.

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registerParties = require('../admin/parties');

// Just enough of the supabase-js builder for the roster routes: select,
// insert, update and delete, with .eq / .in / .order filters, awaited
// directly or through .single() / .maybeSingle(). The router takes its client
// once, at registration, so this reads the module's `tables` at query time —
// each test's fresh copy.
function fakeSupabase() {
  return {
    from(name) {
      const filters = [];
      let op = 'select';
      let payload = null;
      const run = () => {
        const hit = (r) => filters.every((f) => f(r));
        if (op === 'insert') { tables[name].push({ ...payload }); return { data: null, error: null }; }
        if (op === 'update') {
          tables[name] = tables[name].map((r) => (hit(r) ? { ...r, ...payload } : r));
          return { data: null, error: null };
        }
        if (op === 'delete') { tables[name] = tables[name].filter((r) => !hit(r)); return { data: null, error: null }; }
        return { data: tables[name].filter(hit), error: null };
      };
      const q = {
        select() { return q; },
        insert(p) { op = 'insert'; payload = p; return q; },
        update(p) { op = 'update'; payload = p; return q; },
        delete() { op = 'delete'; return q; },
        eq(col, val) { filters.push((r) => r[col] === val); return q; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
        order() { return q; },
        single() { const { data } = run(); return Promise.resolve(data[0] ? { data: data[0], error: null } : { data: null, error: { message: 'none' } }); },
        maybeSingle() { const { data } = run(); return Promise.resolve({ data: data[0] || null, error: null }); },
        then(resolve, reject) { try { resolve(run()); } catch (err) { reject(err); } },
      };
      return q;
    },
  };
}

let tables;
let server;
let base;

before(async () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerParties(router, { supabase: fakeSupabase(), loa: null, signups: null });
  app.use(router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
// fetch keeps its connections alive, and close() alone waits for them.
after(() => { server.closeAllConnections(); server.close(); });

beforeEach(() => {
  tables = {
    rosters: [
      { id: 'r1', name: 'Siege', layout: { parties: [] }, event_date: '2026-11-28', updated_at: '2026-11-27T00:00:00Z' },
      { id: 'default-pvp', name: 'PvP default', layout: { parties: [{ id: 'p1', members: [{ id: 'a' }] }] }, event_date: null, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-20T00:00:00Z' },
    ],
  };
});

const call = (method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: body ? { 'content-type': 'application/json' } : undefined,
  body: body ? JSON.stringify(body) : undefined,
});

describe('default rosters', () => {
  test('are left out of the saved-roster list', async () => {
    const res = await call('GET', '/rosters');
    assert.deepEqual((await res.json()).rosters.map((r) => r.id), ['r1']);
  });

  test('come back by mode, null for one never saved', async () => {
    const { defaults } = await (await call('GET', '/rosters/defaults')).json();
    assert.deepEqual(defaults.pvp.layout, tables.rosters[1].layout);
    assert.equal(defaults.pve, null);
  });

  test('saving one never saved creates it, with no night', async () => {
    const layout = { parties: [{ id: 'p1', members: [{ id: 'b' }] }] };
    const res = await call('PUT', '/rosters/defaults/pve', { layout });
    assert.equal(res.status, 200);
    const row = tables.rosters.find((r) => r.id === 'default-pve');
    assert.equal(row.name, 'PvE default');
    assert.deepEqual(row.layout, layout);
    assert.equal(row.event_date, null);
    assert.equal(row.event_schedule_id, null);
    assert.equal(row.signup_event_id, null);
  });

  test('saving over one keeps when it was first made', async () => {
    const layout = { parties: [] };
    await call('PUT', '/rosters/defaults/pvp', { layout });
    const rows = tables.rosters.filter((r) => r.id === 'default-pvp');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].layout, layout);
    assert.equal(rows[0].created_at, '2026-11-01T00:00:00Z');
  });

  test('only pvp and pve exist, and a layout is required', async () => {
    assert.equal((await call('PUT', '/rosters/defaults/raid', { layout: {} })).status, 400);
    assert.equal((await call('PUT', '/rosters/defaults/pvp', {})).status, 400);
    assert.equal((await call('PUT', '/rosters/defaults/pvp', { layout: [] })).status, 400);
  });

  test('the generic roster routes refuse to edit or delete one', async () => {
    const put = await call('PUT', '/rosters/default-pvp', { name: 'x', layout: {}, event_date: '2026-11-28' });
    assert.equal(put.status, 400);
    assert.equal((await call('DELETE', '/rosters/default-pvp')).status, 400);
    const row = tables.rosters.find((r) => r.id === 'default-pvp');
    assert.equal(row.event_date, null);
    assert.equal(row.name, 'PvP default');
  });

  test('an ordinary roster still saves and deletes as before', async () => {
    assert.equal((await call('PUT', '/rosters/r1', { name: 'Siege 2', layout: {} })).status, 200);
    assert.equal(tables.rosters.find((r) => r.id === 'r1').name, 'Siege 2');
    assert.equal((await call('DELETE', '/rosters/r1')).status, 200);
    assert.equal(tables.rosters.some((r) => r.id === 'r1'), false);
  });
});
