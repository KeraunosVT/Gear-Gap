// backend/admin/lootItems.js — Loot catalog management and the Questlog.gg import/link family.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const { upload } = require('./helpers');

module.exports = function registerLootItems(router, ctx) {
  const { supabase, lootCatalog } = ctx;

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
  const runImport = require('../questlogImport');

  let importStatus = { running: false, result: null, error: null };

  router.post('/loot/import-questlog', (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    if (importStatus.running) return res.status(409).json({ error: 'Import already running.' });
    importStatus = { running: true, result: null, error: null };
    res.json({ ok: true, message: 'Import started.' });
    runImport(supabase)
      .then((result) => { importStatus = { running: false, result, error: null }; })
      .catch((err) => {
        console.error('Questlog import error:', err.stack || err.message);
        importStatus = { running: false, result: null, error: err.message };
      });
  });

  router.get('/loot/import-status', (req, res) => {
    res.json(importStatus);
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
    // Tag each result with the catalog item already linked to it, if any. Names
    // aren't unique across item types (Divine Retribution is both a ring and a
    // skill core), so Auto-link needs this to skip the one that's taken.
    const ids = (data || []).map((r) => r.id);
    const linkedKey = {};
    if (ids.length) {
      const { data: linked } = await supabase.from('loot_items').select('key, questlog_id').in('questlog_id', ids);
      (linked || []).forEach((l) => { linkedKey[l.questlog_id] = l.key; });
    }
    res.json({ items: (data || []).map((r) => ({ ...r, linked_key: linkedKey[r.id] || null })) });
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

    // Same guard add-from-questlog has: one questlog item backs at most one
    // catalog entry. Without it the update below fails on the DB side and the
    // admin only sees a bare 500.
    const { data: taken } = await supabase.from('loot_items').select('key, name')
      .eq('questlog_id', ref.id).neq('key', req.params.key).limit(1).maybeSingle();
    if (taken) return res.status(409).json({ error: `"${ref.name}" is already linked to catalog item "${taken.name}" (${taken.key}).` });

    const { error } = await supabase.from('loot_items').update({
      image_url: ref.icon,
      description: ref.description,
      questlog_id: ref.id,
      grade: ref.grade,
      questlog_data: ref.data,
    }).eq('key', req.params.key);
    if (error) {
      console.error('Questlog link error:', req.params.key, error.message);
      return res.status(500).json({ error: `Failed to link item: ${error.message}` });
    }
    res.json({ ok: true });
  });

  router.put('/loot/unlink-questlog/:key', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('loot_items').update({
      image_url: null, description: null, questlog_id: null, grade: null, questlog_data: null,
    }).eq('key', req.params.key);
    if (error) return res.status(500).json({ error: 'Failed to unlink item.' });
    res.json({ ok: true });
  });
};
