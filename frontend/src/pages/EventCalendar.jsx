import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  CalendarRange, Check, ChevronLeft, ChevronRight, Clock, Loader2, Users, CalendarOff, AlertTriangle, Plus,
  LayoutGrid, List, Settings, Trash2, X, Send,
} from 'lucide-react';
import ScheduleManager from '../components/ScheduleManager';
import WeekTimeGrid from '../components/WeekTimeGrid';
import {
  NightCard, placeTime, standing, timeLeft, STANDING_ICON, STANDING_LABEL,
} from '../components/AttendanceNight';
import { CATEGORIES, OTHER, categoryOf } from '../eventCategories';

import {
  fmtTimeEst, todayInGuildTz, eventsForGuildDay, isAfterMidnight, daySlot, getGuildTz,
  addDays, loaCovers,
} from '../timeUtils';
import { useAuth } from '../auth';
import { PageShell } from '../components/ui/PageShell';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import EmptyState from '../components/ui/EmptyState';
import ErrorState from '../components/ui/ErrorState';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';

// ── WHY THIS PAGE EXISTS ALONGSIDE /signups ─────────────────────────────────
// The Signups page lists occurrences that have been OPENED. Most of a week has
// none: a recurring event has no signup_events row until somebody makes one, so
// a member looking ahead sees an empty page and no way to answer.
//
// This shows the schedule instead, and signing up for a night nobody has opened
// creates the occurrence on the way through (POST /api/signups/for-event). That
// one behaviour is the whole point — without it the calendar could only ever
// display the same handful of rows the other page already does.
//
// Everyone's LOAs come from /api/loa/all — the same list the LOA board already
// shows every member, with reasons stripped for anyone without loa.admin — so
// each event can say who will be missing it.
//
// ── AND LOOKING BACK ────────────────────────────────────────────────────────
// Past nights carry your own attendance (/api/attendance/mine), which used to
// be its own My Attendance page: filled when you were counted, outlined when
// you weren't, and the late-attendance request in the side panel. The page
// asked "will you be there", that one asked "were you there", over the same
// nights on the same grid — so they are one page now.

const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Four weeks of paging against the server's 30-day member-open horizon. Weeks
// run Monday to Sunday, so the last day reachable is at most 27 days out (when
// today is a Monday) — the arrows can never land on a week whose buttons the
// API would refuse. A cap you can page into and then be rejected by is worse
// than one you can't reach.
const WEEKS_AHEAD = 4;
// And back, for your attendance. The fetch covers whole weeks, so the oldest
// week on screen is never half-loaded.
const WEEKS_BACK = 6;
const ATTENDANCE_DAYS = WEEKS_BACK * 7;

const VIEW_KEY = 'calendarView';
const readView = () => {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'week'; } catch { return 'week'; }
};

const dowOf = (dateStr) => new Date(`${dateStr}T12:00:00`).getDay();
const norm = (s) => String(s || '').trim().toLowerCase();

const shortDate = (dateStr) =>
  new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// Where the guild's wall clock sits in tonight's block, so an event that has
// already started can be shown as started rather than offering a button the
// server will answer with 409. Only ever applied to the first night on screen —
// nothing on a future night has begun.
//
// hourCycle 'h23' rather than hour12:false: the latter yields "24" for midnight
// in some engines, which would put the rollover an entire day out.
function guildNowSlot() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: getGuildTz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return daySlot(`${h}:${m}`);
}

const AWAY_KEY = 'calendarShowAway';
const readShowAway = () => {
  try { return localStorage.getItem(AWAY_KEY) !== '0'; } catch { return true; }
};

// How an LOA reads in one line: what kind it is, and when on the night.
function describeLoa(e) {
  const hours = e.start_time
    ? (e.end_time ? `${fmtTimeEst(e.start_time)} – ${fmtTimeEst(e.end_time)}` : `From ${fmtTimeEst(e.start_time)}`)
    : null;
  if (e.type === 'range') return { when: 'All night', what: `${shortDate(e.start_date)} – ${shortDate(e.end_date)}` };
  if (e.type === 'recurring') return { when: hours || 'All night', what: `Every ${DAY_NAME[e.day_of_week]}` };
  return { when: hours || 'All night', what: e.event_schedule_id ? 'This event only' : 'One night' };
}

// One entry per member, for one event. A member can match several (a range
// plus a standing night off); the one without a time window says the most, so
// it wins — the same preference unavailableOn uses.
function awayFor(entries, ctx) {
  const byMember = new Map();
  entries.forEach((e) => {
    if (!loaCovers(e, ctx)) return;
    const prev = byMember.get(e.discord_id);
    if (!prev || (prev.start_time && !e.start_time)) byMember.set(e.discord_id, e);
  });
  return [...byMember.values()].sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
}

