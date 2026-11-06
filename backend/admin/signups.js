// backend/admin/signups.js — Event signups, officer side.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const { listMembers } = require('../discord');
const { todayInGuildTz } = require('../loa');

module.exports = function registerSignups(router, ctx) {
  const { gateway, signups } = ctx;

  // ── Event signups ────────────────────────────────────────────────────────────
  // Officer side: open a signup for a night, cap it, close it, and add or remove
  // people by hand. Members join through /api/signups or the Discord buttons.
  router.get('/signups', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      res.json({ signups: await signups.list({ includeClosed: true, from: req.query.from || null }) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // A night's one-off events, for the Attendance page's event picker. The same
  // feed as /signups/by-occasion/one-offs, but under plain /signups so it takes
  // 'attendance' — that one is the party builder's and takes 'parties'.
  // Registered above /signups/:id so 'one-offs' can't be read as an id.
  router.get('/signups/one-offs', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      res.json({ events: await signups.oneOffsOn(req.query.date || todayInGuildTz()) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // The party builder's feed. Note this path takes the 'parties' capability
  // rather than 'attendance' (see permissions.js) — a parties officer has to be
  // able to read it to seed a roster.
  // A night's one-off events, for the party builder's picker. Under
  // /signups/by-occasion so it takes 'parties', like the route below.
  router.get('/signups/by-occasion/one-offs', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      res.json({ events: await signups.oneOffsOn(req.query.date || todayInGuildTz()) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ?signup=<id> picks a one-off directly — a night can have several, and
  // (date, no schedule id) would only ever find the first.
  router.get('/signups/by-occasion', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      if (req.query.signup) return res.json(await signups.signedUpForId(req.query.signup));
      res.json(await signups.signedUpFor({
        eventDate: req.query.date || todayInGuildTz(),
        eventScheduleId: req.query.event || null,
      }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.get('/signups/:id', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      // The roster is what turns "nobody else responded" into a named list, so
      // it's fetched here rather than inside the module. Best-effort: Discord
      // being down shouldn't cost the officer the signup list itself.
      const roster = await listMembers().catch(() => null);
      res.json(await signups.detail(req.params.id, { includeReasons: true, roster }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/signups', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    const { event_date, event_schedule_id, title, event_time, category, capacity, reminder_minutes, announce } = req.body || {};
    try {
      const { row, created } = await signups.open({
        eventDate: event_date || todayInGuildTz(),
        eventScheduleId: event_schedule_id || null,
        title, eventTime: event_time || null, category, capacity, reminderMinutes: reminder_minutes,
        createdBy: req.user?.id || null,
      });
      res.json({ signup: row, created });
      // Posted after responding and never awaited — the signup is already open,
      // and a Discord outage shouldn't make opening it look like it failed.
      // Re-announcing an existing one is the officer's explicit call, below.
      if (created && announce !== false) gateway.announceSignup(row.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.patch('/signups/:id', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    const {
      capacity, status, reminder_minutes, title, event_date, event_time, category, opponent_guild, war_maps, war_rules,
    } = req.body || {};
    try {
      let promoted = [];
      // First, so a refused edit (a weekly night, a bad time) changes nothing.
      if ([title, event_date, event_time, category].some((v) => v !== undefined)) {
        await signups.setDetails(req.params.id, {
          title, eventDate: event_date, eventTime: event_time, category,
        });
      }
      if (capacity !== undefined) promoted = await signups.setCapacity(req.params.id, capacity);
      if (reminder_minutes !== undefined) await signups.setReminderMinutes(req.params.id, reminder_minutes);
      // Unlike title/time, allowed on a weekly night too: the event is the
      // same every week, the guild on the other side isn't.
      if (opponent_guild !== undefined) await signups.setOpponent(req.params.id, opponent_guild);
      // Same reasoning: each War Games night has its own maps and rules.
      if (war_maps !== undefined || war_rules !== undefined) {
        await signups.setWarDetails(req.params.id, { maps: war_maps, rules: war_rules });
      }
      if (status !== undefined) await signups.setStatus(req.params.id, status);
      res.json({ ok: true, promoted });
      gateway.refreshSignupMessage(req.params.id);
      // Raising the cap can move several people at once; each gets told.
      promoted.forEach((m) => gateway.notifySignupPromotion(m, req.params.id));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.delete('/signups/:id', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const row = await signups.remove(req.params.id);
      res.json({ ok: true });
      gateway.deleteSignupMessage(row);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // (Re)post the announcement. The recovery path for a message someone deleted
  // by hand — without it the signup would still be live with nowhere to click.
  router.post('/signups/:id/announce', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      await signups.get(req.params.id);
      res.json({ ok: true });
      gateway.announceSignup(req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/signups/:id/remind', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      await signups.get(req.params.id);
      res.json({ ok: true });
      // Goes through the same claim as the timed sweep, so firing this while a
      // scheduled reminder is going out can't double-DM anyone.
      gateway.sendSignupReminder(req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Sign someone up on their behalf — the resolveTarget pattern, website side.
  router.post('/signups/:id/entries', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    const { discord_id, display_name } = req.body || {};
    if (!discord_id) return res.status(400).json({ error: 'Member id required.' });
    try {
      const result = await signups.join({
        id: req.params.id, discordId: discord_id, displayName: display_name,
        addedBy: req.user?.id || null,
      });
      res.json(result);
      gateway.refreshSignupMessage(req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Remove someone — the answer to a member who left the guild still holding a
  // slot, which nothing else can free.
  router.delete('/signups/:id/entries/:discordId', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const result = await signups.withdraw({ id: req.params.id, discordId: req.params.discordId });
      res.json(result);
      gateway.refreshSignupMessage(req.params.id);
      if (result.promoted) gateway.notifySignupPromotion(result.promoted, req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
};
