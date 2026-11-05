// backend/weaponClass.js — a weapon pair's class name, from shared/weaponClasses.json.
//
// One lookup for the whole backend, so the war record, the feud pages and the
// scouting post can't name the same pair two different ways. The JSON is keyed
// by both weapons with spaces stripped; either order is tried. A pair it doesn't
// know prints as the two weapons rather than a guess.
const weaponToClass = require('../shared/weaponClasses.json');

function className(weapon1, weapon2) {
  if (!weapon1) return 'Unknown';
  const w1 = (weapon1 || '').trim();
  const w2 = (weapon2 || '').trim();

  let key = (w1 + w2).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];

  key = (w2 + w1).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];

  return `${w1} ${w2}`.trim() || 'Unknown';
}

module.exports = { className };
