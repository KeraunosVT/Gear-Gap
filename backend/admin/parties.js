// backend/admin/parties.js — Saved party rosters, posting them to Discord, and the LOA feed the builder reads.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const crypto = require('crypto');
const guildConfig = require('../guildConfig');
const { postEmbed, postImage } = require('../discord');
const { todayInGuildTz } = require('../loa');
const { upload } = require('./helpers');

const ROLE_EMOJI = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  // A roster is bound to the occasion it was built for (event_date, and
  // optionally one event_schedule_id) so loading it can re-check LOA against
  // that date instead of against today. Both are nullable — rosters saved
  // before the binding existed simply have no occasion to re-check.
  // Returns the columns to write, or null if the date is malformed.
  const rosterOccasion = (body) => {
    const date = body.event_date || null;
    if (date && !DATE_RE.test(date)) return null;
    return { event_date: date, event_schedule_id: body.event_schedule_id || null };
  };

  router.get('/rosters', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase
      .from('rosters').select('id, name, updated_at, event_date, event_schedule_id')
      .order('updated_at', { ascending: false });
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
    const occasion = rosterOccasion(req.body || {});
    if (!occasion) return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format.' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const { error } = await supabase.from('rosters')
      .insert({ id, name: String(name).slice(0, 120), layout, ...occasion, created_at: now, updated_at: now });
    if (error) return res.status(500).json({ error: 'Failed to save roster.' });
    res.json({ id });
  });

  router.put('/rosters/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
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
