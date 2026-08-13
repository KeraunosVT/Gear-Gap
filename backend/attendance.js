// backend/attendance.js — event creation + event-schedule lookups, shared
// between the website's /api/admin/events route and the /attendance Discord
// command so both write through the same validation instead of maintaining
// it twice (same pattern as loa.js).
const crypto = require('crypto');
const { guildDayOfWeek, daySlot } = require('./loa');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Which party this night ran with, resolved to a frozen COPY before anything is
// written. Declared out here rather than inside the returned object literal,
// where a bare `function` declaration is a syntax error.
//
// Three cases, and the difference between them matters:
//   undefined — auto-match. Take the most recently updated roster saved for the
//               same (event_date, event_schedule_id). That pair is already the
//               join key across LOA, signups and the party builder, so the
//               match is right by construction rather than by guesswork.
//   an id     — use that roster, and 404 if it doesn't exist. An officer who
//               named a roster explicitly should hear that it's gone, not
//               silently get an event with no party.
//   null      — no party. Explicitly recording "there wasn't one".
//
// The returned layout is a snapshot, never a join — see the header of
// migrations/015 for why.
async function freezeParty(supabase, { rosterId, eventDate, eventScheduleId }) {
  if (rosterId === null) return { roster_id: null, party_layout: null };

  let row = null;
  if (rosterId) {
    const { data } = await supabase
      .from('rosters').select('id, name, layout').eq('id', rosterId).maybeSingle();
    if (!data) throw httpError(404, 'That roster no longer exists.');
    row = data;
  } else {
    if (!eventDate) return { roster_id: null, party_layout: null };
    let q = supabase.from('rosters')
      .select('id, name, layout, updated_at')
      .eq('event_date', eventDate)
      .order('updated_at', { ascending: false })
      .limit(1);
    // A null event_schedule_id is a real value here (an ad-hoc night), and
    // `.eq(col, null)` does not match it — PostgREST needs `.is()`.
    q = eventScheduleId ? q.eq('event_schedule_id', eventScheduleId) : q.is('event_schedule_id', null);
    const { data, error } = await q;
    if (error) {
      // Auto-matching is a convenience. Failing it must not fail the save —
      // the attendance record is the thing that matters, and a missing party
      // can be attached later.
      console.error('freezeParty lookup failed:', error.message);
      return { roster_id: null, party_layout: null };
    }
    row = (data || [])[0] || null;
  }

  if (!row) return { roster_id: null, party_layout: null };
  // The name travels inside the copy. Reading it back off the rosters row at
  // display time would reintroduce exactly the live-view problem the copy
  // exists to avoid, one field at a time.
  return { roster_id: row.id, party_layout: { ...(row.layout || {}), name: row.name } };
}

module.exports = function createAttendance(supabase) {
  return {
    // Every scheduled event, for populating a dropdown/autocomplete. Ordered by
    // the night each belongs to and its position in that night, so the 12:30am
    // event sits at the end of its own evening rather than at the top of the
    // following morning — matching how these lists are labelled.
    async listSchedule() {
      const { data, error } = await supabase.from('event_schedule').select('*');
      if (error) { console.error('attendance.listSchedule error:', error.message); return []; }
      return (data || []).sort((a, b) =>
        guildDayOfWeek(a.day_of_week, a.event_time) - guildDayOfWeek(b.day_of_week, b.event_time)
        || (a.event_time ? daySlot(a.event_time) : -1) - (b.event_time ? daySlot(b.event_time) : -1)
        || String(a.name).localeCompare(String(b.name)));
    },

    async getScheduleEvent(id) {
      if (!id) return null;
      const { data, error } = await supabase.from('event_schedule').select('*').eq('id', id).single();
      if (error) return null;
      return data;
    },

    async createEvent({ title, eventDate, eventScheduleId, attendees, rosterId }) {
      if (!title) throw httpError(400, 'Title is required.');
      if (!Array.isArray(attendees) || attendees.length === 0) {
        throw httpError(400, 'At least one attendee is required.');
      }

      const eventId = crypto.randomUUID();

      // Resolved BEFORE the write: a named roster that has been deleted should
      // fail the save outright, not leave an event behind with no party and
      // nothing explaining why.
      const party = await freezeParty(supabase, { rosterId, eventDate, eventScheduleId });

      // One transaction via the save_event function (migrations/012), the same
      // pattern save_match uses. This was two inserts with a compensating delete
      // if the second failed — a hand-rolled rollback whose own failure path
      // (delete fails too) leaves an event with zero attendees and nothing
      // explaining it. A function body either commits whole or not at all.
      // The frozen party rides along as two more RPC parameters rather than a
      // follow-up UPDATE. A second statement would be outside the function's
      // transaction, so a failure there would leave a saved event whose party
      // is missing — the exact split-write this function exists to prevent.
      // migrations/015 adds them, defaulted, and explains why the old signature
      // had to be dropped rather than replaced.
      const { data: inserted, error } = await supabase.rpc('save_event', {
        p_id: eventId,
        p_title: String(title).slice(0, 200),
        p_event_date: eventDate || null,
        p_event_schedule_id: eventScheduleId || null,
        p_attendees: attendees.map((a) => ({ id: String(a.id), name: String(a.name || '') })),
        p_roster_id: party.roster_id,
        p_party_layout: party.party_layout,
      });
      if (error) {
        console.error('save_event error:', error.message);
        throw httpError(500, 'Failed to create event.');
      }

      return { id: eventId, attendees: inserted ?? attendees.length, roster_id: party.roster_id };
    },
  };
};
