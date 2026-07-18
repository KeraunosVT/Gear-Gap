// backend/loa.js — Leave-of-absence entries, shared between the website's
// /api/loa routes and the /loa Discord command so both write through the
// same validation instead of maintaining it twice.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GUILD_TZ = 'America/New_York';

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dayOfWeek(dateStr) {
  return new Date(dateStr + 'T12:00:00').getDay();
}

// Parses either a 24-hour "HH:MM" (what the website's <input type="time"> sends)
// or a freeform clock string like "9pm" / "9:00 PM" (what the Discord command
// takes, since slash commands have no time picker). Returns "HH:MM" or null.
function parseTimeOfDay(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const machine = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/.exec(s);
  if (machine) return `${machine[1]}:${machine[2]}`;
  const free = /^(\d{1,2})(?::([0-5]\d))?\s*([ap]\.?m\.?)?$/i.exec(s);
  if (!free) return null;
  let hour = parseInt(free[1], 10);
  const minute = free[2] ? parseInt(free[2], 10) : 0;
  const ampm = free[3] ? free[3][0].toLowerCase() : null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'p' && hour !== 12) hour += 12;
    if (ampm === 'a' && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// "Today" as a YYYY-MM-DD string in the guild's own timezone, not the server's.
// new Date().toISOString() reads the UTC calendar day, which silently rolls
// over to tomorrow from ~7-8pm ET onward — exactly when people are building
// rosters for that night's event — so callers needing "today" must use this
// instead of toISOString().slice(0, 10).
function todayInGuildTz() {
  return new Date().toLocaleDateString('en-CA', { timeZone: GUILD_TZ });
}

module.exports = function createLoa(supabase) {
  const isValidDate = (dateStr) => DATE_RE.test(dateStr || '');
  const requireReason = (reason) => {
    const trimmed = (reason || '').trim();
    if (!trimmed) throw httpError(400, 'Reason is required.');
    return trimmed;
  };

  return {
    isValidDate,
    parseTimeOfDay,

    // Events on the recurring schedule for a given day-of-week (0=Sunday..6=Saturday).
    async eventsForDay(dow) {
      const { data, error } = await supabase.from('event_schedule')
        .select('*').eq('day_of_week', dow).order('name');
      if (error) { console.error('loa.eventsForDay error:', error.message); return []; }
      return data || [];
    },

    // Same, but keyed off a calendar date instead of a raw day-of-week number.
    async eventsForDate(dateStr) {
      if (!isValidDate(dateStr)) return [];
      return this.eventsForDay(dayOfWeek(dateStr));
    },

    async submitEvent({ discordId, displayName, eventDate, eventScheduleId, reason }) {
      if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
      if (!eventScheduleId) throw httpError(400, 'Event is required.');
      const cleanReason = requireReason(reason);
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
        reason: cleanReason.slice(0, 500),
      }).select('id').single();
      if (error) { console.error('loa.submitEvent error:', error.message); throw httpError(500, 'Failed to submit LOA.'); }
      return { id: row.id, eventName: ev.name };
    },

    async submitRange({ discordId, displayName, startDate, endDate, reason }) {
      if (!isValidDate(startDate) || !isValidDate(endDate)) throw httpError(400, 'Dates must be in YYYY-MM-DD format.');
      if (new Date(endDate) < new Date(startDate)) throw httpError(400, 'End date must be after start date.');
      const cleanReason = requireReason(reason);

      const { data: row, error } = await supabase.from('loa_entries').insert({
        discord_id: discordId,
        display_name: (displayName || '').slice(0, 120),
        type: 'range',
        event_date: null,
        event_schedule_id: null,
        start_date: startDate,
        end_date: endDate,
        reason: cleanReason.slice(0, 500),
      }).select('id').single();
      if (error) { console.error('loa.submitRange error:', error.message); throw httpError(500, 'Failed to submit LOA.'); }
      return { id: row.id };
    },

    // Recurs every week on `dayOfWeek` (0=Sunday..6=Saturday) until cancelled.
    // `eventScheduleId` is optional: set it to cover only that one recurring
    // event (e.g. "always out for Tuesday Wargame"), or leave it null to cover
    // the whole day regardless of what's scheduled. `startTime` is also optional:
    // set it to mean "absent from this time onward" rather than the whole day —
    // /loa/unavailable compares it against each event's own scheduled time.
    async submitRecurring({ discordId, displayName, dayOfWeek: dow, eventScheduleId, startTime, reason }) {
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw httpError(400, 'Day of week must be between 0 and 6.');
      const cleanReason = requireReason(reason);
      const cleanStartTime = startTime ? parseTimeOfDay(startTime) : null;
      if (startTime && !cleanStartTime) throw httpError(400, 'Start time must be a valid time, e.g. 9:00 PM.');
      let eventName = null;
      if (eventScheduleId) {
        const { data: ev, error: evErr } = await supabase.from('event_schedule')
          .select('id, name, day_of_week').eq('id', eventScheduleId).single();
        if (evErr || !ev) throw httpError(400, 'Unknown event.');
        if (ev.day_of_week !== dow) throw httpError(400, "That event isn't scheduled on that day.");
        eventName = ev.name;
      }

      const { data: row, error } = await supabase.from('loa_entries').insert({
        discord_id: discordId,
        display_name: (displayName || '').slice(0, 120),
        type: 'recurring',
        event_date: null,
        event_schedule_id: eventScheduleId || null,
        start_date: null,
        end_date: null,
        day_of_week: dow,
        start_time: cleanStartTime,
        reason: cleanReason.slice(0, 500),
      }).select('id').single();
      if (error) { console.error('loa.submitRecurring error:', error.message); throw httpError(500, 'Failed to submit LOA.'); }
      return { id: row.id, eventName };
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

module.exports.todayInGuildTz = todayInGuildTz;
module.exports.parseTimeOfDay = parseTimeOfDay;
