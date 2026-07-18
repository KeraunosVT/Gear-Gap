// backend/attendance.js — event creation + event-schedule lookups, shared
// between the website's /api/admin/events route and the /attendance Discord
// command so both write through the same validation instead of maintaining
// it twice (same pattern as loa.js).
const crypto = require('crypto');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = function createAttendance(supabase) {
  return {
    // Every scheduled event, for populating a dropdown/autocomplete.
    async listSchedule() {
      const { data, error } = await supabase.from('event_schedule')
        .select('*').order('day_of_week').order('name');
      if (error) { console.error('attendance.listSchedule error:', error.message); return []; }
      return data || [];
    },

    async getScheduleEvent(id) {
      if (!id) return null;
      const { data, error } = await supabase.from('event_schedule').select('*').eq('id', id).single();
      if (error) return null;
      return data;
    },

    async createEvent({ title, eventDate, eventScheduleId, attendees }) {
      if (!title) throw httpError(400, 'Title is required.');
      if (!Array.isArray(attendees) || attendees.length === 0) {
        throw httpError(400, 'At least one attendee is required.');
      }

      const eventId = crypto.randomUUID();
      const now = new Date().toISOString();

      const { error: eErr } = await supabase.from('events').insert({
        id: eventId, title: String(title).slice(0, 200),
        event_date: eventDate || null,
        event_schedule_id: eventScheduleId || null,
        created_at: now,
      });
      if (eErr) { console.error('Event insert error:', eErr.message); throw httpError(500, 'Failed to create event.'); }

      const rows = attendees.map((a) => ({
        id: crypto.randomUUID(), event_id: eventId,
        discord_id: String(a.id), display_name: String(a.name || '').slice(0, 120),
        joined_at: now,
      }));
      const { error: aErr } = await supabase.from('event_attendance').insert(rows);
      if (aErr) {
        console.error('Attendance insert error:', aErr.message);
        await supabase.from('events').delete().eq('id', eventId);
        throw httpError(500, 'Failed to save attendees — event rolled back.');
      }

      return { id: eventId, attendees: rows.length };
    },
  };
};
