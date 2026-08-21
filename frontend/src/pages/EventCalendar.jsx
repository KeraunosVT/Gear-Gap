import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  CalendarRange, Check, ChevronLeft, ChevronRight, Clock, Loader2, Users, CalendarOff, AlertTriangle,
} from 'lucide-react';

import {
  fmtTimeEst, todayInGuildTz, eventsForGuildDay, isAfterMidnight, daySlot, getGuildTz,
  withinLoaWindow, addDays,
} from '../timeUtils';
import { PageShell } from '../components/ui/PageShell';
import Button from '../components/ui/Button';
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
// It reads three endpoints that already exist and adds no fourth. Nothing here
// fetches another member's data: /api/signups carries only my_status and
// headcounts, and /api/loa is scoped to the caller in its WHERE clause.

const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Four weeks of paging against the server's 30-day member-open horizon. The
// last day reachable is 27 days out, so the arrows can never land on a week
// whose buttons the API would refuse — a cap you can page into and then be
// rejected by is worse than one you can't reach.
const WEEKS_AHEAD = 4;

const dowOf = (dateStr) => new Date(`${dateStr}T12:00:00`).getDay();

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

// ── LOA, MATCHED CLIENT-SIDE ────────────────────────────────────────────────
// The type tests from loa.js's unavailableOn, run against the caller's OWN
// entries only — this never sees anyone else's, and deliberately doesn't ask
// for them. The time-window half is withinLoaWindow, imported from timeUtils
// rather than restated here: it used to be a verbatim copy of the backend's,
// and a copy of the one rule where a mistake doesn't error, it just quietly
// stops warning the person it exists to warn.
function loaCovers(entry, { date, dow, scheduleId, eventTime }) {
  // An LOA scoped to one event doesn't touch the others that night; an unscoped
  // one covers everything. Same test as unavailableOn's inScope.
  const inScope = !entry.event_schedule_id || !scheduleId || entry.event_schedule_id === scheduleId;
  if (entry.type === 'range') return entry.start_date <= date && entry.end_date >= date;
  if (entry.type === 'event') return entry.event_date === date && inScope && withinLoaWindow(entry, eventTime);
  if (entry.type === 'recurring') return entry.day_of_week === dow && inScope && withinLoaWindow(entry, eventTime);
  return false;
}

export default function EventCalendar() {
  const [occurrences, setOccurrences] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [loaEntries, setLoaEntries] = useState([]);
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
      axios.get('/api/loa'),
    ])
      .then(([sig, sched, loa]) => {
        setOccurrences(sig.data.signups || []);
        setSchedule(sched.data.schedule || []);
        setLoaEntries(loa.data.entries || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load the calendar.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Seven nights from the start of the shown week. Guild nights, not calendar
  // days — todayInGuildTz rolls at the configured day start, so at 12:30am the
  // week still begins with the night in progress rather than skipping it.
  const days = useMemo(() => {
    const start = addDays(todayInGuildTz(), offset * 7);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [offset]);

  const nowSlot = guildNowSlot();

  const nights = useMemo(() => days.map((date, dayIndex) => {
    const dow = dowOf(date);
    const opened = occurrences.filter((o) => o.event_date === date);
    const byScheduleId = new Map(opened.filter((o) => o.event_schedule_id).map((o) => [o.event_schedule_id, o]));

    // Every scheduled event that runs this night, whether or not anyone has
    // opened it. This is the half /signups can't show.
    const scheduled = eventsForGuildDay(schedule, dow).map((s) => {
      const occ = byScheduleId.get(s.id) || null;
      return {
        key: occ ? occ.id : `sched:${s.id}:${date}`,
        signupId: occ?.id || null,
        scheduleId: s.id,
        title: occ?.title || s.name,
        eventTime: occ?.event_time || s.event_time || null,
        occ,
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
    }));

    const rows = [...scheduled, ...extra]
      .map((r) => {
        const away = loaEntries.filter((e) => loaCovers(e, {
          date, dow, scheduleId: r.scheduleId, eventTime: r.eventTime,
        }));
        return {
          ...r,
          myStatus: r.occ?.my_status || null,
          going: r.occ?.going_count || 0,
          waitlist: r.occ?.waitlist_count || 0,
          capacity: r.occ?.capacity ?? null,
          away: away.length > 0,
          // Only tonight can contain something that already ran.
          started: dayIndex === 0 && offset === 0 && Boolean(r.eventTime) && daySlot(r.eventTime) <= nowSlot,
        };
      })
      .sort((a, b) => (a.eventTime ? daySlot(a.eventTime) : -1) - (b.eventTime ? daySlot(b.eventTime) : -1)
        || String(a.title).localeCompare(String(b.title)));

    return { date, dow, rows };
  }), [days, occurrences, schedule, loaEntries, nowSlot, offset]);

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

  if (loading) return <PageShell maxWidth="max-w-3xl"><EmptyState>Reading the week ahead…</EmptyState></PageShell>;
  if (error) {
    return (
      <PageShell maxWidth="max-w-3xl">
        <ErrorState title="CALENDAR UNREACHABLE" message={error} onRetry={() => { setLoading(true); load(); }} />
      </PageShell>
    );
  }

  return (
    <PageShell maxWidth="max-w-3xl">
      <div className="flex items-center gap-3 mb-2">
        <CalendarRange className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">EVENT CALENDAR</h1>
      </div>
      <p className="text-ash text-sm mb-6">
        The week ahead, whether or not signups have been opened. Saying you're in opens them.
        {' '}There's no way to say you're out here — <Link to="/loa" className="text-brass hover:text-brassbright underline">file an LOA</Link> for that.
      </p>

      <Toast msg={msg} />

      {/* Week pager. Bounded on both sides: back past this week is history the
          member can't act on, forward past the horizon is a button the server
          would refuse. */}
      <div className="flex items-center justify-between gap-4 mb-6 panel rounded-lg px-4 py-3">
        <Button
          variant="ghost" size="none" className="px-2 py-1 text-sm"
          onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0}
        >
          <ChevronLeft className="w-4 h-4" /> Previous
        </Button>
        <div className="text-center">
          <div className="text-bone text-sm">{shortDate(days[0])} – {shortDate(days[6])}</div>
          <div className="eyebrow text-[10px] text-ash/75 mt-0.5">
            {offset === 0 ? 'This week' : `In ${offset} week${offset === 1 ? '' : 's'}`}
            {myCount > 0 && <> · you're in for {myCount}</>}
          </div>
        </div>
        <Button
          variant="ghost" size="none" className="px-2 py-1 text-sm"
          onClick={() => setOffset((o) => Math.min(WEEKS_AHEAD - 1, o + 1))} disabled={offset >= WEEKS_AHEAD - 1}
        >
          Next <ChevronRight className="w-4 h-4" />
        </Button>
      </div>

      {totalRows === 0 ? (
        <EmptyState>Nothing on the schedule this week.</EmptyState>
      ) : (
        <div className="space-y-6">
          {nights.map((night, i) => (
            <Night
              key={night.date} night={night}
              isTonight={i === 0 && offset === 0}
              busy={busy} onJoin={signUp} onLeave={withdraw}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}

// One night's agenda. Nights with nothing scheduled still get a heading — a
// week that silently skips Tuesday reads as a loading bug, and "nothing on"
// is a real answer to "what's on Tuesday".
function Night({ night, isTonight, busy, onJoin, onLeave }) {
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ row, busy, onJoin, onLeave }) {
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
