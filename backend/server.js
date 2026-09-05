// backend/server.js
const path = require('path');
// Load environment variables from backend/.env for local development.
// On hosts that inject env vars (Render, Railway, etc.) the .env is simply absent
// and this is a no-op; existing process.env values are never overwritten.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const {
  router: authRouter, requireAuth, requireAdminArea, requirePermission, userHas,
} = require('./auth');
const { listMembers } = require('./discord');
const SHARDS = require('../shared/shards.json');
const BOSS_WEAPONS = require('../shared/archbossWeapons.json');
const BUILDS = ['PvP', 'PvE'];
const VALID_BOSS_WEAPONS = new Set(
  Object.entries(BOSS_WEAPONS).flatMap(([boss, list]) => list.map((w) => `${boss}|${w}`))
);
const createLootCatalog = require('./lootCatalog');
const createEliteTimers = require('./eliteTimers');
const createGearIlvl = require('./gearIlvl');
const createIdentities = require('./identities');
const createLoa = require('./loa');
const { fetchAll } = require('./pagedRead');
const { aggregatePlayerRows } = require('./playerStats');
const { foldRoster, RECENT_GAMES } = require('./feudRoster');
const createEventSignups = require('./eventSignups');
const createAuditLog = require('./auditLog');
const guildConfig = require('./guildConfig');
const createLateAttendance = require('./lateAttendance');
const createEventDetail = require('./eventDetail');

const gearUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

const gateway = require('./discordGateway');

const app = express();

// Render/Railway/etc. sit behind one reverse proxy — needed for req.ip and
// req.secure to reflect the real client rather than the proxy.
app.set('trust proxy', 1);

// Per-member throttle for endpoints that call the vision model (each request costs real
// API money). Keyed on the session user id; IP is only a fallback in case this
// is ever mounted before auth.
const GEAR_LIMIT_PER_HOUR = parseInt(process.env.GEAR_SUBMIT_LIMIT_PER_HOUR, 10) || 5;
const gearSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: GEAR_LIMIT_PER_HOUR,
  keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: `Too many gear submissions — the limit is ${GEAR_LIMIT_PER_HOUR} per hour. Try again later.` },
});

// CORS allowlist. The frontend is served same-origin by this server, so no
// cross-origin access is needed in production — `origin: false` sends no CORS
// headers at all (same-origin requests are unaffected). For local dev (Vite on
// :5173) or any other trusted origin, set CORS_ORIGINS to a comma-separated
// list of full origins, e.g. CORS_ORIGINS=http://localhost:5173
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : false, credentials: true }));
app.use(express.json());
app.use(cookieParser());

console.log("✅ Server started successfully");

// ── SUPABASE SETUP ───────────────────────────────────────────────────────────
let supabase = null;
try {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  console.log("✅ Supabase client initialized");
} catch (e) {
  console.error("❌ Supabase failed to initialize:", e.message);
}

const lootCatalog = supabase ? createLootCatalog(supabase) : null;
const eliteTimers = supabase ? createEliteTimers(supabase) : null;
const gearIlvl = supabase ? createGearIlvl(supabase) : null;
const identities = supabase ? createIdentities(supabase) : null;
const loa = supabase ? createLoa(supabase, identities) : null;
// Takes loa so "is this person out?" has one answer across signups, the party
// builder and the attendance breakdown.
const signups = supabase ? createEventSignups(supabase, identities, loa) : null;
const auditLog = supabase ? createAuditLog(supabase) : null;
const lateAttendance = supabase ? createLateAttendance(supabase, identities) : null;
// The same assembler admin.js mounts. Two routes, one reconciliation — a member
// and an officer looking at the same night must not see different facts.
const eventDetail = supabase
  ? createEventDetail(supabase, { identities, loa, signups, lateAttendance, listMembers })
  : null;

// The gateway needs Supabase for /elitetimer persistence, so start it after setup.
gateway.start(supabase);

// ── GUILD ALIASES ────────────────────────────────────────────────────────────
// Our guild has changed names over time. Collapse all past names to the current
// one so stats aren't split across what looks like several separate guilds. Any
// name NOT in this list is treated as an enemy guild and kept as-is.
//
// Read from guild_config, which Guild Settings writes — these used to be two
// hand-maintained lists (shared/guild.json and the frontend bundle), and a
// rename that updated only one would silently orphan match rows into an enemy
// guild rather than error.
//
// FUNCTIONS, NOT CONSTS. This was `const GUILD_ALIASES = Object.fromEntries(…)`
// evaluated once at require time, which is fine for a file you edit and
// redeploy and completely wrong for a row an officer can edit at 9pm: the
// branding would change immediately and the war-record collapsing would not
// change until the next restart, which is a silent divergence of exactly the
// kind the alias guard in guildSettings.js exists to prevent.
//
// Renaming is ADDITIVE: a scoreboard records whatever the guild was called the
// day it was uploaded, so every past name has to stay listed forever. The
// settings page enforces that; see assertAliasesSafe. And note "Highly
// Regarded" is a *different* guild — it must not be added.
const myGuild = () => guildConfig.get().tag;
const guildAliases = () => guildConfig.aliasMap();
const canonicalGuild = (name) => guildConfig.canonicalGuild(name);

// Health check (public)
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── GUILD IDENTITY (public) ──────────────────────────────────────────────────
// The branding the frontend used to import from shared/guild.json at build
// time. It has to be public and it has to be outside the login wall, because
// the login page itself renders the house name — gating this behind auth would
// mean nobody could see whose hall they were signing in to.
//
// An EXPLICIT field list, never the row. guild_config also holds the officer
// role ids, the member allow-list and every channel id; a `res.json(row)` here,
// or a spread added later by someone in a hurry, publishes all of it to anyone
// who can reach the site. guildConfig.publicIdentity() is the projection, and
// it is the only thing this route is allowed to send.
app.get('/api/guild', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(guildConfig.publicIdentity());
});

// Discord login routes (public)
app.use('/api/auth', authRouter);

// Everything else under /api requires a valid guild-member session.
// Full login wall: stats, matches, and match detail are all gated.
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth')) return next();
  return requireAuth(req, res, next);
});

// ── ADMIN AREA (requires a capability) ───────────────────────────────────────
// requireAdminArea resolves which capability the requested path needs and checks
// it — see backend/permissions.js for the route table. A path with no rule is
// denied rather than admitted, so a new admin route can't ship as public.
//
// Audit log's viewer is mounted separately, before the general /api/admin
// router, so its gate stays structurally independent of admin.js's routing. It
// takes the 'audit' capability directly since its own paths ('/', '/filters')
// don't carry the /audit-log prefix once Express has stripped the mount point.
app.use('/api/admin/audit-log', requirePermission('audit'), auditLog
  ? auditLog.router
  : (req, res) => res.status(503).json({ error: 'Database not configured.' }));

const createAdminRouter = require('./admin');
app.use('/api/admin', requireAdminArea, auditLog ? auditLog.log : (req, res, next) => next(), createAdminRouter(supabase, gateway, lootCatalog, identities));

// ── MEMBERS AREA: Class builds ───────────────────────────────────────────────
app.get('/api/my-classes', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { data } = await supabase.from('member_roles').select('pvp_classes, pve_classes').eq('discord_id', req.user.id).single();
  res.json({
    pvp_classes: Array.isArray(data?.pvp_classes) ? data.pvp_classes : [],
    pve_classes: Array.isArray(data?.pve_classes) ? data.pve_classes : [],
  });
});

