// How a build is laid out and formatted. The stat list itself is
// shared/buildStats.json, the same file backend/builds.js reads the
// screenshots against, so the page can't show a stat the reader doesn't know.
import STATS from '../../shared/buildStats.json';

export const BUILD_STATS = STATS;
export const STAT = Object.fromEntries(STATS.map((s) => [s.id, s]));
export const KINDS = ['pve', 'pvp'];
export const KIND_LABEL = { pve: 'PvE', pvp: 'PvP' };

// The site's existing PvE/PvP colours (Shards' build pill, Parties' toggle).
export const KIND_CHIP = {
  pve: 'text-emerald-400 border-emerald-400/40',
  pvp: 'text-oxblood border-oxblood/40',
};

export const DMG = ['Melee', 'Ranged', 'Magic'];
const PFX = ['melee', 'range', 'magic'];

// The melee/ranged/magic matrix. Boss columns are shown as base + Boss bonus on
// a PvE build and as just the bonus on a PvP one; PvP columns are always shown
// as base + PvP bonus, the total against players.
export const COMBAT = [
  ['Defense', 'armor', false],
  ['Hit Chance', 'accuracy', true],
  ['Critical Hit Chance', 'critical_attack', true],
  ['Heavy Attack Chance', 'double_attack', true],
  ['Evasion', 'evasion', true],
  ['Endurance', 'critical_defense', true],
  ['Heavy Attack Evasion', 'double_defense', true],
].map(([name, key, more]) => ({
  name,
  base: PFX.map((p) => `${p}_${key}`),
  boss: more ? PFX.map((p) => `boss_${p}_${key}`) : null,
  pvp: more ? PFX.map((p) => `pvp_${p}_${key}`) : null,
}));

// pvp_melee_critical_defense → melee_critical_defense. Only the matrix stats
// have a base to add to; PvP Damage and PvP Damage Received don't.
const baseMap = (g) => Object.fromEntries(COMBAT.filter((r) => r[g])
  .flatMap((r) => r[g].map((id, i) => [id, r.base[i]])));
export const PVP_BASE = baseMap('pvp');
export const BOSS_BASE = baseMap('boss');

// The base stat this one is totalled with in a build of this kind, if any.
export const baseOf = (id, kind) => PVP_BASE[id] || (kind === 'pve' ? BOSS_BASE[id] : undefined);

export const DAMAGE = [
  ['Skill Damage', 'skill_power_amplification', 'skill_power_resistance'],
  ['Bonus Damage / Reduction', 'bonus_attack_power', 'damage_reduction'],
  ['Critical Damage', 'critical_damage_dealt_modifier', 'critical_damage_taken_modifier'],
  ['Heavy Attack Damage', 'double_damage_dealt_modifier', 'double_damage_taken_modifier'],
  ['Boss Damage', 'boss_bonus_attack_power', 'boss_damage_reduction'],
  ['PvP Damage', 'pvp_damage_dealt_modifier', 'pvp_damage_taken_modifier'],
  ['Buff / Debuff Duration', 'buff_given_duration_modifier', 'debuff_taken_duration_modifier'],
  ['Block Chance Penetration', 'shield_block_chance_penetration', null],
];

// Lower is better for these, so a negative number reads as good news.
export const IN_YOUR_FAVOUR = new Set(['pvp_damage_taken_modifier', 'debuff_taken_duration_modifier']);

export const CC = ['Weaken', 'Stun', 'Petrification', 'Sleep', 'Silence', 'Fear', 'Bind', 'Collision'].map((e) => ({
  name: e,
  chance: e === 'Collision' ? 'collide_amplification' : `${e.toLowerCase()}_accuracy`,
  res: e === 'Collision' ? 'collide_resistance' : `${e.toLowerCase()}_tolerance`,
}));

export const RESOURCES = [
  [null, ['hp_max', 'hp_regen', 'cost_max', 'cost_regen', 'cost_consumption_modifier', 'stamina_max', 'stamina_regen']],
  ['Speed & reach', ['skill_cooldown_modifier', 'attack_speed_modifier', 'attack_interval_main_hand', 'move_speed', 'attack_range_modifier', 'attack_range_main_hand']],
];
export const HEALING = [
  ['Given', ['heal_modifier', 'continuous_heal_modifier', 'shield_modifier', 'magic_doll_heal_modifier', 'potion_heal_modifier']],
  ['Received', ['skill_heal_taken_modifier', 'targeted_continuous_heal_modifier', 'shield_taken_modifier', 'recovery_taken_modifier']],
];

