// backend/test/signupWarDetails.test.js — a War Games night's maps and rules.
//
// Both are free text an officer types; what's checked is what reaches the
// database: trimmed, blank as null, rules keeping their line breaks, and a
// field left out of the request left alone.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createEventSignups = require('../eventSignups');

function fakeSupabase(updates) {
  return {
    from() {
      const q = {
        update: (patch) => { updates.push(patch); return q; },
        eq: () => q,
        select: () => q,
        single: async () => ({ data: { id: 'wg', ...updates[updates.length - 1] }, error: null }),
      };
      return q;
    },
  };
}

const save = async (body) => {
  const updates = [];
  await createEventSignups(fakeSupabase(updates)).setWarDetails('wg', body);
  const { updated_at: _ignored, ...rest } = updates[0];
  return rest;
};

describe('setWarDetails', () => {
  test('maps are one tidy line', async () => {
    assert.deepEqual(await save({ maps: '  Ancient   Ruins,\n Fortress ' }), { war_maps: 'Ancient Ruins, Fortress' });
  });

  test('rules keep their line breaks, without runs of blank lines', async () => {
    assert.deepEqual(
      await save({ rules: '  No T2 gear\r\n\r\n\r\n\r\nMax 2 healers  ' }),
      { war_rules: 'No T2 gear\n\nMax 2 healers' },
    );
  });

  test('blank clears', async () => {
    assert.deepEqual(await save({ maps: '   ', rules: '' }), { war_maps: null, war_rules: null });
  });

  test('a field not sent is left alone', async () => {
    assert.deepEqual(await save({ maps: 'Fortress' }), { war_maps: 'Fortress' });
  });

  test('length is capped', async () => {
    const { war_maps: maps, war_rules: rules } = await save({ maps: 'x'.repeat(500), rules: 'y'.repeat(2000) });
    assert.equal(maps.length, 300);
    assert.equal(rules.length, 1000);
  });
});