app.put('/api/my-classes', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { pvp_classes, pve_classes } = req.body || {};
  const clean = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).slice(0, 3) : []);
  const { error } = await supabase.from('member_roles')
    .upsert({
      discord_id: req.user.id,
      pvp_classes: clean(pvp_classes),
      pve_classes: clean(pve_classes),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'discord_id', ignoreDuplicates: false });
  if (error) return res.status(500).json({ error: 'Failed to save classes.' });
  res.json({ ok: true });
});

// ── MEMBERS AREA: my own player profile ──────────────────────────────────────
// Profiles are addressed by in-game name (/roster/:name), but a session only
// knows a Discord id — so "my profile" needs the identity mapping to bridge the
// two. Reports why there's no profile rather than just failing, since both
// causes are things a member can act on: nobody has mapped their Discord
// account to an in-game name yet, or they have no logged matches.
app.get('/api/my-profile', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const ids = await identities.load();
    const name = ids.displayNameFor(req.user.id, null);
    if (!name) return res.json({ name: null, mapped: false, hasRecord: false });

    // Every alias counts towards "do they have a record" — a player who only
    // ever appeared under an old in-game name still has one.
    const identity = ids.identityForName(name);
    const names = identity
      ? [identity.display_name, ...(Array.isArray(identity.ingame_names) ? identity.ingame_names : [])].filter(Boolean)
      : [name];
    const { count } = await supabase.from('player_match_stats')
      .select('*', { count: 'exact', head: true })
      .in('player_name', names)
      .in('guild_name', Object.keys(guildAliases()));

    res.json({ name, mapped: true, hasRecord: (count || 0) > 0 });
  } catch (err) {
    console.error('my-profile error:', err.message);
    res.status(500).json({ error: 'Could not resolve your profile.' });
  }
});

// ── MEMBERS AREA: Gear item level ────────────────────────────────────────────
// Any member can submit a screenshot of their own gear; a new submission
// replaces whatever they had on file before. The full comparison table is
// admin-only (see /api/admin/gear-ilvl) — this is just "what's on file for me".
app.get('/api/gear-ilvl/mine', async (req, res) => {
  if (!gearIlvl) return res.status(503).json({ error: 'Database not configured.' });
  const entry = await gearIlvl.forMember(req.user.id);
  res.json({ entry });
});

app.post('/api/gear-ilvl', gearSubmitLimiter, gearUpload.single('image'), async (req, res) => {
  if (!gearIlvl) return res.status(503).json({ error: 'Database not configured.' });
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  if (!req.file.mimetype?.startsWith('image/')) {
    return res.status(415).json({ error: 'Please upload an image file (PNG or JPG screenshot).' });
  }
  try {
    const extracted = await gearIlvl.parseGearScreenshot(req.file.buffer, req.file.mimetype);
    const entry = await gearIlvl.submit(req.user.id, req.user.username, extracted);
    res.json({ entry });
  } catch (err) {
    console.error('Gear ilvl submit error:', err.message);
    res.status(500).json({ error: err.message || 'Could not read that screenshot.' });
  }
});

// ── MEMBERS AREA: Full equipment window ──────────────────────────────────────
// Stored as evidence, never read. Nothing on this path parses the image or
// touches the member's gear level — the Equipment Level popup above is the only
// thing that sets one. See the note at the top of gearIlvl.js for why.
//
// Still behind the same per-member hourly limiter as the popup. It no longer
// costs a vision request, but it does write a file to the bucket, and an
// unmetered image upload is worth rate-limiting on its own.
app.post('/api/gear-screenshot', gearSubmitLimiter, gearUpload.single('image'), async (req, res) => {
  if (!gearIlvl) return res.status(503).json({ error: 'Database not configured.' });
  if (!req.file) return res.status(400).json({ error: 'Screenshot required.' });
  if (!req.file.mimetype?.startsWith('image/')) {
    return res.status(415).json({ error: 'Please upload an image file (PNG or JPG screenshot).' });
  }
  try {
    // Always the session's own id. A member uploads their own gear; an officer
    // correcting someone else's does it by asking them to re-upload, because a
    // screenshot attributed to the wrong person is worse than a missing one.
    const out = await gearIlvl.submitWindow(
      req.user.id, req.user.username, req.file.buffer, req.file.mimetype,
    );
    res.json(out);
  } catch (err) {
    console.error('Gear screenshot submit error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Could not save that screenshot.' });
  }
});

// A member's own stored screenshot and a short-lived signed URL for the image.
app.get('/api/gear-screenshot/mine', async (req, res) => {
  if (!gearIlvl) return res.status(503).json({ error: 'Database not configured.' });
  res.json({ screenshot: await gearIlvl.screenshotFor(req.user.id) });
});

// Someone else's. THIS is the gate the private bucket depends on: the image is
// only reachable through a signed URL minted here, so "officers and the member
// themselves" is enforced at this line and nowhere else.
//
// `gear` rather than a new capability — it is the same officers who already run
// the gear-level table, and a new key would start granted to nobody.
app.get('/api/gear-screenshot/:discordId', async (req, res) => {
  if (!gearIlvl) return res.status(503).json({ error: 'Database not configured.' });
  const target = String(req.params.discordId);
  if (target !== String(req.user.id) && !userHas(req.user, 'gear')) {
    return res.status(403).json({ error: 'Gear screenshots are visible to officers and their owner.' });
  }
  const screenshot = await gearIlvl.screenshotFor(target);
  if (!screenshot) return res.status(404).json({ error: 'No gear screenshot on file for that member.' });
  res.json({ screenshot });
});

