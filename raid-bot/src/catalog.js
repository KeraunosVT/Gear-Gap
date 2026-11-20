// The raid catalog (raids.json) and the few facts every other module needs
// about it. Throne & Liberty only: the three roles are the game's, not a
// setting.
const { raids } = require('../raids.json');

const ROLES = ['Tank', 'DPS', 'Healer'];
const ROLE_EMOJI = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };
const ROLE_PLURAL = { Tank: 'Tanks', DPS: 'DPS', Healer: 'Healers' };

const raidOf = (key) => raids.find((r) => r.key === key) || null;

// The hardest mode a run's plan includes, which picks the post's colour.
function hardestMode(raidKey, segments) {
  const raid = raidOf(raidKey);
  if (!raid || !Array.isArray(segments)) return null;
  const keys = new Set(segments.map((s) => s.mode));
  return [...raid.modes].reverse().find((m) => keys.has(m.key)) || null;
}

// "Gate 2", "Gates 1 & 3", "Gates 1–3".
function gatesText(gates) {
  const g = [...gates].sort((a, b) => a - b);
  if (g.length === 1) return `Gate ${g[0]}`;
  const run = g.every((n, i) => i === 0 || n === g[i - 1] + 1);
  return run && g.length > 2 ? `Gates ${g[0]}–${g[g.length - 1]}` : `Gates ${g.join(' & ')}`;
}

module.exports = { raids, ROLES, ROLE_EMOJI, ROLE_PLURAL, raidOf, hardestMode, gatesText };
