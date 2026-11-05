// backend/admin/schedule.js — The recurring event schedule, day posts, DST shifts, and skips.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const crypto = require('crypto');
const guildConfig = require('../guildConfig');
const { postToChannel } = require('../discord');
const { buildDayPost } = require('../dayPost');
const createLoa = require('../loa');
const createEventSignups = require('../eventSignups');

module.exports = function registerSchedule(router, ctx) {
  const { supabase, gateway } = ctx;

  // ── Event schedule management ────────────────────────────────────────────────
  // Weekly or every other week (migration 10). `dow` and `time` are what the
  // row will hold after the write, because the first night has to fall on the
  // event's own night — after-midnight rule included, so a 12:30am Sunday row
  // takes a Saturday. Returns the columns to write, or { error }.
  const cadenceFields = (intervalWeeks, anchorDate, dow, time) => {
    const every = parseInt(intervalWeeks, 10);
    if (every !== 1 && every !== 2) return { error: 'Repeat must be every week or every other week.' };
    if (every === 1) return { cols: { interval_weeks: 1, anchor_date: null } };
    const anchor = String(anchorDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return { error: 'Pick the first night it runs.' };
    if (createLoa.guildDayOfWeek(dow, time) !== new Date(`${anchor}T12:00:00`).getDay()) {
      return { error: "The first night isn't on the event's night of the week." };
    }
    return { cols: { interval_weeks: 2, anchor_date: anchor } };
  };

  router.post('/event-schedule', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, day_of_week, event_time, category, interval_weeks, anchor_date } = req.body || {};
    if (!name || day_of_week === undefined) return res.status(400).json({ error: 'Name and day of week required.' });
    const dow = parseInt(day_of_week, 10);
    if (!Number.isFinite(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'Day must be 0 (Sun) – 6 (Sat).' });
    const id = crypto.randomUUID();
    const row = { id, name: String(name).slice(0, 120), day_of_week: dow };
    if (event_time) row.event_time = String(event_time).slice(0, 5);
    // Only sent when picked, so a database without 036 can still add events
    // the old way.
    if (createEventSignups.categoryKey(category)) row.category = createEventSignups.categoryKey(category);
    // Same for every other week and migration 10: a weekly row writes neither.
    if (interval_weeks !== undefined && parseInt(interval_weeks, 10) !== 1) {
      const cadence = cadenceFields(interval_weeks, anchor_date, dow, row.event_time || null);
      if (cadence.error) return res.status(400).json({ error: cadence.error });
      Object.assign(row, cadence.cols);
    }
    const { error } = await supabase.from('event_schedule').insert(row);
    if (error) return res.status(500).json({ error: 'Failed to create event.' });
    res.json({ id });
  });

  router.put('/event-schedule/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, day_of_week, event_time, category, interval_weeks, anchor_date } = req.body || {};
    const update = {};
    if (category !== undefined) update.category = createEventSignups.categoryKey(category);
    if (name !== undefined) update.name = String(name).slice(0, 120);
    if (day_of_week !== undefined) {
      const dow = parseInt(day_of_week, 10);
      if (!Number.isFinite(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'Day must be 0 (Sun) – 6 (Sat).' });
      update.day_of_week = dow;
    }
    if (event_time !== undefined) update.event_time = event_time ? String(event_time).slice(0, 5) : null;
    // Moving an every-other-week event's day or time can take it off its first
    // night, so the check runs against the row as it will be, not just the
    // fields sent.
    const touchesNight = day_of_week !== undefined || event_time !== undefined;
    if (interval_weeks !== undefined || touchesNight) {
      const { data: cur, error: readErr } = await supabase.from('event_schedule')
        .select('*').eq('id', req.params.id).single();
      if (readErr || !cur) return res.status(404).json({ error: 'That scheduled event no longer exists.' });
      const every = interval_weeks !== undefined ? interval_weeks : cur.interval_weeks || 1;
      if (interval_weeks !== undefined || parseInt(every, 10) !== 1) {
        const cadence = cadenceFields(
          every,
          anchor_date !== undefined ? anchor_date : cur.anchor_date,
          update.day_of_week ?? cur.day_of_week,
          event_time !== undefined ? update.event_time : cur.event_time,
        );
        if (cadence.error) return res.status(400).json({ error: cadence.error });
        // A weekly row on a database without migration 10 has nothing to write.
        const hasColumn = 'interval_weeks' in cur;
        if ((interval_weeks !== undefined || anchor_date !== undefined) && (hasColumn || cadence.cols.interval_weeks !== 1)) {
          Object.assign(update, cadence.cols);
        }
      }
    }
    const { error } = await supabase.from('event_schedule').update(update).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update event.' });
    res.json({ ok: true });
  });

  // ── Post a night's events to Discord ─────────────────────────────────────────
  // Under /event-schedule so it takes the 'schedule' capability. The channel
  // defaults to the Event Calendar channel in Guild Settings; the form can
  // override it for one post.
  router.get('/event-schedule/post-channels', (req, res) => {
    res.json({ channels: gateway.listTextChannels(), default_channel_id: guildConfig.calendarChannelId() });
  });

  router.post('/event-schedule/post-day', async (req, res) => {
    const { date, events, channel_id, note } = req.body || {};
    try {
      const channelId = channel_id || guildConfig.calendarChannelId();
      if (!channelId) return res.status(400).json({ error: 'Pick a channel to post to.' });
      const payload = buildDayPost({ date, events, note, house: guildConfig.get().house });
      await postToChannel(channelId, payload);
      res.json({ ok: true });
    } catch (err) {
      const discordMsg = err.response?.data?.message;
      res.status(err.status || (discordMsg ? 502 : 500)).json({
        error: discordMsg ? `Discord refused the post: ${discordMsg}` : err.message || 'Failed to post.',
      });
    }
  });

  // The calendar's daylight-saving toggle: moves every weekly event, and the
  // signups already opened for nights still to come, an hour earlier (off) or
  // later (on). All of it happens in set_schedule_dst (migration 035), in one
  // transaction; this only re-renders the Discord posts whose times moved.
  router.post('/event-schedule/dst', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { active } = req.body || {};
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'Say whether daylight saving is on or off.' });
    const { data, error } = await supabase.rpc('set_schedule_dst', { p_active: active });
    if (error) {
      console.error('set_schedule_dst error:', error.message);
      return res.status(500).json({ error: 'Failed to shift the schedule.' });
    }
    guildConfig.invalidate();
    const ids = Array.isArray(data?.signup_ids) ? data.signup_ids : [];
    ids.forEach((id) => gateway.refreshSignupMessage(id));
    res.json({ ok: true, dst_active: active, changed: Boolean(data?.changed), signups_moved: ids.length });
  });

  // Turn a one-off into a weekly event on the same night and time. The work is
  // in make_signup_weekly (migration 037); this only works out the stored day,
  // which is the next calendar day for an after-midnight event — the same rule
  // the calendar's New Event form applies.
  router.post('/event-schedule/from-signup/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data: ev, error: readErr } = await supabase.from('signup_events')
      .select('id, event_date, event_time, event_schedule_id').eq('id', req.params.id).maybeSingle();
    if (readErr || !ev) return res.status(404).json({ error: 'That event no longer exists.' });
    if (ev.event_schedule_id) return res.status(409).json({ error: 'That event is already weekly.' });
    const night = new Date(`${ev.event_date}T12:00:00`).getDay();
    const dow = createLoa.isAfterMidnight(ev.event_time) ? (night + 1) % 7 : night;
    const { data, error } = await supabase.rpc('make_signup_weekly', { p_signup_id: ev.id, p_day_of_week: dow });
    if (error) {
      if (error.message.includes('signup_already_weekly')) return res.status(409).json({ error: 'That event is already weekly.' });
      if (error.message.includes('signup_not_found')) return res.status(404).json({ error: 'That event no longer exists.' });
      console.error('make_signup_weekly error:', error.message);
      return res.status(500).json({ error: 'Failed to make that event weekly.' });
    }
    res.json({ id: data, day_of_week: dow });
  });

  // Cancel (skip: true) or restore (skip: false) one night of a weekly event
  // without touching the rest of the series. `date` is the guild night.
  //
  // A cancelled night stays on the calendar, marked cancelled. Signups already
  // opened for it are marked cancelled too rather than deleted, so whoever
  // signed up sees the Discord post say so instead of watching it vanish — and
  // restoring the night reopens them, entries intact.
  router.post('/event-schedule/:id/skip', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { date, skip = true } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format.' });
    const { data: ev, error: readErr } = await supabase.from('event_schedule')
      .select('id, name, skip_dates').eq('id', req.params.id).single();
    if (readErr || !ev) return res.status(404).json({ error: 'That scheduled event no longer exists.' });
    const current = Array.isArray(ev.skip_dates) ? ev.skip_dates.map(String) : [];
    const next = skip
      ? [...new Set([...current, date])].sort()
      : current.filter((d) => d !== date);
    const { error } = await supabase.from('event_schedule').update({ skip_dates: next }).eq('id', ev.id);
    if (error) return res.status(500).json({ error: 'Failed to update event.' });

    // Only 'open' <-> 'cancelled': a signup the sweep already closed stays
    // closed either way.
    const { data: opened, error: occErr } = await supabase.from('signup_events')
      .update({ status: skip ? 'cancelled' : 'open', updated_at: new Date().toISOString() })
      .eq('event_schedule_id', ev.id).eq('event_date', date).eq('status', skip ? 'open' : 'cancelled')
      .select('id');
    if (occErr) console.error('skip: signup status update failed:', occErr.message);
    res.json({ ok: true, skip_dates: next });
    (opened || []).forEach((o) => gateway?.refreshSignupMessage?.(o.id));
  });

  router.delete('/event-schedule/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('event_schedule').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete event.' });
    res.json({ ok: true });
  });
};
