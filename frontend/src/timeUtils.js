export const GUILD_TZ = 'America/New_York';

// "Today" as YYYY-MM-DD in the guild's own timezone, not the browser's. Plain
// new Date().toISOString().slice(0, 10) reads the UTC calendar day, which
// rolls over to tomorrow from ~7-8pm ET onward — right when officers are
// building rosters for that night's event — so date defaults/comparisons
// against LOA entries need this instead.
export function todayInGuildTz() {
  return new Date().toLocaleDateString('en-CA', { timeZone: GUILD_TZ });
}

export function fmtTimeEst(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm} ET`;
}

// Per-member display preference for how full timestamps (created_at,
// awarded_at, etc.) are shown — defaults to guild time until a member
// explicitly picks something else in Settings. Bare recurring times
// (fmtTimeEst above — event schedules, LOA windows) are NOT affected by this
// and stay in ET regardless: they have no attached date, so there's no safe
// way to resolve DST when converting them to an arbitrary zone.
const DISPLAY_TZ_KEY = 'displayTimezone';

export function getDisplayTimezone() {
  return localStorage.getItem(DISPLAY_TZ_KEY) || GUILD_TZ;
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