// A label that makes sense out of its table: "Boss Melee Endurance" rather
// than "Melee Endurance" under a Boss column.
export const fullLabel = (id) => {
  const s = STAT[id];
  if (!s) return id;
  if (id === 'min_damage' || id === 'max_damage') return s.label.replace(/ \((low|high)\)$/, id === 'min_damage' ? ' (min)' : ' (max)');
  if (s.panel === 'weapon' && (id === 'attack_interval_main_hand' || id === 'attack_range_main_hand')) return `Weapon ${s.label}`;
  return s.label;
};

const fmtNumber = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');

// As the game prints it: "+96.5%", "0.392 s", "19.15 m", "4,175".
export function fmtStat(id, n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const unit = STAT[id]?.unit || '';
  if (unit === '%') return `${n > 0 ? '+' : ''}${fmtNumber(n)}%`.replace('-', '−');
  if (unit === 's' || unit === 'm') return `${fmtNumber(n)} ${unit}`;
  return fmtNumber(n).replace('-', '−');
}

// What a cell shows: PvP matrix stats (and Boss ones on a PvE build) as
// base + bonus, everything else as is. Without a kind, Boss stats stay bonuses.
export function shownValue(stats, id, kind) {
  const v = stats?.[id];
  if (v === undefined) return undefined;
  const base = baseOf(id, kind);
  if (base && Number.isFinite(stats?.[base])) return stats[base] + v;
  return v;
}

// Every stat in the order the compare table lists them, under its heading.
export const COMPARE_SECTIONS = [
  ['Weapon', ['min_damage', 'max_damage', 'attack_interval_main_hand', 'attack_range_main_hand']],
  ['Combat · base', COMBAT.flatMap((r) => r.base)],
  ['Combat · boss bonus', COMBAT.flatMap((r) => r.boss || [])],
  ['Combat · PvP total', COMBAT.flatMap((r) => r.pvp || [])],
  ['Damage', DAMAGE.flatMap(([, d, t]) => [d, t].filter(Boolean))],
  ['Crowd control', CC.flatMap((r) => [r.chance, r.res])],
  ['Resources', RESOURCES.flatMap(([, ids]) => ids).filter((id) => !['attack_interval_main_hand', 'attack_range_main_hand'].includes(id))],
  ['Healing & shields', HEALING.flatMap(([, ids]) => ids)],
];

// The upload checks: the two builds being the same screenshots, or a scan
// filed under the wrong build. Sums of the PvP tab and the Boss tab are the
// tell — a PvP build carries PvP bonuses and usually no Boss ones.
const sumOf = (stats, prefix) => Object.entries(stats || {})
  .filter(([id]) => id.startsWith(prefix)).reduce((t, [, v]) => t + (Number.isFinite(v) ? v : 0), 0);

export function uploadWarnings(kind, scanned, other) {
  if (!other?.stats || !scanned) return [];
  const otherKind = kind === 'pve' ? 'pvp' : 'pve';
  const shared = Object.keys(scanned).filter((id) => id in other.stats);
  if (shared.length >= 20 && shared.every((id) => scanned[id] === other.stats[id])) {
    return [{ type: 'same', text: `These numbers match your ${KIND_LABEL[otherKind]} build exactly. Did you upload the same screenshots twice?` }];
  }
  const pvpHere = sumOf(scanned, 'pvp_');
  const pvpThere = sumOf(other.stats, 'pvp_');
  const bossHere = sumOf(scanned, 'boss_');
  const bossThere = sumOf(other.stats, 'boss_');
  const looksLikeOther = kind === 'pve'
    ? pvpHere > pvpThere * 0.95 && bossHere <= bossThere
    : pvpHere < pvpThere * 1.05 && bossHere >= bossThere && bossHere > 0;
  if (looksLikeOther && pvpThere + pvpHere > 0) {
    return [{ type: 'swapped', text: `This scan looks more like a ${KIND_LABEL[otherKind]} build: its PvP and Boss stats are closer to your ${KIND_LABEL[otherKind]} build than a ${KIND_LABEL[kind]} one. Is it your ${KIND_LABEL[otherKind]} build?` }];
  }
  return [];
}
