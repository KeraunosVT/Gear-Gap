export const GUILD_TZ = 'America/New_York';

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: GUILD_TZ });
  const inGuildTz = new Date(`${today}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`);
  const utcMs = inGuildTz.getTime() - tzOffsetMs(inGuildTz);
  return new Date(utcMs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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

function tzOffsetMs(ref) {
  const utc = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tz = new Date(ref.toLocaleString('en-US', { timeZone: GUILD_TZ }));
  return tz.getTime() - utc.getTime();
}
