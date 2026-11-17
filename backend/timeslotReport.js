// backend/timeslotReport.js — attendance and LOA by hour of the night.
//
// Every logged night is filed under the hour its event starts, on the guild's
// clock: a 9:00 or 9:30 PM event is the 9–10 PM slot. Each current member's
// chance at that night is then one of three things, by exactly the rules the
// Missed Events table uses — so the two never disagree about the same night:
//
//   attended  in the channel (or added by an approved late request)
//   loa       not there, and an LOA covered it (a signup beats an LOA)
//   missed    not there, and nothing covered it
//
// Nights from before someone joined don't count for them at all, unless they
// attended anyway (eligibleCount's rule).
//
// Where a night's start time comes from:
//   - a weekly event: its scheduled time. Events don't record the time they
//     ran, so if a schedule entry's time was changed, its earlier nights move
//     to the new hour.
//   - a one-off: when attendance was taken (created_at), but only if that was
//     on the same guild night — a night logged the next day has no usable time.
// Anything else goes in one "Time unknown" row.

const { countsFor } = require('./memberTenure');
const { daySlot, guildDateOf, guildTz } = require('./loa');

const UNKNOWN = 'unknown';
const MAX_EVENT_NAMES = 6;

const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

// The guild-clock hour (0–23) an instant falls in.
function guildHourOf(ms) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: guildTz(), hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).find((p) => p.type === 'hour')?.value;
  const n = parseInt(h, 10);
  return Number.isInteger(n) ? n % 24 : null;
}

// The hour a logged night started, or null when there's no telling.
function startHour(e, scheduleById) {
  const s = e.event_schedule_id ? scheduleById.get(String(e.event_schedule_id)) : null;
  if (s && /^\d{1,2}:\d{2}/.test(s.event_time || '')) return parseInt(s.event_time, 10) % 24;
  if (!e.event_schedule_id && e.created_at) {
    const ms = Date.parse(e.created_at);
    if (Number.isFinite(ms) && guildDateOf(ms) === String(e.event_date).slice(0, 10)) return guildHourOf(ms);
  }
  return null;
}

/**
 * @param {object} p
 * @param {Array<{id, title, event_date, event_schedule_id, created_at}>} p.events  logged nights in the window
 * @param {Array<{discord_id, event_id}>} p.attendance                                attendance rows for them
 * @param {Array<{id, name, event_time}>} p.schedule                                  the weekly schedule
 * @param {Array<{id, name}>} p.people                                                who to count (current members)
 * @param {Map<string, object>} p.tenures                                             discord_id -> tenure
 * @param {Map<string, Set<string>>} p.loaByEvent                                     event id -> ids covered by an LOA
 */
function buildTimeslotReport({ events, attendance, schedule, people, tenures, loaByEvent }) {
  const scheduleById = new Map((schedule || []).map((s) => [String(s.id), s]));
  const attendedBy = new Map(); // event id -> Set of discord ids
  (attendance || []).forEach((a) => {
    const key = String(a.event_id);
    if (!attendedBy.has(key)) attendedBy.set(key, new Set());
    attendedBy.get(key).add(String(a.discord_id));
  });

  const slots = new Map();
  const slotFor = (hour) => {
    const key = hour === null ? UNKNOWN : String(hour);
    if (!slots.has(key)) {
      slots.set(key, {
        key, hour, nights: 0, attended: 0, loa: 0, missed: 0, names: new Map(), byMember: new Map(),
      });
    }
    return slots.get(key);
  };

  (events || []).forEach((e) => {
    const slot = slotFor(startHour(e, scheduleById));
    slot.nights += 1;
    const s = e.event_schedule_id ? scheduleById.get(String(e.event_schedule_id)) : null;
    const name = (s && s.name) || e.title || 'Event';
    slot.names.set(name, (slot.names.get(name) || 0) + 1);

    const here = attendedBy.get(String(e.id)) || new Set();
    const covered = loaByEvent.get(String(e.id)) || new Set();
    (people || []).forEach(({ id }) => {
      const pid = String(id);
      let status;
      if (here.has(pid)) status = 'attended';
      else if (!countsFor(tenures.get(pid), e.event_date)) return; // not a member yet
      else status = covered.has(pid) ? 'loa' : 'missed';
      slot[status] += 1;
      if (!slot.byMember.has(pid)) slot.byMember.set(pid, { attended: 0, loa: 0, missed: 0 });
      slot.byMember.get(pid)[status] += 1;
    });
  });

  const nameOf = new Map((people || []).map((p) => [String(p.id), p.name]));
  // In night order: evening first, then the hours after midnight that still
  // belong to the night (daySlot), unknown last.
  const order = (s) => (s.hour === null ? Infinity : daySlot(`${String(s.hour).padStart(2, '0')}:00`));
  return [...slots.values()]
    .sort((a, b) => order(a) - order(b))
    .map(({ byMember, names, ...s }) => {
      const total = s.attended + s.loa + s.missed;
      return {
        ...s,
        // Which events made up this hour, most nights first.
        events: [...names].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, MAX_EVENT_NAMES).map(([name, nights]) => ({ name, nights })),
        member_nights: total,
        attended_pct: pct(s.attended, total),
        loa_pct: pct(s.loa, total),
        missed_pct: pct(s.missed, total),
        // Headcount, not a rate: how many turned up on an average night.
        avg_present: s.nights ? Math.round((s.attended / s.nights) * 10) / 10 : 0,
        members: [...byMember].map(([id, c]) => {
          const n = c.attended + c.loa + c.missed;
          return { discord_id: id, display_name: nameOf.get(id) || id, ...c, nights: n, attended_pct: pct(c.attended, n) };
        }).sort((a, b) => b.missed - a.missed || (a.attended_pct ?? 0) - (b.attended_pct ?? 0)
          || a.display_name.localeCompare(b.display_name)),
      };
    });
}

module.exports = { buildTimeslotReport, UNKNOWN };
