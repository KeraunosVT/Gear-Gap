// backend/guildConfig.js — the read side of guild_config (migrations/014).
//
// Every value that used to be a `process.env.DISCORD_*` const at module scope
// or a field in shared/guild.json now comes from here. That change is the whole
// point of the settings page, and it only works if call sites obey one rule:
//
//   READ THROUGH get() AT CALL TIME. NEVER HOIST INTO A MODULE-SCOPE CONST.
//
// `const ADMIN_ROLES = guildConfig.get().admin_role_ids` at the top of a file is
// the same bug as reading env — it snapshots the value at require time, so
// saving in the settings page has no effect until the next deploy and the page
// reads as broken. The lint for this is your eyes; there is no way to enforce it
// from here.
//
// Holds its own Supabase client rather than being a createX(supabase) factory,
// for the same reason permissions.js does: auth.js is a plain module that reads
// env directly, and threading a client through it would mean changing its
// export shape and every import of it for no behavioural gain.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const CACHE_TTL_MS = (parseInt(process.env.GUILD_CONFIG_CACHE_SECONDS, 10) || 30) * 1000;

// Selected explicitly rather than `*`, so a column added later can't start
// silently arriving in places that log or serialise this row.
const COLUMNS = [
  'id', 'house', 'tag', 'aliases', 'motto', 'creed', 'timezone', 'day_start',
  'admin_role_ids', 'allowed_role_ids', 'member_role_ids',
  'roster_channel_id', 'loa_channel_id', 'announce_channel_id', 'signup_channel_id',
  'attendance_voice_channel_id', 'loa_notify_discord_id', 'updated_at',
].join(', ');

// What get() returns before the first load completes, or if the table is
// unreachable on a cold cache.
//
// Every list is EMPTY on purpose. Empty admin_role_ids means nobody is an
// officer and empty member_role_ids means the roster is empty — both fail
// closed. The alternative, guessing at roles, would mean a database blip
// briefly granting officer powers, which is the one direction this must never
// fail. The names are cosmetic and only ever show on a hall that has not been
// seeded yet.
const DEFAULTS = Object.freeze({
  id: 1,
  house: 'Guild Hall',
  tag: 'Guild Hall',
  aliases: [],
  motto: null,
  creed: null,
  timezone: 'America/New_York',
  day_start: '01:00',
  admin_role_ids: [],
  allowed_role_ids: [],
  member_role_ids: [],
  roster_channel_id: null,
  loa_channel_id: null,
  announce_channel_id: null,
  signup_channel_id: null,
  attendance_voice_channel_id: null,
  // Null means nobody is DMed about LOA cancellations, which is what every
  // deployment did before migration 018.
  loa_notify_discord_id: null,
  updated_at: null,
});

let cache = null;      // last successful row
let cachedAt = 0;
let inFlight = null;   // dedupe concurrent refreshes onto one query

// Normalise before anything reads it. Postgres text[] arrives as an array, but
// a null column arrives as null, and `null.some(...)` in a permission check is
// a 500 on the login path. Coercing once here means no call site has to.
function normalise(row) {
  const listOf = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  return {
    ...DEFAULTS,
    ...row,
    house: row.house || DEFAULTS.house,
    tag: row.tag || DEFAULTS.tag,
    timezone: row.timezone || DEFAULTS.timezone,
    day_start: row.day_start || DEFAULTS.day_start,
    aliases: listOf(row.aliases),
    admin_role_ids: listOf(row.admin_role_ids),
    allowed_role_ids: listOf(row.allowed_role_ids),
    member_role_ids: listOf(row.member_role_ids),
  };
}

async function fetchRow() {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('guild_config').select(COLUMNS).eq('id', 1).maybeSingle();
  if (error) {
    // A stale channel id is harmless; a config read that throws takes down
    // every request that touches it. Serve the last good copy and complain.
    console.error('guildConfig load failed:', error.message);
    return null;
  }
  if (!data) {
    console.error('guildConfig: no row 1 — run migrations/014_guild_config.sql.');
    return null;
  }
  return normalise(data);
}

// Force a read, ignoring the TTL. Awaited once at boot so the first request
// never sees DEFAULTS.
async function load() {
  if (inFlight) return inFlight;
  inFlight = fetchRow()
    .then((row) => {
      if (row) { cache = row; cachedAt = Date.now(); }
      return cache || DEFAULTS;
    })
    .finally(() => { inFlight = null; });
  return inFlight;
}

// The async accessor, for call sites that are already async. Refreshes past the
// TTL and waits for it, so a value read here is never more than TTL_MS stale.
async function ensure() {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  return load();
}

// The SYNCHRONOUS accessor, and the one most call sites use.
//
// It never awaits, so it can be dropped straight into the sync code that used
// to read a const — which is most of discordGateway.js and discord.js. Past the
// TTL it kicks off a background refresh and returns the current copy anyway:
// the caller gets an answer immediately and the NEXT caller gets the fresh one.
// That is the right trade for channel ids and role lists, which change roughly
// never and are re-read constantly.
//
// Security-relevant reads (auth.js deciding who is an officer) use ensure()
// instead, so a role change can't be honoured a request late.
function get() {
  if (!cache) {
    if (!inFlight) load().catch(() => {});
    return DEFAULTS;
  }
  if (Date.now() - cachedAt >= CACHE_TTL_MS && !inFlight) load().catch(() => {});
  return cache;
}

// Called by guildSettings.save(). Drops the cache so the next read goes to the
// database — without this the settings page appears to do nothing for up to the
// TTL and people press save again.
function invalidate() {
  cache = null;
  cachedAt = 0;
}

// ── DERIVED HELPERS ─────────────────────────────────────────────────────────
// Small enough to inline everywhere, which is exactly why they shouldn't be:
// each one is a place where getting the fallback wrong is silent.

// Signups post to their own channel if one is set, otherwise the announce
// channel — so the feature works before anyone configures a second channel.
const signupChannelId = () => {
  const c = get();
  return c.signup_channel_id || c.announce_channel_id || null;
};

// The alias -> canonical-tag map server.js collapses `guild_name` through.
// Built fresh on each call from the live config; the old module-scope version
// of this map is precisely why a rename used to need a redeploy.
function aliasMap() {
  const c = get();
  const tag = c.tag;
  const out = {};
  // The tag itself always maps to itself, even if the alias list somehow omits
  // it — otherwise the guild's own current name reads as an enemy's.
  out[tag] = tag;
  c.aliases.forEach((a) => { if (a) out[a] = tag; });
  return out;
}

const canonicalGuild = (name) => {
  const n = (name || '').trim();
  return aliasMap()[n] || n || 'Unknown';
};

// The public projection: what GET /api/guild sends the browser. An explicit
// field list, never the row — it also holds role and channel ids, which the
// browser has no business seeing and which would leak the moment someone added
// a column and reached for a spread.
function publicIdentity() {
  const c = get();
  return {
    house: c.house,
    tag: c.tag,
    aliases: c.aliases,
    motto: c.motto,
    creed: c.creed,
    timezone: c.timezone,
    dayStart: c.day_start,
  };
}

module.exports = {
  DEFAULTS,
  load,
  ensure,
  get,
  invalidate,
  signupChannelId,
  aliasMap,
  canonicalGuild,
  publicIdentity,
};
