import SHARDS from '../../shared/shards.json';
import BOSS_WEAPONS from '../../shared/archbossWeapons.json';
import SHARD_WEAPONS from '../../shared/shardWeapons.json';

// Which shard each wishlist weapon takes and what it costs, read from
// shared/shardWeapons.json. These mirror backend/shardWishlist.js's shardFor
// and costFor, so the rule itself ("Snowsoul weapons take the Thunderstruck
// shard") is stated once, in the JSON; only these few lines of reading it are
// doubled. Used by every tab of the Shards page.

export const SOURCES = SHARD_WEAPONS.sources;
export const SOURCE = new Map(SOURCES.map((s) => [s.key, s]));
export const WEAPONS_BY_SOURCE = new Map(SOURCES.map((s) => [s.key, s.weapons || BOSS_WEAPONS[s.key] || []]));
export const SHARD_LABEL = new Map(SHARDS.types.map((t) => [t.key, t.label]));
// Shard totals are listed in shards.json order, so every chip row lines up.
export const SHARD_ORDER = new Map(SHARDS.types.map((t, i) => [t.key, i]));
export const SHARD_TYPES = SHARDS.types;
export const COSTS = SHARD_WEAPONS.costs;

export const shardFor = (source, weapon) => {
  const s = SOURCE.get(source);
  if (!s) return null;
  return s.snowsoul && String(weapon).includes('Snowsoul') ? s.snowsoul : s.shard;
};

export const costFor = (source) => (SOURCE.get(source)?.heroic ? COSTS.heroic : COSTS.archboss);
