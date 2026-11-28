// backend/admin/parties.js — Saved party rosters, the PvP/PvE default rosters, posting them to Discord, and the LOA feed the builder reads.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const crypto = require('crypto');
const guildConfig = require('../guildConfig');
const { postEmbed, postImage } = require('../discord');
const { todayInGuildTz } = require('../loa');
const { upload } = require('./helpers');

const ROLE_EMOJI = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Default rosters ───────────────────────────────────────────────────────────
// One PvP and one PvE default: templates an officer loads into an event as a
// starting point. They are ordinary rows in `rosters` under fixed ids, so the
// former-member cleanup (departedRequests.js) reaches them with no extra code
// and no migration was needed. They have no occasion (all three occasion
// columns null), so attendance's roster auto-match by night never picks one,
// and they are left out of GET /rosters so the saved-roster dropdown and the
// open-the-night's-roster logic never see them.
const DEFAULT_MODES = { pvp: 'PvP default', pve: 'PvE default' };
const defaultIdFor = (mode) => `default-${mode}`;
const DEFAULT_IDS = new Set(Object.keys(DEFAULT_MODES).map(defaultIdFor));
const isDefaultId = (id) => DEFAULT_IDS.has(String(id));

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
    footer: { text: guildConfig.get().house },
    timestamp: new Date().toISOString(),
  };
}

module.exports = function registerParties(router, ctx) {
  const { supabase, loa, signups } = ctx;

  // ── Roster CRUD ─────────────────────────────────────────────────────────────
  // A roster is linked to the occasion it was built for: its night
  // (event_date) and at most one event, weekly (event_schedule_id) or one-off
  // (signup_event_id). Loading it re-checks LOA against that occasion, and the
  // Parties board opens it when that event is picked. All nullable — rosters
  // saved before the link existed simply have no occasion.
  // Returns the columns to write, or null if the date is malformed.
  const rosterOccasion = (body) => {
    const date = body.event_date || null;
    if (date && !DATE_RE.test(date)) return null;
    const signupEventId = body.signup_event_id || null;
    return {
      event_date: date,
      event_schedule_id: signupEventId ? null : body.event_schedule_id || null,
      signup_event_id: signupEventId,
    };
  };

  router.get('/rosters', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase
      .from('rosters').select('id, name, updated_at, event_date, event_schedule_id, signup_event_id')
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load rosters.' });
    res.json({ rosters: (data || []).filter((r) => !isDefaultId(r.id)) });
  });

  // Registered before /rosters/:id, which would otherwise take "defaults" as
  // an id. Both modes always come back; one never saved is null.
  router.get('/rosters/defaults', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase
      .from('rosters').select('id, layout, updated_at').in('id', [...DEFAULT_IDS]);
    if (error) return res.status(500).json({ error: 'Failed to load default rosters.' });
    const defaults = {};
    Object.keys(DEFAULT_MODES).forEach((mode) => {
      const row = (data || []).find((r) => r.id === defaultIdFor(mode));
      defaults[mode] = row ? { layout: row.layout || {}, updated_at: row.updated_at } : null;
    });
    res.json({ defaults });
  });

  router.put('/rosters/defaults/:mode', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { mode } = req.params;
    if (!DEFAULT_MODES[mode]) return res.status(400).json({ error: 'Mode must be pvp or pve.' });
    const layout = req.body?.layout;
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
      return res.status(400).json({ error: 'A layout is required.' });
    }
    const id = defaultIdFor(mode);
    const now = new Date().toISOString();
    // Read first rather than upsert, so created_at stays the first save's.
    const { data: existing, error: readError } = await supabase
      .from('rosters').select('id').eq('id', id).maybeSingle();
    if (readError) return res.status(500).json({ error: 'Failed to save the default roster.' });
    const row = {
      name: DEFAULT_MODES[mode], layout,
      event_date: null, event_schedule_id: null, signup_event_id: null, updated_at: now,
    };
    const { error } = existing
      ? await supabase.from('rosters').update(row).eq('id', id)
      : await supabase.from('rosters').insert({ id, ...row, created_at: now });
    if (error) return res.status(500).json({ error: 'Failed to save the default roster.' });
    res.json({ ok: true, updated_at: now });
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
    const occasion = rosterOccasion(req.body || {});
    if (!occasion) return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format.' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const { error } = await supabase.from('rosters')
      .insert({ id, name: String(name).slice(0, 120), layout, ...occasion, created_at: now, updated_at: now });
    if (error) return res.status(500).json({ error: 'Failed to save roster.' });
    res.json({ id });
  });

  // The defaults are written only through their own route above: through this
  // one a default could be given a night and start opening as that night's
  // roster, or be deleted out from under the Defaults tab.
  const DEFAULT_REFUSAL = 'Default rosters are edited from the Defaults tab.';

  router.put('/rosters/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    if (isDefaultId(req.params.id)) return res.status(400).json({ error: DEFAULT_REFUSAL });
    const { name, layout } = req.body || {};
    const occasion = rosterOccasion(req.body || {});
    if (!occasion) return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format.' });
    const { error } = await supabase.from('rosters')
      .update({ name: String(name || '').slice(0, 120), layout, ...occasion, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update roster.' });
    res.json({ ok: true });
  });

  router.delete('/rosters/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    if (isDefaultId(req.params.id)) return res.status(400).json({ error: DEFAULT_REFUSAL });
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

  // ── LOA: who's out on a given date/event (for the party builder) ────────────
  // The window and reason come back too, not just the fact of the absence — the
  // builder needs them to tell "gone all night" from "out 7-8, back after",
  // which are different planning problems. Safe to include reason because the
  // whole /api/admin router is admin-gated, the same condition under which
  // loa.all() exposes it.
  router.get('/loa/unavailable', async (req, res) => {
    if (!loa) return res.status(503).json({ error: 'Database not configured.' });
    const date = req.query.date || todayInGuildTz();
    try {
      // ?signup=<id>: a one-off event, checked against its own night and time.
      if (req.query.signup && signups) {
        const ev = await signups.get(req.query.signup);
        const unavailable = await loa.unavailableOn({
          date: ev.event_date,
          eventScheduleId: ev.event_schedule_id || null,
          eventTime: ev.event_time || null,
          oneOff: !ev.event_schedule_id,
          signupEventId: ev.id,
        });
        return res.json({ date: ev.event_date, unavailable });
      }
      const unavailable = await loa.unavailableOn({ date, eventScheduleId: req.query.event || null });
      res.json({ date, unavailable });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to load LOAs.' });
    }
  });
};
