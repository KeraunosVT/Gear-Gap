// backend/admin/attendance.js — Attendance: voice snapshots, logged nights, late requests, TLGM history, and rates.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const crypto = require('crypto');
const guildConfig = require('../guildConfig');
const { listMembers } = require('../discord');
const { fetchAll } = require('../pagedRead');
const { parseTlgm } = require('../attendanceHistory');
const { countsFor } = require('../memberTenure');
const { eligibleCount, upload } = require('./helpers');

module.exports = function registerAttendance(router, ctx) {
  const { supabase, gateway, identities, attendance, loa, lateAttendance, attendanceHistory, tenure, loadTenure, eventDetail, attendanceWindow } = ctx;

  // ── Attendance: voice-channel snapshots ──────────────────────────────────────
  // `configured_id` rides along so the Attendance page can name the guild's
  // default channel without calling GET /settings — which 403s for an officer
  // who holds 'attendance' but not 'settings', and that is most of them.
  router.get('/voice-channels', (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'Discord gateway not available.' });
    res.json({
      channels: gateway.listVoiceChannels(),
      configured_id: guildConfig.get().attendance_voice_channel_id || null,
    });
  });

  router.get('/voice-channels/:id/members', async (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'Discord gateway not available.' });
    const members = gateway.getVoiceMembers(req.params.id);
    // Prefer the guild's mapped display name (player_identities) over whatever
    // nickname/username Discord happens to show, same as /api/admin/members.
    if (supabase && members.length > 0) {
      const ids = await identities.load();
      members.forEach((m) => { m.name = ids.displayNameFor(m.id, m.name); });
    }
    res.json({ members });
  });

  router.get('/events', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { days, since } = attendanceWindow(req);

    let q = supabase.from('events').select('id, title, event_date, created_at')
      .order('event_date', { ascending: false });
    if (since) q = q.gte('event_date', since);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Failed to load events.' });

    const eventIds = (data || []).map((e) => e.id);
    const countMap = {};
    const withParty = new Set();
    if (eventIds.length > 0) {
      // Two queries rather than selecting party_layout in the list: the layout
      // is a whole roster of jsonb per row, and the list only needs to know
      // whether there is one. An id-only query costs nothing; shipping thirty
      // party layouts to render thirty badges is not free.
      // Paged: one read stops at the project's max-rows, and since rows come
      // back oldest first, the nights that lose their count are the newest.
      let att, parties;
      try {
        [att, { data: parties }] = await Promise.all([
          fetchAll(
            () => supabase.from('event_attendance').select('event_id').in('event_id', eventIds).order('id'),
            { label: 'event_attendance' },
          ),
          supabase.from('events').select('id').in('id', eventIds).not('party_layout', 'is', null),
        ]);
      } catch (err) {
        console.error('Event list attendance load failed:', err.message);
        return res.status(500).json({ error: 'Failed to load events.' });
      }
      (att || []).forEach((a) => { countMap[a.event_id] = (countMap[a.event_id] || 0) + 1; });
      (parties || []).forEach((p) => withParty.add(String(p.id)));
    }

    res.json({
      window: days,
      events: (data || []).map((e) => ({
        ...e,
        attendees: countMap[e.id] || 0,
        has_party: withParty.has(String(e.id)),
      })),
    });
  });

  // The whole night, assembled by eventDetail — the same call the member-facing
  // GET /api/attendance/events/:id makes, with `officer: true` widening what
  // comes back rather than changing what is computed.
  //
  // This used to be ~120 lines of inline reconciliation right here, joining the
  // attendance snapshot against LOA and signups by hand. It grew a fourth
  // source (late requests) and a second consumer (the member page) at the same
  // time, and two hand-written copies of a four-way join do not stay in
  // agreement.
  router.get('/events/:id', async (req, res) => {
    if (!eventDetail) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const out = await eventDetail.detail(req.params.id, { viewerId: req.user.id, officer: true });
      res.json(out);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to load that event.' });
    }
  });

  // ── Attendance: adding and removing people after the fact ───────────────────
  // Bulk, because the realistic case is "the snapshot missed the four people who
  // were in the overflow channel", and four separate confirmations for one
  // mistake is how officers stop bothering to fix it.
  //
  // Anyone already present is SKIPPED rather than erroring the whole call: a
  // partially-correct selection is the normal case when someone re-checks a
  // list, and refusing all of it teaches people to stop using the feature.
  router.post('/events/:id/attendees', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const members = Array.isArray(req.body?.members) ? req.body.members : [];
    if (!members.length) return res.status(400).json({ error: 'Nobody selected.' });

    const { data: event } = await supabase.from('events').select('id').eq('id', req.params.id).maybeSingle();
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    const { data: existing } = await supabase.from('event_attendance')
      .select('discord_id').eq('event_id', req.params.id);
    const present = new Set((existing || []).map((a) => String(a.discord_id)));

    const ids = await identities.load().catch(() => null);
    const now = new Date().toISOString();
    const rows = members
      .filter((m) => m && m.id && !present.has(String(m.id)))
      .map((m) => ({
        id: crypto.randomUUID(),
        event_id: req.params.id,
        discord_id: String(m.id),
        display_name: String((ids ? ids.displayNameFor(m.id, m.name) : m.name) || '').slice(0, 120),
        joined_at: now,
        // Not a snapshot. Everything added here arrived after the photograph
        // was taken, which is exactly what this column is for.
        source: 'late',
      }));

    if (!rows.length) return res.json({ added: 0, skipped: members.length });
    const { error } = await supabase.from('event_attendance').insert(rows);
    if (error) {
      console.error('Add attendees error:', error.message);
      return res.status(500).json({ error: 'Failed to add those attendees.' });
    }
    res.json({ added: rows.length, skipped: members.length - rows.length });
  });

  router.delete('/events/:id/attendees/:discordId', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    // Scoped by BOTH ids: an event id alone would be enough to delete the same
    // member's attendance from a different night if the params were swapped.
    const { data, error } = await supabase.from('event_attendance')
      .delete().eq('event_id', req.params.id).eq('discord_id', String(req.params.discordId))
      .select('id').maybeSingle();
    if (error) {
      console.error('Remove attendee error:', error.message);
      return res.status(500).json({ error: 'Failed to remove that attendee.' });
    }
    if (!data) return res.status(404).json({ error: 'That member is not on this event.' });
    res.json({ ok: true });
  });

  // ── Late attendance: the officer queue ──────────────────────────────────────
  // Covered by the existing { prefix: '/attendance', permission: 'attendance' }
  // rule. Deliberately NOT a new permission key: a new key starts granted to
  // nobody, which would lock every granular attendance officer out of a feature
  // they already run, while leaving blanket admins untouched.
  router.get('/attendance/late-requests', async (req, res) => {
    if (!lateAttendance) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const requests = await lateAttendance.list({
        status: req.query.status || 'pending',
        eventId: req.query.event || null,
      });
      res.json({ requests, window_hours: lateAttendance.WINDOW_HOURS });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to load late requests.' });
    }
  });

  router.patch('/attendance/late-requests/:id', async (req, res) => {
    if (!lateAttendance) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const decided = await lateAttendance.decide(
        req.params.id,
        req.body?.status,
        { id: req.user.id, name: req.user.username },
      );
      res.json({ request: decided });

      // After responding, unawaited: a DM that is slow or fails must not delay
      // or undo a decision that is already written. A denial is private, so
      // this is a DM rather than a channel post.
      if (gateway) gateway.notifyLateAttendance(decided).catch(() => {});
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to record that decision.' });
    }
  });

  router.post('/events', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { title, event_date, event_schedule_id, attendees, roster_id } = req.body || {};

    let result;
    try {
      result = await attendance.createEvent({
        title, eventDate: event_date, eventScheduleId: event_schedule_id, attendees,
        // Three-way, and `undefined` is the meaningful default: omitting the
        // field auto-matches the roster saved for this night, while an explicit
        // null records "there was no party". `roster_id ?? undefined` would
        // collapse those two — see freezeParty in attendance.js.
        rosterId: Object.prototype.hasOwnProperty.call(req.body || {}, 'roster_id') ? roster_id : undefined,
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Failed to create event.' });
    }

    res.json(result);

    // Best-effort — DMs go out after responding so a slow/failed Discord send
    // can't delay or break the save itself.
    if (gateway) gateway.notifyAttendance(attendees, title, event_date).catch(() => {});
  });

  // One-time (re-runnable) fix for attendance rows saved before snapshots resolved
  // display names against player_identities — updates any that now have a mapping.
  router.post('/attendance/backfill-names', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const ids = await identities.load();

    // Every attendance row ever, unfiltered — one per member per night, so it
    // passes 1,000 within a few dozen events. Truncated, "Fix past names"
    // silently repaired only the newest slice and reported success, which is
    // the worst possible shape for a repair tool.
    let rows;
    try {
      rows = await fetchAll(
        () => supabase.from('event_attendance').select('id, discord_id, display_name').order('id'),
        { label: 'event_attendance' },
      );
    } catch (err) {
      console.error('attendance backfill load error:', err.message);
      return res.status(500).json({ error: 'Failed to load attendance records.' });
    }

    const toFix = (rows || []).filter((r) => {
      const mapped = ids.displayNameFor(r.discord_id);
      return mapped && mapped !== r.display_name;
    });
    const results = await Promise.all(toFix.map((r) =>
      supabase.from('event_attendance').update({ display_name: ids.displayNameFor(r.discord_id) }).eq('id', r.id)
    ));
    const failed = results.filter((r) => r.error).length;
    if (failed > 0) console.error(`Attendance backfill: ${failed} row(s) failed to update.`);

    res.json({ checked: (rows || []).length, updated: toFix.length - failed });
  });

  // ── Attendance carried over from TLGM ────────────────────────────────────────
  // Two passes over the same file: ?dry_run=1 returns who matched and who
  // didn't, and only the confirmed second post writes. Matching against the
  // live member list is the whole job, so an unreachable Discord is a 503
  // rather than an import that silently skips everyone.
  router.post('/attendance/history/import', upload.single('file'), async (req, res) => {
    if (!attendanceHistory) return res.status(503).json({ error: 'Database not configured.' });
    if (!req.file) return res.status(400).json({ error: 'CSV file required.' });

    let members;
    try {
      members = await listMembers();
    } catch (err) {
      console.error('TLGM import listMembers failed:', err.message);
      return res.status(503).json({ error: 'Could not load the Discord member list to match against.' });
    }
    if (!members.length) return res.status(503).json({ error: 'The Discord member list came back empty.' });

    const ids = await identities.load();
    const result = parseTlgm(req.file.buffer, members, ids);
    if (result.error) return res.status(400).json({ error: result.error });

    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
    if (dryRun) return res.json({ dry_run: true, ...result });

    if (!result.rows.length) return res.status(400).json({ error: 'Nobody in that file matched a current member.' });
    try {
      await attendanceHistory.replace(result.rows, req.user.username || req.user.id);
    } catch (err) {
      console.error('TLGM import error:', err.message);
      return res.status(500).json({ error: 'Failed to save the TLGM history: ' + err.message });
    }
    // The join dates ride along second, and failing them doesn't fail the
    // import: the attendance totals are already saved, and every member still
    // has a Discord-derived join date to fall back on.
    let joinDates = { saved: 0, error: null };
    try {
      joinDates.saved = tenure ? await tenure.setJoinDates(result.rows) : 0;
    } catch (err) {
      console.error('TLGM join date save error:', err.message);
      joinDates = { saved: 0, error: `Join dates weren't saved (${err.message}) — has migration 029 been run?` };
    }
    res.json({ imported: result.rows.length, skipped: result.skipped, join_dates: joinDates });
  });

  router.delete('/attendance/history', async (req, res) => {
    if (!attendanceHistory) return res.status(503).json({ error: 'Database not configured.' });
    try {
      await attendanceHistory.clear();
      res.json({ ok: true });
    } catch (err) {
      console.error('TLGM history clear error:', err.message);
      res.status(500).json({ error: 'Failed to remove the TLGM history.' });
    }
  });

  // The imported TLGM rows, keyed by Discord id. Empty when there are none,
  // including when migration 027 hasn't been run: a missing history table must
  // not take the app's own attendance down with it.
  async function loadHistory() {
    try {
      const rows = await attendanceHistory.list();
      return new Map(rows.map((r) => [String(r.discord_id), r]));
    } catch (err) {
      console.error('attendance history load failed:', err.message);
      return new Map();
    }
  }

  // Every night ever logged here: how many there were, and each attendance row.
  // Only fetched when the window isn't already "all" — then the window's own
  // numbers are these.
  // Dated, not just counted, because each member's all-time denominator is
  // only the nights since they joined.
  async function loadAppAllTime() {
    const [events, att] = await Promise.all([
      fetchAll(
        () => supabase.from('events').select('id, event_date').order('id'),
        { label: 'events' },
      ),
      fetchAll(
        () => supabase.from('event_attendance').select('discord_id, display_name, event_id').order('id'),
        { label: 'event_attendance' },
      ),
    ]);
    return { events, att };
  }

  // discord_id -> Set of event ids, from attendance rows.
  const attendedSets = (att) => {
    const out = new Map();
    (att || []).forEach((a) => {
      const id = String(a.discord_id);
      if (!out.has(id)) out.set(id, new Set());
      out.get(id).add(String(a.event_id));
    });
    return out;
  };

  router.get('/attendance-stats', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const { days, since } = attendanceWindow(req);

      let eq = supabase.from('events').select('id, event_date');
      if (since) eq = eq.gte('event_date', since);
      const { data: evts, error: eErr } = await eq;
      if (eErr) throw eErr;
      const totalEvents = (evts || []).length;

      // The window has to narrow BOTH halves. Filtering only the denominator
      // leaves attendance rows from outside it counting against a smaller total
      // — which produces rates over 100% and, worse, plausible-looking ones
      // like 95% for someone who came twice.
      // Bounded by the window on paper, but the window can be "all" — and even
      // 30 days of a busy guild is events × attendees. This is the numerator of
      // every attendance percentage on the page, so truncating it doesn't
      // produce an obvious blank, it produces plausible rates that are simply
      // too low for whoever sorts last.
      const eventIdsForAtt = (evts || []).map((e) => e.id);
      const att = eventIdsForAtt.length === 0 ? [] : await fetchAll(
        () => supabase.from('event_attendance').select('discord_id, display_name, event_id')
          .in('event_id', eventIdsForAtt).order('id'),
        { label: 'event_attendance' },
      );

      const map = {};
      (att || []).forEach((a) => {
        if (!map[a.discord_id]) map[a.discord_id] = { discord_id: a.discord_id, display_name: a.display_name, attended: 0 };
        map[a.discord_id].attended++;
        if (a.display_name) map[a.discord_id].display_name = a.display_name;
      });

      // ── All-time: TLGM history plus every night logged here ──
      // Added straight together because the two never overlap — TLGM covers
      // the time before this app, so no night is in both. If that ever stops
      // being true, this sum counts the shared nights twice.
      //
      // The window above is untouched by this; all_time is its own figure and
      // reads the same on every tab.
      const [history, app, current, ids, tenures] = await Promise.all([
        loadHistory(),
        since ? loadAppAllTime() : Promise.resolve({ events: evts || [], att }),
        listMembers().then((ms) => new Set(ms.map((m) => String(m.id)))).catch(() => null),
        identities.load(),
        loadTenure(),
      ]);
      const appAttended = attendedSets(app.att);
      const appCount = new Map();
      const appName = new Map();
      (app.att || []).forEach((a) => {
        const id = String(a.discord_id);
        appCount.set(id, (appCount.get(id) || 0) + 1);
        if (a.display_name) appName.set(id, a.display_name);
      });

      new Set([...history.keys(), ...appCount.keys()]).forEach((id) => {
        const h = history.get(id);
        const attended = (h?.attended || 0) + (appCount.get(id) || 0);
        // TLGM's total is already per member; the app's half is the nights
        // since they joined.
        const total = (h?.total || 0) + eligibleCount(app.events, tenures.get(id), appAttended.get(id));
        if (!total) return;
        if (!map[id]) {
          // Not seen in this window. Still listed so their all-time figure
          // isn't hidden — but only if they're still in the guild, or every
          // tab would fill up with people who left long ago.
          if (current && !current.has(id)) return;
          map[id] = { discord_id: id, display_name: ids.displayNameFor(id, appName.get(id) || h?.display_name || id), attended: 0 };
        }
        map[id].all_time = { attended, total, rate: Math.round((attended / total) * 100) };
      });

      // Each member is measured on the window's nights since they joined, so
      // `eligible` differs per row and `totalEvents` is only the page header.
      const windowAttended = attendedSets(att);
      // Current members only — someone who has left isn't anyone's attendance
      // question any more, and their rows crowd out the people who are. The
      // nights they attended still count in each event's own record. If
      // Discord can't be reached, `current` is null and everyone is shown: a
      // full table beats an empty one.
      const members = Object.values(map)
        .filter((m) => !current || current.has(String(m.discord_id)))
        .map((m) => {
          const eligible = eligibleCount(evts || [], tenures.get(String(m.discord_id)), windowAttended.get(String(m.discord_id)));
          // null, not 0, for someone with no nights in the window yet: 0% says
          // "never turned up", which a member who joined yesterday hasn't done.
          return { ...m, eligible, rate: eligible ? Math.round((m.attended / eligible) * 100) : null };
        })
        .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || a.display_name.localeCompare(b.display_name));

      const importedAt = [...history.values()].reduce((max, r) => (!max || r.imported_at > max ? r.imported_at : max), null);
      res.json({
        window: days, totalEvents, members,
        history: importedAt ? { source: 'TLGM', imported_at: importedAt, members: history.size } : null,
      });
    } catch (err) {
      console.error('Attendance stats error:', err.message);
      res.status(500).json({ error: 'Failed to compute attendance stats.' });
    }
  });

  // Who was on LOA for each event in `evts`: event id -> Set of discord ids.
  // Best-effort — if loa_entries can't be read, every night maps to nobody and
  // `ok` is false, so the page can say the LOA split is unavailable rather than
  // quietly counting every absence as unexcused.
  async function loaByEvent(evts) {
    if (!loa) return { ok: false, byEvent: new Map() };
    try {
      const byEvent = await loa.unavailableAcross((evts || []).map((e) => ({
        key: String(e.id), date: e.event_date, eventScheduleId: e.event_schedule_id || null,
      })));
      return { ok: true, byEvent };
    } catch (err) {
      console.error('missed-events LOA lookup failed:', err.message);
      return { ok: false, byEvent: new Map() };
    }
  }

  // Missed nights per member in the window — the officer "who's been absent"
  // list. Unlike the rate table this starts from the Discord roster, not from
  // attendance rows: the member who has missed every night has no rows, and is
  // exactly who this list is for. Missed is eligible − attended, the same
  // split the per-member breakdown below uses, so the two always agree. If
  // Discord can't be reached it falls back to everyone seen in the window.
  //
  // Each missed night is also split by whether an LOA covered it (`missed_loa`)
  // or not (`missed_no_loa`), by the same rules the event page uses to put
  // someone in its LOA bucket.
  router.get('/attendance-stats/missed', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const { days, since } = attendanceWindow(req);

      let eq = supabase.from('events').select('id, event_date, event_schedule_id');
      if (since) eq = eq.gte('event_date', since);
      const { data: evts, error: eErr } = await eq;
      if (eErr) throw eErr;

      const eventIds = (evts || []).map((e) => e.id);
      const att = eventIds.length === 0 ? [] : await fetchAll(
        () => supabase.from('event_attendance').select('discord_id, display_name, event_id')
          .in('event_id', eventIds).order('id'),
        { label: 'event_attendance' },
      );

      const [roster, ids, tenures, onLoa] = await Promise.all([
        listMembers().catch((err) => { console.error('missed listMembers failed:', err.message); return null; }),
        identities.load(),
        loadTenure(),
        loaByEvent(evts),
      ]);

      const seenName = new Map();
      att.forEach((a) => { if (a.display_name) seenName.set(String(a.discord_id), a.display_name); });
      const people = roster
        ? roster.map((m) => ({ id: String(m.id), name: m.name }))
        : [...seenName].map(([id, name]) => ({ id, name }));

      const attendedBy = attendedSets(att);
      const members = people.map(({ id, name }) => {
        const attendedIds = attendedBy.get(id);
        const attended = attendedIds ? attendedIds.size : 0;
        const t = tenures.get(id);
        const eligible = eligibleCount(evts || [], t, attendedIds);
        // The nights eligibleCount counted that they didn't attend.
        let missedLoa = 0;
        (evts || []).forEach((e) => {
          if (attendedIds && attendedIds.has(String(e.id))) return;
          if (t && !countsFor(t, e.event_date)) return;
          if (onLoa.byEvent.get(String(e.id))?.has(id)) missedLoa++;
        });
        return {
          discord_id: id,
          display_name: ids.displayNameFor(id, seenName.get(id) || name || id),
          attended,
          eligible,
          missed: eligible - attended,
          missed_loa: missedLoa,
          missed_no_loa: eligible - attended - missedLoa,
        };
      }).sort((a, b) => b.missed - a.missed || a.display_name.localeCompare(b.display_name));

      res.json({ window: days, totalEvents: (evts || []).length, loa_checked: onLoa.ok, members });
    } catch (err) {
      console.error('Missed attendance error:', err.message);
      res.status(500).json({ error: 'Failed to compute missed events.' });
    }
  });

  // One member's nights in the window, each marked attended, missed, or
  // before_join. The split follows eligibleCount exactly — attended always
  // counts, otherwise the night counts only once they held the role — so the
  // missed list is precisely what stands between them and 100% in the table.
  router.get('/attendance-stats/member/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const id = String(req.params.id);
      const { days, since } = attendanceWindow(req);

      let eq = supabase.from('events').select('id, title, event_date, event_schedule_id')
        .order('event_date', { ascending: false });
      if (since) eq = eq.gte('event_date', since);
      const { data: evts, error: eErr } = await eq;
      if (eErr) throw eErr;

      const eventIds = (evts || []).map((e) => e.id);
      const att = eventIds.length === 0 ? [] : await fetchAll(
        () => supabase.from('event_attendance').select('discord_id, event_id')
          .eq('discord_id', id).in('event_id', eventIds).order('id'),
        { label: 'event_attendance' },
      );
      const attended = new Set(att.filter((a) => String(a.discord_id) === id).map((a) => String(a.event_id)));
      const [tenures, onLoa] = await Promise.all([loadTenure(), loaByEvent(evts)]);
      const t = tenures.get(id);

      const events = (evts || []).map((e) => {
        const status = attended.has(String(e.id)) ? 'attended'
          : !t || countsFor(t, e.event_date) ? 'missed'
          : 'before_join';
        // Only a missed night needs the LOA question answered.
        const loaCovered = status === 'missed' && Boolean(onLoa.byEvent.get(String(e.id))?.has(id));
        return { id: e.id, title: e.title, event_date: e.event_date, status, loa: loaCovered };
      });
      res.json({ window: days, discord_id: id, events });
    } catch (err) {
      console.error('Member attendance error:', err.message);
      res.status(500).json({ error: 'Failed to load that member\'s attendance.' });
    }
  });

  router.delete('/events/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    await supabase.from('event_attendance').delete().eq('event_id', req.params.id);
    const { error } = await supabase.from('events').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete event.' });
    res.json({ ok: true });
  });
};
