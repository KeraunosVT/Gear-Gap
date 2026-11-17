// backend/timeslotReport.js — attendance and LOA split by weekly event slot.
//
// Every logged night is filed under the weekly schedule entry it was logged
// against ("Tue 9:00 PM · Wargame"). Each current member's chance at that night
// is then one of three things, by exactly the rules the Missed Events table
// uses — so the two never disagree about the same night:
//
//   attended  in the channel (or added by an approved late request)
//   loa       not there, and an LOA covered it (a signup beats an LOA)
//   missed    not there, and nothing covered it
//
// Nights from before someone joined don't count for them at all, unless they
// attended anyway (eligibleCount's rule).
//
// Nights logged with no schedule entry (one-offs) share one "One-off events"
// row. A slot is keyed by schedule id, so if an event's time was changed its
// earlier nights show under the new time — events don't record the time they
// ran.

const { countsFor } = require('./memberTenure');
const { guildDayOfWeek, daySlot } = require('./loa');

const ONE_OFF = 'one-off';
// Monday first, as the Event Calendar lays the week out.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const pct = (n, d) => (d ? Math.round((n / d) * 100) : null);

/**
 * @param {object} p
 * @param {Array<{id, title, event_date, event_schedule_id}>} p.events   logged nights in the window
 * @param {Array<{discord_id, event_id}>} p.attendance                     attendance rows for them
 * @param {Array<{id, name, day_of_week, event_time}>} p.schedule          the weekly schedule
 * @param {Array<{id, name}>} p.people                                     who to count (current members)
 * @param {Map<string, object>} p.tenures                                  discord_id -> tenure
 * @param {Map<string, Set<string>>} p.loaByEvent                          event id -> ids covered by an LOA
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
  const slotFor = (e) => {
    const sid = e.event_schedule_id ? String(e.event_schedule_id) : null;
    const key = sid || ONE_OFF;
    if (!slots.has(key)) {
      const s = sid ? scheduleById.get(sid) : null;
      slots.set(key, {
        key,
        schedule_id: sid,
        // A deleted schedule entry still has its nights; they're named from
        // the night's own title and flagged as no longer scheduled.
        name: s ? s.name : sid ? (e.title || 'Event') : 'One-off events',
        night: s ? guildDayOfWeek(s.day_of_week, s.event_time) : null,
        event_time: s ? s.event_time || null : null,
        retired: Boolean(sid && !s),
        nights: 0,
        attended: 0,
        loa: 0,
        missed: 0,
        byMember: new Map(),
      });
    }
    return slots.get(key);
  };

  (events || []).forEach((e) => {
    const slot = slotFor(e);
    slot.nights += 1;
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
  const rank = (s) => (s.night === null ? 99 : WEEK_ORDER.indexOf(s.night));
  return [...slots.values()]
    .sort((a, b) => rank(a) - rank(b)
      || (a.event_time ? daySlot(a.event_time) : 9999) - (b.event_time ? daySlot(b.event_time) : 9999)
      || a.name.localeCompare(b.name))
    .map(({ byMember, ...s }) => {
      const total = s.attended + s.loa + s.missed;
      return {
        ...s,
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

module.exports = { buildTimeslotReport, ONE_OFF };
