// Reading a typed time ("fri 8pm", "tomorrow 20:30", "in 2h") as an instant,
// on the clock of whoever typed it.
//
// No date library: Intl knows every IANA zone and its DST rules, which is all
// converting a wall-clock time needs. What it can't do directly is go from a
// wall time in a zone to UTC, so zonedToUtc() asks it for the zone's offset
// near the target and corrects once.
//
// Everything takes `now` as a parameter so the tests can pin it.

const DAY_MS = 86_400_000;
const MAX_AHEAD_DAYS = 90;

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// What people type for a zone, mapped to one that follows DST properly.
const ZONE_ALIASES = {
  utc: 'UTC', gmt: 'UTC', z: 'UTC',
  et: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', eastern: 'America/New_York',
  ct: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', central: 'America/Chicago',
  mt: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver', mountain: 'America/Denver',
  pt: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pacific: 'America/Los_Angeles',
  brt: 'America/Sao_Paulo', bst: 'Europe/London', uk: 'Europe/London',
  cet: 'Europe/Berlin', cest: 'Europe/Berlin', eet: 'Europe/Athens', eest: 'Europe/Athens',
  kst: 'Asia/Seoul', jst: 'Asia/Tokyo', aest: 'Australia/Sydney', aedt: 'Australia/Sydney',
};

// Offered first when the zone box is empty.
const COMMON_ZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Berlin', 'Europe/Athens', 'Asia/Seoul', 'Asia/Tokyo', 'Australia/Sydney', 'UTC',
];

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// "est" → America/New_York, "america/new_york" → America/New_York. Null if
// it isn't a zone.
function resolveTimeZone(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const alias = ZONE_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  const exact = allZones().find((z) => z.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  return isValidTimeZone(raw) ? raw : null;
}

let zoneList = null;
function allZones() {
  if (!zoneList) zoneList = [...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])];
  return zoneList;
}

// Up to 25 zones for an autocomplete box.
function zoneSuggestions(typed) {
  const q = String(typed || '').trim().toLowerCase();
  if (!q) return COMMON_ZONES;
  const alias = ZONE_ALIASES[q];
  const hits = allZones().filter((z) => z.toLowerCase().replace(/_/g, ' ').includes(q.replace(/_/g, ' ')));
  return [...new Set([...(alias ? [alias] : []), ...hits])].slice(0, 25);
}

// The wall clock in `tz` at instant `ms`.
function wallParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: WEEKDAYS.indexOf(get('weekday').toLowerCase().slice(0, 3)),
  };
}

// How far `tz` is ahead of UTC at instant `ms`.
function offsetMs(ms, tz) {
  const w = wallParts(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

// The instant when the clock in `tz` reads the given wall time. A time that
// doesn't exist (the hour skipped when DST starts) lands an hour later, which
// is what the clock on the wall does too.
function zonedToUtc({ year, month, day, hour, minute }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz);
  const reads = (ms) => {
    const w = wallParts(ms, tz);
    return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute;
  };
  if (reads(first)) return first;
  if (reads(second)) return second;
  return Math.max(first, second); // in the gap
}

// Calendar arithmetic on a { year, month, day }, done in UTC so it never
// meets a DST change.
function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day) + n * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// "8pm", "8:30 pm", "20:00", "noon". Returns { hour, minute }, an { error },
// or null if `s` isn't trying to be a time at all.
function parseClock(s) {
  if (s === 'noon') return { hour: 12, minute: 0 };
  if (s === 'midnight') return { hour: 0, minute: 0 };
  const m = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3]?.[0];
  if (minute > 59) return { error: `"${s}" isn't a time.` };
  if (meridiem) {
    if (hour < 1 || hour > 12) return { error: `"${s}" isn't a time.` };
    hour = (hour % 12) + (meridiem === 'p' ? 12 : 0);
  } else {
    if (hour > 23) return { error: `"${s}" isn't a time.` };
    // A bare "8" is a coin flip between morning and evening; ask rather than guess.
    if (!m[2]) return { error: `Did you mean ${hour}am or ${hour}pm? Add am/pm, or write it as ${String(hour).padStart(2, '0')}:00.` };
  }
  return { hour, minute };
}

