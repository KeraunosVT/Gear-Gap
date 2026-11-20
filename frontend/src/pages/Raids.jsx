import { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import {
  Landmark, Megaphone, Bell, Lock, Trash2, Loader2, Check, ArrowDown, ArrowUp, X, Pencil, Armchair,
} from 'lucide-react';

import { fmtTimeEst, todayInGuildTz, isAfterMidnight } from '../timeUtils';
import Tabs from '../components/ui/Tabs';
import { PageShell } from '../components/ui/PageShell';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import ErrorState from '../components/ui/ErrorState';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';
import { useT, translate, fmtDay } from '../i18n';
import EventsNav from '../components/EventsNav';

// Raid runs: a member posts one for a night, picking which gates of which
// modes it covers, and people join in a role. Each role has a fixed number of
// slots; past that you go on the bench and move up when a slot in your role
// opens. Same Discord post machinery as War signups (backend/eventSignups.js).

const ROLES = ['Tank', 'DPS', 'Healer'];
// Same role colours as the Signups page, the roster and the party board.
const ROLE_TONE = { Tank: 'text-sky-400', Healer: 'text-emerald-400', DPS: 'text-oxblood' };
const ROLE_DOT = { Tank: 'bg-sky-400', Healer: 'bg-emerald-400', DPS: 'bg-oxblood' };
const ROLE_BORDER = { Tank: 'border-sky-400/60', Healer: 'border-emerald-400/60', DPS: 'border-oxblood/60' };
const ROLE_EMOJI = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };

const REMINDER_OPTIONS = [
  { value: '1440', label: 'raids.remind1d' },
  { value: '180', label: 'raids.remind3h' },
  { value: '60', label: 'raids.remind1h' },
  { value: '', label: 'raids.remindNone' },
];

const INPUT = 'bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass';

// { normal: [1,2,3], nightmare: [1] } <-> [{ mode, gates }], in catalog order.
const toSegments = (raid, picked) => raid.modes
  .filter((m) => picked[m.key]?.length)
  .map((m) => ({ mode: m.key, gates: [...picked[m.key]].sort((a, b) => a - b) }));
const fromSegments = (segments) => Object.fromEntries((segments || []).map((s) => [s.mode, [...s.gates]]));

const gateLabel = (gates) => gates.map((g) => `G${g}`).join(' ');

function nightLabel(dateStr, eventTime) {
  const md = fmtDay(dateStr, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = eventTime ? ` · ${fmtTimeEst(eventTime)}` : '';
  return `${md}${time}${isAfterMidnight(eventTime) ? ` (${translate('common.afterMidnight')})` : ''}`;
}

// The Mode × Gate grid, for posting a run and for editing one.
function GatePicker({ raid, picked, onChange }) {
  const { t } = useT();
  const gates = Array.from({ length: raid.gates }, (_, i) => i + 1);
  const toggle = (mode, g) => {
    const cur = picked[mode] || [];
    onChange({ ...picked, [mode]: cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g] });
  };
  return (
    <div role="group" aria-label={t('raids.modesAndGates')}
      className="grid gap-1.5 items-center" style={{ gridTemplateColumns: `minmax(5.5rem, auto) repeat(${raid.gates}, minmax(0, 1fr))` }}>
      <span />
      {gates.map((g) => <span key={g} className="eyebrow text-[10px] text-ash/75 text-center">{t('raids.gateN', { n: g })}</span>)}
      {raid.modes.map((m) => (
        <ModeRow key={m.key} mode={m} gates={gates} picked={picked[m.key] || []} onToggle={(g) => toggle(m.key, g)} />
      ))}
    </div>
  );
}

function ModeRow({ mode, gates, picked, onToggle }) {
  const { t } = useT();
  return (
    <>
      <span className="text-sm font-medium text-bone inline-flex items-center gap-2">
        <span className="w-2 h-2 rounded-full" style={{ background: mode.color }} />
        {t(`raids.mode.${mode.key}`)}
      </span>
      {gates.map((g) => {
        const on = picked.includes(g);
        return (
          <button key={g} type="button" onClick={() => onToggle(g)} aria-pressed={on}
            aria-label={t('raids.modeGate', { mode: t(`raids.mode.${mode.key}`), n: g })}
            className={`rounded-lg border py-2 text-sm transition-colors ${on ? 'text-bone' : 'border-line bg-hall text-ash hover:text-bone'}`}
            style={on ? { borderColor: mode.color, background: `color-mix(in srgb, ${mode.color} 14%, transparent)` } : undefined}>
            {on && <Check className="w-3.5 h-3.5 inline -mt-0.5 mr-1" style={{ color: mode.color }} />}G{g}
          </button>
        );
      })}
    </>
  );
}

