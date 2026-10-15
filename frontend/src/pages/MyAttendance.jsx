import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  CalendarDays, Check, Clock, Loader2, Hourglass, X, ThumbsDown, ChevronLeft, ChevronRight,
  LayoutGrid, List, CalendarCheck,
} from 'lucide-react';
import { fmtDatetime, todayInGuildTz, addDays, getGuildTz } from '../timeUtils';
import { categoryOf } from '../eventCategories';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';
import Button from '../components/ui/Button';
import WeekTimeGrid from '../components/WeekTimeGrid';

// ── WHAT THIS PAGE IS ───────────────────────────────────────────────────────
// A member's own attendance, and the one thing they can do about it: ask to be
// added to a night the snapshot missed.
//
// Not under /admin, and it sits beside Signups and LOA in the sidebar on
// purpose — those three are the whole of "will you be there / were you there"
// from a member's side. Officers decide these requests on /admin/attendance;
// nothing on this page writes an attendance record.
//
// The 24-hour window is enforced server-side and merely DISPLAYED here. The
// button disappearing is a courtesy, not the check.
//
// Laid out on the same week grid as the Event Calendar (WeekTimeGrid), so a
// night sits in the same place on both. Each block is the event's category
// colour, filled when you were there and outlined when you weren't.

// How far back the grid pages. The fetch covers whole weeks, so the oldest
// week on screen is never half-loaded.
const WEEKS_BACK = 6;
const FETCH_DAYS = WEEKS_BACK * 7;

const VIEW_KEY = 'myAttendanceView';
const readView = () => {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'week'; } catch { return 'week'; }
};

const dowOf = (d) => new Date(`${d}T12:00:00`).getDay();