// ── MEMBERS AREA: Archboss shard tracker ─────────────────────────────────────
// Any logged-in member sees the full tally. Editing a row is restricted to its
// owner (matched by Discord id) or an admin — enforced here, not just in the UI.
app.get('/api/members', async (req, res) => {
  try {
    const members = await listMembers();
    const counts = {};
    const roles = {};
    if (supabase) {
      const [{ data: shardData }, { data: roleData }] = await Promise.all([
        supabase.from('shard_counts').select('discord_id, shards'),
        supabase.from('member_roles').select('discord_id, pvp_role'),
      ]);
      (shardData || []).forEach((r) => { counts[r.discord_id] = r.shards || {}; });
      (roleData || []).forEach((r) => { roles[r.discord_id] = r.pvp_role || ''; });
    }
    res.json({ members: members.map((m) => ({ ...m, shards: counts[m.id] || {}, pvp_role: roles[m.id] || '' })) });
  } catch (err) {
    console.error('Members list error:', err.response?.data?.message || err.message);
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

app.put('/api/shards/:discordId', async (req, res) => {
  const target = req.params.discordId;
  if (req.user.id !== target && !userHas(req.user, 'loot.awards')) {
    return res.status(403).json({ error: 'You can only edit your own shards.' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const incoming = req.body?.shards || {};
  const shards = {};
  SHARDS.types.forEach((t) => {
    const v = parseInt(incoming[t.key], 10);
    // Per-type cap, falling back to the file's default. The page clamps as you
    // type, but this is the one that decides — the input is a courtesy.
    const max = Number.isFinite(t.max) ? t.max : SHARDS.max;
    shards[t.key] = Math.max(0, Math.min(max, Number.isFinite(v) ? v : 0));
  });
  const incomingWeapons = Array.isArray(incoming.weapons) ? incoming.weapons : [];
  shards.weapons = incomingWeapons
    .filter((w) => w && VALID_BOSS_WEAPONS.has(`${w.boss}|${w.weapon}`))
    .map((w) => ({ boss: w.boss, weapon: w.weapon, build: BUILDS.includes(w.build) ? w.build : '' }))
    .slice(0, 50);
  const display_name = (req.body?.display_name || req.user.username || '').slice(0, 120);
  const { error } = await supabase.from('shard_counts')
    .upsert({ discord_id: target, display_name, shards, updated_at: new Date().toISOString() });
  if (error) { console.error('Shard save error:', error.message); return res.status(500).json({ error: 'Failed to save shards.' }); }
  res.json({ shards });
});

// ── MEMBERS AREA: Loot wishlist ──────────────────────────────────────────────
// Serve the loot catalog so the frontend doesn't need a static import.
app.get('/api/loot/catalog', async (req, res) => {
  if (!lootCatalog) return res.status(503).json({ error: 'Database not configured.' });
  try {
    res.json(await lootCatalog.getCatalog());
  } catch (err) {
    console.error('Catalog error:', err.message);
    res.status(500).json({ error: 'Failed to load loot catalog.' });
  }
});

// Members set a priority (PvP / Second Build / PvE) on items they want. Everyone
// sees per-item demand counts; admins additionally see who wants what.
app.get('/api/loot', async (req, res) => {
  if (!supabase || !lootCatalog) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const validKeys = await lootCatalog.getKeys();
    const [{ data, error }, ids] = await Promise.all([
      supabase.from('loot_wishlists').select('discord_id, display_name, picks'),
      identities.load(),
    ]);
    if (error) throw error;
    const counts = {};
    const tally = {};
    const mine = {};
    (data || []).forEach((r) => {
      const picks = r.picks || {};
      const memberName = ids.displayNameFor(r.discord_id, r.display_name || 'Member');
      Object.entries(picks).forEach(([k, entry]) => {
        if (!validKeys.has(k)) return;
        // Entries are { priority, added_at }; tolerate the older plain-string shape too.
        const priority = typeof entry === 'string' ? entry : entry?.priority;
        const addedAt = typeof entry === 'object' ? entry?.added_at || null : null;
        if (!priority) return;
        if (r.discord_id === req.user.id) mine[k] = priority;
        counts[k] = (counts[k] || 0) + 1;
        if (userHas(req.user, 'loot.awards')) (tally[k] = tally[k] || []).push({ name: memberName, priority, discord_id: r.discord_id, added_at: addedAt });
      });
    });
    // Builds of each item already awarded to the current member, so the UI can
    // lock just that build's chip and leave the others open to request. Awards
    // with no recorded build (made before builds were tracked) don't lock anything.
    const { data: myAwards } = await supabase.from('loot_awards').select('item_key, priority').eq('discord_id', req.user.id);
    const awardedBuilds = {};
    (myAwards || []).forEach((a) => {
      if (!a.priority) return;
      (awardedBuilds[a.item_key] = awardedBuilds[a.item_key] || []).push(a.priority);
    });
    res.json({ mine, counts, awardedBuilds, tally: userHas(req.user, 'loot.awards') ? tally : undefined });
  } catch (err) {
    console.error('Loot load error:', err.message);
    res.status(500).json({ error: 'Failed to load loot wishlist.' });
  }
});

app.put('/api/loot/:discordId', async (req, res) => {
  const target = req.params.discordId;
  if (req.user.id !== target && !userHas(req.user, 'loot.awards')) {
    return res.status(403).json({ error: 'You can only edit your own wishlist.' });
  }
  if (!supabase || !lootCatalog) return res.status(503).json({ error: 'Database not configured.' });
  const validKeys = await lootCatalog.getKeys();
  const { data: existing } = await supabase.from('loot_wishlists').select('picks').eq('discord_id', target).single();
  const existingPicks = existing?.picks || {};
  const now = new Date().toISOString();
  const incoming = req.body?.picks || {};
  const picks = {};
  Object.entries(incoming).forEach(([k, prio]) => {
    if (!validKeys.has(k) || !lootCatalog.priorities.has(prio)) return;
    const prev = existingPicks[k];
    // Keep the original add time across priority edits; only stamp "now" the first time an item is picked.
    const addedAt = (prev && typeof prev === 'object' && prev.added_at) || now;
    picks[k] = { priority: prio, added_at: addedAt };
  });
  const display_name = (req.body?.display_name || req.user.username || '').slice(0, 120);
  const { error } = await supabase.from('loot_wishlists')
    .upsert({ discord_id: target, display_name, picks, updated_at: new Date().toISOString() });
  if (error) { console.error('Loot save error:', error.message); return res.status(500).json({ error: 'Failed to save wishlist.' }); }
  res.json({ picks: Object.fromEntries(Object.entries(picks).map(([k, v]) => [k, v.priority])) });
});

// ── LOA (Leave of Absence) ───────────────────────────────────────────────────
// Event schedule (read-only for members; admin manages via admin router).
app.get('/api/event-schedule', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { data, error } = await supabase.from('event_schedule').select('*').order('day_of_week').order('name');
  if (error) return res.status(500).json({ error: 'Failed to load schedule.' });
  res.json({ schedule: data || [] });
});

// ── Wargame maps (read-only for members; admin manages via admin router) ────
app.get('/api/maps', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { data, error } = await supabase.from('wargame_maps').select('*').order('name');
  if (error) return res.status(500).json({ error: 'Failed to load maps.' });
  res.json({ maps: data || [] });
});

// ── Elite boss respawn timers (read-only; reported via the /elitetimer Discord command) ──
app.get('/api/elite-timers', async (req, res) => {
  if (!eliteTimers) return res.status(503).json({ error: 'Database not configured.' });
  const timers = await eliteTimers.all();
  res.json({ timers, locations: eliteTimers.locations });
});

// ── FEUDS: the head-to-head record against every enemy guild ────────────────
// Member-facing, like the War Record and the Map Record beside it — all three
// are derived from the same scoreboards, which everyone in the guild can
// already read in full.
//
// Aggregated in SQL (migrations/019). Doing it here would mean paging every
// player row of every match on each request; see the note in that migration.
app.get('/api/guilds/feuds', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const p_guild_names = Object.keys(guildAliases());
    const [feuds, coverage] = await Promise.all([
      supabase.rpc('get_guild_feuds', { p_guild_names }),
      supabase.rpc('get_guild_feud_coverage', { p_guild_names }),
    ]);
    if (feuds.error) throw feuds.error;
    if (coverage.error) throw coverage.error;

    const { total_matches: total = 0, scored_matches: scored = 0 } = coverage.data?.[0] || {};
    res.json({
      feuds: feuds.data || [],
      // Matches whose side couldn't be determined — no player of ours matched
      // on either team. Reported rather than silently dropped: a number that
      // climbs usually means an alias is missing from Guild Settings.
      coverage: { total_matches: Number(total), scored_matches: Number(scored), excluded: Number(total) - Number(scored) },
    });
  } catch (err) {
    console.error('Guild feuds error:', err.message);
    res.status(500).json({ error: 'Failed to load the feud list.' });
  }
});

// Who one enemy guild fields. Fetched on expand — the list is cheap, a roster
// per guild is not.
app.get('/api/guilds/feuds/:name', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const enemy = decodeURIComponent(req.params.name);
    const { data, error } = await supabase.rpc('get_guild_feud_roster', {
      p_guild_names: Object.keys(guildAliases()),
      p_enemy: enemy,
      p_recent: RECENT_GAMES,
    });
    if (error) throw error;

    // Rows arrive grouped by player AND weapon pair. The fold — per-player
    // totals, per-match rates, the class mix, and which players stand out
    // against their own guild's median — lives in feudRoster so it can be
    // tested; see the note at the top of that module.
    //
    // classify is passed in rather than imported there, so
    // shared/weaponClasses.json stays the site's only class vocabulary.
    res.json({
      enemy_guild: enemy,
      ...foldRoster(data || [], { enemyGuild: enemy, classify: getClassNameBackend }),
    });
  } catch (err) {
    console.error('Guild feud roster error:', err.message);
    res.status(500).json({ error: 'Failed to load that guild.' });
  }
});