export default function EventCalendar() {
  const { user, can } = useAuth();
  const [showAway, setShowAway] = useState(readShowAway);
  // Two kinds of event, each behind the capability its route already needs: a
  // one-off is an opened signup ('attendance'), a weekly one is a schedule
  // entry ('schedule'). The button shows for either.
  const canOneOff = can('attendance');
  const canWeekly = can('schedule');
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [posting, setPosting] = useState(false);
  const [view, setView] = useState(readView);
  // The grid's blocks are too small for buttons, so a click opens the event's
  // row in a modal. Held as a key and re-found each render, so the modal shows
  // the fresh row after signing up rather than the one that was clicked.
  const [selected, setSelected] = useState(null);
  const [occurrences, setOccurrences] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [loaEntries, setLoaEntries] = useState([]);
  const [myAttendance, setMyAttendance] = useState([]);
  // Late-attendance request state, owned here and handed to NightCard.
  const [asking, setAsking] = useState(null); // logged event id the reason box is open for
  const [reason, setReason] = useState('');
  const [lateBusy, setLateBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [offset, setOffset] = useState(0);
  const [msg, flash] = useFlash();

  const load = useCallback(() => {
    setError('');
    Promise.all([
      axios.get('/api/signups'),
      axios.get('/api/event-schedule'),
      axios.get('/api/loa/all'),
      // Soft-failed, both: the week ahead is still worth showing without them.
      axios.get('/api/attendance/mine', { params: { days: ATTENDANCE_DAYS } })
        .catch((err) => { console.error('attendance load failed:', err.message); return { data: { events: [] } }; }),
      // Finished nights' signups, so a past night can say "you signed up for
      // this one" beside your attendance on it.
      axios.get('/api/signups', { params: { past_days: ATTENDANCE_DAYS } })
        .catch((err) => { console.error('past signups load failed:', err.message); return { data: { signups: [] } }; }),
    ])
      .then(([sig, sched, loa, att, pastSig]) => {
        setOccurrences([...(pastSig.data.signups || []), ...(sig.data.signups || [])]);
        setSchedule(sched.data.schedule || []);
        setLoaEntries(loa.data.entries || []);
        setMyAttendance(att.data.events || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load the calendar.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Monday to Sunday of the shown week. Guild nights, not calendar days —
  // todayInGuildTz rolls at the configured day start, so at 12:30am "today" is
  // still the night in progress.
  const today = todayInGuildTz();
  const days = useMemo(() => {
    const monday = addDays(today, -((dowOf(today) + 6) % 7) + offset * 7);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }, [offset, today]);

  const nowSlot = guildNowSlot();

  const nights = useMemo(() => days.map((date) => {
    const dow = dowOf(date);
    const opened = occurrences.filter((o) => o.event_date === date);
    const byScheduleId = new Map(opened.filter((o) => o.event_schedule_id).map((o) => [o.event_schedule_id, o]));

    // The nights attendance was logged for, matched onto the rows below and
    // taken off this list as they are; whatever is left gets a block of its own.
    const logged = myAttendance.filter((a) => a.event_date === date);
    const claim = (pred) => {
      const i = logged.findIndex(pred);
      return i === -1 ? null : logged.splice(i, 1)[0];
    };

    // Every scheduled event that runs this night, whether or not anyone has
    // opened it. This is the half /signups can't show.
    const scheduled = eventsForGuildDay(schedule, dow, date).map((s) => {
      const occ = byScheduleId.get(s.id) || null;
      return {
        key: occ ? occ.id : `sched:${s.id}:${date}`,
        signupId: occ?.id || null,
        scheduleId: s.id,
        fromSchedule: true,
        title: occ?.title || s.name,
        eventTime: occ?.event_time || s.event_time || null,
        occ,
        attendance: claim((a) => String(a.event_schedule_id) === String(s.id)),
      };
    });

    // Anything opened for this night that the pass above didn't consume:
    // ad-hoc events with no schedule row, and the edge case of an occurrence
    // whose schedule entry has since been edited to another night. Matching on
    // "not already shown" rather than "has no schedule id" is what keeps that
    // second one visible instead of silently dropping a real signup.
    const shown = new Set(scheduled.filter((r) => r.occ).map((r) => r.occ.id));
    const extra = opened.filter((o) => !shown.has(o.id)).map((o) => ({
      key: o.id,
      signupId: o.id,
      scheduleId: o.event_schedule_id || null,
      title: o.title,
      eventTime: o.event_time || null,
      occ: o,
      // A one-off signup and the night logged for it share no id, only a
      // night and a name.
      attendance: claim((a) => !a.event_schedule_id && norm(a.title) === norm(o.title)),
    }));

    // Logged nights nothing above accounted for: one-offs nobody opened
    // signups for, and nights whose schedule entry has since changed.
    const loggedOnly = logged.map((a) => ({
      key: `att:${a.id}`,
      signupId: null,
      scheduleId: a.event_schedule_id || null,
      title: a.title,
      eventTime: placeTime(a),
      occ: null,
      attendance: a,
    }));

    const rows = [...scheduled, ...extra, ...loggedOnly]
      .map((r) => {
        const awayList = awayFor(loaEntries, { date, dow, scheduleId: r.scheduleId, eventTime: r.eventTime });
        return {
          ...r,
          myStatus: r.occ?.my_status || null,
          going: r.occ?.going_count || 0,
          waitlist: r.occ?.waitlist_count || 0,
          capacity: r.occ?.capacity ?? null,
          // `away` is still "am I away" — the warning on my own row.
          away: awayList.some((e) => e.discord_id === user?.id),
          awayList,
          // A week starts on Monday now, so earlier nights of this week are on
          // screen too — everything on them is over. Tonight's events are over
          // once their time has passed.
          started: date < today || (date === today && Boolean(r.eventTime) && daySlot(r.eventTime) <= nowSlot),
          // A finished night nobody took attendance for — "no record", which
          // is not the same as "you missed it".
          noRoll: date < today && !r.attendance,
        };
      })
      .sort((a, b) => (a.eventTime ? daySlot(a.eventTime) : -1) - (b.eventTime ? daySlot(b.eventTime) : -1)
        || String(a.title).localeCompare(String(b.title)));

    return { date, dow, rows };
  }), [days, occurrences, schedule, loaEntries, myAttendance, nowSlot, today, user?.id]);

  // Logged nights you can still ask to be added to — the one thing on this
  // page with a deadline, so it is offered above the grid whichever week is
  // showing.
  const askable = myAttendance.filter((a) => a.can_request);
  const loggedThisWeek = nights.flatMap((n) => n.rows.map((r) => r.attendance).filter(Boolean));

  const totalRows = nights.reduce((n, d) => n + d.rows.length, 0);
  const myCount = nights.reduce((n, d) => n + d.rows.filter((r) => r.myStatus).length, 0);

  const run = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      flash(err.response?.data?.error || "That didn't work.", false);
    } finally {
      setBusy('');
    }
  };

  // One handler for both row kinds. An already-open occurrence joins by id; a
  // schedule row with nothing behind it opens and joins in the single request,
  // so a failure can't leave an empty occurrence lying around looking like a
  // raid call nobody answered.
  const signUp = (row) => run(`join:${row.key}`, async () => {
    const res = row.signupId
      ? await axios.post(`/api/signups/${row.signupId}/join`)
      : await axios.post('/api/signups/for-event', {
        event_schedule_id: row.scheduleId, event_date: row.date,
      });
    load();
    flash(res.data.status === 'waitlist'
      ? `That one's full — you're on the waitlist for ${row.title}. You'll be moved up if a slot opens.`
      : `You're in for ${row.title}.`);
  });

  const withdraw = (row) => run(`leave:${row.key}`, async () => {
    const res = await axios.delete(`/api/signups/${row.signupId}/join`);
    load();
    flash(res.data.promoted
      ? `Withdrawn — ${res.data.promoted.display_name} moved up off the waitlist.`
      : 'Withdrawn.');
  });

  // Deleting a one-off is deleting its signup — the same route the Signups
  // page uses, which also takes down the Discord post. Scheduled nights aren't
  // offered this: the schedule would just show them again, unopened.
  const removeOneOff = (row) => {
    if (!window.confirm(`Delete ${row.title} on ${shortDate(row.date)}? Everyone's signups go with it.`)) return;
    run(`del:${row.key}`, async () => {
      await axios.delete(`/api/admin/signups/${row.signupId}`);
      setSelected(null);
      load();
      flash(`${row.title} deleted.`);
    });
  };
  const onDelete = canOneOff ? removeOneOff : null;

  // One night of a weekly event, cancelled without touching the rest of the
  // series. If signups were already opened for it they go too — otherwise the
  // opened occurrence would keep showing as an orphan on that night.
  const skipNight = (row) => {
    const tail = row.signupId ? " Everyone's signups for it go too." : '';
    if (!window.confirm(`Remove ${row.title} on ${shortDate(row.date)} only? Other weeks stay on the schedule.${tail}`)) return;
    run(`skip:${row.key}`, async () => {
      if (row.signupId) await axios.delete(`/api/admin/signups/${row.signupId}`);
      await axios.post(`/api/admin/event-schedule/${row.scheduleId}/skip`, { date: row.date, skip: true });
      setSelected(null);
      load();
      flash(`${row.title} removed for ${shortDate(row.date)}.`);
    });
  };
  // Opened signups can only be deleted with 'attendance', so a night that has
  // them needs both.
  const canSkip = (row) => canWeekly && row.fromSchedule && row.date >= today && !row.attendance
    && (!row.signupId || canOneOff);
  const onSkip = canWeekly ? skipNight : null;

  // ── Late attendance ──
  const fileLateRequest = async (ev) => {
    setLateBusy(ev.id);
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
      setLateBusy('');
    }
  };

  const withdrawLateRequest = async (ev) => {
    setLateBusy(ev.id);
    try {
      await axios.delete(`/api/attendance/late/${ev.request.id}`);
      flash('Withdrawn.');
    } catch (err) {
      flash(err.response?.data?.error || 'Could not withdraw that request.', false);
    } finally {
      setLateBusy('');
      load();
    }
  };

  const late = {
    asking, setAsking, reason, setReason, busy: lateBusy,
    onRequest: fileLateRequest, onWithdraw: withdrawLateRequest,
  };

  // Jump to a logged night's week and open it — the "you can still ask" links,
  // which may point at last week. Selected by attendance id, because the row's
  // key isn't known until that week's rows are built.
  const openLogged = (a) => {
    const monday = (d) => addDays(d, -((dowOf(d) + 6) % 7));
    const weeks = Math.round((new Date(`${monday(a.event_date)}T12:00:00Z`) - new Date(`${monday(today)}T12:00:00Z`)) / (7 * 86_400_000));
    setOffset(Math.max(-(WEEKS_BACK - 1), Math.min(WEEKS_AHEAD - 1, weeks)));
    setSelected({ date: a.event_date, attId: a.id });
  };

  if (loading) return <PageShell maxWidth="max-w-3xl"><EmptyState>Reading the week ahead…</EmptyState></PageShell>;
  if (error) {
    return (
      <PageShell maxWidth="max-w-3xl">
        <ErrorState title="CALENDAR UNREACHABLE" message={error} onRetry={() => { setLoading(true); load(); }} />
      </PageShell>
    );
  }

  const changeView = (v) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer nicety only */ }
  };

  const toggleShowAway = () => {
    setShowAway((v) => {
      try { localStorage.setItem(AWAY_KEY, v ? '0' : '1'); } catch { /* per-viewer nicety only */ }
      return !v;
    });
  };

  // The list shows the nights still to come, plus any finished night that has
  // your attendance on it — the list is all a phone gets, so it has to carry
  // the looking-back half too. A finished night with no record would only be
  // a row saying so, and an empty past week reads fine as "nothing".
  const listed = nights
    .map((n) => (n.date >= today ? n : { ...n, rows: n.rows.filter((r) => r.attendance) }))
    .filter((n) => n.date >= today || n.rows.length);
  const listedRows = listed.reduce((n, d) => n + d.rows.length, 0);
  const listView = listedRows === 0 ? (
    <EmptyState>{offset < 0 ? 'No attendance was taken that week.' : 'Nothing on the schedule this week.'}</EmptyState>
  ) : (
    <div className="space-y-6">
      {listed.map((night) => (
        <Night
          key={night.date} night={night}
          isTonight={night.date === today}
          busy={busy} onJoin={signUp} onLeave={withdraw}
          showAway={showAway} onDetails={(row) => setSelected({ date: night.date, key: row.key })}
        />
      ))}
    </div>
  );

  const selectedNight = selected && nights.find((n) => n.date === selected.date);
  const selectedRow = selectedNight?.rows.find((r) => (selected.attId
    ? String(r.attendance?.id) === String(selected.attId)
    : r.key === selected.key));

  return (
    // Week view takes the same full width as the Parties board: seven columns
    // plus the side panel are cramped at 7xl. The list stays narrow — it's
    // one column of rows, and long lines are harder to read.
    <PageShell maxWidth={view === 'week' ? 'max-w-[1600px]' : 'max-w-3xl'}>
      <div className="flex items-center gap-3 mb-2">
        <CalendarRange className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">EVENT CALENDAR</h1>
        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={toggleShowAway} aria-pressed={showAway}
            title="Show how many people have an LOA covering each event"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${showAway ? 'border-brass/60 text-brass bg-panelup' : 'border-line text-ash hover:text-bone'}`}
          >
            <CalendarOff className="w-4 h-4" /> Who's away
          </button>
          {/* Week/List only where the grid can actually be shown. */}
          <div className="hidden md:flex rounded-lg border border-line overflow-hidden">
            {[['week', LayoutGrid, 'Week'], ['list', List, 'List']].map(([key, Icon, label]) => (
              <button
                key={key} onClick={() => changeView(key)} title={`${label} view`}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${view === key ? 'bg-panelup text-brass' : 'text-ash hover:text-bone'}`}
              >
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
          {canWeekly && (
            <Button variant="secondary" size="none" className="px-3 py-1.5 text-sm" onClick={() => setPosting(true)}>
              <Send className="w-4 h-4" /> Post to Discord
            </Button>
          )}
          {canWeekly && (
            <Button variant="secondary" size="none" className="px-3 py-1.5 text-sm" onClick={() => setManaging(true)}>
              <Settings className="w-4 h-4" /> Manage schedule
            </Button>
          )}
          {(canOneOff || canWeekly) && (
            <Button size="none" className="px-3 py-1.5 text-sm" onClick={() => setCreating(true)}>
              <Plus className="w-4 h-4" /> New Event
            </Button>
          )}
        </div>
      </div>

      {creating && (
        <NewEventModal
          canOneOff={canOneOff} canWeekly={canWeekly}
          defaultDate={days[0] < today ? today : days[0]}
          onClose={() => setCreating(false)}
          onCreated={(text) => { setCreating(false); flash(text); load(); }}
        />
      )}

      {posting && (
        <PostDayModal
          defaultDate={selected?.date && selected.date >= today ? selected.date : today}
          schedule={schedule} occurrences={occurrences}
          onClose={() => setPosting(false)}
          onPosted={(text) => { setPosting(false); flash(text); }}
        />
      )}

      {managing && (
        <Modal onClose={() => setManaging(false)} maxWidth="max-w-2xl" scrollable>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-lg tracking-[0.08em] text-bone">EVENT SCHEDULE</h2>
            <button onClick={() => setManaging(false)} className="text-ash hover:text-bone text-sm">Close</button>
          </div>
          <ScheduleManager schedule={schedule} onChanged={load} />
        </Modal>
      )}

      {/* A popup only where there's no room beside the grid: the list view,
          and phones (which get the list even in week view). On the grid the
          same detail sits in the side panel instead — md:hidden keeps this
          overlay from doubling it there. */}
      {selectedRow && (
        <div className={view === 'week' ? 'md:hidden' : ''}>
          <Modal onClose={() => setSelected(null)} scrollable>
            <EventDetail
              night={selectedNight} row={{ ...selectedRow, date: selectedNight.date }}
              busy={busy} onJoin={signUp} onLeave={withdraw} late={late} onDelete={onDelete}
              onSkip={onSkip && canSkip({ ...selectedRow, date: selectedNight.date }) ? onSkip : null}
            />
          </Modal>
        </div>
      )}
      <p className="text-ash text-sm mb-6">
        The week ahead, whether or not signups have been opened — saying you're in opens them. Past nights show
        whether you were counted; if attendance missed you, you can ask to be added for 24 hours after it was taken.
        {' '}There's no way to say you're out here — <Link to="/loa" className="text-brass hover:text-brassbright underline">file an LOA</Link> for that.
      </p>

      <Toast msg={msg} />

      {askable.length > 0 && (
        <div className="panel rounded-lg px-4 py-3 mb-4 text-sm flex flex-wrap items-center gap-x-3 gap-y-2 border-brass/40">
          <Clock className="w-4 h-4 text-brass" />
          <span className="text-bone">Attendance missed you — you can still ask to be added:</span>
          {askable.map((a) => (
            <button key={a.id} onClick={() => openLogged(a)} className="text-brass hover:text-brassbright underline underline-offset-2">
              {a.title} ({new Date(`${a.event_date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' })}, {timeLeft(a.window_closes_at)})
            </button>
          ))}
        </div>
      )}

      {/* Week pager. Forward to the signup horizon — past it is a button the
          server would refuse — and back as far as your attendance is loaded. */}
      <div className="flex items-center justify-between gap-4 mb-6 panel rounded-lg px-4 py-3">
        <Button
          variant="ghost" size="none" className="px-2 py-1 text-sm"
          onClick={() => setOffset((o) => Math.max(-(WEEKS_BACK - 1), o - 1))} disabled={offset <= -(WEEKS_BACK - 1)}
        >
          <ChevronLeft className="w-4 h-4" /> Previous
        </Button>
        <div className="text-center">
          <div className="text-bone text-sm">{shortDate(days[0])} – {shortDate(days[6])}</div>
          <div className="eyebrow text-[10px] text-ash/75 mt-0.5">
            {offset === 0 ? 'This week' : offset > 0 ? `In ${offset} week${offset === 1 ? '' : 's'}` : `${-offset} week${offset === -1 ? '' : 's'} ago`}
            {myCount > 0 && offset >= 0 && <> · you're in for {myCount}</>}
            {loggedThisWeek.length > 0 && <> · attended {loggedThisWeek.filter((a) => a.attended).length} of {loggedThisWeek.length}</>}
            {offset !== 0 && (
              <button onClick={() => setOffset(0)} className="ml-2 text-brass hover:text-brassbright normal-case tracking-normal">this week</button>
            )}
          </div>
        </div>
        <Button
          variant="ghost" size="none" className="px-2 py-1 text-sm"
          onClick={() => setOffset((o) => Math.min(WEEKS_AHEAD - 1, o + 1))} disabled={offset >= WEEKS_AHEAD - 1}
        >
          Next <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {view === 'list' ? listView : (
        <>
          {/* Phones get the list either way — seven columns don't fit. */}
          <div className="md:hidden">{listView}</div>
          {totalRows === 0 ? (
            <div className="hidden md:block"><EmptyState>Nothing on the schedule this week.</EmptyState></div>
          ) : (
            // Side by side from lg up; between md and lg the panel drops below
            // the grid rather than squeezing seven columns narrower.
            <div className="hidden md:flex flex-col lg:flex-row gap-5 items-start">
              <div className="w-full lg:flex-1 min-w-0">
                <WeekGrid
                  nights={nights} today={today} nowSlot={nowSlot} showAway={showAway}
                  selected={selectedRow ? { date: selectedNight.date, key: selectedRow.key } : null}
                  onSelect={setSelected}
                />
              </div>
              <aside className="w-full lg:w-[320px] shrink-0 panel rounded-lg p-5 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-auto">
                {selectedRow ? (
                  <div className="relative">
                    <button
                      onClick={() => setSelected(null)} aria-label="Close"
                      className="absolute right-0 top-0 text-ash hover:text-bone"
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <EventDetail
                      night={selectedNight} row={{ ...selectedRow, date: selectedNight.date }}
                      busy={busy} onJoin={signUp} onLeave={withdraw} late={late} onDelete={onDelete}
                      onSkip={onSkip && canSkip({ ...selectedRow, date: selectedNight.date }) ? onSkip : null}
                    />
                  </div>
                ) : (
                  <div className="py-10 text-center text-sm text-ash">
                    <CalendarRange className="w-6 h-6 text-brass/60 mx-auto mb-3" />
                    Pick an event to see who's in and who's away — or, for a past night, whether you were counted.
                  </div>
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}

// One night's agenda. Nights with nothing scheduled still get a heading — a
// week that silently skips Tuesday reads as a loading bug, and "nothing on"
// is a real answer to "what's on Tuesday".
function Night({ night, isTonight, busy, onJoin, onLeave, showAway, onDetails }) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <h2 className="font-display text-lg tracking-[0.08em] text-bone">{DAY_NAME[night.dow]}</h2>
        <span className="text-ash text-sm">{shortDate(night.date)}</span>
        {isTonight && <span className="eyebrow text-[10px] text-brass">tonight</span>}
      </div>

      {night.rows.length === 0 ? (
        <div className="panel rounded-lg px-4 py-3 text-ash/60 text-sm">Nothing scheduled.</div>
      ) : (
        <div className="panel rounded-lg divide-y divide-line">
          {night.rows.map((row) => (
            <EventRow
              key={row.key} row={{ ...row, date: night.date }}
              busy={busy} onJoin={onJoin} onLeave={onLeave}
              showAway={showAway} onDetails={onDetails}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── THE WEEK GRID ───────────────────────────────────────────────────────────
// Layout lives in WeekTimeGrid; this supplies the blocks and the category
// legend.
function WeekGrid({ nights, today, nowSlot, showAway, selected, onSelect }) {
  const isPicked = (date, key) => selected?.date === date && selected?.key === key;
  const present = new Set(nights.flatMap((n) => n.rows.map((r) => categoryOf(r.title).key)));

  return (
    <WeekTimeGrid
      columns={nights.map((n) => ({ date: n.date, items: n.rows }))}
      today={today} nowSlot={nowSlot}
      renderItem={(r, { date, fill }) => (
        <Block row={r} fill={fill} showAway={showAway} picked={isPicked(date, r.key)} onClick={() => onSelect({ date, key: r.key })} />
      )}
      footer={
        // Legend — only the kinds this week actually has, so it explains what
        // is on screen rather than listing every activity in the game.
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-xs text-ash">
          {[...CATEGORIES, OTHER].filter((c) => present.has(c.key)).map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: c.color }} /> {c.label}
            </span>
          ))}
        </div>
      }
    />
  );
}

// One event on the grid: its colour, name, and the facts worth a glance —
// whether I'm in, how many are, and (with Who's away on) how many have an LOA
// covering it. Everything else is a click away.
//
// A night attendance was taken for shows your attendance instead, because
// once it's over that is the only fact about it worth a glance: filled when
// you were counted, outlined when you weren't (dashed while you can still ask).
function Block({ row, fill = false, showAway = false, picked = false, onClick }) {
  const cat = categoryOf(row.title);
  const mine = row.myStatus === 'going';
  const awayCount = row.awayList?.length || 0;
  const ring = picked ? 'ring-2 ring-bone ring-offset-1 ring-offset-panel' : '';

  if (row.attendance) {
    const s = standing(row.attendance);
    const Icon = STANDING_ICON[s];
    const filled = s === 'attended';
    // Signed up, then not counted — the likeliest night to be worth a late
    // request, and nothing else on the page connects the two.
    const promisedButMissing = mine && !filled;
    return (
      <button
        onClick={onClick}
        aria-pressed={picked}
        title={`${row.title} · ${STANDING_LABEL[s]}${promisedButMissing ? ' · you signed up for this one' : ''}`}
        className={`w-full ${fill ? 'h-full' : ''} flex items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] leading-tight overflow-hidden transition-[filter] hover:brightness-125 ${filled ? 'text-white' : 'bg-panel text-bone'} ${ring}`}
        style={filled ? { background: cat.color } : { border: `1px ${s === 'askable' ? 'dashed' : 'solid'} ${cat.color}` }}
      >
        <Icon className={`w-3 h-3 shrink-0 ${filled ? '' : s === 'pending' || s === 'askable' ? 'text-brass' : s === 'denied' ? 'text-oxblood' : 'text-ash'}`} />
        <span className="truncate font-medium">{row.title}</span>
        {promisedButMissing && <AlertTriangle className="w-3 h-3 shrink-0 ml-auto text-brassbright" />}
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      title={`${row.title}${row.eventTime ? ` · ${fmtTimeEst(row.eventTime)}` : ''} · ${row.going} in${awayCount ? ` · ${awayCount} away` : ''}`}
      className={`w-full ${fill ? 'h-full' : ''} flex items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] leading-tight text-white overflow-hidden transition-[filter] hover:brightness-125 ${row.started ? 'opacity-45' : ''} ${ring || (mine ? 'ring-1 ring-white/70' : '')}`}
      aria-pressed={picked}
      style={{ background: cat.color }}
    >
      <span className="truncate font-medium">{row.title}</span>
      {mine && <Check className="w-3 h-3 shrink-0" />}
      {row.myStatus === 'waitlist' && <Clock className="w-3 h-3 shrink-0" />}
      {/* Without the guild-wide count, still say when I'm the one away. */}
      {row.away && !showAway && <CalendarOff className="w-3 h-3 shrink-0" />}
      <span className="ml-auto shrink-0 font-mono text-white/80">{row.going}{row.capacity ? `/${row.capacity}` : ''}</span>
      {showAway && awayCount > 0 && (
        <span className={`shrink-0 inline-flex items-center gap-0.5 rounded-full px-1.5 font-mono text-[10px] ${row.away ? 'bg-white text-ink' : 'bg-black/35'}`}>
          <CalendarOff className="w-2.5 h-2.5" />{awayCount}
        </span>
      )}
    </button>
  );
}

// ── ONE EVENT, OPENED ───────────────────────────────────────────────────────
// The row's own controls, then who is away for it. The away list is computed
// here from everyone's LOAs; reasons only arrive for officers (/api/loa/all
// strips them otherwise), so they show exactly when the server sent them.
//
// Who is signed up needs the signup's own detail — /api/signups carries only
// counts — so it is fetched when the event has been opened. It is used for one
// thing: flagging anyone who is both on LOA and signed up, which the officer
// has to resolve and which the server already works out as `conflicts`.
function EventDetail({ night, row, busy, onJoin, onLeave, late, onDelete = null, onSkip = null }) {
  const [conflictIds, setConflictIds] = useState(() => new Set());

  useEffect(() => {
    setConflictIds(new Set());
    if (!row.signupId) return undefined;
    let live = true;
    axios.get(`/api/signups/${row.signupId}`)
      .then((res) => {
        if (live) setConflictIds(new Set((res.data.conflicts || []).map((c) => String(c.discord_id))));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [row.signupId, row.going]);

  const away = row.awayList || [];
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-3">
        <span className="w-2.5 h-2.5 rounded-full self-center" style={{ background: categoryOf(row.title).color }} />
        <h2 className="font-display text-lg tracking-[0.08em] text-bone">{DAY_NAME[night.dow]}</h2>
        <span className="text-ash text-sm">{shortDate(night.date)}</span>
      </div>
      <div className="border border-line rounded-lg">
        <EventRow row={row} busy={busy} onJoin={onJoin} onLeave={onLeave} />
      </div>

      {/* The looking-back half: where you stand on a night attendance was
          taken for, and the late request if it missed you. */}
      {row.attendance && (
        <div className="mt-4">
          <div className="eyebrow text-[10px] text-brass mb-2">Your attendance</div>
          <div className="border border-line rounded-lg px-3 py-3">
            <NightCard ev={row.attendance} late={late} showTitle={false} />
          </div>
          {row.myStatus === 'going' && !row.attendance.attended && (
            <p className="text-xs text-brassbright mt-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              You signed up for this one but aren&apos;t on the roll.
              {row.attendance.can_request ? ' If you were there, ask to be added.' : ''}
            </p>
          )}
        </div>
      )}
      {row.noRoll && (
        <p className="text-sm text-ash mt-4">No attendance was taken for this night.</p>
      )}

      <div className="grid grid-cols-3 gap-2 mt-4">
        {[
          ['signed up', row.going, 'text-bone'],
          ['away', away.length, away.length ? 'text-brassbright' : 'text-bone'],
          ['waitlist', row.waitlist, 'text-bone'],
        ].map(([label, n, tone]) => (
          <div key={label} className="bg-panelup rounded-lg py-2 text-center">
            <div className={`font-mono text-lg ${tone}`}>{n}</div>
            <div className="text-[11px] text-ash">{label}</div>
          </div>
        ))}
      </div>

      <div className="eyebrow text-[10px] text-brass mt-5 mb-2">Away ({away.length})</div>
      {away.length === 0 ? (
        <p className="text-sm text-ash">Nobody has an LOA covering this.</p>
      ) : (
        <div className="space-y-1.5">
          {away.map((e) => {
            const { when, what } = describeLoa(e);
            const clash = conflictIds.has(String(e.discord_id));
            return (
              <div
                key={e.discord_id}
                className={`rounded-lg border px-3 py-2 text-sm ${clash ? 'border-oxblood/60 bg-oxblooddeep/30' : 'border-line bg-hall'}`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-bone truncate">{e.display_name || 'Member'}</span>
                  <span className={`text-xs shrink-0 ${clash ? 'text-brassbright' : 'text-ash'}`}>{clash ? 'Signed up' : when}</span>
                </div>
                <div className="text-xs text-ash mt-0.5">
                  {clash ? <>On LOA <em>and</em> signed up · {when} · {what}</> : what}
                </div>
                {e.reason && <div className="text-xs text-ash/80 italic mt-0.5">“{e.reason}”</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* An opened signup with no schedule entry behind it is a one-off. */}
      {onDelete && row.signupId && !row.scheduleId && (
        <div className="mt-5 pt-4 border-t border-line flex justify-end">
          <Button
            variant="destructive" size="sm" icon={<Trash2 className="w-4 h-4" />}
            disabled={busy === `del:${row.key}`} onClick={() => onDelete(row)}
          >
            Delete event
          </Button>
        </div>
      )}
      {/* A weekly event: cancel just this night. */}
      {onSkip && (
        <div className="mt-5 pt-4 border-t border-line flex justify-end">
          <Button
            variant="destructive" size="sm" icon={<Trash2 className="w-4 h-4" />}
            disabled={busy === `skip:${row.key}`} onClick={() => onSkip(row)}
          >
            Remove this night only
          </Button>
        </div>
      )}
    </div>
  );
}

const FIELD = 'w-full bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass';

// One form, two kinds of event. A one-off opens signups for a single date —
// that is what an unscheduled event on this calendar already is, so it shows
// up here the moment it's made. A weekly one is a schedule entry, the same as
// adding it on the LOA page.
//
// Both take the NIGHT, not the calendar day: a 12:30am event picked for
// Saturday is Saturday night's. For a weekly event that means storing it on
// the next calendar day, which is how the schedule keeps after-midnight rows.
function NewEventModal({ canOneOff, canWeekly, defaultDate, onClose, onCreated }) {
  const [kind, setKind] = useState(canOneOff ? 'once' : 'weekly');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [night, setNight] = useState(String(dowOf(defaultDate)));
  const [time, setTime] = useState('');
  const [capacity, setCapacity] = useState('');
  const [announce, setAnnounce] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setError('Give the event a name.'); return; }
    setSaving(true); setError('');
    try {
      if (kind === 'once') {
        const res = await axios.post('/api/admin/signups', {
          event_date: date, title: title.trim(), event_time: time || null,
          capacity: capacity || null, announce,
        });
        onCreated(res.data.created
          ? `${title.trim()} added for ${shortDate(date)}${announce ? ' and posted to Discord' : ''}.`
          : 'That event was already on the calendar.');
      } else {
        const n = parseInt(night, 10);
        await axios.post('/api/admin/event-schedule', {
          name: title.trim(),
          day_of_week: isAfterMidnight(time) ? (n + 1) % 7 : n,
          event_time: time || null,
        });
        onCreated(`${title.trim()} added every ${DAY_NAME[n]}.`);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Could not create that event.');
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <h2 className="font-display text-lg tracking-[0.08em] text-bone">NEW EVENT</h2>

        {canOneOff && canWeekly && (
          <div className="flex gap-2">
            {[['once', 'One-off'], ['weekly', 'Weekly']].map(([key, label]) => (
              <button
                key={key} type="button" onClick={() => setKind(key)}
                className={`flex-1 px-3 py-2 rounded-lg border text-sm transition-colors ${kind === key ? 'border-brass text-brass bg-panelup' : 'border-line text-ash hover:text-bone'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        <div>
          <label className="eyebrow text-[10px] text-ash block mb-2">Name</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Archboss — Morokai" className={FIELD} autoFocus />
        </div>

        <div className="flex gap-3">
          {kind === 'once' ? (
            <div className="flex-1">
              <label className="eyebrow text-[10px] text-ash block mb-2">Night</label>
              <input type="date" value={date} min={todayInGuildTz()} onChange={(e) => setDate(e.target.value)} required className={FIELD} />
            </div>
          ) : (
            <div className="flex-1">
              <label className="eyebrow text-[10px] text-ash block mb-2">Every</label>
              <select value={night} onChange={(e) => setNight(e.target.value)} className={FIELD}>
                {DAY_NAME.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </div>
          )}
          <div className="w-36">
            <label className="eyebrow text-[10px] text-ash block mb-2">Time (optional)</label>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={FIELD} />
          </div>
        </div>
        {isAfterMidnight(time) && (
          <p className="text-xs text-ash/70 -mt-2">After midnight — counted as part of the night before.</p>
        )}

        {kind === 'once' && (
          <>
            <div className="w-36">
              <label className="eyebrow text-[10px] text-ash block mb-2">Cap (optional)</label>
              <input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="No limit" className={FIELD} />
            </div>
            <label className="flex items-center gap-2 text-sm text-ash">
              <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
              Post the signup to Discord
            </label>
          </>
        )}

        {error && <div className="text-sm text-oxblood">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="neutral" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 animate-spin" />} Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── POST A NIGHT TO DISCORD ─────────────────────────────────────────────────
// Filled from the calendar for the picked night, then edited by hand: drop a
// line, change a time, add something that isn't on the schedule. The server
// turns each time into a Discord timestamp, so readers see it in their own
// timezone with a live countdown.
// The night's events as editable lines: scheduled ones (minus nights removed
// from the calendar), then one-offs opened for that night.
function eventsForPost(schedule, occurrences, date) {
  const sched = eventsForGuildDay(schedule, dowOf(date), date);
  const ids = new Set(sched.map((s) => s.id));
  const extra = occurrences.filter((o) => o.event_date === date && !ids.has(o.event_schedule_id));
  return [
    ...sched.map((s) => ({ name: s.name, time: s.event_time || '' })),
    ...extra.map((o) => ({ name: o.title, time: o.event_time || '' })),
  ].map((e, i) => ({ ...e, key: `${date}:${i}` }));
}

function PostDayModal({ defaultDate, schedule, occurrences, onClose, onPosted }) {
  const [date, setDate] = useState(defaultDate);
  const [rows, setRows] = useState(() => eventsForPost(schedule, occurrences, defaultDate));
  const [channels, setChannels] = useState([]);
  const [channelId, setChannelId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get('/api/admin/event-schedule/post-channels')
      .then((res) => {
        const list = res.data.channels || [];
        setChannels(list);
        // Starts on the Event Calendar channel from Guild Settings every time;
        // picking another here only changes this one post.
        const configured = res.data.default_channel_id;
        setChannelId(list.some((c) => c.id === configured) ? configured : list[0]?.id || '');
      })
      .catch(() => setError('Could not load the channel list — is the bot online?'));
  }, []);

  const changeDate = (d) => {
    setDate(d);
    if (d) setRows(eventsForPost(schedule, occurrences, d));
  };
  const edit = (key, field, value) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  const remove = (key) => setRows((rs) => rs.filter((r) => r.key !== key));
  const add = () => setRows((rs) => [...rs, { key: `new:${Date.now()}`, name: '', time: '' }]);

  const submit = async (e) => {
    e.preventDefault();
    const events = rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), time: r.time || null }));
    if (!events.length) { setError('Add at least one event.'); return; }
    if (!channelId) { setError('Pick a channel.'); return; }
    setSaving(true); setError('');
    try {
      await axios.post('/api/admin/event-schedule/post-day', { date, events, channel_id: channelId, note });
      const ch = channels.find((c) => c.id === channelId);
      onPosted(`Posted ${shortDate(date)}'s events${ch ? ` to #${ch.name}` : ''}.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not post.');
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} scrollable>
      <form onSubmit={submit} className="space-y-4">
        <h2 className="font-display text-lg tracking-[0.08em] text-bone">POST TO DISCORD</h2>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="eyebrow text-[10px] text-ash block mb-2">Night</label>
            <input type="date" value={date} onChange={(e) => changeDate(e.target.value)} required className={FIELD} />
          </div>
          <div className="flex-1">
            <label className="eyebrow text-[10px] text-ash block mb-2">Channel</label>
            <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className={FIELD}>
              {channels.length === 0 && <option value="">—</option>}
              {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="eyebrow text-[10px] text-ash block mb-2">Events</label>
          {rows.length === 0 && <p className="text-sm text-ash mb-2">Nothing on the calendar that night — add events below.</p>}
          <div className="space-y-2">
            {rows.map((r) => (
              <div key={r.key} className="flex gap-2 items-center">
                <input value={r.name} onChange={(e) => edit(r.key, 'name', e.target.value)} placeholder="Event name" className={`${FIELD} flex-1`} />
                <input type="time" value={r.time} onChange={(e) => edit(r.key, 'time', e.target.value)} className={`${FIELD} !w-32`} title="Guild time; blank = time TBA" />
                <button type="button" onClick={() => remove(r.key)} title="Remove from this post" className="p-1 text-ash hover:text-oxblood shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
          <button type="button" onClick={add} className="mt-2 inline-flex items-center gap-1 text-sm text-brass hover:text-brassbright">
            <Plus className="w-4 h-4" /> Add event
          </button>
          <p className="text-xs text-ash/70 mt-2">
            Times are guild time; Discord shows each reader their own local time and a live countdown. After-midnight times count as part of this night.
          </p>
        </div>

        <div>
          <label className="eyebrow text-[10px] text-ash block mb-2">Message (optional)</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Shown above the list — e.g. a role ping" className={FIELD} />
        </div>

        {error && <div className="text-sm text-oxblood">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="neutral" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={saving || !channelId}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Post
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EventRow({ row, busy, onJoin, onLeave, showAway = false, onDetails = null }) {
  const joining = busy === `join:${row.key}`;
  const leaving = busy === `leave:${row.key}`;
  const working = joining || leaving;
  const isIn = row.myStatus === 'going';
  const isWaitlisted = row.myStatus === 'waitlist';

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="w-24 shrink-0 text-sm">
        {row.eventTime ? (
          <span className={row.started ? 'text-ash/40' : 'text-brassbright font-mono'}>{fmtTimeEst(row.eventTime)}</span>
        ) : (
          <span className="text-ash/40">—</span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className={`truncate ${row.started ? 'text-ash/60' : 'text-bone'}`}>{row.title}</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5 text-xs">
          <span className="inline-flex items-center gap-1 text-ash">
            <Users className="w-3 h-3" />
            {/* A schedule row nobody has opened genuinely has nobody in it —
                shown as 0 rather than blank, because "no one yet" is the
                information that decides whether to be the first. */}
            <span className={row.going ? 'text-bone font-mono' : 'text-ash/50 font-mono'}>{row.going}</span>
            {row.capacity ? <span className="text-ash/50 font-mono">/{row.capacity}</span> : null}
            in
            {row.waitlist > 0 && <span className="text-ash/50">· {row.waitlist} waiting</span>}
          </span>

          {isAfterMidnight(row.eventTime) && (
            <span className="inline-flex items-center gap-1 text-ash/50" title="Runs after midnight — still part of this night">
              <Clock className="w-3 h-3" /> after midnight
            </span>
          )}

          {/* LOA is surfaced, never resolved. Signing up while on leave is
              allowed — you may have filed a range and made an exception for
              this one night — so the pair shows as a warning, not a block. */}
          {row.away && !row.myStatus && (
            <span className="inline-flex items-center gap-1 text-brass" title="You have an LOA covering this">
              <CalendarOff className="w-3 h-3" /> you're away
            </span>
          )}
          {row.away && row.myStatus && (
            <span className="inline-flex items-center gap-1 text-oxblood" title="You have an LOA covering this and you're signed up">
              <AlertTriangle className="w-3 h-3" /> on LOA and signed up
            </span>
          )}
          {/* No number: the member list doesn't carry a waitlist position, and
              inventing one would be worse than not saying. */}
          {isWaitlisted && <span className="text-brass">waitlisted</span>}
          {/* Your attendance on a logged night, opening the same detail —
              where the late request lives — on tap. */}
          {row.attendance && onDetails && (() => {
            const s = standing(row.attendance);
            const Icon = STANDING_ICON[s];
            const tone = { attended: 'text-emerald-400', pending: 'text-brass', askable: 'text-brassbright', denied: 'text-oxblood', missed: 'text-ash' }[s];
            return (
              <button onClick={() => onDetails(row)} className={`inline-flex items-center gap-1 hover:underline ${tone}`}>
                <Icon className="w-3 h-3" /> {STANDING_LABEL[s]}
              </button>
            );
          })()}
          {/* The list view's way into the same detail the grid opens on click. */}
          {showAway && onDetails && row.awayList?.length > 0 && (
            <button onClick={() => onDetails(row)} className="inline-flex items-center gap-1 text-ash hover:text-brass transition-colors">
              <CalendarOff className="w-3 h-3" /> {row.awayList.length} away
            </button>
          )}
        </div>
      </div>

      <div className="shrink-0">
        {row.started ? (
          <span className="text-ash/40 text-xs">started</span>
        ) : row.myStatus ? (
          <Button
            variant="secondary" size="none" className="px-3 py-1.5 text-sm"
            onClick={() => onLeave(row)} disabled={working}
            title={isIn ? "You're signed up — withdraw" : "You're on the waitlist — withdraw"}
          >
            {leaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {isIn ? "I'm in" : 'Waitlisted'}
          </Button>
        ) : (
          <Button
            size="none" className="px-3 py-1.5 text-sm"
            onClick={() => onJoin(row)} disabled={working}
            title={row.signupId ? 'Sign up' : 'Sign up — this also opens signups for the night'}
          >
            {joining ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            I'm in
          </Button>
        )}
      </div>
    </div>
  );
}
