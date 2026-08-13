// backend/lateAttendance.js — "I was there, the snapshot missed me."
//
// Attendance is a photograph of a voice channel taken at one instant, and
// photographs miss people: someone joins two minutes late, Discord drops a
// voice state, a member reconnects mid-snap. Before this module the only remedy
// was for an officer to delete the whole event and take it again, which
// rewrites everyone else's record to fix one person's.
//
// ── WHY A REQUEST AND NOT A DIRECT EDIT ─────────────────────────────────────
// Attendance is the number guilds make decisions with, so nobody may write
// their own. A member asks; an officer decides. The request survives the
// decision — a denial that deletes the row leaves no answer to "who keeps
// asking" or "who turned them down", which are the two questions a disputed
// attendance record actually turns on.
//
// ── WHY 24 HOURS ────────────────────────────────────────────────────────────
// Measured from when attendance was TAKEN (events.created_at), not from when
// the event was scheduled. The window exists so the correction happens while
// the night is still fresh in people's memory — an officer approving a claim
// about three weeks ago is guessing, and this system should not ask them to.
// Re-checked server-side on every write: a button being visible is not a check.
const crypto = require('crypto');

// The one number this module is about. Exported so the routes, the Discord
// command and the page all quote the same window rather than three copies.
const WINDOW_HOURS = 24;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

const STATUSES = new Set(['approved', 'denied']);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Postgres unique-violation. The partial index on (event_id, discord_id) where
// status = 'pending' is the duplicate check — a SELECT-then-INSERT loses the
// race between two clicks on a slow connection, which is precisely how
// double-submits are made.
const UNIQUE_VIOLATION = '23505';

const cleanReason = (v) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 300) : null;
};