// ── CROSS-GUILD PLAYER LOOKUP ───────────────────────────────────────────────
// "Where else has this name played?" — a name under three guilds in a year is a
// mercenary, and one that moved from a guild you beat to a guild you lose to is
// worth knowing about. Member-facing for the same reason the feuds are: it is
// derived from scoreboards everyone can already read.
app.get('/api/players/search', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const q = String(req.query.q || '').trim();
    // Answered without touching the database. A search box that fires on the
    // first keystroke scans the whole table for a single letter, and the answer
    // is useless anyway.
    if (q.length < 2) return res.json({ players: [], query: q, too_short: q.length > 0 });

    const { data, error } = await supabase.rpc('get_player_search', { p_query: q, p_limit: 25 });
    if (error) throw error;
    res.json({ players: data || [], query: q });
  } catch (err) {
    console.error('Player search error:', err.message);
    res.status(500).json({ error: 'Search failed.' });
  }
});

app.get('/api/players/:name/guilds', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const name = decodeURIComponent(req.params.name);
    const { data, error } = await supabase.rpc('get_player_guilds', {
      p_guild_names: Object.keys(guildAliases()),
      p_player: name,
    });
    if (error) throw error;

    const guilds = data || [];
    // Whether this name is one of OUR members, so the page can link to their
    // full profile. Resolved through identities, which is the only thing that
    // knows our aliases — an enemy name simply isn't in it.
    const ids = identities ? await identities.load() : null;
    const identity = ids ? ids.identityForName(name) : null;

    res.json({
      player_name: name,
      guilds,
      matches: guilds.reduce((n, g) => n + (Number(g.matches) || 0), 0),
      member: identity ? { display_name: identity.display_name } : null,
    });
  } catch (err) {
    console.error('Player guilds error:', err.message);
    res.status(500).json({ error: 'Failed to load that player.' });
  }
});

// Per-map win/loss record, for the War Record page.
app.get('/api/maps/stats', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const { data, error } = await supabase.from('wargame_matches').select('map, result').not('map', 'is', null);
  if (error) return res.status(500).json({ error: 'Failed to load map stats.' });

  const byMap = {};
  (data || []).forEach((m) => {
    const key = m.map;
    if (!key) return;
    const s = (byMap[key] ||= { map: key, played: 0, wins: 0, losses: 0, draws: 0 });
    s.played++;
    if (m.result === 'Win') s.wins++;
    else if (m.result === 'Loss') s.losses++;
    else if (m.result === 'Draw') s.draws++;
  });

  const stats = Object.values(byMap)
    .map((s) => ({ ...s, winPct: s.played > 0 ? Math.round((s.wins / s.played) * 100) : 0 }))
    .sort((a, b) => b.played - a.played);

  res.json({ stats });
});

