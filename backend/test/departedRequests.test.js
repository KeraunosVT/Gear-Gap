// backend/test/departedRequests.test.js — clearing loot requests of members
// who lost the member role.
//
// The deletes are irreversible, so most of this is about when the sweep must
// NOT delete: a first sighting, a member who comes back, a mis-set role that
// makes half the guild look departed, and a Lucent request that's already paid.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const createDepartedRequests = require('../departedRequests');

// Just enough of the supabase-js builder for the two tables the sweep reads
// and deletes from: select / delete, then .in() filters, awaited.
function fakeSupabase(tables) {
  return {
    from(name) {
      const filters = [];
      let op = 'select';
      const q = {
        select() { op = 'select'; return q; },
        delete() { op = 'delete'; return q; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
        then(resolve) {
          const hit = (r) => filters.every((f) => f(r));
          if (op === 'delete') tables[name] = tables[name].filter((r) => !hit(r));
          resolve({ data: op === 'select' ? tables[name].filter(hit) : null, error: null });
        },
      };
      return q;
    },
  };
}

let tables;
let members;
let departed;

beforeEach(() => {
  tables = {
    loot_wishlists: [{ discord_id: 'a' }, { discord_id: 'b' }, { discord_id: 'c' }, { discord_id: 'd' }],
    lucent_requests: [
      { discord_id: 'b', status: 'pending' },
      { discord_id: 'b', status: 'approved' },
      { discord_id: 'b', status: 'paid' },
      { discord_id: 'b', status: 'denied' },
    ],
  };
  members = [{ id: 'a' }, { id: 'c' }, { id: 'd' }];
  departed = createDepartedRequests(fakeSupabase(tables), async () => members);
});

describe('departed-request sweep', () => {
  test('first sighting only starts the clock', async () => {
    const { removed } = await departed.sweep();
    assert.deepEqual(removed, []);
    assert.equal(tables.loot_wishlists.length, 4);
  });

  test('second sighting clears the wishlist and open Lucent requests, keeps paid and denied', async () => {
    await departed.sweep();
    const { removed } = await departed.sweep();
    assert.deepEqual(removed, ['b']);
    assert.deepEqual(tables.loot_wishlists.map((r) => r.discord_id), ['a', 'c', 'd']);
    assert.deepEqual(tables.lucent_requests.map((r) => r.status), ['paid', 'denied']);
  });

  test('getting the role back between sweeps resets the clock', async () => {
    await departed.sweep();
    members = [...members, { id: 'b' }];
    await departed.sweep();
    members = members.filter((m) => m.id !== 'b');
    const { removed } = await departed.sweep();
    assert.deepEqual(removed, []);
    assert.equal(tables.loot_wishlists.length, 4);
  });

  test('more than half the requesters missing is treated as a misconfigured role', async () => {
    members = [{ id: 'a' }];
    await departed.sweep();
    const result = await departed.sweep();
    assert.equal(result.skipped, 'mass removal');
    assert.equal(tables.loot_wishlists.length, 4);
  });

  test('an empty member list never deletes', async () => {
    members = [];
    await departed.sweep();
    const result = await departed.sweep();
    assert.equal(result.skipped, 'empty member list');
    assert.equal(tables.loot_wishlists.length, 4);
  });
});
