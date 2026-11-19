// backend/shardPriority.js — the rules behind the Shards page's Priority tab
// (migrations/16_shard_priority.sql), kept free of Express and Supabase so
// they can be tested on their own.
//
// A REQUEST is one member wanting one weapon: "discordId|boss|weapon". The
// priority list is those keys in order, first gets the next shard. Keys are
// checked against shardWishlist's weapon list, but NOT against who currently
// wants what — the list is saved as the officer arranged it, and an entry
// whose member has since unlinked the weapon is simply skipped wherever the
// list is read (liveList), so it drops out on the next save.
//
// A CONFIRMATION is an officer's "checked with them, they still need N". It
// holds only while the wishlist still says N: a member who changes their
// number after the check has a number nobody checked.

const SHARDS = require('../shared/shards.json');
const SHARD_WEAPONS = require('../shared/shardWeapons.json');
const { isWeapon, shardFor, costFor } = require('./shardWishlist');

const BUILDS = ['PvP', 'PvE'];
const BOSSES = SHARD_WEAPONS.sources.map((s) => s.key);
const SHARD_LABEL = new Map(SHARDS.types.map((t) => [t.key, t.label]));
const MAX_LIST = 500;
const DISCORD_LIMIT = 2000;

const keyOf = (discordId, boss, weapon) => `${discordId}|${boss}|${weapon}`;

// Discord ids are digit strings; weapon names never contain '|'.
function parseKey(key) {
  if (typeof key !== 'string') return null;
  const parts = key.split('|');
  if (parts.length !== 3) return null;
  const [discordId, boss, weapon] = parts;
  if (!/^\d{5,25}$/.test(discordId) || !isWeapon(boss, weapon)) return null;
  return { discordId, boss, weapon };
}

// The list exactly as given, minus anything that isn't a request and any repeat.
function cleanList(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((k) => parseKey(k)))].slice(0, MAX_LIST);
}

// { boss: [weapon, ...] } for known bosses and their own weapons only.
function cleanWeaponOrder(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  BOSSES.forEach((boss) => {
    const list = raw[boss];
    if (!Array.isArray(list)) return;
    const weapons = [...new Set(list.filter((w) => typeof w === 'string' && isWeapon(boss, w)))];
    if (weapons.length) out[boss] = weapons;
  });
  return out;
}

function cleanBossOrder(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((b) => BOSSES.includes(b)))];
}

// Every request the wishlists hold right now: key -> what it is. Only weapons
// tagged PvP or PvE — an untagged one belongs to neither side of the page.
// `wishlists` is [{ discordId, shards }], shards already read through
// shardWishlist.read().
function liveRequests(wishlists) {
  const out = new Map();
  (wishlists || []).forEach(({ discordId, shards }) => {
    (shards?.weapons || []).forEach((w) => {
      if (!BUILDS.includes(w.build)) return;
      out.set(keyOf(discordId, w.boss, w.weapon), {
        discordId: String(discordId), boss: w.boss, weapon: w.weapon, build: w.build, class: w.class || '', need: w.need,
        shard: shardFor(w.boss, w.weapon), cost: costFor(w.boss),
      });
    });
  });
  return out;
}

// The saved list narrowed to requests that still exist, in order.
const liveList = (list, live) => cleanList(list).filter((k) => live.has(k));

// A confirmation vouches for the need it was given and no other. An unset
// need (null) can't be confirmed at all.
function isConfirmed(confirmation, need) {
  return Boolean(confirmation) && need !== null && need !== undefined && confirmation.need === need;
}

// Names go into Discord markdown; a name like "_x_" would italicise itself.
const escapeMd = (s) => String(s ?? '').replace(/([\\*_~`|>])/g, '\\$1');

// The post: a header, then one line per ranked request, split across as many
// messages as Discord's 2,000-character limit needs. `mention` pings each
// member (<@id>); without it names are plain text and allowed_mentions is
// empty, so nobody is pinged even if a name happens to look like a mention.
//
// `nameFor(discordId)` gives the display name; `confirmations` is a Map
// key -> { need }.
function buildPost({ list, live, nameFor, confirmations, mention = false }) {
  const keys = liveList(list, live);
  const lines = keys.map((k, i) => {
    const r = live.get(k);
    const who = mention ? `<@${r.discordId}>` : escapeMd(nameFor(r.discordId));
    const need = r.need === null || r.need === undefined ? '?' : r.need;
    const ok = isConfirmed(confirmations.get(k), r.need);
    const tag = r.class ? `${r.build}, ${escapeMd(r.class)}` : r.build;
    return `${i + 1}. ${who} (${tag}) · ${SHARD_LABEL.get(r.shard) || r.shard} · ${escapeMd(r.weapon)} · needs ${need}/${r.cost}${ok ? ' ✓' : ' · not confirmed'}`;
  });
  const header = '**Shard priority** · first on the list gets the next shard';

  const messages = [];
  let current = { lines: [header], ids: [] };
  const flush = () => {
    messages.push({
      content: current.lines.join('\n'),
      allowed_mentions: mention ? { parse: [], users: [...new Set(current.ids)].slice(0, 100) } : { parse: [] },
    });
  };
  keys.forEach((k, i) => {
    const line = lines[i];
    const length = current.lines.join('\n').length + 1 + line.length;
    // A new message every 100 pings as well: Discord honours at most 100
    // users in allowed_mentions.
    if (length > DISCORD_LIMIT || (mention && current.ids.length >= 100)) {
      flush();
      current = { lines: [], ids: [] };
    }
    current.lines.push(line);
    current.ids.push(live.get(k).discordId);
  });
  flush();
  return { messages, count: keys.length, lines: [header, ...lines] };
}

module.exports = {
  BUILDS, BOSSES, keyOf, parseKey, cleanList, cleanWeaponOrder, cleanBossOrder,
  liveRequests, liveList, isConfirmed, escapeMd, buildPost,
};