// The date part, relative to today on the poster's clock. Returns
// { date, flexible } — flexible means "the next one of these", so a time
// already gone today rolls to the next — or { error }, or null.
function parseDay(s, today) {
  if (s === '') return { date: today, flexible: 'day' };
  if (s === 'today' || s === 'tonight') return { date: today };
  if (['tomorrow', 'tmr', 'tmrw', 'tom'].includes(s)) return { date: addDays(today, 1) };

  const wd = /^(next\s+)?([a-z]+)$/.exec(s);
  if (wd) {
    const idx = WEEKDAYS.findIndex((d) => wd[2].startsWith(d) && (wd[2].length === 3 || dayName(d).startsWith(wd[2])));
    if (idx >= 0) {
      const ahead = (idx - today.weekday + 7) % 7;
      return { date: addDays(today, ahead), flexible: 'week' };
    }
  }

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validDate(Number(m[1]), Number(m[2]), Number(m[3]), s);

  // "nov 21", "november 21st", "21 nov".
  m = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(s) || /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?$/.exec(s);
  if (m) {
    const [monthWord, dayNum] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const month = MONTHS.findIndex((mo) => monthWord.startsWith(mo)) + 1;
    if (month > 0) {
      const result = validDate(today.year, month, Number(dayNum), s);
      if (result.date) result.flexible = 'year';
      return result;
    }
  }
  return null;
}

const DAY_NAMES = { sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday' };
const dayName = (d) => DAY_NAMES[d];

function validDate(year, month, day, s) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return { error: `"${s}" isn't a date.` };
  return { date: { year, month, day } };
}

const RELATIVE_UNITS = { d: DAY_MS, h: 3_600_000, m: 60_000 };

// "in 2h", "in 1h 30m", "in 90 minutes".
function parseRelative(s) {
  const body = /^in\s+(.+)$/.exec(s)?.[1];
  if (!body) return null;
  const re = /(\d+)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?)\b/g;
  let total = 0;
  let consumed = '';
  for (const m of body.matchAll(re)) {
    total += Number(m[1]) * RELATIVE_UNITS[m[2][0]];
    consumed += m[0];
  }
  if (!total || consumed.replace(/\s/g, '') !== body.replace(/\s|and|,/g, '')) {
    return { error: `Couldn't read "${s}". Try something like "in 2h" or "in 1h 30m".` };
  }
  return { ms: total };
}

