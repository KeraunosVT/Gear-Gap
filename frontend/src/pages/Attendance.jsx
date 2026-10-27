import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import {
  RefreshCw, Camera, Trash2, Users, CalendarDays, Loader2,
  BarChart3, Wand2, Swords, Check, X, Inbox, Volume2, AlertTriangle, Upload, UserPlus, Search,
} from 'lucide-react';
import { fmtTimeEst, fmtDatetime, guildDayOfWeek, isAfterMidnight, todayInGuildTz, eventsForGuildDay } from '../timeUtils';
import RestrictedGate from '../components/ui/RestrictedGate';
import Tabs from '../components/ui/Tabs';
import Modal from '../components/ui/Modal';
import { Table, Thead, SortableTh, Tr } from '../components/ui/Table';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The four windows this page can be looked at through. Server-side: the rate
// table and the event list sit side by side, and the only way to guarantee they
// agree about what "the last two weeks" means is for one place to decide it.
//
// "All" is here so the pre-filter behaviour stays reachable — a filter that
// hides history with no way back loses data as far as anyone using it can tell.
const WINDOWS = [
  { key: '7', label: '1 week' },
  { key: '14', label: '2 weeks' },
  { key: '30', label: '30 days' },
  { key: 'all', label: 'All' },
];
const WINDOW_LABEL = { 7: 'last 7 days', 14: 'last 14 days', 30: 'last 30 days', all: 'all time' };
// The missed-events panel has its own filter: "who has been absent lately" is
// a short-range question, so it has no All tab and starts at one week.
const MISSED_WINDOWS = WINDOWS.filter((w) => w.key !== 'all');

