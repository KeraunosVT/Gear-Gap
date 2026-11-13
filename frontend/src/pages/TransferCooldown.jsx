// frontend/src/pages/TransferCooldown.jsx — everyone's server transfer
// cooldown, counting down live.
//
// Members enter what the game shows as left (days + hours, 30 days at most);
// the server turns that into an end time, so nobody has to come back and
// update it. The list ticks every 30 seconds, and refetches every few minutes
// so other people's updates appear without a reload.
import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { ArrowRightLeft, Check, Clock, Loader2, Trash2 } from 'lucide-react';
import { useAuth } from '../auth';
import { PageShell } from '../components/ui/PageShell';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import ErrorState from '../components/ui/ErrorState';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';
import { useT } from '../i18n';
import { fmtDatetime } from '../timeUtils';

const TICK_MS = 30_000;
const REFETCH_MS = 5 * 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INPUT = 'bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass';

// "12d 5h", "5h 3m", "3m" — minutes only once it's under a day, where they
// start to matter. Rounded up, so it never says 0m while time is left.
function timeLeft(ms) {
  const mins = Math.ceil(ms / MINUTE);
  const d = Math.floor(mins / (24 * 60));
  const h = Math.floor((mins % (24 * 60)) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function TransferCooldown() {
  const { t } = useT();
  const { user } = useAuth();
  const [rows, setRows] = useState([]);
  const [maxDays, setMaxDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [days, setDays] = useState('');
  const [hours, setHours] = useState('');
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [msg, flash] = useFlash();

  const load = useCallback(() => axios.get('/api/transfer-cooldowns')
    .then((res) => {
      setRows(res.data.cooldowns || []);
      if (res.data.max_days) setMaxDays(res.data.max_days);
      setError('');
    })
    .catch((err) => setError(err.response?.data?.error || t('xfer.loadFailed')))
    .finally(() => setLoading(false)), [t]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), TICK_MS);
    const refetch = setInterval(load, REFETCH_MS);
    return () => { clearInterval(tick); clearInterval(refetch); };
  }, [load]);

  const mine = rows.find((r) => String(r.discord_id) === String(user?.id)) || null;
  const sorted = useMemo(() => [...rows].sort((a, b) => Date.parse(a.ends_at) - Date.parse(b.ends_at)), [rows]);

  // Checked here as well as on the server, so the button can say why it's off.
  const d = days === '' ? 0 : Number(days);
  const h = hours === '' ? 0 : Number(hours);
  const total = (Number.isInteger(d) && d >= 0 ? d : NaN) * DAY + (Number.isInteger(h) && h >= 0 && h <= 23 ? h : NaN) * HOUR;
  const problem = Number.isNaN(total) ? t('xfer.wholeNumbers')
    : total <= 0 ? null
      : total > maxDays * DAY ? t('xfer.tooLong', { max: maxDays })
        : null;

  const save = async (e) => {
    e.preventDefault();
    if (problem || total <= 0) return;
    setSaving(true);
    try {
      await axios.put('/api/transfer-cooldowns/mine', { days: d, hours: h });
      setDays(''); setHours('');
      flash(t('xfer.saved'));
      load();
    } catch (err) {
      flash(err.response?.data?.error || t('xfer.saveFailed'), false);
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!window.confirm(t('xfer.confirmClear'))) return;
    try {
      await axios.delete('/api/transfer-cooldowns/mine');
      flash(t('xfer.cleared'));
      load();
    } catch (err) {
      flash(err.response?.data?.error || t('xfer.saveFailed'), false);
    }
  };

  if (loading) return <PageShell width="narrow"><EmptyState>{t('xfer.loading')}</EmptyState></PageShell>;
  if (error && rows.length === 0) {
    return (
      <PageShell width="narrow">
        <ErrorState title={t('xfer.unreachable')} message={error} onRetry={() => { setLoading(true); load(); }} />
      </PageShell>
    );
  }

  const mineLeft = mine ? Date.parse(mine.ends_at) - now : null;

  return (
    <PageShell width="narrow">
      <div className="flex items-center gap-3 mb-2">
        <ArrowRightLeft className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">{t('xfer.title')}</h1>
      </div>
      <p className="text-ash text-sm mb-8">{t('xfer.intro', { max: maxDays })}</p>

      <Toast msg={msg} />

      {/* Yours: where it stands, and the form to set or replace it. */}
      <form onSubmit={save} className="panel rounded-lg p-5 mb-8">
        <div className="eyebrow text-[10px] text-brass mb-3">{t('xfer.yours')}</div>
        {mine && (
          <div className="flex items-center gap-3 flex-wrap mb-4 text-sm">
            {mineLeft > 0 ? (
              <span className="inline-flex items-center gap-1.5 text-bone">
                <Clock className="w-4 h-4 text-brass" />
                {t('xfer.yoursLeft', { left: timeLeft(mineLeft) })}
                <span className="text-ash">· {t('xfer.ends', { when: fmtDatetime(mine.ends_at) })}</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-emerald-400"><Check className="w-4 h-4" /> {t('xfer.yoursReady')}</span>
            )}
            <Button type="button" variant="ghost" size="sm" icon={<Trash2 className="w-4 h-4" />} onClick={clear}>
              {t('xfer.clear')}
            </Button>
          </div>
        )}
        <div className="flex items-end gap-3 flex-wrap">
          <label className="block">
            <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">{t('xfer.days')}</span>
            <input type="number" min="0" max={maxDays} step="1" inputMode="numeric" value={days}
              onChange={(e) => setDays(e.target.value)} placeholder="0" className={`w-24 ${INPUT}`} />
          </label>
          <label className="block">
            <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">{t('xfer.hours')}</span>
            <input type="number" min="0" max="23" step="1" inputMode="numeric" value={hours}
              onChange={(e) => setHours(e.target.value)} placeholder="0" className={`w-24 ${INPUT}`} />
          </label>
          <Button type="submit" size="sm" disabled={saving || Boolean(problem) || !(total > 0)}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} {mine ? t('xfer.update') : t('xfer.save')}
          </Button>
        </div>
        <p className={`text-xs mt-2 ${problem ? 'text-oxblood' : 'text-ash/70'}`}>{problem || t('xfer.hint', { max: maxDays })}</p>
      </form>

      {/* Everyone's, soonest first. Ended ones read Ready for a week. */}
      <div className="eyebrow text-[10px] text-brass mb-3">{t('xfer.everyone', { count: sorted.length })}</div>
      {sorted.length === 0 ? (
        <EmptyState>{t('xfer.none')}</EmptyState>
      ) : (
        <div className="panel rounded-lg divide-y divide-line">
          {sorted.map((r) => {
            const left = Date.parse(r.ends_at) - now;
            const isMe = String(r.discord_id) === String(user?.id);
            return (
              <div key={r.discord_id} className={`flex items-center gap-3 px-4 py-3 ${isMe ? 'bg-panelup' : ''}`}>
                <span className="text-bone truncate flex-1">{r.display_name || t('cal.member')}</span>
                <span className="text-xs text-ash hidden sm:inline">{fmtDatetime(r.ends_at)}</span>
                {left > 0 ? (
                  <span className="font-mono text-sm text-brassbright w-24 text-right">{timeLeft(left)}</span>
                ) : (
                  <span className="inline-flex items-center justify-end gap-1 text-sm text-emerald-400 w-24">
                    <Check className="w-3.5 h-3.5" /> {t('xfer.ready')}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
