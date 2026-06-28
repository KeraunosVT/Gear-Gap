// backend/admin.js — admin-only match ingest. Mounted behind requireAdmin.
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { parseScreenshot, parseCsv, WEAPONS } = require('./ingest');
const { listMembers, postEmbed, postImage } = require('./discord');

const ROLE_EMOJI = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };

// Levenshtein edit distance — used to suggest the closest known player for an
// unmapped (likely OCR-misread) name.
function lev(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}
const norm = (s) => (s || '').trim().toLowerCase();

// Merge parsed rows from one or more screenshots/CSVs into a single reviewed set:
// de-duplicate by player name (fallback rank), sort by rank, and recompute the
// data-quality warnings. Shared by the batch and per-file parse paths.
function mergePlayers(all, fileCount) {
  const warnings = [];
  const seen = new Map();
  let duplicates = 0;
  for (const p of all) {
    const key = p.player_name ? `n:${p.player_name.toLowerCase()}` : `r:${p.rank}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.set(key, p);
  }
  const players = [...seen.values()].sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  if (fileCount > 1) warnings.unshift(`Merged ${fileCount} files into ${players.length} players${duplicates ? `, ${duplicates} duplicate row(s) removed` : ''}.`);
  if (players.length === 0) {
    warnings.push('No player rows were detected — check the files and try again.');
  } else {
    const missingTeam = players.filter((p) => !p.team_color).length;
    if (missingTeam) warnings.push(`${missingTeam} row(s) have no team color set.`);
    const badWeapon = players.filter((p) => !WEAPONS.includes(p.weapon_1) || !WEAPONS.includes(p.weapon_2)).length;
    if (badWeapon) warnings.push(`${badWeapon} row(s) have a class to confirm.`);
  }
  return { players, warnings };
}

// Build a Discord embed from a roster layout.
function rosterEmbed(name, parties) {
  const fields = (parties || [])
    .filter((p) => (p.members || []).length > 0)
    .map((p) => ({
      name: (p.name || 'Party').slice(0, 256),
      value: (p.members.map((m) => `${ROLE_EMOJI[m.role] || '•'} ${m.name}`).join('\n') || '—').slice(0, 1024),
      inline: true,
    }));
  return {
    title: (name || 'Roster').slice(0, 256),
    color: 0xc9973a,
    fields: fields.length ? fields : [{ name: 'Empty', value: 'No members assigned.' }],
    footer: { text: 'House Regard' },
    timestamp: new Date().toISOString(),
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v).replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};
const team = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (s.startsWith('r')) return 'Red';
  if (s.startsWith('y')) return 'Yellow';
  return null;
};

module.exports = function createAdminRouter(supabase, gateway, lootCatalog) {
  const router = express.Router();

  router.get('/whoami', (req, res) => {
    res.json({ admin: true, username: req.user.username });
  });

  // ── Party member pool (Discord members with the member role) ────────────────
  router.get('/members', async (req, res) => {
    try {
      const members = await listMembers();
      if (supabase) {
        const [{ data: roleData }, { data: idData }] = await Promise.all([
          supabase.from('member_roles').select('discord_id, role, pvp_class, pve_class'),
          supabase.from('player_identities').select('display_name, discord_id'),
        ]);
        const roleMap = {};
        const classMap = {};
        (roleData || []).forEach((r) => {
          roleMap[r.discord_id] = r.role;
          classMap[r.discord_id] = { pvp_class: r.pvp_class || '', pve_class: r.pve_class || '' };
        });

        const discordMap = {};
        (idData || []).forEach((it) => {
          if (it.discord_id) discordMap[it.discord_id] = it.display_name;
        });

        members.forEach((m) => {
          m.role = roleMap[m.id] || '';
          m.pvp_class = classMap[m.id]?.pvp_class || '';
          m.pve_class = classMap[m.id]?.pve_class || '';
          if (discordMap[m.id]) m.name = discordMap[m.id];
        });
      }
      res.json({ members });
    } catch (err) {
      console.error('Member list error:', err.response?.data?.message || err.message);
      res.status(502).json({ error: err.response?.data?.message || err.message });
    }
  });

  // ── Persist a member's role (sticks across rosters) ─────────────────────────
  router.put('/member-roles', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { id, role } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Member id required.' });
    const { error } = await supabase.from('member_roles')
      .upsert({ discord_id: String(id), role: role || null, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: 'Failed to save role.' });
    res.json({ ok: true });
  });

  // ── Loot council: awards ────────────────────────────────────────────────────
  router.get('/loot/awards', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const [{ data, error }, { data: idData }] = await Promise.all([
      supabase.from('loot_awards').select('*').order('awarded_at', { ascending: false }),
      supabase.from('player_identities').select('display_name, discord_id'),
    ]);
    if (error) return res.status(500).json({ error: 'Failed to load awards.' });
    const discordNameMap = {};
    (idData || []).forEach((it) => { if (it.discord_id) discordNameMap[it.discord_id] = it.display_name; });
    const awards = (data || []).map((a) => ({
      ...a,
      display_name: discordNameMap[a.discord_id] || a.display_name,
    }));
    res.json({ awards });
  });

  router.post('/loot/awards', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { item_key, discord_id, display_name } = req.body || {};
    if (!item_key || !discord_id) return res.status(400).json({ error: 'Item and player are required.' });
    const validKeys = await lootCatalog.getKeys();
    if (!validKeys.has(item_key)) return res.status(400).json({ error: 'Unknown item.' });
    const id = crypto.randomUUID();
    const { error } = await supabase.from('loot_awards').insert({
      id, item_key, discord_id: String(discord_id),
      display_name: display_name || null,
      awarded_by: req.user.username || req.user.id,
      awarded_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ error: 'Failed to record award.' });
    res.json({ id });
  });

  router.delete('/loot/awards/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('loot_awards').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to revoke award.' });
    res.json({ ok: true });
  });

  // ── Loot catalog management ──────────────────────────────────────────────────
  router.post('/loot/categories', async (req, res) => {
    const { label } = req.body || {};
    if (!label) return res.status(400).json({ error: 'Category label required.' });
    const cat = await lootCatalog.addCategory(label);
    if (!cat) return res.status(409).json({ error: 'Category already exists.' });
    res.json(cat);
  });

  router.put('/loot/categories/:key', async (req, res) => {
    const { label } = req.body || {};
    if (!label) return res.status(400).json({ error: 'Category label required.' });
    if (!(await lootCatalog.renameCategory(req.params.key, label))) return res.status(404).json({ error: 'Category not found.' });
    res.json({ ok: true });
  });

  router.delete('/loot/categories/:key', async (req, res) => {
    if (!(await lootCatalog.deleteCategory(req.params.key))) return res.status(404).json({ error: 'Category not found.' });
    res.json({ ok: true });
  });

  router.post('/loot/items', async (req, res) => {
    const { category, name } = req.body || {};
    if (!category || !name) return res.status(400).json({ error: 'Category and item name required.' });
    const item = await lootCatalog.addItem(category, name);
    if (!item) return res.status(409).json({ error: 'Item already exists or category not found.' });
    res.json(item);
  });

  router.put('/loot/items/:key', async (req, res) => {
    const { name, description, image_url } = req.body || {};
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (image_url !== undefined) updates.image_url = image_url;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    if (!(await lootCatalog.editItem(req.params.key, updates))) return res.status(404).json({ error: 'Item not found.' });
    res.json({ ok: true });
  });

  router.post('/loot/items/:key/image', upload.single('image'), async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No image uploaded.' });
    const ext = f.mimetype === 'image/png' ? 'png' : f.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const path = `loot-icons/${req.params.key}.${ext}`;
    const { error: upErr } = await supabase.storage.from('assets').upload(path, f.buffer, {
      contentType: f.mimetype, upsert: true,
    });
    if (upErr) { console.error('Image upload error:', upErr.message); return res.status(500).json({ error: 'Failed to upload image.' }); }
    const { data: urlData } = supabase.storage.from('assets').getPublicUrl(path);
    const image_url = urlData.publicUrl;
    await lootCatalog.editItem(req.params.key, { image_url });
    res.json({ image_url });
  });

  router.delete('/loot/items/:key', async (req, res) => {
    if (!(await lootCatalog.deleteItem(req.params.key))) return res.status(404).json({ error: 'Item not found.' });
    res.json({ ok: true });
  });

  // ── Questlog.gg bulk import ─────────────────────────────────────────────────
  const runImport = require('./questlogImport');

  router.post('/loot/import-questlog', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const result = await runImport(supabase);
      res.json(result);
    } catch (err) {
      console.error('Questlog import error:', err.message);
      res.status(500).json({ error: 'Import failed: ' + err.message });
    }
  });

  router.get('/loot/questlog-search', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const q = req.query.q || '';
    const cat = req.query.category || '';
    let query = supabase.from('questlog_items').select('*').order('name');
    if (q.trim()) query = query.ilike('name', `%${q.trim()}%`);
    if (cat) query = query.eq('sub_category', cat);
    query = query.limit(50);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Search failed.' });
    res.json({ items: data || [] });
  });

  router.post('/loot/add-from-questlog', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { questlog_id, category } = req.body || {};
    if (!questlog_id || !category) return res.status(400).json({ error: 'Questlog ID and category required.' });

    const { data: ref } = await supabase.from('questlog_items').select('*').eq('id', questlog_id).single();
    if (!ref) return res.status(404).json({ error: 'Item not found in reference data. Run import first.' });

    const itemKey = `${category}__${questlog_id}`;
    const { data: existing } = await supabase.from('loot_items').select('key').eq('questlog_id', questlog_id).single();
    if (existing) return res.status(409).json({ error: 'Item already in catalog.' });

    const { data: maxRow } = await supabase.from('loot_items').select('sort_order').eq('category_key', category)
      .order('sort_order', { ascending: false }).limit(1).single();
    const sort_order = (maxRow?.sort_order ?? -1) + 1;

    const { error } = await supabase.from('loot_items').insert({
      key: itemKey,
      category_key: category,
      name: ref.name,
      sort_order,
      image_url: ref.icon,
      description: ref.description,
      questlog_id: ref.id,
      grade: ref.grade,
      questlog_data: ref.data,
    });
    if (error) return res.status(500).json({ error: 'Failed to add item.' });
    res.json({ key: itemKey, name: ref.name });
  });

  router.put('/loot/link-questlog/:key', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { questlog_id } = req.body || {};
    if (!questlog_id) return res.status(400).json({ error: 'Questlog ID required.' });

    const { data: ref } = await supabase.from('questlog_items').select('*').eq('id', questlog_id).single();
    if (!ref) return res.status(404).json({ error: 'Item not found in reference data.' });

    const { error } = await supabase.from('loot_items').update({
      image_url: ref.icon,
      description: ref.description,
      questlog_id: ref.id,
      grade: ref.grade,
      questlog_data: ref.data,
    }).eq('key', req.params.key);
    if (error) return res.status(500).json({ error: 'Failed to link item.' });
    res.json({ ok: true });
  });

  // ── Player identities / name merging ────────────────────────────────────────
  router.get('/identities', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase.from('player_identities')
      .select('id, display_name, ingame_names, discord_id').order('display_name');
    if (error) return res.status(500).json({ error: 'Failed to load identities.' });
    res.json({ identities: data || [] });
  });

  // In-game names from match data that aren't yet mapped to any identity.
  router.get('/unmapped-names', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const [counts, ids] = await Promise.all([
        supabase.rpc('get_guild_player_counts'),
        supabase.from('player_identities').select('id, display_name, ingame_names'),
      ]);
      if (counts.error) throw counts.error;
      if (ids.error) throw ids.error;
      const identities = ids.data || [];

      const mapped = new Set();
      identities.forEach((it) => {
        if (it.display_name) mapped.add(norm(it.display_name));
        (Array.isArray(it.ingame_names) ? it.ingame_names : []).forEach((n) => mapped.add(norm(n)));
      });

      const unmapped = (counts.data || [])
        .filter((c) => !mapped.has(norm(c.player_name)))
        .map((c) => {
          let best = null;
          identities.forEach((it) => {
            [it.display_name, ...(Array.isArray(it.ingame_names) ? it.ingame_names : [])]
              .filter(Boolean)
              .forEach((cand) => {
                const d = lev(norm(c.player_name), norm(cand));
                if (best === null || d < best.distance) best = { id: it.id, display_name: it.display_name, distance: d };
              });
          });
          const threshold = Math.max(2, Math.floor((c.player_name || '').length * 0.34));
          return { name: c.player_name, matches: c.matches, suggestion: best && best.distance <= threshold ? best : null };
        })
        .sort((a, b) => b.matches - a.matches);

      res.json({ unmapped, identities });
    } catch (err) {
      console.error('Unmapped names error:', err.message);
      res.status(500).json({ error: 'Failed to load unmapped names.' });
    }
  });

  // Attach an in-game name to an existing identity.
  router.post('/identities/:id/aliases', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name required.' });
    const { data: it, error: gErr } = await supabase
      .from('player_identities').select('ingame_names').eq('id', req.params.id).single();
    if (gErr) return res.status(404).json({ error: 'Identity not found.' });
    const arr = Array.isArray(it.ingame_names) ? it.ingame_names : [];
    if (!arr.some((n) => norm(n) === norm(name))) arr.push(name);
    const { error } = await supabase.from('player_identities')
      .update({ ingame_names: arr, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to add alias.' });
    res.json({ ok: true });
  });

  // Remove an in-game name from an identity (un-merge a mistake).
  router.delete('/identities/:id/aliases', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name } = req.body || {};
    const { data: it, error: gErr } = await supabase
      .from('player_identities').select('ingame_names').eq('id', req.params.id).single();
    if (gErr) return res.status(404).json({ error: 'Identity not found.' });
    const arr = (Array.isArray(it.ingame_names) ? it.ingame_names : []).filter((n) => norm(n) !== norm(name));
    const { error } = await supabase.from('player_identities')
      .update({ ingame_names: arr, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to remove alias.' });
    res.json({ ok: true });
  });

  // Link a Discord ID to an identity.
  router.put('/identities/:id/discord', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { discord_id } = req.body || {};
    const { error } = await supabase.from('player_identities')
      .update({ discord_id: discord_id || null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to link Discord account.' });
    res.json({ ok: true });
  });

  // Create a new identity (optionally seeded with a first in-game name).
  router.post('/identities', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { display_name, ingame_names } = req.body || {};
    if (!display_name) return res.status(400).json({ error: 'Display name required.' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const aliases = Array.isArray(ingame_names) ? ingame_names : ingame_names ? [ingame_names] : [];
    const { error } = await supabase.from('player_identities')
      .insert({ id, display_name: String(display_name).slice(0, 120), ingame_names: aliases, created_at: now, updated_at: now });
    if (error) return res.status(500).json({ error: 'Failed to create identity.' });
    res.json({ id });
  });

  // ── Roster CRUD ─────────────────────────────────────────────────────────────
  router.get('/rosters', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase
      .from('rosters').select('id, name, updated_at').order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load rosters.' });
    res.json({ rosters: data || [] });
  });

  router.get('/rosters/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase
      .from('rosters').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: 'Roster not found.' });
    res.json({ roster: data });
  });

  router.post('/rosters', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, layout } = req.body || {};
    if (!name || !layout) return res.status(400).json({ error: 'Name and layout are required.' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const { error } = await supabase.from('rosters')
      .insert({ id, name: String(name).slice(0, 120), layout, created_at: now, updated_at: now });
    if (error) return res.status(500).json({ error: 'Failed to save roster.' });
    res.json({ id });
  });

  router.put('/rosters/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, layout } = req.body || {};
    const { error } = await supabase.from('rosters')
      .update({ name: String(name || '').slice(0, 120), layout, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update roster.' });
    res.json({ ok: true });
  });

  router.delete('/rosters/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('rosters').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete roster.' });
    res.json({ ok: true });
  });

  // ── Post a roster to Discord ────────────────────────────────────────────────
  router.post('/rosters/post', upload.single('image'), async (req, res) => {
    try {
      if (req.file) {
        const name = req.body?.name || 'Roster';
        await postImage(req.file.buffer, 'roster.png', name);
      } else {
        const { name, parties } = req.body || {};
        if (!Array.isArray(parties)) return res.status(400).json({ error: 'Nothing to post.' });
        await postEmbed(rosterEmbed(name, parties));
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('Discord post error:', err.response?.data?.message || err.message);
      res.status(502).json({ error: err.response?.data?.message || err.message });
    }
  });

  // ── Parse a SINGLE upload (per-file, so the UI can show progress + retry) ────
  router.post('/match/parse-one', upload.single('file'), async (req, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      let players = [];
      if (f.mimetype.startsWith('image/')) {
        players = (await parseScreenshot(f.buffer, f.mimetype)).players;
      } else if (f.mimetype === 'text/csv' || /\.csv$/i.test(f.originalname)) {
        players = parseCsv(f.buffer.toString('utf8')).players;
      } else {
        return res.status(415).json({ error: 'Unsupported file type.' });
      }
      res.json({ players: players || [] });
    } catch (err) {
      const msg = err.message || 'Could not read that file.';
      console.error('Parse-one error:', msg);
      const busy = /overload|rate.?limit|429|503|busy|unavailable|timeout|temporar/i.test(msg);
      res.status(busy ? 503 : 502).json({ error: busy ? `The reader is busy — ${msg}` : msg, retryable: busy });
    }
  });

  // ── Merge already-parsed rows into the reviewed set ─────────────────────────
  router.post('/match/merge', (req, res) => {
    const all = Array.isArray(req.body?.players) ? req.body.players : [];
    const fileCount = Number(req.body?.fileCount) || 0;
    res.json(mergePlayers(all, fileCount));
  });

  // ── Parse one or more uploads into merged draft rows (batch; no DB writes) ──
  router.post('/match/parse', upload.array('files', 20), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });

    const results = await Promise.all(files.map(async (f) => {
      try {
        if (f.mimetype.startsWith('image/')) return { players: (await parseScreenshot(f.buffer, f.mimetype)).players };
        if (f.mimetype === 'text/csv' || /\.csv$/i.test(f.originalname)) return { players: parseCsv(f.buffer.toString('utf8')).players };
        return { players: [], error: `${f.originalname}: unsupported type, skipped.` };
      } catch (err) {
        return { players: [], error: `${f.originalname}: ${err.message}` };
      }
    }));

    const fileWarnings = [];
    const all = [];
    for (const r of results) { if (r.error) fileWarnings.push(r.error); all.push(...r.players); }
    const merged = mergePlayers(all, files.length);
    res.json({ players: merged.players, warnings: [...fileWarnings, ...merged.warnings] });
  });

  // ── Commit reviewed rows: create match + insert players ─────────────────────
  router.post('/match/commit', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const { title, match_date, result, players } = req.body || {};
    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'No players to save.' });
    }

    const matchId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    // 1. Create the match row
    const { error: mErr } = await supabase.from('wargame_matches').insert({
      id: matchId,
      title: clean(title) || 'Wargame',
      match_date: clean(match_date),
      result: clean(result),
      created_at: nowIso,
    });
    if (mErr) {
      console.error('Match insert error:', mErr.message);
      return res.status(500).json({ error: 'Failed to create the match.' });
    }

    // 2. Insert the player rows
    const rows = players.map((p) => ({
      id: crypto.randomUUID(),
      match_id: matchId,
      rank: toInt(p.rank),
      weapon_1: clean(p.weapon_1),
      weapon_2: clean(p.weapon_2),
      guild_name: clean(p.guild_name),
      player_name: clean(p.player_name),
      team_color: team(p.team_color),
      kills: toInt(p.kills),
      assists: toInt(p.assists),
      damage_dealt: toInt(p.damage_dealt),
      damage_taken: toInt(p.damage_taken),
      healing: toInt(p.healing),
      created_at: nowIso,
    }));

    const { error: pErr } = await supabase.from('player_match_stats').insert(rows);
    if (pErr) {
      console.error('Players insert error:', pErr.message);
      // No cross-table transaction here, so clean up the orphan match row.
      await supabase.from('wargame_matches').delete().eq('id', matchId);
      return res.status(500).json({ error: 'Failed to save players — match was rolled back.' });
    }

    res.json({ match_id: matchId, inserted: rows.length });
  });

  // ── Load an existing match for editing ───────────────────────────────────────
  router.get('/match/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data: match, error: mErr } = await supabase
      .from('wargame_matches').select('*').eq('id', req.params.id).single();
    if (mErr) return res.status(404).json({ error: 'Match not found.' });
    const { data: players, error: pErr } = await supabase
      .from('player_match_stats').select('*').eq('match_id', req.params.id)
      .order('rank', { ascending: true });
    if (pErr) return res.status(500).json({ error: 'Failed to load players.' });
    res.json({ match, players: players || [] });
  });

  // ── Update an existing match (metadata + replace all player rows) ──────────
  router.put('/match/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const { title, match_date, result, players } = req.body || {};
    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'No players to save.' });
    }

    const matchId = req.params.id;

    const { data: existing, error: chk } = await supabase
      .from('wargame_matches').select('id').eq('id', matchId).single();
    if (chk || !existing) return res.status(404).json({ error: 'Match not found.' });

    const { error: mErr } = await supabase.from('wargame_matches')
      .update({ title: clean(title) || 'Wargame', match_date: clean(match_date), result: clean(result) })
      .eq('id', matchId);
    if (mErr) {
      console.error('Match update error:', mErr.message);
      return res.status(500).json({ error: 'Failed to update match.' });
    }

    const { error: dErr } = await supabase.from('player_match_stats').delete().eq('match_id', matchId);
    if (dErr) {
      console.error('Player delete error:', dErr.message);
      return res.status(500).json({ error: 'Failed to replace players.' });
    }

    const nowIso = new Date().toISOString();
    const rows = players.map((p) => ({
      id: crypto.randomUUID(),
      match_id: matchId,
      rank: toInt(p.rank),
      weapon_1: clean(p.weapon_1),
      weapon_2: clean(p.weapon_2),
      guild_name: clean(p.guild_name),
      player_name: clean(p.player_name),
      team_color: team(p.team_color),
      kills: toInt(p.kills),
      assists: toInt(p.assists),
      damage_dealt: toInt(p.damage_dealt),
      damage_taken: toInt(p.damage_taken),
      healing: toInt(p.healing),
      created_at: nowIso,
    }));

    const { error: pErr } = await supabase.from('player_match_stats').insert(rows);
    if (pErr) {
      console.error('Players re-insert error:', pErr.message);
      return res.status(500).json({ error: 'Failed to save updated players.' });
    }

    res.json({ match_id: matchId, updated: rows.length });
  });

  // ── Delete a match and its player rows ─────────────────────────────────────
  router.delete('/match/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    await supabase.from('player_match_stats').delete().eq('match_id', req.params.id);
    const { error } = await supabase.from('wargame_matches').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete match.' });
    res.json({ ok: true });
  });

  // ── Attendance: voice-channel snapshots ──────────────────────────────────────
  router.get('/voice-channels', (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'Discord gateway not available.' });
    res.json({ channels: gateway.listVoiceChannels() });
  });

  router.get('/voice-channels/:id/members', (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'Discord gateway not available.' });
    res.json({ members: gateway.getVoiceMembers(req.params.id) });
  });

  router.get('/events', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase
      .from('events').select('id, title, event_date, created_at')
      .order('event_date', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load events.' });

    const eventIds = (data || []).map((e) => e.id);
    let countMap = {};
    if (eventIds.length > 0) {
      const { data: att } = await supabase
        .from('event_attendance').select('event_id')
        .in('event_id', eventIds);
      (att || []).forEach((a) => { countMap[a.event_id] = (countMap[a.event_id] || 0) + 1; });
    }

    res.json({ events: (data || []).map((e) => ({ ...e, attendees: countMap[e.id] || 0 })) });
  });

  router.get('/events/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data: event, error: eErr } = await supabase
      .from('events').select('*').eq('id', req.params.id).single();
    if (eErr) return res.status(404).json({ error: 'Event not found.' });
    const { data: attendees, error: aErr } = await supabase
      .from('event_attendance').select('*').eq('event_id', req.params.id)
      .order('display_name');
    if (aErr) return res.status(500).json({ error: 'Failed to load attendees.' });
    res.json({ event, attendees: attendees || [] });
  });

  router.post('/events', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { title, event_date, attendees } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    if (!Array.isArray(attendees) || attendees.length === 0) {
      return res.status(400).json({ error: 'At least one attendee is required.' });
    }

    const eventId = crypto.randomUUID();
    const now = new Date().toISOString();

    const { error: eErr } = await supabase.from('events').insert({
      id: eventId, title: String(title).slice(0, 200),
      event_date: event_date || null, created_at: now,
    });
    if (eErr) { console.error('Event insert error:', eErr.message); return res.status(500).json({ error: 'Failed to create event.' }); }

    const rows = attendees.map((a) => ({
      id: crypto.randomUUID(), event_id: eventId,
      discord_id: String(a.id), display_name: String(a.name || '').slice(0, 120),
      joined_at: now,
    }));
    const { error: aErr } = await supabase.from('event_attendance').insert(rows);
    if (aErr) {
      console.error('Attendance insert error:', aErr.message);
      await supabase.from('events').delete().eq('id', eventId);
      return res.status(500).json({ error: 'Failed to save attendees — event rolled back.' });
    }

    res.json({ id: eventId, attendees: rows.length });
  });

  router.get('/attendance-stats', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const { data: evts, error: eErr } = await supabase.from('events').select('id');
      if (eErr) throw eErr;
      const totalEvents = (evts || []).length;
      if (totalEvents === 0) return res.json({ totalEvents: 0, members: [] });

      const { data: att, error: aErr } = await supabase
        .from('event_attendance').select('discord_id, display_name');
      if (aErr) throw aErr;

      const map = {};
      (att || []).forEach((a) => {
        if (!map[a.discord_id]) map[a.discord_id] = { discord_id: a.discord_id, display_name: a.display_name, attended: 0 };
        map[a.discord_id].attended++;
        if (a.display_name) map[a.discord_id].display_name = a.display_name;
      });

      const members = Object.values(map)
        .map((m) => ({ ...m, rate: Math.round((m.attended / totalEvents) * 100) }))
        .sort((a, b) => b.rate - a.rate || a.display_name.localeCompare(b.display_name));

      res.json({ totalEvents, members });
    } catch (err) {
      console.error('Attendance stats error:', err.message);
      res.status(500).json({ error: 'Failed to compute attendance stats.' });
    }
  });

  router.delete('/events/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    await supabase.from('event_attendance').delete().eq('event_id', req.params.id);
    const { error } = await supabase.from('events').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete event.' });
    res.json({ ok: true });
  });

  // ── Event schedule management ────────────────────────────────────────────────
  router.post('/event-schedule', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, day_of_week, event_time } = req.body || {};
    if (!name || day_of_week === undefined) return res.status(400).json({ error: 'Name and day of week required.' });
    const dow = parseInt(day_of_week, 10);
    if (!Number.isFinite(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'Day must be 0 (Sun) – 6 (Sat).' });
    const id = crypto.randomUUID();
    const row = { id, name: String(name).slice(0, 120), day_of_week: dow };
    if (event_time) row.event_time = String(event_time).slice(0, 5);
    const { error } = await supabase.from('event_schedule').insert(row);
    if (error) return res.status(500).json({ error: 'Failed to create event.' });
    res.json({ id });
  });

  router.put('/event-schedule/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, day_of_week, event_time } = req.body || {};
    const update = {};
    if (name !== undefined) update.name = String(name).slice(0, 120);
    if (day_of_week !== undefined) {
      const dow = parseInt(day_of_week, 10);
      if (!Number.isFinite(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'Day must be 0 (Sun) – 6 (Sat).' });
      update.day_of_week = dow;
    }
    if (event_time !== undefined) update.event_time = event_time ? String(event_time).slice(0, 5) : null;
    const { error } = await supabase.from('event_schedule').update(update).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update event.' });
    res.json({ ok: true });
  });

  router.delete('/event-schedule/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('event_schedule').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete event.' });
    res.json({ ok: true });
  });

  // ── LOA: who's out on a given date/event (for party builder) ────────────────
  router.get('/loa/unavailable', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const eventFilter = req.query.event || null;
    const { data, error } = await supabase.from('loa_entries').select('discord_id, display_name, type, event_date, event_schedule_id, start_date, end_date');
    if (error) return res.status(500).json({ error: 'Failed to load LOAs.' });
    const out = new Map();
    (data || []).forEach((e) => {
      let matches = false;
      if (e.type === 'event' && e.event_date === date) {
        matches = !eventFilter || e.event_schedule_id === eventFilter;
      }
      if (e.type === 'range' && e.start_date <= date && e.end_date >= date) matches = true;
      if (matches) out.set(e.discord_id, { discord_id: e.discord_id, display_name: e.display_name });
    });
    res.json({ date, unavailable: [...out.values()] });
  });

  return router;
};
