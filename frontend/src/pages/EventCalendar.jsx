import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  CalendarRange, Check, ChevronLeft, ChevronRight, Clock, Loader2, Users, CalendarOff, AlertTriangle, Plus,
  LayoutGrid, List, Settings,
} from 'lucide-react';
import ScheduleManager from '../components/ScheduleManager';
import { CATEGORIES, OTHER, categoryOf } from '../eventCategories';

import {
  fmtTimeEst, todayInGuildTz, eventsForGuildDay, isAfterMidnight, daySlot, getGuildTz,
  withinLoaWindow, addDays, loaSkipsDate,
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
// It reads three endpoints that already exist and adds no fourth. Nothing here
// fetches another member's data: /api/signups carries only my_status and
// headcounts, and /api/loa is scoped to the caller in its WHERE clause.

const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Four weeks of paging against the server's 30-day member-open horizon. Weeks
// run Monday to Sunday, so the last day reachable is at most 27 days out (when
// today is a Monday) — the arrows can never land on a week whose buttons the
// API would refuse. A cap you can page into and then be rejected by is worse
// than one you can't reach.
const WEEKS_AHEAD = 4;

const VIEW_KEY = 'calendarView';
const readView = () => {
  try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'week'; } catch { return 'week'; }
};

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
  // A date lifted out of the series doesn't warn you're away — you told us you
  // could make this one. Same order as unavailableOn: the exception is checked
  // before scope and window, because a removed occurrence isn't in the series
  // for any event that night.
  if (entry.type === 'recurring') {
    return entry.day_of_week === dow && !loaSkipsDate(entry, date)
      && inScope && withinLoaWindow(entry, eventTime);
  }
  return false;
}

