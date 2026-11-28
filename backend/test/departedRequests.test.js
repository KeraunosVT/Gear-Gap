// backend/test/departedRequests.test.js — clearing loot requests of members
// who lost the member role.
//
// The deletes are irreversible, so most of this is about when the sweep must
// NOT delete: a first sighting, a member who comes back, a mis-set role that
// makes half the guild look departed, and a Lucent request that's already paid.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const createDepartedRequests = require('../departedRequests');

// Just enough of the supabase-js builder for the tables the sweep reads
// and writes: select / delete / update, then .in() and .eq() filters, awaited.
function fakeSupabase(tables) {
  return {
    from(name) {
      const filters = [];
      let op = 'select';
      let patch = null;
      const q = {
        select() { op = 'select'; return q; },
        delete() { op = 'delete'; return q; },
        update(p) { op = 'update'; patch = p; return q; },
        in(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
        eq(col, val) { filters.push((r) => r[col] === val); return q; },
        then(resolve) {
          const hit = (r) => filters.every((f) => f(r));
          if (op === 'delete') tables[name] = tables[name].filter((r) => !hit(r));
          if (op === 'update') tables[name] = tables[name].map((r) => (hit(r) ? { ...r, ...patch } : r));
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
let deletedMessages;

beforeEach(() => {
  tables = {
    loot_wishlists: [{ discord_id: 'a' }, { discord_id: 'b' }, { discord_id: 'c' }, { discord_id: 'd' }],
    lucent_requests: [
      { discord_id: 'b', status: 'pending' },
      { discord_id: 'b', status: 'approved' },
      { discord_id: 'b', status: 'paid' },
      { discord_id: 'b', status: 'denied' },
    ],
    loa_entries: [
      { discord_id: 'a', discord_message_id: 'msg-a' },
      { discord_id: 'b', discord_message_id: 'msg-b1' },
      { discord_id: 'b', discord_message_id: null },
    ],
    rosters: [
      {
        id: 'r1',
        updated_at: '2026-11-01T00:00:00Z',
        layout: {
          parties: [
            { id: 'p1', name: 'Party 1', members: [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bo' }] },
            { id: 'p2', name: 'Party 2', members: [{ id: 'c', name: 'Cy' }] },
          ],
          absent: [{ id: 'b', name: 'Bo', why: 'loa' }],
          classAssignments: { pvp: { a: 'Mage', b: 'Tank' }, pve: { b: 'Healer' } },
          rolesByMode: { pvp: { a: 'DPS', b: 'Tank' }, pve: {} },
        },
      },
      {
        id: 'r2',
        updated_at: '2026-11-02T00:00:00Z',
        layout: { parties: [{ id: 'p1', name: 'Party 1', members: [{ id: 'c', name: 'Cy' }] }], absent: [] },
      },
    ],
  };
  members = [{ id: 'a' }, { id: 'c' }, { id: 'd' }];
  deletedMessages = [];
  departed = createDepartedRequests(fakeSupabase(tables), async () => members, {
    deleteLoaMessage: async (id) => { deletedMessages.push(id); },
  });
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

  test('second sighting clears their LOAs and deletes the announcements', async () => {
    await departed.sweep();
    await departed.sweep();
    assert.deepEqual(tables.loa_entries.map((r) => r.discord_id), ['a']);
    assert.deepEqual(deletedMessages, ['msg-b1']);
  });

  test('second sighting takes them out of saved rosters, picks and all', async () => {
    await departed.sweep();
    await departed.sweep();
    const r1 = tables.rosters.find((r) => r.id === 'r1');
    assert.deepEqual(r1.layout.parties.map((p) => p.members.map((m) => m.id)), [['a'], ['c']]);
    assert.deepEqual(r1.layout.absent, []);
    assert.deepEqual(r1.layout.classAssignments, { pvp: { a: 'Mage' }, pve: {} });
    assert.deepEqual(r1.layout.rolesByMode, { pvp: { a: 'DPS' }, pve: {} });
    // Party names and the rest of the roster survive; only the seat goes.
    assert.deepEqual(r1.layout.parties.map((p) => p.name), ['Party 1', 'Party 2']);
    assert.equal(r1.updated_at, '2026-11-01T00:00:00Z');
  });

  test('a roster with nobody departed in it is not rewritten', async () => {
    const before = tables.rosters.find((r) => r.id === 'r2');
    await departed.sweep();
    await departed.sweep();
    assert.equal(tables.rosters.find((r) => r.id === 'r2'), before);
  });

  test('someone holding only a roster seat is still cleared', async () => {
    tables.rosters[1].layout.parties[0].members.push({ id: 'e', name: 'Eve' });
    await departed.sweep();
    const { removed } = await departed.sweep();
    assert.deepEqual(removed.sort(), ['b', 'e']);
    assert.deepEqual(tables.rosters[1].layout.parties[0].members.map((m) => m.id), ['c']);
  });

  test('getting the role back keeps their roster seats', async () => {
    await departed.sweep();
    members = [...members, { id: 'b' }];
    await departed.sweep();
    assert.deepEqual(tables.rosters[0].layout.parties[0].members.map((m) => m.id), ['a', 'b']);
  });

  test('someone holding only an LOA is still cleared', async () => {
    tables.loa_entries.push({ discord_id: 'e', discord_message_id: 'msg-e' });
    await departed.sweep();
    const { removed } = await departed.sweep();
    assert.deepEqual(removed.sort(), ['b', 'e']);
    assert.deepEqual(tables.loa_entries.map((r) => r.discord_id), ['a']);
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
    assert.equal(tables.loa_entries.length, 3);
    assert.deepEqual(tables.rosters[1].layout.parties[0].members.map((m) => m.id), ['c']);
  });

  test('preview lists who would go and what of theirs, without deleting', async () => {
    tables.loa_entries.push({ discord_id: 'e', display_name: 'Gone', discord_message_id: null });
    const { people } = await departed.preview();
    // b sits twice in r1 (a party and Absent), which is one roster, not two.
    assert.deepEqual(
      people.map((p) => [p.discord_id, p.wishlist, p.lucent, p.loas, p.rosters]),
      [['b', true, 2, 2, 1], ['e', false, 0, 1, 0]],
    );
    assert.equal(tables.loa_entries.length, 4);
    assert.equal(tables.rosters[0].layout.absent.length, 1);
  });

  test('preview names someone known only from a roster by the name it saved', async () => {
    tables.rosters[1].layout.parties[0].members.push({ id: 'e', name: 'Eve' });
    const { people } = await departed.preview();
    assert.deepEqual(people.find((p) => p.discord_id === 'e'), {
      discord_id: 'e', display_name: 'Eve', wishlist: false, lucent: 0, loas: 0, rosters: 1,
    });
  });

  test('clear skips both guards but keeps anyone who has come back', async () => {
    members = [{ id: 'a' }]; // b, c and d look gone — the sweep would refuse this
    const sweep = await departed.sweep();
    assert.equal(sweep.removed.length, 0);

    members = [{ id: 'a' }, { id: 'c' }]; // c came back after the page loaded
    const { removed, kept, rosters } = await departed.clear(['b', 'c', 'd']);
    assert.deepEqual(removed.sort(), ['b', 'd']);
    assert.deepEqual(kept, ['c']);
    assert.equal(rosters, 1);
    assert.deepEqual(tables.rosters[0].layout.parties[1].members.map((m) => m.id), ['c']);
    assert.deepEqual(tables.loot_wishlists.map((r) => r.discord_id), ['a', 'c']);
    assert.deepEqual(tables.loa_entries.map((r) => r.discord_id), ['a']);
    assert.deepEqual(deletedMessages, ['msg-b1']);
  });

  test('an empty member list never deletes', async () => {
    members = [];
    await departed.sweep();
    const result = await departed.sweep();
    assert.equal(result.skipped, 'empty member list');
    assert.equal(tables.loot_wishlists.length, 4);
  });
});
