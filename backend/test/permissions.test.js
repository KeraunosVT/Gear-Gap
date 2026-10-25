// backend/test/permissions.test.js — what a session is allowed to do.
//
// The case this was written for: an officer logged in before 'builds' existed
// and couldn't pin key stats, because their token carried the permission list
// from login. An officer role is meant to hold every capability, including
// ones added later, so heldBy reads the current list for it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { heldBy, userHas, ALL_PERMISSIONS } = require('../permissions');

const ALL = ALL_PERMISSIONS.map((p) => p.key);

describe('heldBy / userHas', () => {
  test('an officer-role session holds a capability its token predates', () => {
    const officer = { id: '1', fullAccess: true, isAdmin: true, permissions: ALL.filter((k) => k !== 'builds') };
    assert.ok(userHas(officer, 'builds'));
    assert.deepEqual(heldBy(officer), ALL);
  });

  test('a granted session holds exactly what it was granted', () => {
    const loot = { id: '2', fullAccess: false, isAdmin: true, permissions: ['loot.awards'] };
    assert.ok(userHas(loot, 'loot.awards'));
    assert.ok(!userHas(loot, 'builds'));
  });

  test('a token from before capabilities existed counts as full access only if it was admin', () => {
    assert.ok(userHas({ id: '3', isAdmin: true }, 'builds'));
    assert.ok(!userHas({ id: '4', isAdmin: false }, 'builds'));
  });

  test('a member holds nothing, and no session holds a key that does not exist', () => {
    assert.deepEqual(heldBy({ id: '5', fullAccess: false, permissions: [] }), []);
    assert.ok(!userHas({ id: '6', fullAccess: true }, 'not.a.permission'));
    assert.ok(!userHas(null, 'builds'));
  });
});