// "3h left" / "45m left". Rounded down: a window shown as an hour that closes
// in fifty minutes is worse than the reverse.
function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'closing now';
  const mins = Math.floor(ms / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h left` : `${mins}m left`;
}

// Where a night goes on the time axis: its scheduled time, else the time
// attendance was taken, in the guild's clock. A one-off night has no schedule
// entry, and the snapshot is the best record of when it ran.
function placeTime(ev) {
  if (ev.event_time) return ev.event_time;
  if (!ev.created_at) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: getGuildTz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ev.created_at));
  const h = parts.find((p) => p.type === 'hour')?.value;
  const m = parts.find((p) => p.type === 'minute')?.value;
  return h && m ? `${h}:${m}` : null;
}

// One word for where a night stands, shared by the block, the legend and the
// panel so the three can't disagree.
function standing(ev) {
  if (ev.attended) return 'attended';
  if (ev.request?.status === 'pending') return 'pending';
  if (ev.request?.status === 'denied') return 'denied';
  if (ev.can_request) return 'askable';
  return 'missed';
}

const STANDING_ICON = { attended: Check, pending: Hourglass, denied: ThumbsDown, askable: Clock, missed: X };

function StatusLine({ ev }) {
  if (ev.attended) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-emerald-400">
        <Check className="w-3.5 h-3.5" />
        Attended
        {ev.late && <span className="text-brass text-xs">(added late)</span>}
        <span className="text-ash text-xs">· {fmtDatetime(ev.joined_at)}</span>
      </span>
    );
  }
  const req = ev.request;
  if (req?.status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-brass">
        <Hourglass className="w-3.5 h-3.5" /> Waiting on an officer
      </span>
    );
  }
  if (req?.status === 'denied') {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-oxblood">
        <ThumbsDown className="w-3.5 h-3.5" /> Request declined
      </span>
    );
  }
  return <span className="text-sm text-ash">Not on the list</span>;
}

// One night: what it was, where you stand, and the late-request controls.
// Used as a list row and as the side panel, so both offer the same actions.
function NightCard({ ev, asking, setAsking, reason, setReason, busy, onRequest, onWithdraw }) {
  return (
    <div>
      <div className="flex items-start gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          {/* Straight through to the full roll for that night — this answers
              "was I counted", the event page answers "who else was". */}
          <Link to={`/attendance/${ev.id}`} className="font-medium text-bone hover:text-brass transition-colors">
            {ev.title}
          </Link>
          <div className="flex items-center gap-3 text-xs text-ash mt-1">
            <span className="inline-flex items-center gap-1">
              <CalendarDays className="w-3 h-3" />
              {ev.event_date
                ? new Date(`${ev.event_date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                : 'No date'}
            </span>
          </div>
          <div className="mt-2"><StatusLine ev={ev} /></div>
        </div>

        <div className="shrink-0 flex items-center gap-2">
          {ev.can_request && (
            <div className="text-right">
              {asking !== ev.id && (
                <Button size="sm" variant="secondary" onClick={() => { setAsking(ev.id); setReason(''); }}>
                  Request late attendance
                </Button>
              )}
              {/* The deadline, stated where the decision is made. "24 hours" in
                  the blurb is a rule; this is the number that tells someone
                  whether to act now — so it stays on screen while the reason
                  box is open, which is exactly when they're deciding. */}
              <div className="text-[10px] text-ash mt-1 flex items-center justify-end gap-1">
                <Clock className="w-2.5 h-2.5" /> {timeLeft(ev.window_closes_at)}
              </div>
            </div>
          )}
          {ev.request?.status === 'pending' && (
            <Button size="sm" variant="neutral" disabled={busy === ev.id}
              onClick={() => onWithdraw(ev)} icon={<X className="w-3.5 h-3.5" />}>
              Withdraw
            </Button>
          )}
        </div>
      </div>

      {asking === ev.id && (
        <div className="mt-4 border-t border-line pt-4 space-y-3">
          <label className="eyebrow text-[10px] text-ash block">Anything that helps an officer decide (optional)</label>
          <input
            value={reason} onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            placeholder="e.g. joined comms at 9:05, Discord dropped me mid-fight"
            className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass"
          />
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => onRequest(ev)} disabled={busy === ev.id}
              icon={busy === ev.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}>
              Send request
            </Button>
            <Button size="sm" variant="neutral" onClick={() => { setAsking(null); setReason(''); }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// One night on the grid. Filled in its category colour when you were there,
// outlined when you weren't — the difference that matters most, readable from
// across the week without the icon.
function NightBlock({ ev, fill, picked, onClick }) {
  const cat = categoryOf(ev.title);
  const s = standing(ev);
  const Icon = STANDING_ICON[s];
  const filled = s === 'attended';
  return (
    <button
      onClick={onClick}
      aria-pressed={picked}
      title={`${ev.title} · ${{ attended: 'attended', pending: 'waiting on an officer', denied: 'request declined', askable: 'missed — you can still ask', missed: 'missed' }[s]}`}
      className={`w-full ${fill ? 'h-full' : ''} flex items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] leading-tight overflow-hidden transition-[filter] hover:brightness-125 ${
        filled ? 'text-white' : 'bg-panel text-bone'
      } ${picked ?'ring-2 ring-bone ring-offset-1 ring-offset-panel' : ''}`}
      style={filled ? { background: cat.color } : { border: `1px ${s === 'askable' ? 'dashed' : 'solid'} ${cat.color}` }}
    >
      <Icon className={`w-3 h-3 shrink-0 ${filled ? '' : s === 'pending' || s === 'askable' ? 'text-brass' : s === 'denied' ? 'text-oxblood' : 'text-ash'}`} />
      <span className="truncate font-medium">{ev.title}</span>
    </button>
  );
}

export default function MyAttendance() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash();
  const [asking, setAsking] = useState(null); // event id the reason box is open for
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [view, setView] = useState(readView);
  const [offset, setOffset] = useState(0); // 0 = this week, negative = weeks back
  const [selectedId, setSelectedId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    axios.get('/api/attendance/mine', { params: { days: FETCH_DAYS } })
      .then((res) => setEvents(res.data.events || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load your attendance.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const today = todayInGuildTz();
  const days = useMemo(() => {
    const monday = addDays(today, -((dowOf(today) + 6) % 7) + offset * 7);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [today, offset]);

  const columns = useMemo(() => days.map((date) => ({
    date,
    items: events
      .filter((ev) => ev.event_date === date)
      .map((ev) => ({ ...ev, key: ev.id, eventTime: placeTime(ev) })),
  })), [days, events]);

  const weekEvents = columns.flatMap((c) => c.items);
  const weekAttended = weekEvents.filter((ev) => ev.attended).length;
  // Nights you can still ask about, anywhere in the fetched range — the one
  // thing on this page with a deadline, so it is offered above the grid
  // whichever week is showing.
  const askable = events.filter((ev) => ev.can_request);
  const selected = events.find((ev) => ev.id === selectedId) || null;

  const changeView = (v) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer nicety only */ }
  };

  // Jump the grid to a night's week and open it — used by the "you can still
  // ask" links, which may point at last week.
  const openNight = (ev) => {
    const monday = (d) => addDays(d, -((dowOf(d) + 6) % 7));
    const weeks = Math.round((new Date(`${monday(ev.event_date)}T12:00:00Z`) - new Date(`${monday(today)}T12:00:00Z`)) / (7 * 86_400_000));
    setOffset(Math.max(-(WEEKS_BACK - 1), Math.min(0, weeks)));
    setSelectedId(ev.id);
  };

  const fileRequest = async (ev) => {
    setBusy(ev.id);
    try {
      await axios.post('/api/attendance/late', { event_id: ev.id, reason: reason.trim() || null });
      flash('Asked. An officer will approve or deny it — you\'ll get a DM either way.');
      setAsking(null); setReason('');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not file that request.', false);
      // The window may have closed, or an officer may have added you already —
      // either way what's on screen is out of date.
      if (err.response?.status === 409 || err.response?.status === 400) load();
    } finally {
      setBusy('');
    }
  };

  const withdraw = async (ev) => {
    setBusy(ev.id);
    try {
      await axios.delete(`/api/attendance/late/${ev.request.id}`);
      flash('Withdrawn.');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not withdraw that request.', false);
      load();
    } finally {
      setBusy('');
    }
  };

  const cardProps = { asking, setAsking, reason, setReason, busy, onRequest: fileRequest, onWithdraw: withdraw };

  const listView = events.length === 0 ? (
    <EmptyState>No attendance has been taken in the last {WEEKS_BACK} weeks.</EmptyState>
  ) : (
    <div className="panel rounded-lg divide-y divide-line">
      {events.map((ev) => (
        <div key={ev.id} className="px-5 py-4"><NightCard ev={ev} {...cardProps} /></div>
      ))}
    </div>
  );

  return (
    <PageShell maxWidth={view === 'week' ? 'max-w-[1600px]' : 'max-w-3xl'}>
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="font-display text-3xl text-bone tracking-[0.08em]">My Attendance</h1>
        <div className="ml-auto hidden md:flex rounded-lg border border-line overflow-hidden">
          {[['week', LayoutGrid, 'Week'], ['list', List, 'List']].map(([key, Icon, label]) => (
            <button
              key={key} onClick={() => changeView(key)} title={`${label} view`}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${view === key ? 'bg-panelup text-brass' : 'text-ash hover:text-bone'}`}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>
      </div>
      <p className="text-sm text-ash mt-2">
        Every night attendance was taken in the last {WEEKS_BACK} weeks. If you were there but aren&apos;t on the list,
        you can ask an officer to add you — for 24 hours after attendance was taken.
      </p>
      <div className="rule-fade my-6" />

      <Toast msg={msg} />
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {loading && events.length === 0 ? (
        <EmptyState>Reading the rolls…</EmptyState>
      ) : view === 'list' ? listView : (
        <>
          {/* Phones get the list either way — seven columns don't fit. */}
          <div className="md:hidden">{listView}</div>

          <div className="hidden md:block space-y-4">
            {askable.length > 0 && (
              <div className="panel rounded-lg px-4 py-3 text-sm flex flex-wrap items-center gap-x-3 gap-y-2 border-brass/40">
                <Clock className="w-4 h-4 text-brass" />
                <span className="text-bone">Not on the list — you can still ask to be added:</span>
                {askable.map((ev) => (
                  <button key={ev.id} onClick={() => openNight(ev)} className="text-brass hover:text-brassbright underline underline-offset-2">
                    {ev.title} ({new Date(`${ev.event_date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' })}, {timeLeft(ev.window_closes_at)})
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between gap-4 panel rounded-lg px-4 py-3">
              <Button
                variant="ghost" size="none" className="px-2 py-1 text-sm"
                onClick={() => setOffset((o) => Math.max(-(WEEKS_BACK - 1), o - 1))} disabled={offset <= -(WEEKS_BACK - 1)}
              >
                <ChevronLeft className="w-4 h-4" /> Previous
              </Button>
              <div className="text-center">
                <div className="text-bone text-sm">
                  {new Date(`${days[0]}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  {' – '}
                  {new Date(`${days[6]}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
                <div className="eyebrow text-[10px] text-ash/75 mt-0.5">
                  {offset === 0 ? 'This week' : `${-offset} week${offset === -1 ? '' : 's'} ago`}
                  {weekEvents.length > 0 && <> · attended {weekAttended} of {weekEvents.length}</>}
                </div>
              </div>
              <Button
                variant="ghost" size="none" className="px-2 py-1 text-sm"
                onClick={() => setOffset((o) => Math.min(0, o + 1))} disabled={offset >= 0}
              >
                Next <ChevronRight className="w-4 h-4" />
              </Button>
            </div>

            <div className="flex flex-col lg:flex-row gap-5 items-start">
              <div className="w-full lg:flex-1 min-w-0">
                <WeekTimeGrid
                  columns={columns} today={today}
                  renderItem={(ev, { fill }) => (
                    <NightBlock ev={ev} fill={fill} picked={ev.id === selectedId} onClick={() => setSelectedId(ev.id === selectedId ? null : ev.id)} />
                  )}
                  footer={
                    <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 py-3 text-xs text-ash">
                      <span className="inline-flex items-center gap-1.5"><span className="w-5 h-2.5 rounded-sm bg-[#24734a]" /> Attended</span>
                      <span className="inline-flex items-center gap-1.5"><span className="w-5 h-2.5 rounded-sm border border-[#24734a]" /> Missed</span>
                      <span className="inline-flex items-center gap-1.5"><span className="w-5 h-2.5 rounded-sm border border-dashed border-[#24734a]" /> Missed — you can still ask</span>
                      <span className="inline-flex items-center gap-1.5"><Hourglass className="w-3 h-3 text-brass" /> Waiting on an officer</span>
                      <span className="inline-flex items-center gap-1.5"><ThumbsDown className="w-3 h-3 text-oxblood" /> Declined</span>
                      <span className="ml-auto text-ash/70">Colour is the kind of event, as on the Event Calendar.</span>
                    </div>
                  }
                />
                {weekEvents.length === 0 && (
                  <p className="text-sm text-ash mt-3">No attendance was taken this week.</p>
                )}
              </div>

              <aside className="w-full lg:w-[340px] shrink-0 panel rounded-lg p-5 lg:sticky lg:top-20">
                {selected ? (
                  <div className="relative">
                    <button onClick={() => setSelectedId(null)} aria-label="Close" className="absolute right-0 top-0 text-ash hover:text-bone">
                      <X className="w-4 h-4" />
                    </button>
                    <div className="pr-6"><NightCard ev={selected} {...cardProps} /></div>
                  </div>
                ) : (
                  <div className="py-10 text-center text-sm text-ash">
                    <CalendarCheck className="w-6 h-6 text-brass/60 mx-auto mb-3" />
                    Pick a night to see where you stand, or to ask to be added.
                  </div>
                )}
              </aside>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}