export default function EventCalendar() {
  const { can } = useAuth();
  // Two kinds of event, each behind the capability its route already needs: a
  // one-off is an opened signup ('attendance'), a weekly one is a schedule
  // entry ('schedule'). The button shows for either.
  const canOneOff = can('attendance');
  const canWeekly = can('schedule');
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState(false);
  const [view, setView] = useState(readView);
  // The grid's blocks are too small for buttons, so a click opens the event's
  // row in a modal. Held as a key and re-found each render, so the modal shows
  // the fresh row after signing up rather than the one that was clicked.
  const [selected, setSelected] = useState(null);
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
          // A week starts on Monday now, so earlier nights of this week are on
          // screen too — everything on them is over. Tonight's events are over
          // once their time has passed.
          started: date < today || (date === today && Boolean(r.eventTime) && daySlot(r.eventTime) <= nowSlot),
        };
      })
      .sort((a, b) => (a.eventTime ? daySlot(a.eventTime) : -1) - (b.eventTime ? daySlot(b.eventTime) : -1)
        || String(a.title).localeCompare(String(b.title)));

    return { date, dow, rows };
  }), [days, occurrences, schedule, loaEntries, nowSlot, today]);

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

  const changeView = (v) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* per-viewer nicety only */ }
  };

  // The list keeps its old shape: the nights still to come. Earlier nights of
  // this week only earn their place on the grid, where an empty column would
  // look like a gap.
  const upcoming = nights.filter((n) => n.date >= today);
  const upcomingRows = upcoming.reduce((n, d) => n + d.rows.length, 0);
  const listView = upcomingRows === 0 ? (
    <EmptyState>Nothing on the schedule this week.</EmptyState>
  ) : (
    <div className="space-y-6">
      {upcoming.map((night) => (
        <Night
          key={night.date} night={night}
          isTonight={night.date === today}
          busy={busy} onJoin={signUp} onLeave={withdraw}
        />
      ))}
    </div>
  );

  const selectedNight = selected && nights.find((n) => n.date === selected.date);
  const selectedRow = selectedNight?.rows.find((r) => r.key === selected.key);

  return (
    <PageShell maxWidth={view === 'week' ? 'max-w-7xl' : 'max-w-3xl'}>
      <div className="flex items-center gap-3 mb-2">
        <CalendarRange className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">EVENT CALENDAR</h1>
        <div className="ml-auto flex items-center gap-2">
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

      {managing && (
        <Modal onClose={() => setManaging(false)} maxWidth="max-w-2xl" scrollable>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-lg tracking-[0.08em] text-bone">EVENT SCHEDULE</h2>
            <button onClick={() => setManaging(false)} className="text-ash hover:text-bone text-sm">Close</button>
          </div>
          <ScheduleManager schedule={schedule} onChanged={load} />
        </Modal>
      )}

      {selectedRow && (
        <Modal onClose={() => setSelected(null)}>
          <div className="flex items-baseline gap-2 mb-3">
            <span className="w-2.5 h-2.5 rounded-full self-center" style={{ background: categoryOf(selectedRow.title).color }} />
            <h2 className="font-display text-lg tracking-[0.08em] text-bone">{DAY_NAME[selectedNight.dow]}</h2>
            <span className="text-ash text-sm">{shortDate(selectedNight.date)}</span>
          </div>
          <div className="border border-line rounded-lg">
            <EventRow row={{ ...selectedRow, date: selectedNight.date }} busy={busy} onJoin={signUp} onLeave={withdraw} />
          </div>
        </Modal>
      )}
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

      {view === 'list' ? listView : (
        <>
          {/* Phones get the list either way — seven columns don't fit. */}
          <div className="md:hidden">{listView}</div>
          <div className="hidden md:block">
            {totalRows === 0
              ? <EmptyState>Nothing on the schedule this week.</EmptyState>
              : <WeekGrid nights={nights} today={today} nowSlot={nowSlot} onSelect={setSelected} />}
          </div>
        </>
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

// ── THE WEEK GRID ───────────────────────────────────────────────────────────
// Time runs down in guild-night slots (daySlot), not clock hours, so a 12:30am
// event sits at the bottom of the night it belongs to instead of at the top of
// the next column. Events have no stored length; every block is drawn as
// BLOCK_MIN long, which is also what decides whether two of them overlap.
const HOUR_PX = 52;
const BLOCK_MIN = 30;
const DEFAULT_RANGE = [18 * 60, 24 * 60]; // 6pm–midnight when nothing is timed

const shortDay = (dateStr) =>
  new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

function hourLabel(slot) {
  const h = Math.floor(slot / 60) % 24;
  return `${h % 12 || 12}${h >= 12 ? 'pm' : 'am'}`;
}

// Side-by-side lanes for blocks that would otherwise sit on top of each other.
// Greedy per cluster of overlapping blocks: each takes the first free lane,
// and every block in the cluster is narrowed to the cluster's lane count.
function layoutLanes(items) {
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds = [];
    const placed = cluster.map((it) => {
      let lane = laneEnds.findIndex((end) => end <= it.slot);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = it.slot + BLOCK_MIN;
      return { ...it, lane };
    });
    placed.forEach((p) => out.push({ ...p, lanes: laneEnds.length }));
    cluster = [];
  };
  [...items].sort((a, b) => a.slot - b.slot).forEach((it) => {
    if (cluster.length && it.slot >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.slot + BLOCK_MIN);
  });
  if (cluster.length) flush();
  return out;
}

function WeekGrid({ nights, today, nowSlot, onSelect }) {
  // Only the hours that hold something, an hour either side. A full 24-hour
  // column is mostly empty scrolling for a guild that plays in the evening.
  const slots = nights.flatMap((n) => n.rows.filter((r) => r.eventTime).map((r) => daySlot(r.eventTime)));
  const [lo, hi] = slots.length ? [Math.min(...slots), Math.max(...slots) + BLOCK_MIN] : DEFAULT_RANGE;
  const start = Math.max(0, Math.floor(lo / 60) * 60 - 60);
  const end = Math.ceil(hi / 60) * 60 + 60;
  const hours = Array.from({ length: (end - start) / 60 }, (_, i) => start + i * 60);
  const height = ((end - start) / 60) * HOUR_PX;
  const anyUntimed = nights.some((n) => n.rows.some((r) => !r.eventTime));
  const present = new Set(nights.flatMap((n) => n.rows.map((r) => categoryOf(r.title).key)));

  return (
    <div className="panel rounded-lg overflow-hidden">
      <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))]">
        {/* Header row */}
        <div className="border-b border-line" />
        {nights.map((n) => (
          <div
            key={n.date}
            className={`border-b border-l border-line px-2 py-2 text-center text-sm ${n.date === today ? 'text-brass font-semibold' : n.date < today ? 'text-ash/50' : 'text-bone'}`}
          >
            {shortDay(n.date)}
          </div>
        ))}

        {/* Events with no time can't be placed on the axis; they get a strip
            of their own rather than being guessed into a slot. */}
        {anyUntimed && (
          <>
            <div className="border-b border-line text-[10px] text-ash/60 px-1 py-1.5 text-right">any time</div>
            {nights.map((n) => (
              <div key={n.date} className={`border-b border-l border-line p-1 space-y-1 ${n.date === today ? 'bg-brass/5' : ''}`}>
                {n.rows.filter((r) => !r.eventTime).map((r) => (
                  <Block key={r.key} row={r} onClick={() => onSelect({ date: n.date, key: r.key })} />
                ))}
              </div>
            ))}
          </>
        )}

        {/* Hour gutter */}
        <div className="relative" style={{ height }}>
          {hours.map((h, i) => (
            <div key={h} className="absolute right-1.5 text-[11px] text-ash/70 -translate-y-1/2" style={{ top: i * HOUR_PX }}>
              {i === 0 ? '' : hourLabel(h)}
            </div>
          ))}
        </div>

        {nights.map((n) => {
          const placed = layoutLanes(n.rows.filter((r) => r.eventTime).map((r) => ({ row: r, slot: daySlot(r.eventTime) })));
          const isToday = n.date === today;
          return (
            <div key={n.date} className={`relative border-l border-line ${isToday ? 'bg-brass/5' : ''}`} style={{ height }}>
              {hours.map((h, i) => (
                <div key={h} className="absolute inset-x-0 border-t border-line/60" style={{ top: i * HOUR_PX }} />
              ))}
              {placed.map(({ row, slot, lane, lanes }) => (
                <div
                  key={row.key}
                  className="absolute px-0.5"
                  style={{
                    top: ((slot - start) / 60) * HOUR_PX + 1,
                    height: (BLOCK_MIN / 60) * HOUR_PX - 2,
                    left: `${(lane / lanes) * 100}%`,
                    width: `${100 / lanes}%`,
                  }}
                >
                  <Block row={row} fill onClick={() => onSelect({ date: n.date, key: row.key })} />
                </div>
              ))}
              {isToday && nowSlot >= start && nowSlot <= end && (
                <div className="absolute inset-x-0 h-px bg-oxblood pointer-events-none" style={{ top: ((nowSlot - start) / 60) * HOUR_PX }}>
                  <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-oxblood" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend — only the kinds this week actually has, so it explains what
          is on screen rather than listing every activity in the game. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 border-t border-line text-xs text-ash">
        {[...CATEGORIES, OTHER].filter((c) => present.has(c.key)).map((c) => (
          <span key={c.key} className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: c.color }} /> {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// One event on the grid: its colour, name, and the two facts worth a glance —
// whether I'm in, and how many are. Everything else is a click away.
function Block({ row, fill = false, onClick }) {
  const cat = categoryOf(row.title);
  const mine = row.myStatus === 'going';
  return (
    <button
      onClick={onClick}
      title={`${row.title}${row.eventTime ? ` · ${fmtTimeEst(row.eventTime)}` : ''} · ${row.going} in`}
      className={`w-full ${fill ? 'h-full' : ''} flex items-center gap-1 rounded px-1.5 py-0.5 text-left text-[11px] leading-tight text-white overflow-hidden transition-[filter] hover:brightness-125 ${row.started ? 'opacity-45' : ''} ${mine ? 'ring-1 ring-white/70' : ''}`}
      style={{ background: cat.color }}
    >
      <span className="truncate font-medium">{row.title}</span>
      {mine && <Check className="w-3 h-3 shrink-0" />}
      {row.myStatus === 'waitlist' && <Clock className="w-3 h-3 shrink-0" />}
      {row.away && <CalendarOff className="w-3 h-3 shrink-0" />}
      <span className="ml-auto shrink-0 font-mono text-white/80">{row.going}{row.capacity ? `/${row.capacity}` : ''}</span>
    </button>
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
