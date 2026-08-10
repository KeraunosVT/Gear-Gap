import { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import {
  ClipboardList, Check, X, Users, Megaphone, Bell, Trash2, Lock, ChevronDown, Loader2,
} from 'lucide-react';

import { fmtTimeEst, todayInGuildTz, eventsForGuildDay, isAfterMidnight } from '../timeUtils';
import Tabs from '../components/ui/Tabs';
import { PageShell } from '../components/ui/PageShell';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import ErrorState from '../components/ui/ErrorState';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Same three colours the roster tiles and the party board already use for
// roles, so a Healer is green everywhere on the site.
const ROLE_TONE = { Tank: 'text-sky-400', Healer: 'text-emerald-400', DPS: 'text-oxblood', Unassigned: 'text-ash' };
const ROLE_DOT = { Tank: 'bg-sky-400', Healer: 'bg-emerald-400', DPS: 'bg-oxblood', Unassigned: 'bg-ash' };
// Display order everywhere on this page, matching the backend's ROLE_ORDER.
const ROLE_COLUMNS = ['Tank', 'DPS', 'Healer'];
const roleKey = (role) => (ROLE_COLUMNS.includes(role) ? role : 'Unassigned');

// The composition strip. Tank/DPS/Healer always render even at zero — a missing
// tank is the thing an officer is looking for, and hiding the row when it's
// empty would hide exactly that.
function RoleCounts({ counts, className = '' }) {
  if (!counts) return null;
  const cols = [...ROLE_COLUMNS, ...(counts.Unassigned ? ['Unassigned'] : [])];
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {cols.map((role) => (
        <span key={role} className="inline-flex items-center gap-1.5" title={role === 'Unassigned' ? 'No role on file' : role}>
          <span className={`w-1.5 h-1.5 rounded-full ${ROLE_DOT[role]}`} />
          <span className={`font-mono text-sm ${counts[role] ? 'text-bone' : 'text-ash/50'}`}>{counts[role] || 0}</span>
          <span className="eyebrow text-[10px] text-ash/75">{role === 'Unassigned' ? 'none' : role}</span>
        </span>
      ))}
    </div>
  );
}

const REMINDER_OPTIONS = [
  { value: '', label: 'No reminder' },
  { value: '60', label: '1 hour before' },
  { value: '180', label: '3 hours before' },
  { value: '360', label: '6 hours before' },
  { value: '720', label: '12 hours before' },
  { value: '1440', label: '1 day before' },
];

const INPUT = 'bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass';

// The night, spelled out. event_date is the guild night rather than the
// calendar day, so an after-midnight event reads "Sat night" even though its
// clock time lands on Sunday — the same thing the Parties event picker does.
function nightLabel(dateStr, eventTime) {
  const d = new Date(`${dateStr}T12:00:00`);
  const day = DAY_ABBR[d.getDay()];
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = eventTime ? ` · ${fmtTimeEst(eventTime)}` : '';
  return `${day} ${md}${time}${isAfterMidnight(eventTime) ? ' (after midnight)' : ''}`;
}