module.exports = function createLateAttendance(supabase, identities = null) {
  // Member routes live outside /api/admin, where auditLog's middleware doesn't
  // reach, and a Discord slash command is not an HTTP request at all. Written
  // here, at the one point every surface passes through, under the same
  // "Attendance" label the admin attendance routes already stamp.
  //
  // Best-effort: a failed audit insert is logged and swallowed. Losing a line
  // is a nuisance; an unhandled rejection takes the process down.
  //
  // `path` carries the action because this table has no action column — the
  // middleware that normally writes it derives everything from the request, and
  // these entries have no request to derive from.
  async function audit(actor, path, body) {
    try {
      const { error } = await supabase.from('audit_log').insert({
        discord_id: String(actor?.id || 'system'),
        display_name: actor?.name || null,
        method: 'POST',
        path,
        feature: 'Attendance',
        body: body || {},
        status_code: 200,
      });
      if (error) console.error('late attendance audit insert failed:', error.message);
    } catch (err) {
      console.error('late attendance audit insert skipped:', err.message);
    }
  }

  async function resolveDisplayName(discordId, fallback) {
    if (!identities || !discordId) return fallback;
    try {
      const ids = await identities.load();
      return ids.displayNameFor(discordId, fallback) || fallback;
    } catch (err) {
      console.warn('late attendance: identity lookup failed, using the supplied name:', err.message);
      return fallback;
    }
  }

  async function loadEvent(eventId) {
    if (!eventId) throw httpError(400, 'Which event?');
    const { data, error } = await supabase
      .from('events').select('id, title, event_date, created_at')
      .eq('id', eventId).maybeSingle();
    if (error) { console.error('lateAttendance.loadEvent error:', error.message); throw httpError(500, 'Failed to load that event.'); }
    if (!data) throw httpError(404, 'That event no longer exists.');
    return data;
  }

  const closesAt = (event) => new Date(new Date(event.created_at).getTime() + WINDOW_MS);
  const isOpen = (event, now = Date.now()) => closesAt(event).getTime() > now;

  return {
    WINDOW_HOURS,

    // What a member can see and act on: the recent events, their own standing
    // in each, and whether the door is still open. One query per table rather
    // than one per event — a member with a month of history would otherwise
    // make sixty round trips to render one page.
    async listForMember(discordId, { days = 30 } = {}) {
      const since = new Date(Date.now() - Math.max(1, days) * 86_400_000).toISOString();

      const { data: events, error: eErr } = await supabase
        .from('events').select('id, title, event_date, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: false });
      if (eErr) { console.error('lateAttendance.listForMember events error:', eErr.message); throw httpError(500, 'Failed to load events.'); }
      if (!events || !events.length) return [];

      const ids = events.map((e) => e.id);
      const [{ data: mine }, { data: reqs }] = await Promise.all([
        supabase.from('event_attendance').select('event_id, joined_at, source')
          .eq('discord_id', String(discordId)).in('event_id', ids),
        supabase.from('late_attendance_requests').select('*')
          .eq('discord_id', String(discordId)).in('event_id', ids),
      ]);

      const attended = new Map((mine || []).map((a) => [String(a.event_id), a]));
      const requested = new Map((reqs || []).map((r) => [String(r.event_id), r]));
      const now = Date.now();

      return events.map((e) => {
        const att = attended.get(String(e.id)) || null;
        const req = requested.get(String(e.id)) || null;
        const open = isOpen(e, now);
        return {
          ...e,
          attended: !!att,
          joined_at: att ? att.joined_at : null,
          late: !!att && att.source === 'late',
          request: req
            ? { id: req.id, status: req.status, reason: req.reason, requested_at: req.requested_at, decided_at: req.decided_at }
            : null,
          window_closes_at: closesAt(e).toISOString(),
          // Every reason the button is absent, resolved here rather than in the
          // browser, so the page and the route can never disagree about it.
          can_request: open && !att && !(req && req.status === 'pending'),
        };
      });
    },

    // Just the events a member could still file against — the Discord command's
    // autocomplete list. A member with nothing eligible gets an empty list,
    // which reads as "nothing to do here" rather than as a rejection.
    async eligibleEvents(discordId) {
      const rows = await this.listForMember(discordId, { days: 3 });
      return rows.filter((r) => r.can_request);
    },

    async request({ eventId, discordId, displayName, reason }) {
      const event = await loadEvent(eventId);
      if (!isOpen(event)) {
        throw httpError(400, `Late attendance closes ${WINDOW_HOURS} hours after attendance is taken, and that window has passed for "${event.title}". Ask an officer directly.`);
      }

      const { data: already, error: aErr } = await supabase
        .from('event_attendance').select('id')
        .eq('event_id', event.id).eq('discord_id', String(discordId)).maybeSingle();
      if (aErr) { console.error('lateAttendance.request lookup error:', aErr.message); throw httpError(500, 'Failed to check that event.'); }
      if (already) throw httpError(409, `You're already marked as attending "${event.title}".`);

      const name = await resolveDisplayName(discordId, displayName);
      const id = crypto.randomUUID();
      const { error } = await supabase.from('late_attendance_requests').insert({
        id,
        event_id: event.id,
        discord_id: String(discordId),
        display_name: String(name || '').slice(0, 120) || null,
        reason: cleanReason(reason),
        status: 'pending',
        requested_at: new Date().toISOString(),
      });
      if (error) {
        if (error.code === UNIQUE_VIOLATION) throw httpError(409, `You've already asked about "${event.title}" — an officer hasn't decided yet.`);
        console.error('lateAttendance.request insert error:', error.message);
        throw httpError(500, 'Failed to file that request.');
      }

      await audit({ id: discordId, name }, '/attendance/late', { action: 'requested', event_id: event.id, event_title: event.title });
      return { id, event_id: event.id, event_title: event.title, status: 'pending' };
    },

    // The officer queue. Names re-resolved through player_identities so a
    // request filed weeks ago shows who that member is called today.
    async list({ status = 'pending', eventId = null } = {}) {
      let q = supabase.from('late_attendance_requests').select('*')
        .order('requested_at', { ascending: false });
      if (status && status !== 'all') q = q.eq('status', status);
      if (eventId) q = q.eq('event_id', eventId);
      const { data, error } = await q;
      if (error) { console.error('lateAttendance.list error:', error.message); throw httpError(500, 'Failed to load late requests.'); }
      const rows = data || [];
      if (!rows.length) return [];

      const eventIds = [...new Set(rows.map((r) => r.event_id))];
      const { data: events } = await supabase
        .from('events').select('id, title, event_date, created_at').in('id', eventIds);
      const byId = new Map((events || []).map((e) => [String(e.id), e]));

      let ids = null;
      if (identities) {
        try { ids = await identities.load(); } catch (err) {
          console.warn('late attendance: identity lookup failed, showing stored names:', err.message);
        }
      }

      return rows.map((r) => {
        const event = byId.get(String(r.event_id)) || null;
        return {
          ...r,
          display_name: ids ? ids.displayNameFor(r.discord_id, r.display_name) : r.display_name,
          event: event ? { id: event.id, title: event.title, event_date: event.event_date } : null,
          window_closes_at: event ? closesAt(event).toISOString() : null,
        };
      });
    },

    // Approve or deny. The interesting one, because approving has a side effect
    // — it writes an attendance row — and two officers can press the button at
    // the same moment.
    async decide(id, status, actor) {
      if (!STATUSES.has(status)) throw httpError(400, 'A request can only be approved or denied.');
      const now = new Date().toISOString();

      // Claim the row by putting the CURRENT status in the WHERE clause. A
      // read-then-write would let two simultaneous approvals both see 'pending'
      // and both write an attendance row, inflating that member's rate; this
      // way the second update matches nothing and the second officer is told
      // so. Same shape as the signup capacity claim.
      const { data: claimed, error: cErr } = await supabase.from('late_attendance_requests')
        .update({ status, decided_by: (actor && (actor.name || actor.id)) || null, decided_at: now })
        .eq('id', id).eq('status', 'pending')
        .select('*').maybeSingle();
      if (cErr) { console.error('lateAttendance.decide claim error:', cErr.message); throw httpError(500, 'Failed to record that decision.'); }
      if (!claimed) {
        // Either it never existed, or someone got there first. Told apart here
        // rather than reported as one confusing error.
        const { data: exists } = await supabase.from('late_attendance_requests').select('id, status').eq('id', id).maybeSingle();
        if (!exists) throw httpError(404, 'That request no longer exists.');
        throw httpError(409, `That request was already ${exists.status} by someone else.`);
      }

      let attendanceId = null;
      if (status === 'approved') {
        attendanceId = crypto.randomUUID();
        const { error: aErr } = await supabase.from('event_attendance').insert({
          id: attendanceId,
          event_id: claimed.event_id,
          discord_id: claimed.discord_id,
          display_name: claimed.display_name,
          // The moment it was granted, not the moment of the event. The
          // attendance table shows this column, so a late approval reads as
          // visibly later than the snapshot rows — which is the truth.
          joined_at: now,
          source: 'late',
        });
        if (aErr) {
          console.error('lateAttendance.decide attendance insert error:', aErr.message);
          // Put the request back so the officer can try again, rather than
          // leaving it marked approved with nothing to show for it.
          await supabase.from('late_attendance_requests')
            .update({ status: 'pending', decided_by: null, decided_at: null }).eq('id', id);
          throw httpError(500, 'Approved, but the attendance row failed to save — the request has been reopened.');
        }
        await supabase.from('late_attendance_requests').update({ attendance_id: attendanceId }).eq('id', id);
      }

      await audit(actor, '/attendance/late-requests', {
        action: status, request_id: id, event_id: claimed.event_id, member: claimed.discord_id,
      });
      // The event travels with the decision so the caller can name it in a DM
      // without a second lookup. Best-effort — a missing title is worth a
      // vaguer message, not a failed decision that has already been written.
      const event = await loadEvent(claimed.event_id).catch(() => null);
      return { ...claimed, status, attendance_id: attendanceId, event };
    },

    // A member withdrawing their own pending ask. Scoped by discord_id in the
    // WHERE clause, not checked after the fact, so it cannot cancel anyone
    // else's however the id was obtained.
    async cancel(id, discordId) {
      const { data, error } = await supabase.from('late_attendance_requests')
        .delete().eq('id', id).eq('discord_id', String(discordId)).eq('status', 'pending')
        .select('id, event_id').maybeSingle();
      if (error) { console.error('lateAttendance.cancel error:', error.message); throw httpError(500, 'Failed to withdraw that request.'); }
      if (!data) throw httpError(404, "That request isn't yours, or an officer has already decided it.");
      await audit({ id: discordId }, '/attendance/late', { action: 'withdrawn', request_id: id, event_id: data.event_id });
      return { ok: true };
    },

    // How many are waiting — for the badge on the officer page, which must not
    // pay for the whole list to render a number.
    async pendingCount() {
      const { count, error } = await supabase
        .from('late_attendance_requests').select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      if (error) { console.error('lateAttendance.pendingCount error:', error.message); return 0; }
      return count || 0;
    },
  };
};

module.exports.WINDOW_HOURS = WINDOW_HOURS;
module.exports.WINDOW_MS = WINDOW_MS;