// The whole thing. Returns { ok: true, date } or { ok: false, error } with a
// message that can go straight back to the person who typed it.
function parseWhen(input, { timeZone, now = Date.now() } = {}) {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const s = String(input || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return { ok: false, error: 'Say when the run starts, e.g. "fri 8pm".' };

  let ms = null;

  // A Discord timestamp (<t:1732233600:F>) or bare unix seconds: already exact.
  const stamp = /^<t:(\d{9,11})(?::[a-z])?>$/i.exec(s) || /^(\d{9,11})$/.exec(s);
  if (stamp) ms = Number(stamp[1]) * 1000;

  if (ms === null) {
    const rel = parseRelative(s);
    if (rel?.error) return { ok: false, error: rel.error };
    if (rel) ms = nowMs + rel.ms;
  }

  if (ms === null) {
    // Split off the time at the end; what's left (minus a trailing "at") is the day.
    const m = /^(.*?)(?:\s+at\s+|\s*@\s*|\s+|^)(noon|midnight|\d{1,2}(?:[:.h]\d{2})?\s*(?:am|pm|a|p)?)$/.exec(s);
    if (!m) {
      const dayOnly = parseDay(s, wallParts(nowMs, tz));
      return { ok: false, error: dayOnly && !dayOnly.error ? 'Add a time too, e.g. "fri 8pm".' : `Couldn't read "${input}". Try "fri 8pm", "tomorrow 20:30", "nov 21 9pm" or "in 2h".` };
    }
    const today = wallParts(nowMs, tz);
    const clock = parseClock(m[2].trim());
    if (!clock) return { ok: false, error: `Couldn't read the time in "${input}".` };
    if (clock.error) {
      // "nov 21" reads as day "nov" at "21" — it's a date with no time.
      const whole = parseDay(s, today);
      return { ok: false, error: whole?.date ? 'Add a time too, e.g. "nov 21 8pm".' : clock.error };
    }
    const day = parseDay(m[1].trim(), today);
    if (!day) return { ok: false, error: `Couldn't read the day in "${input}". Try "today", "tomorrow", a weekday, "nov 21" or 2026-11-21.` };
    if (day.error) return { ok: false, error: day.error };

    ms = zonedToUtc({ ...day.date, ...clock }, tz);
    // "8pm" when it's 9pm means tomorrow; "fri 8pm" on a Friday at 9pm means
    // next Friday; "jan 3" in December means next January.
    if (ms <= nowMs && day.flexible) {
      const next = day.flexible === 'day' ? addDays(day.date, 1)
        : day.flexible === 'week' ? addDays(day.date, 7)
          : { ...day.date, year: day.date.year + 1 };
      ms = zonedToUtc({ ...next, ...clock }, tz);
    }
  }

  if (ms <= nowMs) return { ok: false, error: `That's in the past (<t:${Math.floor(ms / 1000)}:F>).` };
  if (ms > nowMs + MAX_AHEAD_DAYS * DAY_MS) return { ok: false, error: `Runs can be posted up to ${MAX_AHEAD_DAYS} days ahead.` };
  return { ok: true, date: new Date(ms) };
}

// "2026-11-21 20:00" on `tz`'s clock: what the edit form is pre-filled with,
// and a format parseWhen reads back exactly.
function formatForInput(date, tz) {
  const w = wallParts(new Date(date).getTime(), isValidTimeZone(tz) ? tz : 'UTC');
  const p = (n) => String(n).padStart(2, '0');
  return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)}`;
}

// "Fri, Nov 21, 8:00 PM" on `tz`'s clock, for autocomplete labels (which
// can't render Discord timestamps).
function formatShort(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: isValidTimeZone(tz) ? tz : 'UTC',
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(date));
}

// Autocomplete for the "when" box: what they've typed, read back on their
// clock so a wrong guess shows before they post. Labels can't render Discord
// timestamps, so they're spelled out.
function whenSuggestions(typed, tz, now = Date.now()) {
  const t = String(typed || '').trim();
  const label = (s, date) => `${s} → ${formatShort(date, tz)} (${tz})`.slice(0, 100);
  if (!t) {
    return ['today 8pm', 'tomorrow 8pm', 'sat 8pm', 'sun 8pm', 'in 1h']
      .map((s) => ({ s, r: parseWhen(s, { timeZone: tz, now }) }))
      .filter(({ r }) => r.ok)
      .map(({ s, r }) => ({ name: label(s, r.date), value: s }));
  }
  const r = parseWhen(t, { timeZone: tz, now });
  const value = t.slice(0, 100);
  if (r.ok) return [{ name: `✓ ${label(t, r.date)}`.slice(0, 100), value }];
  const error = r.error.includes('<t:') ? "That's in the past." : r.error;
  return [{ name: `⚠ ${error}`.slice(0, 100), value }];
}

const unix = (date) => Math.floor(new Date(date).getTime() / 1000);

module.exports = {
  parseWhen, zonedToUtc, isValidTimeZone, resolveTimeZone, zoneSuggestions,
  whenSuggestions, formatForInput, formatShort, unix, MAX_AHEAD_DAYS,
};
