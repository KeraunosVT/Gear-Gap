// ── GUILD TIME, CONFIGURED AT RUNTIME ────────────────────────────────────────
// These were two exported consts. They are now module state, set once by the
// guild provider (src/guild.jsx) from GET /api/guild before anything renders,
// because both live in guild_config and are editable from Guild Settings.
//
// Every function below reads them LIVE rather than closing over them at module
// scope. That is the whole point: a copy taken at import time would be the
// hardcoded default forever, and the symptom is not an error — it is an entire
// night's LOA, signups and attendance quietly filed against the wrong date.
//
// The defaults here are only what applies for the instant between the bundle
// loading and the provider's fetch resolving. Nothing renders in that window.
let guildTz = 'America/New_York';

// Mirror of the guild-night model in backend/loa.js — keep the two in step.
// A guild night doesn't end at midnight: the 12:30am Guild Field Boss is the
// tail of the previous evening's block, not the start of a new day. The
// schedule stores each event on the calendar day it actually occurs (Sunday
// 00:30), and these map it back to the night it belongs to (Saturday).
let guildDayStart = '01:00';
let guildDayStartMin = 60;

const MINUTES_PER_DAY = 1440;

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

// Called by the guild provider. Both arguments are validated on the way in:
// a bad timezone would otherwise throw inside Intl on every date the site
// renders, which turns one bad settings value into a blank page.
export function configureGuildTime(timezone, dayStart) {
  if (timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      guildTz = timezone;
    } catch {
      console.error(`Ignoring unusable guild timezone "${timezone}" — falling back to ${guildTz}.`);
    }
  }
  if (/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(dayStart || ''))) {
    guildDayStart = dayStart;
    guildDayStartMin = minutesOf(dayStart);
  }
}

export const getGuildTz = () => guildTz;
export const getGuildDayStart = () => guildDayStart;

// Where a wall-clock time falls within the guild night, as minutes from its
// start — so 00:30 (1470) sorts after 21:00 (1260) instead of before it, which
// is what comparing "HH:MM" as text would give you.
export function daySlot(hhmm) {
  const mins = minutesOf(hhmm);
  return mins < guildDayStartMin ? mins + MINUTES_PER_DAY : mins;
}

// Does an event at `eventTime` fall inside this LOA entry's absence window?
// No start_time means no restriction; a start with no end is an open-ended
// cutoff ("out from this time onward"); both is a bounded window they're back
// after. An event with no recorded time can't be compared, so it counts as
// covered.
//
// Mirrors withinLoaWindow in backend/loa.js — the two are held in step by
// backend/test/guildNightConformance.test.js, which drives both and fails if
// they ever disagree. Lived in EventCalendar.jsx as a third copy until it moved
// here; it belongs beside daySlot, which is the only thing it depends on.
export function withinLoaWindow(entry, eventTime) {
  if (!entry.start_time || !eventTime) return true;
  const at = daySlot(eventTime);
  const from = daySlot(entry.start_time);
  if (at < from) return false;
  if (!entry.end_time) return true;
  // An end no later than the start ran past the rollover ("out 11pm-1am"), so
  // it closes on the next slot round rather than the current one.
  let to = daySlot(entry.end_time);
  if (to <= from) to += MINUTES_PER_DAY;
  return at < to;
}

// Does this LOA still apply on or after `today` (a guild-night YYYY-MM-DD)?
// Recurring entries never expire — that is the point of them — so anything
// counting "absences on file" has to treat them as permanently live rather
// than looking for an end date they don't have.
export function loaStillApplies(entry, today) {
  if (entry.type === 'recurring') return true;
  if (entry.type === 'event') return (entry.event_date || '') >= today;
  if (entry.type === 'range') return (entry.end_date || '') >= today;
  return false;
}

// Calendar-date arithmetic on a YYYY-MM-DD string. Anchored at noon UTC so a
// browser in any timezone lands on the same date — midnight anchoring is one
// DST hour away from returning the previous day.
//
// Was written out three separate times (eventSignups, EventCalendar, Home)
// before landing here.
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The day-of-week a scheduled event belongs to, from the calendar day and time
// it's stored under: a 00:30 event stored on Sunday is part of Saturday night.
export function guildDayOfWeek(dow, eventTime) {
  if (!eventTime || minutesOf(eventTime) >= guildDayStartMin) return dow;
  return (dow + 6) % 7;
}

