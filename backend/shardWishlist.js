// backend/shardWishlist.js — the shard wishlist's stored shape, and the one-time
// reading of the old shape into it.
//
// A member's wishlist is a list of weapons, each carrying how many of its shard
// they still need (0 up to the weapon's cost). Per-shard totals are never
// stored: they are the sum over the weapons, plus `unlinked`.
//
//   { v: 2, weapons: [{ boss, weapon, build, need, priority }], unlinked: { <shard key>: n } }
//
// `priority` is 'high', 'low' or '' (normal) — an officer's call on who gets
// that weapon's shards first. Members save their own rows, so the route keeps
// the stored priorities for anyone who can't set them (see keepPriorities).
//
// `need` is null when nobody has said yet — a weapon carried over from the old
// wishlist whose shard count couldn't be pinned to it. Null counts toward
// nothing and the page asks for it.
//
// `unlinked` is shard counts from before weapons carried them, that no single
// weapon could claim. It stays in the totals, so the guild's demand doesn't
// drop overnight, until the member links a weapon and clears it.
//
// THE OLD SHAPE (no `v`) is converted on every read, not migrated: the stored
// row is untouched until its owner next saves, so a wrong guess here costs a
// reload rather than someone's numbers.

const SHARDS = require('../shared/shards.json');
const BOSS_WEAPONS = require('../shared/archbossWeapons.json');
const SHARD_WEAPONS = require('../shared/shardWeapons.json');

const BUILDS = ['PvP', 'PvE'];
const PRIORITIES = ['high', 'low'];
const TYPE_KEYS = SHARDS.types.map((t) => t.key);
const SOURCES = new Map(SHARD_WEAPONS.sources.map((s) => [s.key, s]));
const WEAPONS_BY_SOURCE = new Map(
  SHARD_WEAPONS.sources.map((s) => [s.key, s.weapons || BOSS_WEAPONS[s.key] || []]),
);
const VALID = new Set(
  [...WEAPONS_BY_SOURCE].flatMap(([src, list]) => list.map((w) => `${src}|${w}`)),
);

// Old per-type caps, kept only to bound `unlinked`: a carried-over count can
// never have been more than these.
const legacyMax = (key) => {
  const t = SHARDS.types.find((x) => x.key === key);
  return Number.isFinite(t?.max) ? t.max : SHARDS.max;
};

function shardFor(source, weapon) {
  const s = SOURCES.get(source);
  if (!s) return null;
  return s.snowsoul && String(weapon).includes('Snowsoul') ? s.snowsoul : s.shard;
}

function costFor(source) {
  return SOURCES.get(source)?.heroic ? SHARD_WEAPONS.costs.heroic : SHARD_WEAPONS.costs.archboss;
}

const toInt = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

// Anything coming in — a save, or a stored v2 row — is passed through this, so
// the cap and the weapon list are enforced in one place.
function normalize(raw) {
  const seen = new Set();
  const weapons = (Array.isArray(raw?.weapons) ? raw.weapons : [])
    .filter((w) => w && VALID.has(`${w.boss}|${w.weapon}`))
    .filter((w) => {
      const k = `${w.boss}|${w.weapon}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 60)
    .map((w) => {
      const n = w.need === null || w.need === undefined || w.need === '' ? null : toInt(w.need);
      return {
        boss: w.boss,
        weapon: w.weapon,
        build: BUILDS.includes(w.build) ? w.build : '',
        need: n === null ? null : Math.max(0, Math.min(costFor(w.boss), n)),
        priority: PRIORITIES.includes(w.priority) ? w.priority : '',
      };
    });
  const unlinked = {};
  TYPE_KEYS.forEach((k) => {
    const n = toInt(raw?.unlinked?.[k]);
    if (n > 0) unlinked[k] = Math.min(legacyMax(k), n);
  });
  return { v: 2, weapons, unlinked };
}

// The old shape: per-type counts beside a weapon list that carried no counts.
// A count goes onto a weapon only when there is no doubt which one it was for:
//   - exactly one wishlisted weapon uses that shard → it takes the count, up to
//     its cost; anything over the cost stays unlinked;
//   - several do, and the count is exactly enough to fill them all → each is
//     full;
//   - otherwise (none, or several with a count that splits more than one
//     way) the count stays unlinked and those weapons' need is left unset.
// A weapon whose shard had no count at all is left unset too — 0 in the old
// table meant "not filled in" as often as "done".
function fromLegacy(old) {
  const weapons = (Array.isArray(old?.weapons) ? old.weapons : [])
    .filter((w) => w && VALID.has(`${w.boss}|${w.weapon}`))
    .map((w) => ({ boss: w.boss, weapon: w.weapon, build: BUILDS.includes(w.build) ? w.build : '', need: null }));
  const unlinked = {};
  TYPE_KEYS.forEach((key) => {
    const n = Math.max(0, toInt(old?.[key]) || 0);
    if (!n) return;
    const claim = weapons.filter((w) => shardFor(w.boss, w.weapon) === key);
    if (claim.length === 1) {
      const cost = costFor(claim[0].boss);
      claim[0].need = Math.min(cost, n);
      if (n > cost) unlinked[key] = n - cost;
    } else if (claim.length > 1 && claim.every((w) => costFor(w.boss) === costFor(claim[0].boss))
      && n === costFor(claim[0].boss) * claim.length) {
      claim.forEach((w) => { w.need = costFor(w.boss); });
    } else {
      unlinked[key] = n;
    }
  });
  return normalize({ weapons, unlinked });
}

// A stored row, whichever shape it's in.
function read(stored) {
  if (!stored || typeof stored !== 'object') return normalize({});
  return stored.v === 2 ? normalize(stored) : fromLegacy(stored);
}

// A save from someone who can't set priority: whatever they sent, each weapon
// carries the priority already stored for it. A newly linked weapon starts
// normal; an unlinked one takes its priority with it.
function keepPriorities(incoming, stored) {
  const had = new Map(read(stored).weapons.map((w) => [`${w.boss}|${w.weapon}`, w.priority]));
  return {
    ...incoming,
    weapons: incoming.weapons.map((w) => ({ ...w, priority: had.get(`${w.boss}|${w.weapon}`) || '' })),
  };
}

module.exports = { read, normalize, fromLegacy, keepPriorities, shardFor, costFor };