function ModeChips({ raid, segments }) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {(segments || []).map((s) => {
        const mode = raid?.modes.find((m) => m.key === s.mode);
        const color = mode?.color || '#888';
        return (
          <span key={s.mode} className="text-xs rounded-full px-2.5 py-0.5 border"
            style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}>
            <b className="font-semibold mr-1">{t(`raids.mode.${s.mode}`)}</b>{gateLabel(s.gates)}
          </span>
        );
      })}
    </div>
  );
}

export default function Raids() {
  const { t } = useT();
  const { user } = useAuth();

  const [raids, setRaids] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [details, setDetails] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash();
  const [tab, setTab] = useState('upcoming');
  const [busy, setBusy] = useState('');

  // Post-a-run form. Starts on the run most guilds do first: all of Normal.
  const [formRaid, setFormRaid] = useState('');
  const [formDate, setFormDate] = useState(todayInGuildTz);
  const [formTime, setFormTime] = useState('21:00');
  const [formReminder, setFormReminder] = useState('1440');
  const [formGates, setFormGates] = useState({ normal: [1, 2, 3] });
  const [posting, setPosting] = useState(false);

  const loadDetail = useCallback((id) => axios.get(`/api/raids/${id}`)
    .then((res) => setDetails((d) => ({ ...d, [id]: res.data })))
    .catch(() => {}), []);

  // Every card shows its roster, so each run's detail is read alongside the
  // list. There are only ever a handful of runs open at once.
  const load = useCallback(() => {
    setError('');
    return axios.get('/api/raids')
      .then((res) => {
        const rows = res.data.raids || [];
        setRaids(rows);
        setCatalog(res.data.catalog || []);
        return Promise.all(rows.map((r) => loadDetail(r.id)));
      })
      .catch((err) => setError(err.response?.data?.error || t('raids.loadFailed')))
      .finally(() => setLoading(false));
  }, [loadDetail]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!formRaid && catalog.length) setFormRaid(catalog[0].key); }, [catalog, formRaid]);

  const raidByKey = useMemo(() => Object.fromEntries(catalog.map((r) => [r.key, r])), [catalog]);
  const formCatalogRaid = raidByKey[formRaid];
  const shown = tab === 'mine'
    ? raids.filter((r) => r.my_status || String(r.created_by) === String(user?.id))
    : raids;

  const refresh = useCallback(async (id) => {
    await load();
    if (id) await loadDetail(id);
  }, [load, loadDetail]);

  const run = async (key, fn) => {
    setBusy(key);
    try {
      const ok = await fn();
      if (ok) flash(ok);
    } catch (err) {
      flash(err.response?.data?.error || t('cal.didntWork'), false);
    } finally {
      setBusy('');
    }
  };

  const postRun = async (e) => {
    e.preventDefault();
    if (!formCatalogRaid) return;
    const segments = toSegments(formCatalogRaid, formGates);
    if (!segments.length) return flash(t('raids.pickGate'), false);
    setPosting(true);
    try {
      await axios.post('/api/raids', {
        raid_key: formRaid, event_date: formDate, event_time: formTime, segments, reminder_minutes: formReminder,
      });
      flash(t('raids.posted'));
      await load();
    } catch (err) {
      flash(err.response?.data?.error || t('raids.postFailed'), false);
    } finally {
      setPosting(false);
    }
  };

  // What a join tells you, mirroring the Discord replies.
  const joinMessage = (res) => {
    const role = t(`role.${res.role}`);
    let out;
    if (res.status === 'going') out = t('raids.joined', { role });
    else if (res.benchKind === 'overflow') out = t('raids.joinedOverflow', { role, n: res.position || 1 });
    else out = t('raids.joinedBench', { role });
    if (res.promoted) out += ` ${t('raids.promotedNote', { name: res.promoted.display_name })}`;
    return out;
  };

  const join = (row, role, bench = false) => run(`join:${row.id}`, async () => {
    const res = await axios.post(`/api/signups/${row.id}/join`, { role, bench });
    await refresh(row.id);
    return joinMessage(res.data);
  });
  const withdraw = (row) => run(`leave:${row.id}`, async () => {
    const res = await axios.delete(`/api/signups/${row.id}/join`);
    await refresh(row.id);
    return res.data.promoted ? t('raids.withdrawnPromoted', { name: res.data.promoted.display_name }) : t('cal.withdrawn');
  });

  if (loading) return <PageShell><EventsNav /><EmptyState>{t('raids.loading')}</EmptyState></PageShell>;
  if (error) {
    return (
      <PageShell>
        <EventsNav />
        <ErrorState title={t('raids.unreachable')} message={error} onRetry={() => { setLoading(true); load(); }} />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <EventsNav />
      <div className="flex items-center gap-3 mb-2">
        <Landmark className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">{t('raids.title')}</h1>
      </div>
      <p className="text-ash text-sm mb-8">{t('raids.intro')}</p>

      <Toast msg={msg} />

      {formCatalogRaid && (
        <form onSubmit={postRun} className="panel rounded-lg p-5 mb-8">
          <div className="eyebrow text-[10px] text-brass mb-4">{t('raids.postHeading')}</div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {catalog.length > 1 && (
              <label className="block col-span-2 lg:col-span-1">
                <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">{t('raids.raid')}</span>
                <select value={formRaid} onChange={(e) => setFormRaid(e.target.value)} className={`w-full ${INPUT}`}>
                  {catalog.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                </select>
              </label>
            )}
            <label className="block">
              <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">{t('cal.night')}</span>
              <input type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} className={`w-full ${INPUT}`} />
            </label>
            <label className="block">
              <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">{t('raids.start')}</span>
              <input type="time" value={formTime} onChange={(e) => setFormTime(e.target.value)} required className={`w-full ${INPUT}`} />
            </label>
            <label className="block col-span-2 lg:col-span-1">
              <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">{t('raids.remindLabel')}</span>
              <select value={formReminder} onChange={(e) => setFormReminder(e.target.value)} className={`w-full ${INPUT}`}>
                {REMINDER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}
              </select>
            </label>
          </div>
          {isAfterMidnight(formTime) && <p className="text-xs text-ash/70 mt-1.5">{t('cal.afterMidnightNote')}</p>}

          <div className="mt-5">
            <GatePicker raid={formCatalogRaid} picked={formGates} onChange={setFormGates} />
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-ash/70">{t('raids.postHint')}</p>
            <Button type="submit" size="none" className="px-6 py-3" icon={<Megaphone className="w-4 h-4" />}
              disabled={posting || !toSegments(formCatalogRaid, formGates).length}>
              {posting ? t('raids.posting') : t('raids.post')}
            </Button>
          </div>
        </form>
      )}

      <Tabs variant="flat" active={tab} onChange={setTab}
        items={[{ key: 'upcoming', label: t('raids.tabUpcoming') }, { key: 'mine', label: t('raids.tabMine') }]} />

      {shown.length === 0 ? (
        <EmptyState>{tab === 'mine' ? t('raids.noneMine') : t('raids.noneOpen')}</EmptyState>
      ) : (
        <div className="space-y-4">
          {shown.map((row) => (
            <RaidCard
              key={row.id}
              row={row}
              raid={raidByKey[row.raid_key]}
              detail={details[row.id]}
              myId={user?.id}
              busy={busy}
              onJoin={(role, bench) => join(row, role, bench)}
              onWithdraw={() => withdraw(row)}
              onMove={(discordId, to, name) => run(`move:${row.id}`, async () => {
                await axios.post(`/api/raids/${row.id}/move`, { discord_id: discordId, to });
                await refresh(row.id);
                return to === 'going' ? t('raids.movedUp', { name }) : t('raids.movedToBench', { name });
              })}
              onRemove={(discordId, name) => run(`rm:${row.id}`, async () => {
                await axios.delete(`/api/raids/${row.id}/entries/${discordId}`);
                await refresh(row.id);
                return t('raids.removed', { name });
              })}
              onPatch={(body, okMsg) => run(`patch:${row.id}`, async () => {
                await axios.patch(`/api/raids/${row.id}`, body);
                await refresh(row.id);
                return okMsg;
              })}
              onAnnounce={() => run(`ann:${row.id}`, async () => {
                await axios.post(`/api/raids/${row.id}/announce`);
                return t('raids.reposted');
              })}
              onRemind={() => run(`rem:${row.id}`, async () => {
                const res = await axios.post(`/api/raids/${row.id}/remind`);
                return res.data?.count ? t('raids.reminding', { count: res.data.count }) : t('raids.remindNobody');
              })}
              onDelete={() => run(`del:${row.id}`, async () => {
                await axios.delete(`/api/raids/${row.id}`);
                await load();
                return t('raids.deleted');
              })}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function RaidCard({
  row, raid, detail, myId, busy, onJoin, onWithdraw, onMove, onRemove, onPatch, onAnnounce, onRemind, onDelete,
}) {
  const { t } = useT();
  const [pickingBench, setPickingBench] = useState(false);
  const [editingGates, setEditingGates] = useState(false);
  const [gates, setGates] = useState(() => fromSegments(row.raid_segments));
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { setGates(fromSegments(row.raid_segments)); }, [row.raid_segments]);

  const closed = row.status !== 'open';
  const working = busy.endsWith(`:${row.id}`);
  const caps = row.role_caps || raid?.roles || {};
  const seats = ROLES.reduce((n, r) => n + (caps[r] || 0), 0);
  const filled = ROLES.reduce((n, r) => n + (row.role_counts?.[r] || 0), 0);
  const manage = row.can_manage;
  const going = detail?.going || [];
  const bench = detail?.bench || [];
  const isMe = (e) => String(e.discord_id) === String(myId);
  const isLead = (e) => String(e.discord_id) === String(row.created_by);

  // Each overflow bench entry's place in line for its role.
  const benchPos = {};
  const counters = {};
  bench.forEach((e) => {
    if (e.bench_kind === 'overflow') { counters[e.role] = (counters[e.role] || 0) + 1; benchPos[e.discord_id] = counters[e.role]; }
  });

  return (
    <div className={`panel rounded-lg p-5 ${closed ? 'opacity-70' : ''}`}>
      <div className="flex items-start gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-bone font-medium">{row.title}</span>
            {closed && (
              <span className="inline-flex items-center gap-1 text-[10px] eyebrow text-ash border border-line rounded-full px-2 py-0.5">
                <Lock className="w-3 h-3" /> {t(`signups.status.${row.status}`)}
              </span>
            )}
          </div>
          <div className="text-sm text-ash mt-0.5">
            {nightLabel(row.event_date, row.event_time)}
            {row.raid_lead_name && <> · {t('raids.ledBy', { name: row.raid_lead_name })}</>}
          </div>
          <ModeChips raid={raid} segments={row.raid_segments} />
        </div>
        <div className="text-right shrink-0">
          <div className="font-mono text-lg text-brassbright">{filled}<span className="text-ash text-sm">/{seats}</span></div>
          <div className="eyebrow text-[10px] text-ash/75">
            {t('raids.filled')}{row.bench_count > 0 ? ` · ${t('raids.onBenchN', { count: row.bench_count })}` : ''}
          </div>
        </div>
      </div>

      {/* The roster as fixed slots: empty ones are drawn, since a missing
          healer is the thing people look for. Stacks below `sm`. */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mt-5">
        {ROLES.map((role) => {
          const inRole = going.filter((e) => e.role === role);
          const cap = caps[role] || 0;
          return (
            <div key={role} className={role === 'DPS' ? 'sm:col-span-2' : ''}>
              <div className={`eyebrow text-[10px] mb-2 flex justify-between gap-2 ${ROLE_TONE[role]}`}>
                <span>{ROLE_EMOJI[role]} {t(`raids.plural.${role}`)}</span>
                <span className="font-mono text-ash tracking-normal">{inRole.length}/{cap}</span>
              </div>
              <div className={`grid gap-1.5 ${role === 'DPS' ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {inRole.map((e) => (
                  <div key={e.discord_id}
                    className={`min-h-[34px] rounded-lg px-2.5 py-1.5 text-sm flex items-center gap-2 border min-w-0 ${
                      isMe(e) ? `${ROLE_BORDER[role]} bg-panelup` : 'border-line bg-panelup'}`}>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ROLE_DOT[role]}`} />
                    <span className="truncate flex-1 text-bone">{e.display_name}</span>
                    {isLead(e) && <span className="eyebrow text-[9px] text-brass">{t('raids.lead')}</span>}
                    {manage && !closed && (
                      <button type="button" onClick={() => onMove(e.discord_id, 'bench', e.display_name)} disabled={working}
                        title={t('raids.toBench', { name: e.display_name })} aria-label={t('raids.toBench', { name: e.display_name })}
                        className="text-ash hover:text-bone"><ArrowDown className="w-3.5 h-3.5" /></button>
                    )}
                  </div>
                ))}
                {Array.from({ length: Math.max(0, cap - inRole.length) }, (_, i) => (
                  <div key={`open-${i}`} className="min-h-[34px] rounded-lg border border-dashed border-line text-xs text-ash/70 flex items-center justify-center">
                    {t('raids.open')}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-5 pt-4 border-t border-line">
        <div className="eyebrow text-[10px] text-brass mb-2">🪑 {t('raids.benchN', { count: bench.length })}</div>
        {bench.length === 0 ? (
          <p className="text-sm text-ash/70">{t('raids.benchEmpty')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {bench.map((e) => (
              <span key={e.discord_id}
                className={`inline-flex items-center gap-1.5 text-sm bg-hall border rounded-full px-3 py-1 ${isMe(e) ? 'border-brass/60' : 'border-line'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${ROLE_DOT[e.role] || 'bg-ash'}`} title={t(`role.${e.role}`)} />
                {benchPos[e.discord_id] && <span className="font-mono text-[11px] text-ash">#{benchPos[e.discord_id]}</span>}
                <span className="text-bone">{e.display_name}</span>
                {e.bench_kind === 'opt_in' && <span className="text-[11px] text-ash">{t('raids.optIn')}</span>}
                {manage && !closed && (
                  <button type="button" onClick={() => onMove(e.discord_id, 'going', e.display_name)} disabled={working}
                    title={t('raids.toRoster', { name: e.display_name })} aria-label={t('raids.toRoster', { name: e.display_name })}
                    className="text-ash hover:text-bone"><ArrowUp className="w-3.5 h-3.5" /></button>
                )}
                {manage && (
                  <button type="button" onClick={() => onRemove(e.discord_id, e.display_name)} disabled={working}
                    title={t('raids.remove', { name: e.display_name })} aria-label={t('raids.remove', { name: e.display_name })}
                    className="text-ash hover:text-oxblood"><X className="w-3 h-3" /></button>
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Your own place on the run. */}
      <div className="flex items-center gap-2 flex-wrap mt-5">
        {closed ? (
          <span className="text-sm text-ash">{t('signups.closedBtn')}</span>
        ) : pickingBench ? (
          <>
            <span className="text-sm text-ash">{t('raids.benchAs')}</span>
            {ROLES.map((r) => (
              <Button key={r} variant="secondary" size="sm" disabled={working}
                onClick={() => { setPickingBench(false); onJoin(r, true); }}>{ROLE_EMOJI[r]} {t(`role.${r}`)}</Button>
            ))}
            <Button variant="neutral" size="sm" onClick={() => setPickingBench(false)}>{t('common.cancel')}</Button>
          </>
        ) : !row.my_status ? (
          <>
            {ROLES.map((r) => (
              <Button key={r} size="sm" disabled={working} onClick={() => onJoin(r)}>
                {t('raids.joinAs', { role: `${ROLE_EMOJI[r]} ${t(`role.${r}`)}` })}
              </Button>
            ))}
            <Button variant="secondary" size="sm" disabled={working} icon={<Armchair className="w-4 h-4" />}
              onClick={() => setPickingBench(true)}>{t('raids.benchMe')}</Button>
          </>
        ) : (
          <>
            <span className={`inline-flex items-center gap-1.5 text-sm rounded-full px-3 py-1 border ${
              row.my_status === 'bench' ? 'border-brass/40 text-brass' : 'border-emerald-400/40 text-emerald-400'}`}>
              <Check className="w-3.5 h-3.5" />
              {row.my_status === 'bench'
                ? t('raids.youOnBench', { role: `${ROLE_EMOJI[row.my_role] || ''} ${t(`role.${row.my_role}`)}` })
                : t('raids.youreIn', { role: `${ROLE_EMOJI[row.my_role] || ''} ${t(`role.${row.my_role}`)}` })}
            </span>
            {ROLES.filter((r) => row.my_status === 'bench' || r !== row.my_role).map((r) => (
              <Button key={r} variant="secondary" size="sm" disabled={working} onClick={() => onJoin(r)}>
                {row.my_status === 'bench' ? t('raids.tryRole', { role: `${ROLE_EMOJI[r]} ${t(`role.${r}`)}` }) : t('raids.switchTo', { role: ROLE_EMOJI[r] })}
              </Button>
            ))}
            {row.my_status === 'going' && (
              <Button variant="neutral" size="sm" disabled={working} onClick={() => onJoin(row.my_role, true)}>{t('raids.moveToBench')}</Button>
            )}
            <Button variant="destructive" size="sm" disabled={working} onClick={onWithdraw}>{t('att.withdraw')}</Button>
          </>
        )}
        {working && <Loader2 className="w-4 h-4 text-brass animate-spin" />}
      </div>

      {manage && (
        <div className="mt-5 pt-4 border-t border-dashed border-line space-y-3">
          <div className="eyebrow text-[10px] text-ash/75">{t('raids.leadTools')}</div>
          {editingGates && raid && (
            <div className="space-y-3">
              <GatePicker raid={raid} picked={gates} onChange={setGates} />
              <div className="flex gap-2 justify-end">
                <Button variant="neutral" size="sm" onClick={() => { setEditingGates(false); setGates(fromSegments(row.raid_segments)); }}>
                  {t('common.cancel')}
                </Button>
                <Button variant="secondary" size="sm" disabled={working || !toSegments(raid, gates).length}
                  onClick={() => { setEditingGates(false); onPatch({ segments: toSegments(raid, gates) }, t('raids.gatesSaved')); }}>
                  {t('raids.saveGates')}
                </Button>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            {!editingGates && !closed && (
              <Button variant="ghost" size="sm" icon={<Pencil className="w-4 h-4" />} onClick={() => setEditingGates(true)}>{t('raids.editGates')}</Button>
            )}
            <Button variant="ghost" size="sm" icon={<Megaphone className="w-4 h-4" />} disabled={working} onClick={onAnnounce}
              title={t('signups.repostTitle')}>{t('signups.repost')}</Button>
            <Button variant="ghost" size="sm" icon={<Bell className="w-4 h-4" />} disabled={working} onClick={onRemind}
              title={t('raids.remindTitle')}>{t('signups.remind')}</Button>
            {!closed && (
              <Button variant="ghost" size="sm" icon={<Lock className="w-4 h-4" />} disabled={working}
                onClick={() => onPatch({ status: 'closed' }, t('signups.closedMsg'))}>{t('common.close')}</Button>
            )}
            <div className="flex-1" />
            {confirmDelete ? (
              <>
                <span className="text-sm text-ash">{t('raids.confirmDelete')}</span>
                <Button variant="neutral" size="sm" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
                <Button variant="destructive" size="sm" icon={<Trash2 className="w-4 h-4" />} disabled={working}
                  onClick={() => { setConfirmDelete(false); onDelete(); }}>{t('signups.delete')}</Button>
              </>
            ) : (
              <Button variant="destructive" size="sm" icon={<Trash2 className="w-4 h-4" />} disabled={working}
                onClick={() => setConfirmDelete(true)}>{t('signups.delete')}</Button>
            )}
          </div>
          <p className="text-xs text-ash/70">{t('raids.leadHint')}</p>
        </div>
      )}
    </div>
  );
}