// True when an event runs after midnight, so its calendar day is a day ahead
// of the night it belongs to — worth labelling wherever it's listed.
export const isAfterMidnight = (eventTime) => Boolean(eventTime) && minutesOf(eventTime) < guildDayStartMin;

// Events for one guild night, newest-last. Not a plain day_of_week filter:
// Saturday night's list has to pull in the Sunday 00:30 row and leave Sunday
// evening's rows out.
export function eventsForGuildDay(schedule, dow) {
  return (schedule || [])
    .filter((s) => guildDayOfWeek(s.day_of_week, s.event_time) === dow)
    .sort((a, b) => (a.event_time ? daySlot(a.event_time) : -1) - (b.event_time ? daySlot(b.event_time) : -1)
      || String(a.name).localeCompare(String(b.name)));
}

// "Today" as YYYY-MM-DD in the guild's own timezone, not the browser's. Plain
// new Date().toISOString().slice(0, 10) reads the UTC calendar day, which
// rolls over to tomorrow from ~7-8pm ET onward — right when officers are
// building rosters for that night's event — so date defaults/comparisons
// against LOA entries need this instead. Rolls at GUILD_DAY_START rather than
// midnight for the same reason: at 12:30am the night in progress is still
// last night's.
export function todayInGuildTz() {
  const shifted = new Date(Date.now() - guildDayStartMin * 60_000);
  return shifted.toLocaleDateString('en-CA', { timeZone: guildTz });
}

// The guild timezone's short name ("ET", "GMT", "AEDT") as of right now.
//
// "Right now" is the honest answer available: these are bare recurring times
// with no date attached, so there is no instant to resolve DST against. During
// the fortnight either side of a transition the suffix can read a week early or
// late; the alternative is picking an arbitrary date, which is wrong more often.
//
// Intl gives "EST"/"EDT" for US zones; the leading region letter plus "T" is
// the form people actually write, so those collapse to "ET". Anything that
// doesn't match that shape (GMT, UTC, +05:30) passes through untouched.
function guildZoneAbbrev() {
  const raw = new Intl.DateTimeFormat('en-US', { timeZone: guildTz, timeZoneName: 'short' })
    .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
  const seasonal = /^([A-Z])[SD]T$/.exec(raw);
  return seasonal ? `${seasonal[1]}T` : raw;
}

// Named for the guild's timezone, not the browser's — a recurring event time is
// stored as the guild's wall clock and is meaningless in any other zone. The
// name is historical: this was hardcoded to ET back when the timezone was too.
export function fmtTimeEst(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const zone = guildZoneAbbrev();
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}${zone ? ` ${zone}` : ''}`;
}

// Per-member display preference for how full timestamps (created_at,
// awarded_at, etc.) are shown — defaults to guild time until a member
// explicitly picks something else in Settings. Bare recurring times
// (fmtTimeEst above — event schedules, LOA windows) are NOT affected by this
// and stay in ET regardless: they have no attached date, so there's no safe
// way to resolve DST when converting them to an arbitrary zone.
const DISPLAY_TZ_KEY = 'displayTimezone';

export function getDisplayTimezone() {
  return localStorage.getItem(DISPLAY_TZ_KEY) || guildTz;
}

export function setDisplayTimezone(tz) {
  localStorage.setItem(DISPLAY_TZ_KEY, tz);
}

// Curated list for the Settings picker — not every IANA zone, just enough to
// cover where members are likely to be.
export const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'America/Anchorage', label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (HST)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Central Europe (CET)' },
  { value: 'Europe/Moscow', label: 'Moscow (MSK)' },
  { value: 'Asia/Dubai', label: 'Dubai (GST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Shanghai', label: 'China (CST)' },
  { value: 'Asia/Tokyo', label: 'Japan (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AET)' },
];

export function fmtDatetime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const tz = getDisplayTimezone();
  const zoneName = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(d).find((p) => p.type === 'timeZoneName')?.value || '';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZone: tz,
  }) + (zoneName ? ` ${zoneName}` : '');
}
