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

export function fmtDatetime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
