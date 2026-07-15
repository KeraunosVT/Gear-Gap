// backend/loa.js — Leave-of-absence entries, shared between the website's
// /api/loa routes and the /loa Discord command so both write through the
// same validation instead of maintaining it twice.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay();
}

module.exports = function createLoa(supabase) {
  const isValidDate = (dateStr) => DATE_RE.test(dateStr || '');

  return {
    isValidDate,

    // Events on the recurring schedule that fall on the same day-of-week as `dateStr`.
    async eventsForDate(dateStr) {
      if (!isValidDate(dateStr)) return [];
      const { data, error } = await supabase.from('event_schedule')
        .select('*').eq('day_of_week', dayOfWeek(dateStr)).order('name');
      if (error) { console.error('loa.eventsForDate error:', error.message); return []; }
      return data || [];
    },

    async submitEvent({ discordId, displayName, eventDate, eventScheduleId, reason }) {
      if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
      if (!eventScheduleId) throw httpError(400, 'Event is required.');
      const { data: ev, error: evErr } = await supabase.from('event_schedule')
        .select('id, name, day_of_week').eq('id', eventScheduleId).single();
      if (evErr || !ev) throw httpError(400, 'Unknown event.');
      if (ev.day_of_week !== dayOfWeek(eventDate)) throw httpError(400, "That event isn't scheduled on that date.");

      const { data: row, error } = await supabase.from('loa_entries').insert({
        discord_id: discordId,
        display_name: (displayName || '').slice(0, 120),
        type: 'event',
        event_date: eventDate,
        event_schedule_id: eventScheduleId,
        start_date: null,
        end_date: null,
        reason: (reason || '').slice(0, 500) || null,
      }).select('id').single();
      if (error) throw httpError(500, 'Failed to submit LOA.');
      return { id: row.id, eventName: ev.name };
    },

    async submitRange({ discordId, displayName, startDate, endDate, reason }) {
      if (!isValidDate(startDate) || !isValidDate(endDate)) throw httpError(400, 'Dates must be in YYYY-MM-DD format.');
      if (new Date(endDate) < new Date(startDate)) throw httpError(400, 'End date must be after start date.');

      const { data: row, error } = await supabase.from('loa_entries').insert({
        discord_id: discordId,
        display_name: (displayName || '').slice(0, 120),
        type: 'range',
        event_date: null,
        event_schedule_id: null,
        start_date: startDate,
        end_date: endDate,
        reason: (reason || '').slice(0, 500) || null,
      }).select('id').single();
      if (error) throw httpError(500, 'Failed to submit LOA.');
      return { id: row.id };
    },

    // Best-effort — called after announceLoa() posts to Discord, to remember
    // which message to clean up if this entry is later cancelled. Not throwing
    // on failure here is deliberate: the LOA itself already succeeded by the
    // time this runs, and losing the message link just means cancel won't be
    // able to delete the announcement, not that anything is inconsistent.
    async setMessageId(id, messageId) {
      const { error } = await supabase.from('loa_entries').update({ discord_message_id: messageId }).eq('id', id);
      if (error) console.error('loa.setMessageId error:', error.message);
    },

    async mine(discordId) {
      const { data, error } = await supabase.from('loa_entries').select('*')
        .eq('discord_id', discordId).order('created_at', { ascending: false });
      if (error) throw httpError(500, 'Failed to load LOAs.');
      return data || [];
    },

    async all(isAdmin) {
      const { data, error } = await supabase.from('loa_entries').select('*').order('created_at', { ascending: false });
      if (error) throw httpError(500, 'Failed to load LOAs.');
      return (data || []).map((e) => {
        const out = { ...e };
        if (!isAdmin) delete out.reason;
        return out;
      });
    },

    async cancel(id, discordId, isAdmin) {
      const { data: entry } = await supabase.from('loa_entries').select('discord_id, discord_message_id').eq('id', id).single();
      if (!entry) throw httpError(404, 'LOA not found.');
      if (entry.discord_id !== discordId && !isAdmin) throw httpError(403, 'You can only cancel your own LOA.');
      const { error } = await supabase.from('loa_entries').delete().eq('id', id);
      if (error) throw httpError(500, 'Failed to cancel LOA.');
      return { messageId: entry.discord_message_id || null };
    },
  };
};
