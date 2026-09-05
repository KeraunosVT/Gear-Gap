// backend/test/weaponNames.test.js — the seam between what the model answers and
// the tokens shared/weaponClasses.json can resolve.
//
// A name that doesn't resolve doesn't throw. It survives as raw text, gets
// flagged for manual correction on the upload screen, and — if committed —
// renders on the War Record as a raw weapon pair instead of a class. "Bow" is
// the live example: it is the natural English word AND the label on the legend
// image the prompt tells the model to trust, so the model has every reason to
// answer it.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { cleanWeapon, WEAPONS } = require('../ingest');
const weaponClasses = require('../../shared/weaponClasses.json');

describe('cleanWeapon', () => {
  test('passes every canonical name through unchanged', () => {
    WEAPONS.forEach((w) => assert.equal(cleanWeapon(w), w));
  });

  test('is case-insensitive', () => {
    assert.equal(cleanWeapon('greatsword'), 'Greatsword');
    assert.equal(cleanWeapon('SNS'), 'SnS');
    assert.equal(cleanWeapon('  wand  '), 'Wand');
  });

  test('"Bow" resolves to Longbow', () => {
    // The legend image labels this icon "Bow"; every other layer says Longbow.
    assert.equal(cleanWeapon('Bow'), 'Longbow');
    assert.equal(cleanWeapon('bow'), 'Longbow');
    assert.equal(cleanWeapon('Long Bow'), 'Longbow');
  });

  test('other plausible spellings resolve too', () => {
    assert.equal(cleanWeapon('Sword and Shield'), 'SnS');
    assert.equal(cleanWeapon('Cross Bow'), 'Crossbow');
    assert.equal(cleanWeapon('Great Sword'), 'Greatsword');
    assert.equal(cleanWeapon('Daggers'), 'Dagger');
    assert.equal(cleanWeapon('Gauntlets'), 'Gauntlet');
  });

  test('Unknown is preserved, not guessed at', () => {
    // It has to stay unresolved so buildWarnings flags the row. Mapping it to
    // anything would put a wrong class in the record with nobody reviewing it.
    assert.equal(cleanWeapon('Unknown'), 'Unknown');
    assert.equal(cleanWeapon('Trebuchet'), 'Trebuchet');
    assert.equal(cleanWeapon(''), '');
  });

  test('every alias lands on a name the class map can resolve', () => {
    // The point of the whole exercise: a token that isn't a weaponClasses key
    // component renders as a raw pair on the War Record.
    const keys = Object.keys(weaponClasses);
    const aliases = ['Bow', 'Long Bow', 'Cross Bow', 'Sword and Shield', 'Great Sword', 'Daggers', 'Gauntlets'];
    aliases.forEach((a) => {
      const resolved = cleanWeapon(a);
      assert.ok(WEAPONS.includes(resolved), `${a} -> ${resolved} is not a canonical weapon`);
      assert.ok(
        keys.some((k) => k.includes(resolved)),
        `${resolved} appears in no weaponClasses key`,
      );
    });
  });
});
