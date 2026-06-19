// backend/server.js
const path = require('path');
// Load environment variables from backend/.env for local development.
// On hosts that inject env vars (Render, Railway, etc.) the .env is simply absent
// and this is a no-op; existing process.env values are never overwritten.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { router: authRouter, requireAuth, requireAdmin } = require('./auth');
const { listMembers } = require('./discord');
const SHARDS = require('../shared/shards.json');
const createLootCatalog = require('./lootCatalog');

const gateway = require('./discordGateway');
gateway.start();

const app = express();

app.use(cors({ origin: true, credentials: true }));
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

// ── GUILD ALIASES ────────────────────────────────────────────────────────────
// Our guild has changed names over time. Collapse all past names to the current
// one ("FTP") so stats aren't split across what looks like four separate guilds.
// Any name NOT in this map is treated as an enemy guild and kept as-is.
const MY_GUILD = 'FTP';
const GUILD_ALIASES = {
  'FTP': MY_GUILD,
  'PUSH': MY_GUILD,
  'House Regard': MY_GUILD,
  'Best Regards': MY_GUILD,
};
const canonicalGuild = (name) => GUILD_ALIASES[(name || '').trim()] || (name || '').trim() || 'Unknown';

// Health check (public)
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Discord login routes (public)
app.use('/api/auth', authRouter);

// Everything else under /api requires a valid guild-member session.
// Full login wall: stats, matches, and match detail are all gated.
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/auth')) return next();
  return requireAuth(req, res, next);
});

// ── ADMIN AREA (requires admin role) ─────────────────────────────────────────
const createAdminRouter = require('./admin');
app.use('/api/admin', requireAdmin, createAdminRouter(supabase, gateway, lootCatalog));

// ── MEMBERS AREA: Archboss shard tracker ─────────────────────────────────────
// Any logged-in member sees the full tally. Editing a row is restricted to its
// owner (matched by Discord id) or an admin — enforced here, not just in the UI.
app.get('/api/members', async (req, res) => {
  try {
    const members = await listMembers();
    const counts = {};
    if (supabase) {
      const { data } = await supabase.from('shard_counts').select('discord_id, shards');
      (data || []).forEach((r) => { counts[r.discord_id] = r.shards || {}; });
    }
    res.json({ members: members.map((m) => ({ ...m, shards: counts[m.id] || {} })) });
  } catch (err) {
    console.error('Members list error:', err.response?.data?.message || err.message);
    res.status(502).json({ error: err.response?.data?.message || err.message });
  }
});

app.put('/api/shards/:discordId', async (req, res) => {
  const target = req.params.discordId;
  if (req.user.id !== target && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You can only edit your own shards.' });
  }
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  const incoming = req.body?.shards || {};
  const shards = {};
  SHARDS.types.forEach((t) => {
    const v = parseInt(incoming[t.key], 10);
    shards[t.key] = Math.max(0, Math.min(SHARDS.max, Number.isFinite(v) ? v : 0));
  });
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
    const { data, error } = await supabase.from('loot_wishlists').select('discord_id, display_name, picks');
    if (error) throw error;
    const counts = {};
    const tally = {};
    let mine = {};
    (data || []).forEach((r) => {
      const picks = r.picks || {};
      if (r.discord_id === req.user.id) mine = picks;
      Object.entries(picks).forEach(([k, prio]) => {
        if (!validKeys.has(k)) return;
        counts[k] = (counts[k] || 0) + 1;
        if (req.user.isAdmin) (tally[k] = tally[k] || []).push({ name: r.display_name || 'Member', priority: prio, discord_id: r.discord_id });
      });
    });
    // Items already awarded to the current member (shown as "Loot Counciled").
    const { data: myAwards } = await supabase.from('loot_awards').select('item_key').eq('discord_id', req.user.id);
    const awarded = (myAwards || []).map((a) => a.item_key);
    res.json({ mine, counts, awarded, tally: req.user.isAdmin ? tally : undefined });
  } catch (err) {
    console.error('Loot load error:', err.message);
    res.status(500).json({ error: 'Failed to load loot wishlist.' });
  }
});

app.put('/api/loot/:discordId', async (req, res) => {
  const target = req.params.discordId;
  if (req.user.id !== target && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You can only edit your own wishlist.' });
  }
  if (!supabase || !lootCatalog) return res.status(503).json({ error: 'Database not configured.' });
  const validKeys = await lootCatalog.getKeys();
  const incoming = req.body?.picks || {};
  const picks = {};
  Object.entries(incoming).forEach(([k, prio]) => {
    if (validKeys.has(k) && lootCatalog.priorities.has(prio)) picks[k] = prio;
  });
  const display_name = (req.body?.display_name || req.user.username || '').slice(0, 120);
  const { error } = await supabase.from('loot_wishlists')
    .upsert({ discord_id: target, display_name, picks, updated_at: new Date().toISOString() });
  if (error) { console.error('Loot save error:', error.message); return res.status(500).json({ error: 'Failed to save wishlist.' }); }
  res.json({ picks });
});

// ── ALL-TIME PLAYER STATS (our guild only) ───────────────────────────────────
app.get('/api/players', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const { data, error } = await supabase.rpc('get_player_stats');
    if (error) throw error;
    res.json({ players: data || [] });
  } catch (err) {
    console.error('Player stats error:', err.message);
    res.status(500).json({ error: 'Failed to load player stats.' });
  }
});