function NameGroup({ label, tone = 'text-ash', children }) {
  return (
    <div>
      <div className={`eyebrow text-[10px] mb-2 ${tone}`}>{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function NameChip({ children, className = '', title, onRemove }) {
  return (
    <span title={title}
      className={`inline-flex items-center gap-1.5 text-sm bg-hall border rounded-full px-3 py-1 ${className || 'border-line text-ash'}`}>
      {children}
      {onRemove && (
        <button onClick={onRemove} title="Remove from this signup"
          className="text-ash hover:text-oxblood transition-colors">
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

const EntryChip = ({ entry, onRemove }) => (
  <NameChip title={entry.pvp_role || undefined} onRemove={onRemove}>
    <span className={ROLE_TONE[entry.pvp_role] || 'text-ash'}>●</span>
    <span className="text-bone">{entry.display_name}</span>
  </NameChip>
);

export default function Signups() {
  const { can } = useAuth();
  const isOfficer = can('attendance');

  const [rows, setRows] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash();
  const [tab, setTab] = useState('upcoming');

  // Which card is expanded, and the detail payload keyed by signup id. Details
  // are fetched on demand — the list is cheap, a per-occurrence roster diff is
  // not, and most of the time an officer only cares about one night.
  const [expanded, setExpanded] = useState(null);
  const [detail, setDetail] = useState({});
  const [busy, setBusy] = useState('');

  // Officer "open a signup" form.
  const [formDate, setFormDate] = useState(todayInGuildTz);
  const [formEvent, setFormEvent] = useState('');
  const [formTitle, setFormTitle] = useState('');
  const [formCapacity, setFormCapacity] = useState('');
  const [formReminder, setFormReminder] = useState('1440');
  const [opening, setOpening] = useState(false);

  const load = useCallback(() => {
    setError('');
    // The member list is always the base: it's the only one that carries
    // my_status. Officers get the admin list layered on top for the closed
    // occurrences, with their own status merged back in by id.
    const calls = [axios.get('/api/signups'), axios.get('/api/event-schedule')];
    if (isOfficer) calls.push(axios.get('/api/admin/signups'));

    Promise.all(calls)
      .then(([mine, sched, all]) => {
        const mineRows = mine.data.signups || [];
        setSchedule(sched.data.schedule || []);
        if (!all) return setRows(mineRows);
        const status = new Map(mineRows.map((r) => [r.id, r.my_status]));
        setRows((all.data.signups || []).map((r) => ({ ...r, my_status: status.get(r.id) ?? r.my_status ?? null })));
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load signups.'))
      .finally(() => setLoading(false));
  }, [isOfficer]);

  useEffect(() => { load(); }, [load]);

  const eventsOnDate = useMemo(
    () => (formDate ? eventsForGuildDay(schedule, new Date(`${formDate}T12:00:00`).getDay()) : []),
    [formDate, schedule],
  );

  // Picking a different night can strand a selection on an event that doesn't
  // run then, which the server would reject with "doesn't run on that night".
  useEffect(() => {
    if (formEvent && !eventsOnDate.some((e) => e.id === formEvent)) setFormEvent('');
  }, [eventsOnDate, formEvent]);

  const shown = useMemo(
    () => (tab === 'mine' ? rows.filter((r) => r.my_status) : rows),
    [rows, tab],
  );

  const loadDetail = useCallback(async (id) => {
    try {
      const url = isOfficer ? `/api/admin/signups/${id}` : `/api/signups/${id}`;
      const res = await axios.get(url);
      setDetail((d) => ({ ...d, [id]: res.data }));
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to load that signup.', false);
    }
  }, [isOfficer, flash]);

  const toggle = (id) => {
    if (expanded === id) return setExpanded(null);
    setExpanded(id);
    loadDetail(id);
  };

  // Every mutation ends the same way: re-read the list, and re-read the open
  // card if there is one. Cheaper to say once than to thread refreshes through
  // eight handlers, and it keeps the headcount honest after a promotion.
  const refresh = useCallback(async (id) => {
    load();
    if (id && expanded === id) await loadDetail(id);
  }, [load, expanded, loadDetail]);

  const run = async (key, fn, okMsg) => {
    setBusy(key);
    try {
      await fn();
      if (okMsg) flash(okMsg);
    } catch (err) {
      flash(err.response?.data?.error || 'That didn\'t work.', false);
    } finally {
      setBusy('');
    }
  };

  const join = (row) => run(`join:${row.id}`, async () => {
    const res = await axios.post(`/api/signups/${row.id}/join`);
    await refresh(row.id);
    flash(res.data.status === 'waitlist'
      ? `That one's full — you're #${res.data.waitlist} on the waitlist. You'll be moved up if a slot opens.`
      : `You're in for ${row.title}.`);
  });

  const withdraw = (row) => run(`leave:${row.id}`, async () => {
    const res = await axios.delete(`/api/signups/${row.id}/join`);
    await refresh(row.id);
    flash(res.data.promoted
      ? `Withdrawn — ${res.data.promoted.display_name} moved up off the waitlist.`
      : 'Withdrawn.');
  });

  const openSignup = async (e) => {
    e.preventDefault();
    if (!formEvent && !formTitle.trim()) return flash('Pick a scheduled event or give it a title.', false);
    setOpening(true);
    try {
      const res = await axios.post('/api/admin/signups', {
        event_date: formDate,
        event_schedule_id: formEvent || null,
        title: formTitle.trim(),
        capacity: formCapacity,
        reminder_minutes: formReminder,
      });
      flash(res.data.created ? 'Signup opened and posted to Discord.' : 'That signup was already open — showing the existing one.');
      setFormTitle(''); setFormCapacity('');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to open that signup.', false);
    } finally {
      setOpening(false);
    }
  };

  if (loading) return <PageShell maxWidth="max-w-4xl"><EmptyState>Reading the muster roll…</EmptyState></PageShell>;
  if (error) {
    return (
      <PageShell maxWidth="max-w-4xl">
        <ErrorState title="MUSTER UNREACHABLE" message={error} onRetry={() => { setLoading(true); load(); }} />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="max-w-4xl">
      <div className="flex items-center gap-3 mb-2">
        <ClipboardList className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">EVENT SIGNUPS</h1>
      </div>
      <p className="text-ash text-sm mb-8">
        Signing up says you're coming. It's the only thing recorded here — if you can't make it,
        file an LOA instead. No entry just means we haven't heard from you.
      </p>

      <Toast msg={msg} />

      {isOfficer && (
        <form onSubmit={openSignup} className="panel rounded-lg p-5 mb-8">
          <div className="eyebrow text-[10px] text-brass mb-4">Open a signup</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block">
              <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">Night</span>
              <input type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} className={`w-full ${INPUT}`} />
            </label>
            <label className="block">
              <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">Event</span>
              <select value={formEvent} onChange={(e) => setFormEvent(e.target.value)} className={`w-full ${INPUT}`}>
                <option value="">One-off (title below)</option>
                {/* After-midnight events belong to this night but land on the
                    next calendar day, so the day is spelled out. */}
                {eventsOnDate.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.event_time ? ` — ${fmtTimeEst(s.event_time)}` : ''}
                    {isAfterMidnight(s.event_time) ? ` ${DAY_ABBR[s.day_of_week]}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">Capacity</span>
              <input type="number" min="1" value={formCapacity} onChange={(e) => setFormCapacity(e.target.value)}
                placeholder="Uncapped" className={`w-full ${INPUT}`} />
            </label>
            <label className="block">
              <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">Remind non-responders</span>
              <select value={formReminder} onChange={(e) => setFormReminder(e.target.value)} className={`w-full ${INPUT}`}>
                {REMINDER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          {!formEvent && (
            <input value={formTitle} onChange={(e) => setFormTitle(e.target.value)}
              placeholder="Title for this one-off event" className={`w-full mt-3 ${INPUT}`} />
          )}

          <div className="mt-4">
            <Button type="submit" size="none" disabled={opening} icon={<Megaphone className="w-4 h-4" />}
              className="px-6 py-3">
              {opening ? 'Posting…' : 'Open & post to Discord'}
            </Button>
          </div>
        </form>
      )}

      <Tabs variant="flat" active={tab} onChange={setTab}
        items={[{ key: 'upcoming', label: 'Upcoming' }, { key: 'mine', label: 'Mine' }]} />

      {shown.length === 0 ? (
        <EmptyState>{tab === 'mine' ? "You haven't signed up for anything yet." : 'No signups are open right now.'}</EmptyState>
      ) : (
        <div className="space-y-3">
          {shown.map((row) => (
            <SignupCard
              key={row.id}
              row={row}
              detail={detail[row.id]}
              expanded={expanded === row.id}
              onToggle={() => toggle(row.id)}
              isOfficer={isOfficer}
              busy={busy}
              onJoin={() => join(row)}
              onWithdraw={() => withdraw(row)}
              onPatch={(body, okMsg) => run(`patch:${row.id}`, async () => {
                await axios.patch(`/api/admin/signups/${row.id}`, body);
                await refresh(row.id);
              }, okMsg)}
              onAnnounce={() => run(`ann:${row.id}`, () => axios.post(`/api/admin/signups/${row.id}/announce`), 'Reposted to Discord.')}
              onRemind={() => run(`rem:${row.id}`, () => axios.post(`/api/admin/signups/${row.id}/remind`), 'Reminders going out to anyone who hasn\'t answered.')}
              onDelete={() => run(`del:${row.id}`, async () => {
                await axios.delete(`/api/admin/signups/${row.id}`);
                setExpanded(null);
                load();
              }, 'Signup deleted.')}
              onRemoveEntry={(discordId) => run(`ent:${row.id}:${discordId}`, async () => {
                await axios.delete(`/api/admin/signups/${row.id}/entries/${discordId}`);
                await refresh(row.id);
              }, 'Removed.')}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}

function SignupCard({
  row, detail, expanded, onToggle, isOfficer, busy,
  onJoin, onWithdraw, onPatch, onAnnounce, onRemind, onDelete, onRemoveEntry,
}) {
  const [capacity, setCapacity] = useState(row.capacity ?? '');
  useEffect(() => { setCapacity(row.capacity ?? ''); }, [row.capacity]);

  const closed = row.status !== 'open';
  const full = row.capacity != null && row.going_count >= row.capacity;
  const working = busy.endsWith(`:${row.id}`) || busy.includes(`:${row.id}:`);

  return (
    <div className={`panel rounded-lg p-5 ${closed ? 'opacity-70' : ''}`}>
      <div className="flex items-start gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-bone font-medium">{row.title}</span>
            {closed && (
              <span className="inline-flex items-center gap-1 text-[10px] eyebrow text-ash border border-line rounded-full px-2 py-0.5">
                <Lock className="w-3 h-3" /> {row.status}
              </span>
            )}
          </div>
          <div className="text-sm text-ash mt-0.5">{nightLabel(row.event_date, row.event_time)}</div>
        </div>

        <div className="text-right shrink-0">
          <div className="font-mono text-lg text-brassbright">
            {row.going_count}{row.capacity != null && <span className="text-ash text-sm">/{row.capacity}</span>}
          </div>
          <div className="eyebrow text-[10px] text-ash/75">
            going{row.waitlist_count > 0 ? ` · ${row.waitlist_count} waiting` : ''}
          </div>
        </div>
      </div>

      <RoleCounts counts={row.role_counts} className="mt-3" />

      <div className="flex items-center gap-2 flex-wrap mt-4">
        {row.my_status ? (
          <>
            <span className={`inline-flex items-center gap-1.5 text-sm rounded-full px-3 py-1 border ${
              row.my_status === 'waitlist' ? 'border-brass/40 text-brass' : 'border-emerald-400/40 text-emerald-400'}`}>
              <Check className="w-3.5 h-3.5" />
              {row.my_status === 'waitlist' ? 'On the waitlist' : "You're in"}
            </span>
            {/* "Withdraw", not "Can't make it" — withdrawing returns you to
                undecided. Declaring absence is what an LOA is for. */}
            <Button variant="destructive" size="sm" onClick={onWithdraw} disabled={working}>Withdraw</Button>
          </>
        ) : (
          <Button size="sm" onClick={onJoin} disabled={working || closed}>
            {closed ? 'Signups closed' : full ? "I'm in (waitlist)" : "I'm in"}
          </Button>
        )}

        <Button variant="ghost" size="sm" onClick={onToggle}
          icon={<ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />}>
          Who's coming?
        </Button>

        {working && <Loader2 className="w-4 h-4 text-brass animate-spin" />}
      </div>

      {expanded && (
        <div className="mt-5 pt-5 border-t border-line space-y-5">
          {!detail ? <div className="text-sm text-ash">Reading the list…</div> : (
            <>
              {detail.going.length === 0 ? (
                <NameGroup label="Going (0)" tone="text-emerald-400">
                  <span className="text-sm text-ash">Nobody yet.</span>
                </NameGroup>
              ) : (
                /* One column per role rather than a single list. Collapses to
                   stacked groups below `sm`, where three columns of chips would
                   be one name wide. */
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
                  {ROLE_COLUMNS.map((role) => {
                    const inRole = detail.going.filter((e) => roleKey(e.pvp_role) === role);
                    return (
                      <NameGroup key={role} label={`${role} (${inRole.length})`} tone={ROLE_TONE[role]}>
                        {inRole.length === 0 && <span className="text-sm text-ash/50">—</span>}
                        {inRole.map((e) => (
                          <EntryChip key={e.discord_id} entry={e}
                            onRemove={isOfficer ? () => onRemoveEntry(e.discord_id) : undefined} />
                        ))}
                      </NameGroup>
                    );
                  })}
                </div>
              )}

              {/* Signed up with no role on file — the people who'd silently
                  fall out of a party seed, so they get their own row. */}
              {detail.going.some((e) => roleKey(e.pvp_role) === 'Unassigned') && (
                <NameGroup label="No role on file" tone="text-brass">
                  {detail.going.filter((e) => roleKey(e.pvp_role) === 'Unassigned').map((e) => (
                    <EntryChip key={e.discord_id} entry={e}
                      onRemove={isOfficer ? () => onRemoveEntry(e.discord_id) : undefined} />
                  ))}
                </NameGroup>
              )}

              {detail.waitlist.length > 0 && (
                <NameGroup label={`Waitlist (${detail.waitlist.length})`} tone="text-brass">
                  {/* Composition of the queue, so "we're short a healer and
                      there's one waiting" is visible before deciding on the cap. */}
                  <RoleCounts counts={detail.roleCounts?.waitlist} className="w-full mb-1" />
                  {detail.waitlist.map((e, i) => (
                    <NameChip key={e.discord_id} className="border-brass/30 text-brass"
                      onRemove={isOfficer ? () => onRemoveEntry(e.discord_id) : undefined}>
                      <span className="font-mono text-xs">#{i + 1}</span>
                      <span className="text-bone">{e.display_name}</span>
                    </NameChip>
                  ))}
                </NameGroup>
              )}

              {detail.conflicts?.length > 0 && (
                <div className="text-sm text-oxblood">
                  Signed up but has an LOA on file: {detail.conflicts.map((c) => c.display_name).join(', ')}.
                  {' '}Worth a message before you build the roster.
                </div>
              )}

              {isOfficer && (
                <>
                  {detail.onLoa?.length > 0 && (
                    <NameGroup label={`On LOA (${detail.onLoa.length})`} tone="text-ash">
                      {detail.onLoa.map((m) => (
                        <NameChip key={m.discord_id} title={m.loa?.reason || undefined}>{m.display_name}</NameChip>
                      ))}
                    </NameGroup>
                  )}

                  {detail.noResponse?.length > 0 && (
                    <NameGroup label={`No response (${detail.noResponse.length})`} tone="text-ash/75">
                      {detail.noResponse.map((m) => <NameChip key={m.discord_id}>{m.display_name}</NameChip>)}
                    </NameGroup>
                  )}

                  <div className="flex items-end gap-2 flex-wrap pt-1">
                    <label className="block">
                      <span className="eyebrow text-[10px] text-ash/75 block mb-1.5">Capacity</span>
                      <input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)}
                        placeholder="Uncapped" className={`w-32 ${INPUT} py-2`} />
                    </label>
                    {/* Lowering the cap never demotes anyone who already has a
                        slot — it only stops the next join. */}
                    <Button variant="secondary" size="sm" disabled={working}
                      onClick={() => onPatch({ capacity: capacity === '' ? null : capacity }, 'Capacity updated.')}>
                      Save cap
                    </Button>
                    <div className="flex-1" />
                    <Button variant="ghost" size="sm" icon={<Megaphone className="w-4 h-4" />} disabled={working}
                      onClick={onAnnounce} title="Repost the announcement if the message was deleted">
                      Repost
                    </Button>
                    <Button variant="ghost" size="sm" icon={<Bell className="w-4 h-4" />} disabled={working}
                      onClick={onRemind} title="DM everyone who hasn't answered and isn't on LOA">
                      Remind
                    </Button>
                    {!closed && (
                      <Button variant="ghost" size="sm" icon={<Lock className="w-4 h-4" />} disabled={working}
                        onClick={() => onPatch({ status: 'closed' }, 'Signups closed.')}>
                        Close
                      </Button>
                    )}
                    <Button variant="destructive" size="sm" icon={<Trash2 className="w-4 h-4" />} disabled={working}
                      onClick={() => window.confirm(`Delete the signup for ${row.title}? Everyone's entries go with it.`) && onDelete()}>
                      Delete
                    </Button>
                  </div>
                </>
              )}

              {!isOfficer && detail.counts?.capacity != null && (
                <div className="text-xs text-ash flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" />
                  {detail.counts.capacity - detail.counts.going > 0
                    ? `${detail.counts.capacity - detail.counts.going} slot(s) left.`
                    : 'Full — new signups join the waitlist.'}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