export default function Attendance() {
  const { can } = useAuth();

  const [channels, setChannels] = useState([]);
  const [configuredId, setConfiguredId] = useState(null);
  const [snapped, setSnapped] = useState([]);
  // Ids an officer has deliberately taken off the snap. Refresh merges the
  // channel back in, so without this every refresh would resurrect the person
  // they just removed — and they'd have to remove them again after each one.
  const [removed, setRemoved] = useState(() => new Set());
  const [schedule, setSchedule] = useState([]);
  const [eventScheduleId, setEventScheduleId] = useState('');
  const [title, setTitle] = useState('');
  // Defaults to the guild NIGHT, not the calendar day. Left empty, an officer
  // logging the 12:30am boss types the date they see on the clock, and the join
  // against LOA and signups — both keyed on the night — silently misses.
  const [eventDate, setEventDate] = useState(todayInGuildTz);
  const [rosters, setRosters] = useState([]);
  const [rosterId, setRosterId] = useState('auto');
  const [snapping, setSnapping] = useState(false);
  const [picking, setPicking] = useState(false); // the "Add by hand" roster picker is open
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);

  const [window_, setWindow_] = useState('30');
  const [events, setEvents] = useState([]);
  const [loadingEvents, setLoadingEvents] = useState(true);

  const [stats, setStats] = useState({ totalEvents: 0, members: [], history: null });
  const [loadingStats, setLoadingStats] = useState(true);
  const [statSort, setStatSort] = useState('rate'); // 'rate' | 'name' | 'attended'
  const [statDir, setStatDir] = useState('desc');
  const [backfilling, setBackfilling] = useState(false);
  const [viewing, setViewing] = useState(null); // the member whose nights are open
  const [viewingWindow, setViewingWindow] = useState(null); // which window that breakdown uses

  const [missedWindow, setMissedWindow] = useState('7');
  const [missed, setMissed] = useState({ totalEvents: 0, members: [] });
  const [loadingMissed, setLoadingMissed] = useState(true);

  // A TLGM import is previewed before anything is written: the file and the
  // server's dry-run result are held here until the officer confirms.
  const [tlgmFile, setTlgmFile] = useState(null);
  const [tlgmPreview, setTlgmPreview] = useState(null);
  const [tlgmBusy, setTlgmBusy] = useState(false);

  const [lateRequests, setLateRequests] = useState([]);
  const [deciding, setDeciding] = useState('');

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  // One call answers both questions: which channel is configured, and what it
  // is called. The id alone would put a snowflake on screen where a name
  // belongs, and /api/admin/settings is closed to attendance-only officers.
  const loadChannels = useCallback(() => {
    axios.get('/api/admin/voice-channels')
      .then((res) => {
        setChannels(res.data.channels || []);
        setConfiguredId(res.data.configured_id || null);
      })
      .catch(() => { setChannels([]); setConfiguredId(null); });
  }, []);

  // The rate table and the event list are refetched together, always, and both
  // are handed the same window. Filtering one without the other is how a member
  // ends up with a rate above 100%.
  const loadEvents = useCallback(() => {
    setLoadingEvents(true);
    axios.get('/api/admin/events', { params: { window: window_ } })
      .then((res) => setEvents(res.data.events || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load events.'))
      .finally(() => setLoadingEvents(false));
  }, [window_]);

  const loadStats = useCallback(() => {
    setLoadingStats(true);
    axios.get('/api/admin/attendance-stats', { params: { window: window_ } })
      .then((res) => setStats(res.data || { totalEvents: 0, members: [], history: null }))
      .catch(() => {})
      .finally(() => setLoadingStats(false));
  }, [window_]);

  const loadMissed = useCallback(() => {
    setLoadingMissed(true);
    axios.get('/api/admin/attendance-stats/missed', { params: { window: missedWindow } })
      .then((res) => setMissed(res.data || { totalEvents: 0, members: [] }))
      .catch(() => setMissed({ totalEvents: 0, members: [] }))
      .finally(() => setLoadingMissed(false));
  }, [missedWindow]);

  const loadLate = useCallback(() => {
    axios.get('/api/admin/attendance/late-requests', { params: { status: 'pending' } })
      .then((res) => setLateRequests(res.data.requests || []))
      .catch(() => setLateRequests([]));
  }, []);

  useEffect(() => {
    axios.get('/api/event-schedule').then((res) => setSchedule(res.data.schedule || [])).catch(() => setSchedule([]));
    axios.get('/api/admin/rosters').then((res) => setRosters(res.data.rosters || [])).catch(() => setRosters([]));
    loadChannels();
    loadLate();
  }, [loadChannels, loadLate]);

  useEffect(() => { loadEvents(); loadStats(); }, [loadEvents, loadStats]);
  useEffect(() => { loadMissed(); }, [loadMissed]);

  const channel = useMemo(
    () => channels.find((c) => c.id === configuredId) || null,
    [channels, configuredId],
  );

  // Only the events on the night being logged. The date is a guild night, so
  // eventsForGuildDay pulls in that night's after-midnight event and leaves out
  // the next evening's. No date picked falls back to the whole week.
  const nightSchedule = useMemo(() => {
    if (!eventDate) return schedule;
    return eventsForGuildDay(schedule, new Date(eventDate + 'T12:00:00').getDay());
  }, [schedule, eventDate]);

  const sortedStats = useMemo(() => {
    const dir = statDir === 'asc' ? 1 : -1;
    return [...stats.members].sort((a, b) => {
      if (statSort === 'name') return a.display_name.localeCompare(b.display_name) * dir;
      // All-Time ranks by activities attended, not rate — a 2/2 newcomer at
      // 100% shouldn't outrank someone at 180/200. Rate breaks ties. No
      // all-time figure sorts below 0 attended, whichever way it's turned.
      if (statSort === 'all_time') {
        const byCount = (a.all_time?.attended ?? -1) - (b.all_time?.attended ?? -1);
        return (byCount || (a.all_time?.rate ?? -1) - (b.all_time?.rate ?? -1)) * dir;
      }
      // A null rate (no nights since joining) sorts below 0% too.
      return ((a[statSort] ?? -1) - (b[statSort] ?? -1)) * dir;
    });
  }, [stats.members, statSort, statDir]);

  // Every hook is above this line on purpose. It used to sit higher up, which
  // made the hook count depend on a capability check — legal only for as long
  // as nobody's permissions changed mid-session.
  if (!can('attendance')) return <RestrictedGate />;

  const backfillNames = async () => {
    setBackfilling(true);
    try {
      const res = await axios.post('/api/admin/attendance/backfill-names');
      flash(`Checked ${res.data.checked} record${res.data.checked === 1 ? '' : 's'} — updated ${res.data.updated}.`);
      loadEvents(); loadStats(); loadMissed();
    } catch (err) {
      flash(err.response?.data?.error || 'Backfill failed.', false);
    } finally {
      setBackfilling(false);
    }
  };

  const tlgmPost = (file, dryRun) => {
    const form = new FormData();
    form.append('file', file);
    return axios.post('/api/admin/attendance/history/import', form, { params: dryRun ? { dry_run: 1 } : {} });
  };

  const previewTlgm = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same file again still fires
    if (!file) return;
    setTlgmBusy(true);
    try {
      const res = await tlgmPost(file, true);
      setTlgmFile(file);
      setTlgmPreview(res.data);
    } catch (err) {
      flash(err.response?.data?.error || 'Could not read that file.', false);
    } finally {
      setTlgmBusy(false);
    }
  };

  const confirmTlgm = async () => {
    setTlgmBusy(true);
    try {
      const res = await tlgmPost(tlgmFile, false);
      const jd = res.data.join_dates;
      if (jd?.error) {
        flash(`Imported TLGM history for ${res.data.imported} member${res.data.imported === 1 ? '' : 's'}, but ${jd.error}`, false);
      } else {
        flash(`Imported TLGM history for ${res.data.imported} member${res.data.imported === 1 ? '' : 's'}`
          + (jd?.saved ? `, with ${jd.saved} join date${jd.saved === 1 ? '' : 's'}.` : '.'));
      }
      setTlgmFile(null); setTlgmPreview(null);
      loadStats();
    } catch (err) {
      flash(err.response?.data?.error || 'Import failed.', false);
    } finally {
      setTlgmBusy(false);
    }
  };

  const removeTlgm = async () => {
    if (!window.confirm('Remove the imported TLGM history for everyone? You can import the file again afterwards.')) return;
    try {
      await axios.delete('/api/admin/attendance/history');
      flash('TLGM history removed.');
      loadStats();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not remove the TLGM history.', false);
    }
  };

  const snap = async () => {
    if (!configuredId) return;
    setSnapping(true);
    try {
      const res = await axios.get(`/api/admin/voice-channels/${configuredId}/members`);
      const members = res.data.members || [];
      if (members.length === 0) { flash('No one is in that channel right now.', false); return; }
      setSnapped(members);
      // A fresh snap starts a fresh list, so past removals stop applying.
      setRemoved(new Set());
      loadChannels();
      flash(`Snapped ${members.length} member${members.length === 1 ? '' : 's'}.`);
    } catch {
      flash('Could not read that voice channel.', false);
    } finally {
      setSnapping(false);
    }
  };

  // Re-read the channel without throwing away the snap. Anyone who joined since
  // is added; anyone already on the list stays, including people who have since
  // left — they were there, which is the whole point of snapping early. A plain
  // re-Snap can't do this: it replaces the list, so it drops the people who left
  // and undoes every manual removal.
  const refreshSnap = async () => {
    if (!configuredId) return;
    setRefreshing(true);
    try {
      const res = await axios.get(`/api/admin/voice-channels/${configuredId}/members`);
      const inChannel = res.data.members || [];
      loadChannels(); // keeps the "N in channel now" line honest too
      if (snapped.length === 0) {
        flash(`${inChannel.length} in channel now — press Snap to capture them.`);
        return;
      }
      const known = new Set(snapped.map((m) => m.id));
      const added = inChannel.filter((m) => !known.has(m.id) && !removed.has(m.id));
      if (added.length === 0) { flash('No one new in the channel.'); return; }
      setSnapped((prev) => [...prev, ...added]);
      flash(`Added ${added.length} — ${snapped.length + added.length} snapped.`);
    } catch {
      flash('Could not read that voice channel.', false);
    } finally {
      setRefreshing(false);
    }
  };

  const removeSnapped = (id) => {
    setSnapped((prev) => prev.filter((m) => m.id !== id));
    setRemoved((prev) => new Set(prev).add(id));
  };

  // Hand-picked members join the same list a snap fills. Anyone picked here
  // comes off the removed set too — choosing someone by name is a clearer
  // statement of intent than an earlier removal, and refresh should keep them.
  const addByHand = (members) => {
    setSnapped((prev) => {
      const have = new Set(prev.map((m) => m.id));
      return [...prev, ...members.filter((m) => !have.has(m.id)).map((m) => ({ id: m.id, name: m.name, avatar: m.avatar || null }))];
    });
    setRemoved((prev) => {
      const next = new Set(prev);
      members.forEach((m) => next.delete(m.id));
      return next;
    });
    flash(`Added ${members.length} by hand.`);
  };

  const selectScheduleEvent = (id) => {
    setEventScheduleId(id);
    const ev = schedule.find((s) => s.id === id);
    if (ev) setTitle(ev.name);
  };

  // Moving the date to another night drops a scheduled event that isn't on it —
  // otherwise the select shows "custom" while a hidden id from the old night
  // still gets saved. The title goes too, but only if it was the event's name
  // filled in automatically; one the officer typed is theirs.
  const changeDate = (date) => {
    setEventDate(date);
    if (!eventScheduleId || !date) return;
    const onNight = eventsForGuildDay(schedule, new Date(date + 'T12:00:00').getDay());
    if (onNight.some((s) => s.id === eventScheduleId)) return;
    const ev = schedule.find((s) => s.id === eventScheduleId);
    if (ev && title === ev.name) setTitle('');
    setEventScheduleId('');
  };

  const save = async () => {
    if (!title.trim()) { flash('Give this event a title.', false); return; }
    if (snapped.length === 0) { flash('Snap the voice channel, or add people by hand, first.', false); return; }
    setSaving(true); setError('');
    try {
      const res = await axios.post('/api/admin/events', {
        title, event_date: eventDate || null, event_schedule_id: eventScheduleId || null, attendees: snapped,
        // 'auto' means omit the field entirely, which is what tells the server
        // to look for the roster built for this night. Sending null instead
        // would read as "deliberately no party".
        ...(rosterId === 'auto' ? {} : { roster_id: rosterId || null }),
      });
      flash(`Saved — ${res.data.attendees} attendees logged.`);
      // Back to tonight, not blank — the same reason the initial value isn't
      // blank, and logging two events on one night is the common case.
      setSnapped([]); setRemoved(new Set()); setPicking(false);
      setTitle(''); setEventDate(todayInGuildTz()); setEventScheduleId(''); setRosterId('auto');
      loadEvents(); loadStats(); loadMissed();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not save event.', false);
    } finally {
      setSaving(false);
    }
  };

  const deleteEvent = async (id) => {
    if (!window.confirm('Delete this event and its attendance records?')) return;
    try {
      await axios.delete(`/api/admin/events/${id}`);
      setEvents((prev) => prev.filter((e) => e.id !== id));
      flash('Event deleted.');
      loadStats(); loadMissed();
    } catch (err) {
      flash(err.response?.data?.error || 'Delete failed.', false);
    }
  };

  const decide = async (req, status) => {
    setDeciding(req.id);
    try {
      await axios.patch(`/api/admin/attendance/late-requests/${req.id}`, { status });
      flash(status === 'approved'
        ? `${req.display_name} added to ${req.event?.title || 'that event'}.`
        : `Declined ${req.display_name}'s request.`);
      setLateRequests((prev) => prev.filter((r) => r.id !== req.id));
      // An approval writes an attendance row, so the counts on screen are stale.
      if (status === 'approved') { loadEvents(); loadStats(); loadMissed(); }
    } catch (err) {
      flash(err.response?.data?.error || 'Could not record that decision.', false);
      // A 409 means someone else decided it — refetch rather than leave a
      // button that will keep failing.
      if (err.response?.status === 409) loadLate();
    } finally {
      setDeciding('');
    }
  };

  const toggleStatSort = (key) => {
    if (statSort === key) setStatDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setStatSort(key); setStatDir(key === 'name' ? 'asc' : 'desc'); }
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-6">
        <p className="text-sm text-ash">
          Snap the attendance channel to log who showed up — or, for a night nobody snapped, set its date and use
          Add by hand. Set a title and date, then save.
        </p>
        <div className="flex items-center gap-5 shrink-0">
          <label
            title="Carry over per-member attendance totals from a TLGM member export (CSV)"
            className={`inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright transition-colors cursor-pointer ${tlgmBusy ? 'opacity-40 pointer-events-none' : ''}`}
          >
            {tlgmBusy && !tlgmPreview ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Import TLGM
            <input type="file" accept=".csv,text/csv" onChange={previewTlgm} className="hidden" />
          </label>
          <button
            onClick={backfillNames} disabled={backfilling}
            title="Re-check past attendance records against mapped display names"
            className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright transition-colors disabled:opacity-40"
          >
            <Wand2 className="w-4 h-4" /> {backfilling ? 'Fixing…' : 'Fix past names'}
          </button>
        </div>
      </div>

      {/* ── TLGM import preview ───────────────────────────────────────
          Nothing is written until Import is pressed. The skipped list is the
          point of the preview: it's what an officer fixes (an alias on the
          Names page, a typo in the file) before committing. */}
      {tlgmPreview && (
        <div className="panel rounded-lg p-5 mb-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="text-bone font-medium">TLGM import — {tlgmFile?.name}</div>
              <div className="text-sm text-ash mt-1">
                {tlgmPreview.rows.length} matched
                {tlgmPreview.skipped.length > 0 && <> · <span className="text-brassbright">{tlgmPreview.skipped.length} skipped</span></>}
                {' '}· replaces any TLGM history already imported
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={confirmTlgm} disabled={tlgmBusy || tlgmPreview.rows.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40"
              >
                {tlgmBusy && <Loader2 className="w-4 h-4 animate-spin" />} Import {tlgmPreview.rows.length}
              </button>
              <button
                onClick={() => { setTlgmPreview(null); setTlgmFile(null); }} disabled={tlgmBusy}
                className="px-4 py-2 border border-line text-ash hover:text-bone rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>

          {tlgmPreview.skipped.length > 0 && (
            <div className="mt-4 pt-4 border-t border-line">
              <div className="eyebrow text-[10px] text-brassbright mb-2">Skipped</div>
              <ul className="text-sm space-y-1 max-h-60 overflow-auto">
                {tlgmPreview.skipped.map((s) => (
                  <li key={s.row} className="text-ash">
                    <span className="font-mono text-xs text-ash/50">row {s.row}</span>{' '}
                    <span className="text-bone">{s.name}</span>
                    {s.discord_username && s.discord_username !== s.name && <span className="text-ash/70"> ({s.discord_username})</span>}
                    {' '}— {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {tlgmPreview.rows.length > 0 && (
            <details className="mt-4 pt-4 border-t border-line">
              <summary className="eyebrow text-[10px] text-brass cursor-pointer">Matched</summary>
              <ul className="text-sm space-y-1 max-h-60 overflow-auto mt-2">
                {tlgmPreview.rows.map((r) => (
                  <li key={r.row} className="text-ash">
                    <span className="text-bone">{r.display_name}</span>
                    {r.source_name && r.source_name !== r.display_name && <span className="text-ash/70"> ← {r.source_name}</span>}
                    {' '}· {r.attended}/{r.total} · <span className="text-ash/60">by {r.matched_by}</span>
                    {/* Shown as read, so a day/month swap is caught here rather
                        than in someone's attendance rate. */}
                    {r.joined_at ? (
                      <span className="text-ash/60"> · joined {new Date(r.joined_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}</span>
                    ) : r.joined_raw ? (
                      <span className="text-brassbright"> · join date "{r.joined_raw}" unreadable — Discord's will be used</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {msg && (
        <div className={`mb-6 px-5 py-3 rounded-lg border text-sm ${msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'}`}>{msg.text}</div>
      )}
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {/* ── Capture ───────────────────────────────────────────────────
          One row across the top. Logging a night is the only thing on this
          page that is a *task* rather than a reading, and it is the same four
          fields every week — a row keeps it to one glance and leaves the whole
          page below it for the record. */}
      <div className="panel rounded-lg p-4 mb-12">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[190px]">
            <label className="eyebrow text-[10px] text-ash block mb-2">Scheduled event</label>
            <select
              value={eventScheduleId} onChange={(e) => selectScheduleEvent(e.target.value)}
              className="w-full bg-hall border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass"
            >
              <option value="">— custom / none —</option>
              {/* Labelled by the night it belongs to: an after-midnight event
                  is stored on the next calendar day, so its raw day_of_week
                  would name the wrong night to whoever is logging it. */}
              {nightSchedule.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {DAYS[guildDayOfWeek(s.day_of_week, s.event_time)]}
                  {isAfterMidnight(s.event_time) ? ' night' : ''}
                  {s.event_time ? ` at ${fmtTimeEst(s.event_time)}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1 min-w-[190px]">
            <label className="eyebrow text-[10px] text-ash block mb-2">Event title</label>
            <input
              value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Archboss — Morokai"
              className="w-full bg-hall border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass"
            />
          </div>
          <div className="w-[150px]">
            <label className="eyebrow text-[10px] text-ash block mb-2">Date</label>
            <input
              type="date" value={eventDate} onChange={(e) => changeDate(e.target.value)}
              className="w-full bg-hall border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass"
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <label className="eyebrow text-[10px] text-ash block mb-2">Party fielded</label>
            <select
              value={rosterId} onChange={(e) => setRosterId(e.target.value)}
              className="w-full bg-hall border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass"
            >
              <option value="auto">— match this night —</option>
              <option value="">— no party —</option>
              {rosters.map((r) => (
                <option key={r.id} value={r.id}>{r.name}{r.event_date ? ` (${r.event_date})` : ''}</option>
              ))}
            </select>
          </div>
          <button
            onClick={snap} disabled={!configuredId || snapping}
            className="inline-flex items-center gap-2 px-5 py-2.5 border border-brass/50 text-brass hover:bg-panelup rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {snapping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />} Snap
          </button>
          {/* For the night nobody snapped: pick who was there from the roster
              instead. Adds to the same list a snap fills, so the two mix — snap
              the stragglers still in voice, then add the people who left. */}
          <button
            onClick={() => setPicking((v) => !v)}
            className={`inline-flex items-center gap-2 px-4 py-2.5 border rounded-lg transition-colors ${picking ? 'border-brass text-brass bg-panelup' : 'border-line text-ash hover:text-bone'}`}
            title="Log attendance without a voice snap — pick members from the roster"
          >
            <UserPlus className="w-4 h-4" /> Add by hand
          </button>
          <button
            onClick={save} disabled={saving || snapped.length === 0}
            className="px-5 py-2.5 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? 'Saving…' : `Save${snapped.length ? ` (${snapped.length})` : ''}`}
          </button>
        </div>

        {/* Which channel Snap will read, and — when it can't — what to do about
            it. The picker moved to Guild Settings, so a blank here is a config
            problem with a fix, not a dropdown someone forgot to touch. */}
        <div className="mt-3 text-xs">
          {!configuredId ? (
            <span className="inline-flex items-center gap-1.5 text-brassbright">
              <AlertTriangle className="w-3.5 h-3.5" />
              No attendance voice channel set —{' '}
              <Link to="/admin/settings" className="underline hover:text-brass">choose one in Guild Settings</Link>.
            </span>
          ) : channel ? (
            <span className="inline-flex items-center gap-1.5 text-ash">
              <Volume2 className="w-3.5 h-3.5 text-brass" />
              Snapping <span className="text-bone">{channel.name}</span> · {channel.memberCount} in channel now
              <span className="text-ash/50">·</span>
              {/* Sits on the count it updates. Both readings of "refresh" land
                  here: the number goes live again, and latecomers join the snap
                  without disturbing what's already on it. */}
              <button
                onClick={refreshSnap} disabled={refreshing || snapping}
                title={snapped.length > 0
                  ? 'Re-read the channel — adds anyone who joined since the snap, keeps everyone already on it'
                  : 'Re-read the channel to update the count'}
                className="inline-flex items-center gap-1 hover:text-brass transition-colors disabled:opacity-40"
              >
                <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'refreshing…' : 'refresh'}
              </button>
              <span className="text-ash/50">·</span>
              <Link to="/admin/settings" className="hover:text-brass">change</Link>
            </span>
          ) : channels.length === 0 ? (
            // No voice channels at all is a different fault from one missing
            // one, and it has a different fix — the bot is offline or can't
            // see the category. Naming the right one saves an officer editing
            // a setting that was never wrong.
            <span className="inline-flex items-center gap-1.5 text-brassbright">
              <AlertTriangle className="w-3.5 h-3.5" />
              The bot can’t see any voice channels — check it’s online and has permission to view them.
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-brassbright">
              <AlertTriangle className="w-3.5 h-3.5" />
              The configured channel isn’t one the bot can see —{' '}
              <Link to="/admin/settings" className="underline hover:text-brass">pick another in Guild Settings</Link>.
            </span>
          )}
          <span className="text-ash/50 block mt-1">
            A copy of the party is stored on the event, so editing the saved party later won’t change this record.
          </span>
        </div>

        {picking && (
          <MemberPicker
            exclude={snapped}
            onAdd={addByHand}
            onClose={() => setPicking(false)}
          />
        )}

        {snapped.length > 0 && (
          <div className="mt-4 pt-4 border-t border-line">
            <div className="eyebrow text-[10px] text-brass mb-3 flex items-center gap-2">
              <Users className="w-3.5 h-3.5" /> Attendees ({snapped.length})
              {/* Says why refresh isn't bringing someone back — otherwise a
                  removal that keeps holding looks like the refresh missing them. */}
              {removed.size > 0 && (
                <span className="text-ash/60 normal-case tracking-normal">
                  · {removed.size} removed, and refresh won’t re-add them
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {snapped.map((m) => (
                <div key={m.id} className="inline-flex items-center gap-2 bg-hall border border-line rounded-full pl-1.5 pr-2.5 py-1">
                  {m.avatar
                    ? <img src={m.avatar} alt="" className="w-5 h-5 rounded-full border border-line" />
                    : <span className="w-5 h-5 rounded-full bg-panelup border border-line flex items-center justify-center text-[9px] text-brass">{(m.name || '?')[0].toUpperCase()}</span>}
                  <span className="text-sm text-bone">{m.name}</span>
                  <button onClick={() => removeSnapped(m.id)} className="text-ash hover:text-oxblood" title="Remove">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Late attendance queue ─────────────────────────────────── */}
      {/* Hidden entirely when empty. A permanent "0 pending" panel above the
          part of the page officers actually use is a cost paid on every visit
          for information that matters on a few of them. */}
      {lateRequests.length > 0 && (
        <div className="mb-12">
          <h2 className="font-display text-2xl text-bone tracking-[0.08em] flex items-center gap-3">
            <Inbox className="w-5 h-5 text-brass" />
            Late attendance
            <span className="text-sm font-sans text-brass">{lateRequests.length} waiting</span>
          </h2>
          <div className="rule-fade mb-6" />
          <div className="panel rounded-lg divide-y divide-line">
            {lateRequests.map((r) => (
              <div key={r.id} className="flex items-center gap-4 px-5 py-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-bone">
                    <span className="font-medium">{r.display_name}</span>
                    <span className="text-ash"> — {r.event?.title || 'an event that no longer exists'}</span>
                    {r.event?.event_date && <span className="text-ash text-xs"> · {r.event.event_date}</span>}
                  </div>
                  {r.reason && <div className="text-sm text-ash mt-0.5 italic">“{r.reason}”</div>}
                  <div className="text-xs text-ash/60 mt-0.5">Asked {fmtDatetime(r.requested_at)}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => decide(r, 'approved')} disabled={deciding === r.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-emerald-400/40 text-emerald-400 hover:bg-panelup transition-colors disabled:opacity-40"
                  >
                    {deciding === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />} Approve
                  </button>
                  <button
                    onClick={() => decide(r, 'denied')} disabled={deciding === r.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-line text-ash hover:text-oxblood transition-colors disabled:opacity-40"
                  >
                    <X className="w-3.5 h-3.5" /> Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── The record ────────────────────────────────────────────── */}
      {/* One set of window tabs above both panels, because one window governs
          both: the rate is "attended / events in this window", and the list
          beside it is those same events. Two filters would let the denominator
          disagree with the list explaining it. */}
      <div className="flex items-center justify-between gap-4 mb-2">
        <h2 className="font-display text-2xl text-bone tracking-[0.08em]">Roster Attendance</h2>
        <button onClick={() => { loadEvents(); loadStats(); loadMissed(); }} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass" title="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <div className="rule-fade mb-4" />

      <Tabs
        variant="flat" active={window_} onChange={setWindow_}
        items={WINDOWS.map((w) => ({
          // Only the active tab can carry a count — the others' totals aren't
          // loaded, and a guessed number is worse than none.
          key: w.key,
          label: w.key === window_ ? `${w.label} (${events.length})` : w.label,
        }))}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
        {/* Rate per player */}
        <div>
          <div className="flex items-center gap-2 text-xs text-ash mb-3">
            <BarChart3 className="w-3.5 h-3.5 text-brass" />
            {/* The window is named here, not only in the tab, because a
                percentage read out of context is assumed to be all-time. */}
            {stats.totalEvents} event{stats.totalEvents === 1 ? '' : 's'} · {WINDOW_LABEL[window_]}
            {/* All-Time ignores the window — said here so nobody reads it as
                filtered — and names where the pre-app part of it came from. */}
            {stats.history && (
              <span className="text-ash/70">
                · All-Time includes TLGM history imported {new Date(stats.history.imported_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {' '}·{' '}
                <button onClick={removeTlgm} className="hover:text-oxblood transition-colors">remove</button>
              </span>
            )}
          </div>

          {loadingStats ? (
            <div className="py-16 text-center text-ash"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
          ) : sortedStats.length === 0 ? (
            <div className="py-16 text-center text-ash">No attendance in this window.</div>
          ) : (
            <Table maxHeight="max-h-[720px]" minWidth="min-w-[420px]">
              <Thead sticky>
                <th className="p-4 font-normal w-10 text-right">#</th>
                <SortableTh label="Member" sortKey="name" activeKey={statSort} dir={statDir} onSort={toggleStatSort} />
                <SortableTh label="Attended" sortKey="attended" activeKey={statSort} dir={statDir} onSort={toggleStatSort} align="right" />
                <th className="p-4 font-normal w-[34%]">Rate</th>
                <SortableTh label="%" sortKey="rate" activeKey={statSort} dir={statDir} onSort={toggleStatSort} align="right" />
                <SortableTh label="All-Time" sortKey="all_time" activeKey={statSort} dir={statDir} onSort={toggleStatSort} align="right" />
              </Thead>
              <tbody>
                {sortedStats.map((m, i) => (
                  <Tr key={m.discord_id}>
                    <td className="p-4 text-right font-mono text-xs text-ash/60">{i + 1}</td>
                    <td className="p-4">
                      <button onClick={() => { setViewing(m); setViewingWindow(window_); }} className="text-bone hover:text-brass transition-colors text-left">
                        {m.display_name}
                      </button>
                    </td>
                    {/* Out of the nights since they joined, not the window's
                        total — so it can be smaller than the header's count. */}
                    <td
                      className="p-4 text-right font-mono text-xs text-ash whitespace-nowrap"
                      title={m.eligible < stats.totalEvents ? `${m.eligible} of this window's ${stats.totalEvents} nights were after they joined` : undefined}
                    >
                      {m.attended}<span className="text-ash/40">/{m.eligible}</span>
                    </td>
                    {/* The bar is the reason this table earns the width the
                        old sidebar didn't have: sixty rows of numbers hide the
                        shape of the guild, and a bar shows the drop-off. */}
                    <td className="p-4">
                      <div className="h-1.5 rounded-full bg-hall overflow-hidden">
                        <div
                          className={`h-full rounded-full ${m.rate >= 75 ? 'bg-emerald-400/70' : m.rate >= 40 ? 'bg-brass' : 'bg-oxblood'}`}
                          style={{ width: `${Math.min(100, m.rate || 0)}%` }}
                        />
                      </div>
                    </td>
                    {m.rate === null ? (
                      // Joined after every night in this window.
                      <td className="p-4 text-right font-mono text-xs text-ash/40">—</td>
                    ) : (
                      <td className={`p-4 text-right font-mono text-xs ${m.rate >= 75 ? 'text-emerald-400' : m.rate >= 40 ? 'text-brassbright' : 'text-oxblood'}`}>
                        {m.rate}%
                      </td>
                    )}
                    <td className="p-4 text-right font-mono text-xs whitespace-nowrap">
                      {m.all_time ? (
                        <span title={`${m.all_time.attended} of ${m.all_time.total} activities, all time`}>
                          <span className="text-ash/60">{m.all_time.attended}/{m.all_time.total}</span>{' '}
                          <span className={m.all_time.rate >= 75 ? 'text-emerald-400' : m.all_time.rate >= 40 ? 'text-brassbright' : 'text-oxblood'}>
                            {m.all_time.rate}%
                          </span>
                        </span>
                      ) : <span className="text-ash/40">—</span>}
                    </td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>

        {/* Past events */}
        <aside className="lg:sticky lg:top-20 self-start">
          <div className="eyebrow text-[10px] text-brass flex items-center gap-2 mb-3">
            <CalendarDays className="w-3.5 h-3.5" /> Past Events
          </div>

          {loadingEvents ? (
            <div className="py-8 text-center text-ash"><Loader2 className="w-4 h-4 animate-spin inline" /></div>
          ) : events.length === 0 ? (
            <p className="text-ash text-sm py-4">
              {window_ === 'all' ? 'No events logged yet.' : `Nothing logged in the ${WINDOW_LABEL[window_]}.`}
            </p>
          ) : (
            <div className="panel rounded-lg divide-y divide-line max-h-[720px] overflow-auto">
              {events.map((ev) => (
                <div key={ev.id} className="flex items-center gap-2 px-4 py-3 hover:bg-panelup transition-colors">
                  {/* Straight to the night's own page. This used to expand in
                      place; a logged night is a page's worth of table, party
                      and detail, and it was never going to fit under a row. */}
                  <Link to={`/attendance/${ev.id}`} className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-bone truncate hover:text-brass transition-colors">{ev.title}</div>
                    <div className="flex items-center gap-3 text-xs text-ash mt-1">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="w-3 h-3" />
                        {ev.event_date ? new Date(ev.event_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'No date'}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="w-3 h-3" /> {ev.attendees}
                      </span>
                      {ev.has_party && (
                        <span className="inline-flex items-center gap-1 text-brass/70" title="A party was recorded for this night">
                          <Swords className="w-3 h-3" />
                        </span>
                      )}
                    </div>
                  </Link>
                  <button
                    onClick={() => deleteEvent(ev.id)}
                    className="text-ash hover:text-oxblood shrink-0 p-1" title="Delete event"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>

      {/* ── Missed events ─────────────────────────────────────────────
          Every current member, most absences first — including people with
          no attendance at all, who the rate table above can't show. */}
      <div className="flex items-center justify-between gap-4 mt-12 mb-2">
        <h2 className="font-display text-2xl text-bone tracking-[0.08em] flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-oxblood" /> Missed Events
        </h2>
        <button onClick={loadMissed} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass" title="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>
      <div className="rule-fade mb-4" />

      <Tabs
        variant="flat" active={missedWindow} onChange={setMissedWindow}
        items={MISSED_WINDOWS.map((w) => ({
          key: w.key,
          label: w.key === missedWindow && !loadingMissed ? `${w.label} (${missed.totalEvents})` : w.label,
        }))}
      />

      <div className="flex items-center gap-2 text-xs text-ash mb-3">
        <X className="w-3.5 h-3.5 text-oxblood" />
        {missed.totalEvents} event{missed.totalEvents === 1 ? '' : 's'} · {WINDOW_LABEL[missedWindow]}
        <span className="text-ash/60">· nights before someone joined don't count as missed</span>
      </div>

      {loadingMissed ? (
        <div className="py-16 text-center text-ash"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : missed.totalEvents === 0 ? (
        <div className="py-16 text-center text-ash">Nothing logged in the {WINDOW_LABEL[missedWindow]}.</div>
      ) : (
        <Table maxHeight="max-h-[720px]" minWidth="min-w-[360px]">
          <Thead sticky>
            <th className="p-4 font-normal w-10 text-right">#</th>
            <th className="p-4 font-normal">Member</th>
            <th className="p-4 font-normal text-right">Missed</th>
            <th className="p-4 font-normal text-right">Attended</th>
          </Thead>
          <tbody>
            {missed.members.map((m, i) => (
              <Tr key={m.discord_id}>
                <td className="p-4 text-right font-mono text-xs text-ash/60">{i + 1}</td>
                <td className="p-4">
                  <button onClick={() => { setViewing(m); setViewingWindow(missedWindow); }} className="text-bone hover:text-brass transition-colors text-left">
                    {m.display_name}
                  </button>
                </td>
                <td className={`p-4 text-right font-mono text-xs ${m.missed === 0 ? 'text-emerald-400' : m.missed >= 3 ? 'text-oxblood' : 'text-brassbright'}`}>
                  {m.eligible === 0 ? <span className="text-ash/40">—</span> : m.missed}
                </td>
                <td className="p-4 text-right font-mono text-xs text-ash whitespace-nowrap">
                  {m.attended}<span className="text-ash/40">/{m.eligible}</span>
                </td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {viewing && <MemberNights member={viewing} window_={viewingWindow || window_} onClose={() => setViewing(null)} />}
    </div>
  );
}

// ── ONE MEMBER'S NIGHTS ─────────────────────────────────────────────────────
// Every night in the page's window, split into attended and missed. Nights
// from before they held the role are listed separately: they don't count
// against the rate, so showing them as "missed" would contradict the table.
const NIGHT_GROUPS = [
  { status: 'missed', label: 'Missed', icon: X, tone: 'text-oxblood' },
  { status: 'attended', label: 'Attended', icon: Check, tone: 'text-emerald-400' },
  { status: 'before_join', label: 'Before they joined', icon: null, tone: 'text-ash/60' },
];

function MemberNights({ member, window_, onClose }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get(`/api/admin/attendance-stats/member/${encodeURIComponent(member.discord_id)}`, { params: { window: window_ } })
      .then((res) => setEvents(res.data.events || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load their attendance.'));
  }, [member.discord_id, window_]);

  return (
    <Modal onClose={onClose} maxWidth="max-w-lg" scrollable>
      <div className="flex items-start gap-3 mb-1">
        <h3 className="font-display text-xl text-bone tracking-[0.06em] min-w-0 truncate">{member.display_name}</h3>
        <button onClick={onClose} className="ml-auto text-ash hover:text-bone shrink-0" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>
      <p className="text-xs text-ash mb-4">
        {member.attended}/{member.eligible} nights · {WINDOW_LABEL[window_]}
      </p>

      {error ? (
        <p className="text-sm text-oxblood">{error}</p>
      ) : !events ? (
        <p className="text-sm text-ash"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-ash">No events in this window.</p>
      ) : (
        NIGHT_GROUPS.map(({ status, label, icon: Icon, tone }) => {
          const group = events.filter((e) => e.status === status);
          if (!group.length) return null;
          return (
            <div key={status} className="mb-4 last:mb-0">
              <div className={`eyebrow text-[10px] mb-2 ${tone}`}>{label} ({group.length})</div>
              <div className="panel rounded-lg divide-y divide-line">
                {group.map((ev) => (
                  <Link
                    key={ev.id} to={`/attendance/${ev.id}`}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-panelup transition-colors"
                  >
                    {Icon ? <Icon className={`w-3.5 h-3.5 shrink-0 ${tone}`} /> : <span className="w-3.5 shrink-0" />}
                    <span className="text-sm text-bone truncate flex-1">{ev.title}</span>
                    <span className="text-xs text-ash shrink-0">
                      {ev.event_date ? new Date(ev.event_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'No date'}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          );
        })
      )}
    </Modal>
  );
}

// ── ADD BY HAND ─────────────────────────────────────────────────────────────
// Attendance for a night nobody snapped: tick who was there from the roster.
// The roster is the member-role list (/api/admin/members, readable by any
// officer), names already resolved to the guild's aliases.
//
// People already on the list are left out rather than shown ticked, so the
// count on the button is exactly how many this adds.
function MemberPicker({ exclude, onAdd, onClose }) {
  const [members, setMembers] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(() => new Set());

  useEffect(() => {
    axios.get('/api/admin/members')
      .then((res) => setMembers(res.data.members || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load the roster.'));
  }, []);

  const have = useMemo(() => new Set(exclude.map((m) => m.id)), [exclude]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members || [])
      .filter((m) => !have.has(m.id))
      .filter((m) => !q || String(m.name).toLowerCase().includes(q))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }, [members, have, query]);

  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  // "All" means all of what the search shows, so a filtered list can be taken
  // in one go without sweeping in people the search hid.
  const allShown = shown.length > 0 && shown.every((m) => picked.has(m.id));
  const toggleAll = () => setPicked((prev) => {
    const next = new Set(prev);
    shown.forEach((m) => (allShown ? next.delete(m.id) : next.add(m.id)));
    return next;
  });

  const add = () => {
    const chosen = (members || []).filter((m) => picked.has(m.id) && !have.has(m.id));
    if (!chosen.length) return;
    onAdd(chosen);
    setPicked(new Set());
    setQuery('');
  };

  return (
    <div className="mt-4 pt-4 border-t border-line">
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <div className="eyebrow text-[10px] text-brass flex items-center gap-2">
          <UserPlus className="w-3.5 h-3.5" /> Add by hand
        </div>
        <span className="text-xs text-ash">Tick who was there. They join the attendee list below; nothing is saved until you press Save.</span>
        <button onClick={onClose} className="ml-auto text-ash hover:text-bone" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      {error ? (
        <p className="text-sm text-oxblood">{error}</p>
      ) : !members ? (
        <p className="text-sm text-ash"><Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading the roster…</p>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-4 h-4 text-ash absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search members"
                className="w-full bg-hall border border-line rounded-lg pl-9 pr-3 py-2 text-sm text-bone focus:outline-none focus:border-brass"
              />
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-ash cursor-pointer">
              <input type="checkbox" checked={allShown} onChange={toggleAll} className="accent-[rgb(var(--color-brass))]" />
              All shown
            </label>
            <button
              onClick={add} disabled={picked.size === 0}
              className="px-4 py-2 bg-brass hover:bg-brassbright text-ink text-sm font-semibold rounded-lg transition-colors disabled:opacity-40"
            >
              Add {picked.size || ''}
            </button>
          </div>

          {shown.length === 0 ? (
            <p className="text-sm text-ash py-3">{query ? 'Nobody matches that.' : 'Everyone on the roster is already on the list.'}</p>
          ) : (
            <div className="max-h-64 overflow-auto border border-line rounded-lg grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((m) => (
                <label key={m.id} className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-panelup">
                  <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} className="accent-[rgb(var(--color-brass))]" />
                  {m.avatar
                    ? <img src={m.avatar} alt="" className="w-5 h-5 rounded-full border border-line" />
                    : <span className="w-5 h-5 rounded-full bg-panelup border border-line flex items-center justify-center text-[9px] text-brass">{(m.name || '?')[0].toUpperCase()}</span>}
                  <span className="text-bone truncate">{m.name}</span>
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