// ── PLAYER PROFILE ──────────────────────────────────────────────────────────
app.get('/api/player/:name', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
  try {
    const requestedName = decodeURIComponent(req.params.name).trim();
    const lower = requestedName.toLowerCase();

    // Resolve all in-game names this player might appear as via identities.
    const { data: ids } = await supabase.from('player_identities')
      .select('display_name, ingame_names');
    let names = [requestedName];
    let displayName = requestedName;
    (ids || []).forEach((it) => {
      const all = [it.display_name, ...(Array.isArray(it.ingame_names) ? it.ingame_names : [])].filter(Boolean);
      if (all.some((n) => n.toLowerCase() === lower)) {
        displayName = it.display_name || requestedName;
        names = all;
      }
    });

    // Pull every match row for those names (our guild only).
    const guildNames = Object.keys(GUILD_ALIASES);
    const { data: rows, error: rErr } = await supabase
      .from('player_match_stats')
      .select('*, wargame_matches!inner(id, title, match_date)')
      .in('player_name', names)
      .in('guild_name', guildNames);
    if (rErr) throw rErr;
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Player not found.' });

    // Aggregate totals.
    let kills = 0, assists = 0, damage_dealt = 0, damage_taken = 0, healing = 0;
    const classCount = {};
    const matches = [];

    rows.forEach((r) => {
      kills += Number(r.kills) || 0;
      assists += Number(r.assists) || 0;
      damage_dealt += Number(r.damage_dealt) || 0;
      damage_taken += Number(r.damage_taken) || 0;
      healing += Number(r.healing) || 0;

      const cls = getClassNameBackend(r.weapon_1, r.weapon_2);
      classCount[cls] = (classCount[cls] || 0) + 1;

      matches.push({
        match_id: r.wargame_matches.id,
        title: r.wargame_matches.title,
        match_date: r.wargame_matches.match_date,
        rank: r.rank,
        weapon_1: r.weapon_1,
        weapon_2: r.weapon_2,
        kills: Number(r.kills) || 0,
        assists: Number(r.assists) || 0,
        damage_dealt: Number(r.damage_dealt) || 0,
        damage_taken: Number(r.damage_taken) || 0,
        healing: Number(r.healing) || 0,
      });
    });

    matches.sort((a, b) => new Date(b.match_date || 0) - new Date(a.match_date || 0));

    const total = matches.length;
    const classBreakdown = Object.entries(classCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    res.json({
      name: displayName,
      aliases: names.length > 1 ? names.filter((n) => n.toLowerCase() !== displayName.toLowerCase()) : [],
      matches: total,
      kills, assists, damage_dealt, damage_taken, healing,
      avg_kills: total ? kills / total : 0,
      avg_assists: total ? assists / total : 0,
      avg_damage: total ? damage_dealt / total : 0,
      avg_healing: total ? healing / total : 0,
      classBreakdown,
      matchHistory: matches,
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
    // Called with no argument; the SQL function already scopes to our guild's names.
    const { data: aggData, error: aggError } = await supabase
      .rpc('get_stats_summary');

    if (aggError) throw aggError;

    const totalKills   = Number(aggData[0]?.total_kills)   || 0;
    const totalDamage  = Number(aggData[0]?.total_damage)  || 0;
    const totalHealing = Number(aggData[0]?.total_healing) || 0;

    res.json({
      totalMatches:  totalMatches || 0,
      totalKills:    totalKills.toLocaleString(),
      totalDamage:   (totalDamage  / 1_000_000).toFixed(1) + "M",
      totalHealing:  (totalHealing / 1_000_000).toFixed(1) + "M"
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
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 6, 1), 50);

    const { data: matches, error } = await supabase
      .from('wargame_matches')
      .select('*')
      .order('match_date', { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!matches || matches.length === 0) return res.json([]);

    // Single query for every player row across all matches (no N+1)
    const matchIds = matches.map(m => m.id);
    const { data: allPlayers, error: pError } = await supabase
      .from('player_match_stats')
      .select('match_id, guild_name, kills, damage_dealt, healing')
      .in('match_id', matchIds);

    if (pError) throw pError;

    // Group player rows by match_id in memory
    const playersByMatch = {};
    (allPlayers || []).forEach(p => {
      (playersByMatch[p.match_id] ||= []).push(p);
    });

    const enriched = matches.map(match => {
      const players = playersByMatch[match.id] || [];
      const guildStats = {};

      players.forEach(p => {
        const g = canonicalGuild(p.guild_name);
        if (!guildStats[g]) guildStats[g] = { kills: 0, damage: 0, healing: 0 };
        guildStats[g].kills += Number(p.kills) || 0;
        guildStats[g].damage += Number(p.damage_dealt) || 0;
        guildStats[g].healing += Number(p.healing) || 0;
      });

      // Our guild vs. everyone else (handles matches with 2+ enemy guilds)
      const myKills = guildStats[MY_GUILD]?.kills || 0;
      const enemyKills = Object.entries(guildStats)
        .filter(([g]) => g !== MY_GUILD)
        .reduce((sum, [, s]) => sum + s.kills, 0);

      const killDifference = Math.abs(myKills - enemyKills);
      const winningGuild = myKills >= enemyKills ? MY_GUILD : 'Enemy';

      return {
        ...match,
        kills: Object.values(guildStats).reduce((sum, g) => sum + g.kills, 0),
        damage: Object.values(guildStats).reduce((sum, g) => sum + g.damage, 0),
        healing: Object.values(guildStats).reduce((sum, g) => sum + g.healing, 0),
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
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});