// My LOAs
app.get('/api/loa', async (req, res) => {
  if (!loa) return res.status(503).json({ error: 'Database not configured.' });
  try {
    res.json({ entries: await loa.mine(req.user.id) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// All LOAs (so members can see who's out, minus reasons)
app.get('/api/loa/all', async (req, res) => {
  if (!loa) return res.status(503).json({ error: 'Database not configured.' });
  try {
    res.json({ entries: await loa.all(userHas(req.user, 'loa.admin')) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Submit an LOA (per-event or range)
app.post('/api/loa', async (req, res) => {
  if (!loa) return res.status(503).json({ error: 'Database not configured.' });
  const { type, event_date, event_schedule_id, start_date, end_date, day_of_week, start_time, end_time, reason, discord_id, display_name } = req.body || {};
  // Admins can submit on a member's behalf by passing discord_id/display_name;
  // anyone else's request is always attributed to themselves regardless of
  // what the body says.
  const onBehalf = userHas(req.user, 'loa.admin') && discord_id;
  const targetId = onBehalf ? discord_id : req.user.id;
  // Only a fallback: submit* resolves the target's site alias and hands back
  // the name it actually stored, which is what the announcement below uses.
  const targetName = onBehalf ? (display_name || 'Member') : req.user.username;
  try {
    let saved;
    let announce;
    if (type === 'event') {
      saved = await loa.submitEvent({ discordId: targetId, displayName: targetName, eventDate: event_date, eventScheduleId: event_schedule_id, startTime: start_time, endTime: end_time, reason });
      announce = { type: 'event', displayName: saved.displayName, eventName: saved.eventName, eventDate: event_date, startTime: saved.startTime, endTime: saved.endTime };
    } else if (type === 'range') {
      saved = await loa.submitRange({ discordId: targetId, displayName: targetName, startDate: start_date, endDate: end_date, reason });
      announce = { type: 'range', displayName: saved.displayName, startDate: start_date, endDate: end_date };
    } else if (type === 'recurring') {
      const dow = parseInt(day_of_week, 10);
      saved = await loa.submitRecurring({ discordId: targetId, displayName: targetName, dayOfWeek: dow, eventScheduleId: event_schedule_id, startTime: start_time, endTime: end_time, reason });
      announce = { type: 'recurring', displayName: saved.displayName, eventName: saved.eventName, dayOfWeek: dow, startTime: saved.startTime, endTime: saved.endTime };
    } else {
      return res.status(400).json({ error: 'Type must be "event", "range", or "recurring".' });
    }
    res.json({ ok: true });
    // Announced after the response and never awaited: the LOA is already saved
    // by this point, so a slow or unreachable Discord shouldn't hold up the
    // submitter or make a successful save look like it failed. Recording the
    // message id lets DELETE below remove the announcement on cancellation.
    gateway.announceLoaEntry(announce)
      .then((messageId) => messageId && loa.setMessageId(saved.id, messageId))
      .catch((err) => console.error('LOA announce error:', err.message));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Delete own LOA
app.delete('/api/loa/:id', async (req, res) => {
  if (!loa) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { messageId, entry } = await loa.cancel(req.params.id, req.user.id, userHas(req.user, 'loa.admin'));
    res.json({ ok: true });
    gateway.deleteLoaMessage(messageId);
    // After the response and never awaited, like the announcement on submit:
    // the LOA is already gone, so a slow Discord must not make a successful
    // cancellation look like it failed.
    gateway.notifyLoaCancelled(entry, { id: req.user.id, name: req.user.username })
      .catch((err) => console.error('LOA cancellation notice error:', err.message));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Remove ONE occurrence from a recurring LOA, or put it back.
//
// Separate from DELETE /api/loa/:id on purpose. That one cancels the standing
// rule; this one lifts a single date out of it. The board projects a recurring
// entry onto every matching night, so those nights look like rows you can
// delete — and until this existed, deleting one deleted all of them. Two
// different destructive scopes need two different routes, or the UI has no way
// to offer the small one.
//
// DELETE removes the occurrence, POST restores it — the occurrence is the
// resource, and the series it belongs to is untouched either way.
const loaOccurrence = (skip) => async (req, res) => {
  if (!loa) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const result = await loa.setOccurrenceSkipped({
      id: req.params.id,
      date: req.params.date,
      skip,
      discordId: req.user.id,
      isAdmin: userHas(req.user, 'loa.admin'),
    });
    res.json({ ok: true, skip_dates: result.skipDates });
    // Only when something actually changed: a repeated click is a no-op and
    // shouldn't DM anybody a second time. After the response and never awaited,
    // like the announcement on submit and the notice on cancel.
    if (result.changed) {
      gateway.notifyLoaOccurrence(result.entry, req.params.date, skip, {
        id: req.user.id, name: req.user.username,
      }).catch((err) => console.error('LOA occurrence notice error:', err.message));
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};

app.delete('/api/loa/:id/occurrences/:date', loaOccurrence(true));
app.post('/api/loa/:id/occurrences/:date', loaOccurrence(false));

// ── Event signups ────────────────────────────────────────────────────────────
// Opt-in only: a row means "I'm coming". There is no way to record "I'm out"
// here — that's what an LOA is — so a member with no entry is undecided, not
// declined. Officers open and manage signups through the admin router.
app.get('/api/signups', async (req, res) => {
  if (!signups) return res.status(503).json({ error: 'Database not configured.' });
  try {
    res.json({ signups: await signups.list({ discordId: req.user.id }) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Sign up for a scheduled night, opening the occurrence if it doesn't exist.
// This is what the event calendar posts to: it shows the whole schedule, so
// most rows on it have no signup_events row behind them until someone commits.
//
// Open and join are ONE request on purpose. A client that opened first and
// joined second leaves an empty occurrence behind every time the second call
// fails — and an empty occurrence is indistinguishable from a raid call nobody
// answered, which is a worse thing to have in the list than nothing at all.
//
// Registered above /api/signups/:id so the literal path can never be read as an
// id. The target is always the caller; there is no discord_id body field here,
// same rule as the join route below.
app.post('/api/signups/for-event', async (req, res) => {
  if (!signups) return res.status(503).json({ error: 'Database not configured.' });
  const { event_schedule_id, event_date } = req.body || {};
  try {
    const occ = await signups.openForSchedule({
      eventScheduleId: event_schedule_id || null,
      eventDate: event_date,
      openedBy: req.user.username || req.user.id,
    });
    const result = await signups.join({
      id: occ.id, discordId: req.user.id, displayName: req.user.username,
    });
    res.json({ ...result, signup_id: occ.id, opened: occ.opened });
    // Only ever edits a post that already exists — opening from here is quiet,
    // so a member answering a night three weeks out announces nothing. Officers
    // post it from the Signups page when they want the call made.
    gateway.refreshSignupMessage(occ.id);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('/api/signups/:id', async (req, res) => {
  if (!signups) return res.status(503).json({ error: 'Database not configured.' });
  try {
    // LOA reasons are officer-only, same rule as /api/loa/all above.
    res.json(await signups.detail(req.params.id, { includeReasons: userHas(req.user, 'loa.admin') }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Always the caller. Signing someone else up is an officer action and lives on
// the admin router, so there's no body field here to spoof.
app.post('/api/signups/:id/join', async (req, res) => {
  if (!signups) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const result = await signups.join({ id: req.params.id, discordId: req.user.id, displayName: req.user.username });
    res.json(result);
    gateway.refreshSignupMessage(req.params.id);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/signups/:id/join', async (req, res) => {
  if (!signups) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const result = await signups.withdraw({ id: req.params.id, discordId: req.user.id });
    res.json(result);
    // Both after the response and unawaited, for the same reason the LOA
    // announcement above is: the withdrawal is already saved, and a slow or
    // unreachable Discord must not make it look like it failed.
    gateway.refreshSignupMessage(req.params.id);
    if (result.promoted) gateway.notifySignupPromotion(result.promoted, req.params.id);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── MEMBERS AREA: Attendance ─────────────────────────────────────────────────
// A member's own attendance record, and the one correction they may ask for.
//
// Everything here is self-scoped in the WHERE clause rather than checked after
// the fact: the requester is always req.user.id and never a body field, so
// there is no on-behalf-of path to get wrong. Officers add people on someone
// else's behalf through /api/admin, where the audit middleware sees it.

// The night in full. `officer` widens the response for someone who holds
// 'attendance' — the reasons and the decider — rather than changing what the
// page computes; see eventDetail.js.
app.get('/api/attendance/events/:id', async (req, res) => {
  if (!eventDetail) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const out = await eventDetail.detail(req.params.id, {
      viewerId: req.user.id,
      officer: userHas(req.user, 'attendance'),
    });
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to load that event.' });
  }
});

app.get('/api/attendance/mine', async (req, res) => {
  if (!lateAttendance) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180);
    const events = await lateAttendance.listForMember(req.user.id, { days });
    res.json({ events, days, window_hours: lateAttendance.WINDOW_HOURS });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to load your attendance.' });
  }
});

app.post('/api/attendance/late', async (req, res) => {
  if (!lateAttendance) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const out = await lateAttendance.request({
      eventId: req.body?.event_id,
      // Always the session's own id. There is deliberately no way to file for
      // someone else here — attendance is the number the guild makes decisions
      // with, so nobody writes their own and nobody writes anyone else's
      // without going through an officer route that is audited.
      discordId: req.user.id,
      displayName: req.user.username,
      reason: req.body?.reason,
    });
    res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to file that request.' });
  }
});

app.delete('/api/attendance/late/:id', async (req, res) => {
  if (!lateAttendance) return res.status(503).json({ error: 'Database not configured.' });
  try {
    res.json(await lateAttendance.cancel(req.params.id, req.user.id));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to withdraw that request.' });
  }
});

// ── ALL-TIME PLAYER STATS (our guild only) ───────────────────────────────────
app.get('/api/players', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const lastN = Math.min(Math.max(parseInt(req.query.last, 10) || 0, 0), 500);
    const ids = await identities.load();

    let data;
    let matchIds = null; // null = all-time (no match scoping), set below for the "last N" branch
    if (lastN > 0) {
      const { data: recentMatches } = await supabase
        .from('wargame_matches').select('id')
        .order('match_date', { ascending: false }).limit(lastN);
      matchIds = (recentMatches || []).map((m) => m.id);
      if (matchIds.length === 0) return res.json({ players: [] });

      const guildNames = Object.keys(guildAliases());
      const { data: rows, error: rErr } = await supabase
        .from('player_match_stats')
        .select('player_name, kills, assists, damage_dealt, damage_taken, healing')
        .in('match_id', matchIds)
        .in('guild_name', guildNames);
      if (rErr) throw rErr;

      const agg = {};
      (rows || []).forEach((r) => {
        const resolved = ids.resolveName(r.player_name);
        if (!agg[resolved]) agg[resolved] = { player_name: resolved, matches: 0, kills: 0, assists: 0, damage_dealt: 0, damage_taken: 0, healing: 0 };
        agg[resolved].matches++;
        agg[resolved].kills += Number(r.kills) || 0;
        agg[resolved].assists += Number(r.assists) || 0;
        agg[resolved].damage_dealt += Number(r.damage_dealt) || 0;
        agg[resolved].damage_taken += Number(r.damage_taken) || 0;
        agg[resolved].healing += Number(r.healing) || 0;
      });
      data = Object.values(agg);
    } else {
      const result = await supabase.rpc('get_player_stats', { p_guild_names: Object.keys(guildAliases()) });
      if (result.error) throw result.error;
      data = result.data;
    }

    // Primary class per player, for the Roster page's Melee/Range/Kill
    // Squad/Healers filter — weapon columns aren't part of get_player_stats()'s
    // RPC output, so this is a separate fetch, scoped to the same match set as
    // the stats above. Paginated via .range() since player_match_stats can
    // exceed PostgREST's 1,000-row default cap for a guild with real history.
    const guildNames = Object.keys(guildAliases());
    // Only the unscoped all-time scan is worth caching — a "last N" query is
    // already bounded by its match set and changes with the parameter.
    const weaponRows = matchIds
      ? await fetchAllRows(supabase, 'player_match_stats', 'player_name, weapon_1, weapon_2', guildNames, matchIds)
      : await allTimeWeaponRows(supabase, guildNames);
    const classCounts = {}; // resolved player_name -> { className: count }
    weaponRows.forEach((r) => {
      const resolved = ids.resolveName(r.player_name);
      const cls = getClassNameBackend(r.weapon_1, r.weapon_2);
      if (cls === 'Unknown') return;
      if (!classCounts[resolved]) classCounts[resolved] = {};
      classCounts[resolved][cls] = (classCounts[resolved][cls] || 0) + 1;
    });
    const primaryClassFor = (name) => {
      const counts = classCounts[name];
      if (!counts) return null;
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    };

    const members = await listMembers().catch(() => []);
    const memberIds = new Set(members.map((m) => m.id));

    const players = (data || []).map((p) => {
      const did = ids.discordIdFor(p.player_name);
      return { ...p, is_member: did ? memberIds.has(did) : false, primary_class: primaryClassFor(p.player_name) };
    });

    res.json({ players });
  } catch (err) {
    console.error('Player stats error:', err.message);
    res.status(500).json({ error: 'Failed to load player stats.' });
  }
});

// How many logged events this member turned up to, and out of how many they
// could have. "Could have" counts only events from their first recorded
// attendance onward — measuring a new member against events that happened
// before they joined would show a rate that says nothing about them.
async function playerAttendance(discordId) {
  const [{ data: mine }, { data: allEvents }] = await Promise.all([
    supabase.from('event_attendance').select('event_id').eq('discord_id', discordId),
    supabase.from('events').select('id, title, event_date').order('event_date', { ascending: false }),
  ]);
  const attendedIds = new Set((mine || []).map((a) => a.event_id));
  const events = allEvents || [];
  if (events.length === 0) return { attended: 0, eligible: 0, rate: null, since: null, recent: [] };

  const attendedEvents = events.filter((e) => attendedIds.has(e.id));
  const since = attendedEvents.length
    ? attendedEvents[attendedEvents.length - 1].event_date
    : null;
  const eligible = since ? events.filter((e) => (e.event_date || '') >= since) : [];

  // The last 10 eligible events, newest first, each flagged attended or missed —
  // a rate alone hides whether someone is trending away.
  const recent = eligible.slice(0, 10).map((e) => ({
    id: e.id, title: e.title, event_date: e.event_date, attended: attendedIds.has(e.id),
  }));

  return {
    attended: attendedEvents.length,
    eligible: eligible.length,
    rate: eligible.length ? attendedEvents.length / eligible.length : null,
    since,
    recent,
  };
}

// Gear and currency a member has been given. Visible on your own profile
// unconditionally; on someone else's it takes the capability that governs that
// ledger, since who-got-what is otherwise officer-only (see the loot tally).
// The two halves are gated separately — currency is the more sensitive one.
async function playerLoot(discordId, viewer) {
  const isSelf = viewer?.id === discordId;
  const canItems = isSelf || userHas(viewer, 'loot.awards');
  const canCurrency = isSelf || userHas(viewer, 'loot.currency');

  const [awards, currency, catalogItems] = await Promise.all([
    canItems
      ? supabase.from('loot_awards').select('id, item_key, priority, awarded_at')
        .eq('discord_id', discordId).order('awarded_at', { ascending: false }).then((r) => r.data || [])
      : Promise.resolve(null),
    canCurrency
      ? supabase.from('currency_awards').select('id, currency, amount, reason, awarded_at')
        .eq('discord_id', discordId).order('awarded_at', { ascending: false }).then((r) => r.data || [])
      : Promise.resolve(null),
    // Names resolved here rather than making the profile page fetch the whole
    // catalog just to label a handful of rows.
    canItems ? supabase.from('loot_items').select('key, name, grade, image_url').then((r) => r.data || []) : Promise.resolve([]),
  ]);

  const byKey = Object.fromEntries((catalogItems || []).map((i) => [i.key, i]));
  return {
    canSeeItems: canItems,
    canSeeCurrency: canCurrency,
    items: awards && awards.map((a) => ({
      ...a,
      name: byKey[a.item_key]?.name || a.item_key,
      grade: byKey[a.item_key]?.grade || null,
      image_url: byKey[a.item_key]?.image_url || null,
    })),
    currency: currency,
  };
}

// ── PLAYER PROFILE ──────────────────────────────────────────────────────────
app.get('/api/player/:name', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const requestedName = decodeURIComponent(req.params.name).trim();

    // Resolve all in-game names this player might appear as via identities.
    const ids = await identities.load();
    const identity = ids.identityForName(requestedName);
    let names = [requestedName];
    let displayName = requestedName;
    let discordId = null;
    if (identity) {
      displayName = identity.display_name || requestedName;
      names = [identity.display_name, ...(Array.isArray(identity.ingame_names) ? identity.ingame_names : [])].filter(Boolean);
      discordId = identity.discord_id || null;
    }
    const gearEntry = discordId && gearIlvl ? await gearIlvl.forMember(discordId) : null;

    // Every match row under any of this player's names, REGARDLESS of guild —
    // the guild split happens below, in JS, so it can be reported instead of
    // silently applied.
    //
    // It used to filter `.in('guild_name', guildNames)` in the query, which is
    // why profiles looked short: a row whose scoreboard guild name is a
    // spelling the alias list doesn't carry (OCR variance, a rename, a night
    // subbing elsewhere) simply vanished, with nothing anywhere saying so.
    //
    // Paged, too. One player rarely passes 1,000 rows, but this is no longer
    // scoped to one guild and the cap truncates without erroring.
    //
    // Explicit constraint name, not just "!inner" — player_match_stats has
    // picked up a second (oddly-named, likely stale) foreign key to
    // wargame_matches on match_id, so PostgREST can no longer infer which
    // relationship to embed and errors with "more than one relationship
    // was found" on a bare wargame_matches!inner(...).
    const guildNames = Object.keys(guildAliases());
    const guildSet = new Set(guildNames);
    const allRows = await fetchAll(
      () => supabase
        .from('player_match_stats')
        .select('*, wargame_matches!player_match_stats_match_id_fkey(id, title, match_date)')
        .in('player_name', names)
        .order('id'),
      { label: 'player_match_stats' },
    );
    if (allRows.length === 0) return res.status(404).json({ error: 'Player not found.' });

    // The split, the totals and the excluded tally all live in playerStats so
    // they can be tested — see the note at the top of that module.
    const stats = aggregatePlayerRows(allRows, guildSet, getClassNameBackend);

    // ── Attendance and loot ─────────────────────────────────────────────────
    // Both hang off the Discord id, so an unmapped player has neither — a name
    // on a scoreboard with nobody linked to it can't be tied to a member.
    const [attendance, loot] = discordId
      ? await Promise.all([playerAttendance(discordId), playerLoot(discordId, req.user)])
      : [null, null];

    res.json({
      name: displayName,
      aliases: names.length > 1 ? names.filter((n) => n.toLowerCase() !== displayName.toLowerCase()) : [],
      attendance,
      loot,
      ...stats,
      gear: gearEntry ? {
        weapon: gearEntry.weapon, armor: gearEntry.armor,
        accessory: gearEntry.accessory, average: gearEntry.average,
      } : null,
    });
  } catch (err) {
    console.error('Player profile error:', err.message);
    res.status(500).json({ error: 'Failed to load player profile.' });
  }
});

// ── STATS SUMMARY ────────────────────────────────────────────────────────────
app.get('/api/stats/summary', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    // Total Matches
    const { count: totalMatches } = await supabase
      .from('wargame_matches')
      .select('*', { count: 'exact', head: true });

    // Aggregation via RPC — bypasses the 1,000-row PostgREST limit entirely.
    // The alias list is passed in, never assumed by the function: it used to be
    // hardcoded in the SQL body, so these tiles stopped counting at the last
    // guild rename. See 024.
    const { data: aggData, error: aggError } = await supabase
      .rpc('get_stats_summary', { p_guild_names: Object.keys(guildAliases()) });

    if (aggError) throw aggError;

    const totalKills   = Number(aggData[0]?.total_kills)   || 0;
    const totalDamage  = Number(aggData[0]?.total_damage)  || 0;
    const totalHealing = Number(aggData[0]?.total_healing) || 0;

    // Roster composition — active member count plus a PvP-role breakdown, both
    // used by the Dashboard's "Standing" tiles.
    let activeMembers = 0, tanks = 0, dps = 0, healers = 0;
    try {
      const [members, { data: roleData }] = await Promise.all([
        listMembers(),
        supabase.from('member_roles').select('discord_id, pvp_role'),
      ]);
      activeMembers = members.length;
      // Scoped to the current member list, the way every other member_roles
      // reader does it. Rows are never deleted when someone leaves the guild or
      // loses the member role, so counting the table raw folds in every ex-member
      // who was ever assigned a role — which is how the breakdown ended up
      // outrunning the Active Members tile sitting next to it.
      const active = new Set(members.map((m) => m.id));
      (roleData || []).forEach((r) => {
        if (!active.has(r.discord_id)) return;
        if (r.pvp_role === 'Tank') tanks++;
        else if (r.pvp_role === 'DPS') dps++;
        else if (r.pvp_role === 'Healer') healers++;
      });
    } catch (err) {
      console.warn('Roster composition unavailable for stats summary:', err.message);
    }

    res.json({
      totalMatches:  totalMatches || 0,
      totalKills:    totalKills.toLocaleString(),
      totalDamage:   (totalDamage  / 1_000_000).toFixed(1) + "M",
      totalHealing:  (totalHealing / 1_000_000).toFixed(1) + "M",
      activeMembers,
      tanks,
      dps,
      healers,
    });

  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: "Failed to load stats summary" });
  }
});

// ── REAL RECENT MATCHES WITH STATS ──────────────────────────────────────────
app.get('/api/matches/recent', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Database not configured" });

  try {
    // Clamp the limit so a caller can't request, say, ?limit=100000
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 6, 1), 500);

    const { data: matches, error } = await supabase
      .from('wargame_matches')
      .select('*')
      .order('match_date', { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!matches || matches.length === 0) return res.json([]);

    // ── PER-MATCH TOTALS ARE OPT-IN ─────────────────────────────────────────
    // kills/damage/healing/killDifference/winningGuild mean reading every
    // player row of every listed match — at ?limit=500 that is tens of
    // thousands of rows. The War Record page asks for 500 and uses none of
    // them: it only needs id, title, date and map to fill its dropdown. So it
    // was fetching a thousand rows (the cap; the rest were silently dropped)
    // and throwing all of them away on every page load.
    //
    // Only the dashboard needs them, and only as a fallback for rows with no
    // stored `result`. It asks with ?enrich=1.
    const enrich = req.query.enrich === '1' || req.query.enrich === 'true';
    const playersByMatch = {};

    if (enrich) {
      // Paged. 20 matches is already ~2,000 rows, so the unpaged version was
      // truncating past roughly the tenth match — and a truncated match gets
      // zero kills on both sides, which reads as a draw rather than as missing
      // data. No guild filter: the enemy team's kills are half of the
      // comparison, so this deliberately reads both sides.
      const matchIds = matches.map((m) => m.id);
      const allPlayers = await fetchAll(
        () => supabase
          .from('player_match_stats')
          .select('match_id, guild_name, team_color, kills, damage_dealt, healing')
          .in('match_id', matchIds)
          .order('id'),
        { label: 'player_match_stats' },
      );
      allPlayers.forEach((p) => { (playersByMatch[p.match_id] ||= []).push(p); });
    }

    // Without ?enrich=1 the rows go back as they are. Omitted rather than
    // zeroed: absent says "not computed", whereas `kills: 0` says "nobody
    // killed anybody", and a caller can't tell the second from a real draw.
    if (!enrich) return res.json(matches);

    const enriched = matches.map(match => {
      const players = playersByMatch[match.id] || [];

      // Determine which team color is ours by finding the team with the most
      // FTP-aliased players (handles subs from other guilds correctly).
      const teamGuildCount = { Red: {}, Yellow: {} };
      players.forEach(p => {
        const color = (p.team_color || '').toLowerCase();
        const teamKey = color === 'red' ? 'Red' : color === 'yellow' ? 'Yellow' : null;
        if (!teamKey) return;
        const g = canonicalGuild(p.guild_name);
        teamGuildCount[teamKey][g] = (teamGuildCount[teamKey][g] || 0) + 1;
      });
      const myRedCount = teamGuildCount.Red[myGuild()] || 0;
      const myYellowCount = teamGuildCount.Yellow[myGuild()] || 0;
      const ourColor = myRedCount >= myYellowCount ? 'Red' : 'Yellow';

      // Sum kills by team color
      const teamKills = { Red: 0, Yellow: 0 };
      let totalKills = 0, totalDamage = 0, totalHealing = 0;
      players.forEach(p => {
        const k = Number(p.kills) || 0;
        const color = (p.team_color || '').toLowerCase();
        if (color === 'red') teamKills.Red += k;
        else if (color === 'yellow') teamKills.Yellow += k;
        totalKills += k;
        totalDamage += Number(p.damage_dealt) || 0;
        totalHealing += Number(p.healing) || 0;
      });

      const myKills = teamKills[ourColor];
      const enemyKills = teamKills[ourColor === 'Red' ? 'Yellow' : 'Red'];
      const killDifference = Math.abs(myKills - enemyKills);
      const winningGuild = myKills >= enemyKills ? myGuild() : 'Enemy';

      return {
        ...match,
        kills: totalKills,
        damage: totalDamage,
        healing: totalHealing,
        killDifference,
        winningGuild
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('Recent matches error:', err);
    res.status(500).json({ error: "Failed to load recent matches" });
  }
});
// ── MATCH DETAIL WITH RED vs YELLOW TEAMS ───────────────────────────────────
app.get('/api/match/:id', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: "Database not configured" });
  }

  try {
    const { id } = req.params;

    // Get match info
    const { data: match, error: matchError } = await supabase
      .from('wargame_matches')
      .select('*')
      .eq('id', id)
      .single();

    if (matchError) throw matchError;

    // Get players
    const { data: players, error: playersError } = await supabase
      .from('player_match_stats')
      .select('*')
      .eq('match_id', id)
      .order('rank', { ascending: true });

    if (playersError) throw playersError;

    // Class Breakdown
    const classCount = {};
    players.forEach(p => {
      const className = getClassNameBackend(p.weapon_1, p.weapon_2);
      classCount[className] = (classCount[className] || 0) + 1;
    });

    // Team Stats by team_color (Red vs Yellow)
    const teamStats = {
      Red: { kills: 0, damage_dealt: 0, damage_taken: 0, healing: 0 },
      Yellow: { kills: 0, damage_dealt: 0, damage_taken: 0, healing: 0 }
    };

    players.forEach(p => {
      const color = (p.team_color || '').toLowerCase();
      const teamKey = color === 'red' ? 'Red' : color === 'yellow' ? 'Yellow' : 'Unknown';

      if (teamStats[teamKey]) {
        teamStats[teamKey].kills += Number(p.kills || 0);
        teamStats[teamKey].damage_dealt += Number(p.damage_dealt || 0);
        teamStats[teamKey].damage_taken += Number(p.damage_taken || 0);
        teamStats[teamKey].healing += Number(p.healing || 0);
      }
    });

    // Label each color with the guild fielding the most players on it.
    // Aliases are collapsed so our house counts as one; ties break on kills.
    const guildTally = { Red: {}, Yellow: {} };
    players.forEach(p => {
      const color = (p.team_color || '').toLowerCase();
      const teamKey = color === 'red' ? 'Red' : color === 'yellow' ? 'Yellow' : null;
      if (!teamKey) return;
      const g = canonicalGuild(p.guild_name);
      if (!guildTally[teamKey][g]) guildTally[teamKey][g] = { count: 0, kills: 0 };
      guildTally[teamKey][g].count += 1;
      guildTally[teamKey][g].kills += Number(p.kills || 0);
    });

    const dominantGuild = (tally) => {
      const entries = Object.entries(tally);
      if (entries.length === 0) return null;
      entries.sort((a, b) => b[1].count - a[1].count || b[1].kills - a[1].kills);
      return entries[0][0];
    };

    teamStats.Red.guildName = dominantGuild(guildTally.Red);
    teamStats.Yellow.guildName = dominantGuild(guildTally.Yellow);

    res.json({
      match: match || {},
      players: players || [],
      classBreakdown: Object.entries(classCount)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
      teamStats: teamStats
    });
  } catch (err) {
    console.error('Match detail error:', err);
    res.status(500).json({ error: 'Failed to load match details' });
  }
});

// Fetches every matching row from a table, paging past PostgREST's 1,000-row
// default cap via .range() instead of trusting a single .select() to return
// everything. `matchIds` is optional — pass null to skip that filter entirely
// (an all-time query) rather than scoping to a specific set of matches.
// The all-time weapon scan pages the whole of player_match_stats on every
// /api/players request, and that table only grows. Cached with the same
// stale-serve + in-flight-dedupe shape as the members and identities caches.
//
// Deliberately caches the RAW rows, not the finished class breakdown: name
// resolution still runs per request, so remapping an identity on the Names page
// shows up immediately instead of waiting out the TTL. Only the expensive part
// is cached.
const WEAPON_CACHE_TTL_MS = (parseInt(process.env.WEAPON_CACHE_SECONDS, 10) || 300) * 1000;
let weaponCache = null;
let weaponCacheAt = 0;
let weaponInFlight = null;

async function allTimeWeaponRows(supabase, guildNames) {
  if (weaponCache && Date.now() - weaponCacheAt < WEAPON_CACHE_TTL_MS) return weaponCache;
  // Concurrent callers share one scan rather than each starting their own.
  if (weaponInFlight) return weaponInFlight;
  weaponInFlight = fetchAllRows(supabase, 'player_match_stats', 'player_name, weapon_1, weapon_2', guildNames, null)
    .then((rows) => { weaponCache = rows; weaponCacheAt = Date.now(); return rows; })
    .catch((err) => {
      // A stale breakdown beats an error page; a cold cache still surfaces it.
      if (weaponCache) { console.warn('Weapon scan failed — serving stale cache:', err.message); return weaponCache; }
      throw err;
    })
    .finally(() => { weaponInFlight = null; });
  return weaponInFlight;
}

// Thin wrapper over pagedRead's fetchAll, kept for its call sites' signature.
// It used to hand-roll the loop and stop on a short page, which quietly
// truncates on any project whose max-rows is set below the page size — see the
// note in backend/pagedRead.js. Ordered by id so range paging is stable.
function fetchAllRows(supabase, table, columns, guildNames, matchIds) {
  return fetchAll(() => {
    let q = supabase.from(table).select(columns).in('guild_name', guildNames);
    if (matchIds) q = q.in('match_id', matchIds);
    return q.order('id');
  }, { label: table });
}

// Backend Class Helper
const weaponToClass = require('../shared/weaponClasses.json');

function getClassNameBackend(weapon1, weapon2) {
  if (!weapon1) return "Unknown";
  const w1 = (weapon1 || "").trim();
  const w2 = (weapon2 || "").trim();

  let key = (w1 + w2).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];

  key = (w2 + w1).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];

  return `${w1} ${w2}`.trim() || "Unknown";
}

// ── SERVE REACT FRONTEND ─────────────────────────────────────────────────────
const frontendPath = path.join(__dirname, '../frontend/dist');
app.use(express.static(frontendPath));

// Unknown API routes return JSON 404 (not the SPA's index.html)
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Everything else falls through to the React app
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// ── Error handler ────────────────────────────────────────────────────────────
// Must be last, and must take four arguments — that arity is how Express
// recognises it. Without one, a Multer failure (an over-size upload, say) fell
// through to Express's default handler and returned an HTML stack page, while
// every fetch in the frontend does `err.response?.data?.error` and would show
// "undefined" instead of the real reason.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.name === 'MulterError') {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? 'That file is too large — the limit is 15 MB.' : `Upload failed: ${err.message}`,
    });
  }
  console.error('Unhandled error:', err?.stack || err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// Load guild_config BEFORE accepting the first request. guildConfig.get() falls
// back to DEFAULTS on a cold cache, and DEFAULTS has empty role lists — which
// fails closed, correctly, but would mean the first few requests after a deploy
// saw nobody as an officer and nobody as allowed to sign in. One await removes
// that window entirely.
//
// A failure here is logged, not fatal: the app still starts, serves the
// defaults, and self-heals on the next read. Refusing to boot because a config
// row was briefly unreadable would turn a blip into an outage.
guildConfig.load()
  .catch((err) => console.error('guild_config preload failed — serving defaults until it recovers:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  });