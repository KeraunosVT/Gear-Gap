import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { CalendarOff, CalendarX2, Plus, Trash2, Settings, X, Repeat } from 'lucide-react';

import { fmtTime, fmtTimeEst, todayInGuildTz } from '../timeUtils';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export default function LOA() {
  const { user } = useAuth();
  const [schedule, setSchedule] = useState([]);
  const [myEntries, setMyEntries] = useState([]);
  const [allEntries, setAllEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);

  const [tab, setTab] = useState('submit');
  const [loaType, setLoaType] = useState('event');
  const [eventDate, setEventDate] = useState('');
  const [eventScheduleId, setEventScheduleId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [recurDay, setRecurDay] = useState('');
  const [recurEventScheduleId, setRecurEventScheduleId] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [showScheduleAdmin, setShowScheduleAdmin] = useState(false);
  const [newEventName, setNewEventName] = useState('');
  const [newEventDay, setNewEventDay] = useState('');
  const [newEventTime, setNewEventTime] = useState('');

  // Officers can submit an LOA on someone else's behalf; '' means "myself".
  const [adminMembers, setAdminMembers] = useState([]);
  const [submitFor, setSubmitFor] = useState('');

  const load = () => {
    setLoading(true); setError('');
    Promise.all([
      axios.get('/api/event-schedule'),
      axios.get('/api/loa'),
      axios.get('/api/loa/all'),
    ])
      .then(([sched, mine, all]) => {
        setSchedule(sched.data.schedule || []);
        setMyEntries(mine.data.entries || []);
        setAllEntries(all.data.entries || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Failed to load.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!user?.isAdmin) return;
    axios.get('/api/admin/members').then((res) => setAdminMembers(res.data.members || [])).catch(() => {});
  }, [user?.isAdmin]);

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  const scheduleById = useMemo(() => {
    const m = {};
    schedule.forEach((s) => { m[s.id] = s; });
    return m;
  }, [schedule]);

  const eventsOnDate = useMemo(() => {
    if (!eventDate) return [];
    const dow = new Date(eventDate + 'T12:00:00').getDay();
    return schedule.filter((s) => s.day_of_week === dow);
  }, [eventDate, schedule]);

  const eventsOnRecurDay = useMemo(() => {
    if (recurDay === '') return [];
    return schedule.filter((s) => s.day_of_week === Number(recurDay));
  }, [recurDay, schedule]);

  const submitTarget = useMemo(() => adminMembers.find((m) => m.id === submitFor) || null, [adminMembers, submitFor]);

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      await axios.post('/api/loa', {
        type: loaType,
        event_date: loaType === 'event' ? eventDate : undefined,
        event_schedule_id: loaType === 'event' ? eventScheduleId : loaType === 'recurring' ? (recurEventScheduleId || undefined) : undefined,
        start_date: loaType === 'range' ? startDate : undefined,
        end_date: loaType === 'range' ? endDate : undefined,
        day_of_week: loaType === 'recurring' ? Number(recurDay) : undefined,
        reason,
        discord_id: submitTarget?.id,
        display_name: submitTarget?.name,
      });
      flash(submitTarget ? `LOA submitted for ${submitTarget.name}.` : 'LOA submitted.');
      setEventDate(''); setEventScheduleId(''); setStartDate(''); setEndDate('');
      setRecurDay(''); setRecurEventScheduleId(''); setReason(''); setSubmitFor('');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to submit LOA.', false);
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (id) => {
    try {
      await axios.delete(`/api/loa/${id}`);
      flash('LOA cancelled.');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to cancel.', false);
    }
  };

  const addScheduleEvent = async () => {
    if (!newEventName.trim() || newEventDay === '') return;
    try {
      await axios.post('/api/admin/event-schedule', { name: newEventName.trim(), day_of_week: parseInt(newEventDay, 10), event_time: newEventTime || null });
      setNewEventName(''); setNewEventDay(''); setNewEventTime('');
      load();
      flash('Event added to schedule.');
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to add event.', false);
    }
  };

  const deleteScheduleEvent = async (id) => {
    try {
      await axios.delete(`/api/admin/event-schedule/${id}`);
      load();
      flash('Event removed from schedule.');
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to delete.', false);
    }
  };

  const formatEventLabel = (entry) => {
    const ev = scheduleById[entry.event_schedule_id];
    const name = ev ? ev.name : 'Event';
    const time = ev?.event_time ? ` at ${fmtTime(ev.event_time)}` : '';
    return `${name}${time} — ${new Date(entry.event_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  };

  // Same as above minus the trailing date — used in the agenda, where the date is already a section header.
  const formatEventName = (entry) => {
    const ev = scheduleById[entry.event_schedule_id];
    const name = ev ? ev.name : 'Event';
    const time = ev?.event_time ? ` at ${fmtTime(ev.event_time)}` : '';
    return `${name}${time}`;
  };

  const formatRangeLabel = (entry) => {
    const fmt = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${fmt(entry.start_date)} – ${fmt(entry.end_date)}`;
  };

  const formatRecurringLabel = (entry) => {
    const ev = scheduleById[entry.event_schedule_id];
    const scope = ev ? ` — ${ev.name}${ev.event_time ? ` at ${fmtTime(ev.event_time)}` : ''}` : '';
    return `Every ${DAYS[entry.day_of_week]}${scope}`;
  };

  // Same recurring entry, but as it reads on one specific occurrence in the
  // dated agenda rather than the standing-rule summary above.
  const formatRecurringOccurrence = (entry) => {
    const ev = scheduleById[entry.event_schedule_id];
    return ev ? `${ev.name}${ev.event_time ? ` at ${fmtTime(ev.event_time)}` : ''}` : 'All day';
  };

  const formatDateHeader = (dateStr) =>
    new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  // Every YYYY-MM-DD from start to end inclusive. Built from UTC-based day math
  // rather than local Date/toISOString round-tripping, so it can't skip or repeat
  // a day around a timezone's DST boundary.
  const eachDate = (start, end) => {
    const [sy, sm, sd] = start.split('-').map(Number);
    const [ey, em, ed] = end.split('-').map(Number);
    const last = Date.UTC(ey, em - 1, ed);
    const out = [];
    for (let t = Date.UTC(sy, sm - 1, sd); t <= last; t += 86400000) {
      out.push(new Date(t).toISOString().slice(0, 10));
    }
    return out;
  };

  const todayStr = todayInGuildTz();

  const upcomingAbsent = useMemo(() => {
    return allEntries.filter((e) => {
      if (e.type === 'event') return e.event_date >= todayStr;
      if (e.type === 'range') return e.end_date >= todayStr;
      return false; // recurring entries are projected onto the agenda separately below
    });
  }, [allEntries, todayStr]);

  // Recurring absences have no fixed date, so the board also lists them as a
  // standing summary in addition to projecting them onto the dated agenda below.
  const recurringEntries = useMemo(() => allEntries.filter((e) => e.type === 'recurring'), [allEntries]);

  // One row per day-of-week per member gets repetitive fast for anyone out
  // most of the week, so the standing summary groups by member instead and
  // shows their days as a weekly grid (one dot per day-of-week).
  const recurringByMember = useMemo(() => {
    const m = new Map();
    recurringEntries.forEach((e) => {
      if (!m.has(e.discord_id)) m.set(e.discord_id, { discord_id: e.discord_id, display_name: e.display_name, byDay: {} });
      m.get(e.discord_id).byDay[e.day_of_week] = e;
    });
    return [...m.values()].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  }, [recurringEntries]);

  // How far ahead to project recurring absences onto the agenda. Recurring
  // entries have no end date, so unlike event/range entries the agenda can't
  // just span "however far out the data goes" — it needs an explicit cutoff.
  const AGENDA_LOOKAHEAD_DAYS = 14;

  // Calendar dates from today through the lookahead window, built from
  // UTC-based day math (see eachDate below) so it can't skip or repeat a day
  // around a timezone's DST boundary.
  const lookaheadDates = useMemo(() => {
    const [y, m, d] = todayStr.split('-').map(Number);
    const start = Date.UTC(y, m - 1, d);
    return Array.from({ length: AGENDA_LOOKAHEAD_DAYS }, (_, i) =>
      new Date(start + i * 86400000).toISOString().slice(0, 10));
  }, [todayStr]);

  // Agenda: the same upcoming absences, grouped under a date header and sorted
  // chronologically. A range entry appears under every day it covers (clamped to
  // today onward) rather than just its start date, so "who's out today" is accurate.
  // Recurring entries are projected onto every matching day-of-week within the
  // lookahead window, so a standing Tuesday absence shows up under each Tuesday.
  const agendaGroups = useMemo(() => {
    const groups = {};
    upcomingAbsent.forEach((e) => {
      if (e.type === 'range') {
        eachDate(e.start_date, e.end_date)
          .filter((d) => d >= todayStr)
          .forEach((d) => { (groups[d] = groups[d] || []).push(e); });
      } else {
        (groups[e.event_date] = groups[e.event_date] || []).push(e);
      }
    });
    lookaheadDates.forEach((d) => {
      const dow = new Date(d + 'T12:00:00').getDay();
      recurringEntries
        .filter((e) => e.day_of_week === dow)
        .forEach((e) => { (groups[d] = groups[d] || []).push(e); });
    });
    return Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, entries]) => ({ date, entries }));
  }, [upcomingAbsent, todayStr, lookaheadDates, recurringEntries]);

  const canSubmitEvent = loaType === 'event' && eventDate && eventScheduleId && reason.trim();
  const canSubmitRange = loaType === 'range' && startDate && endDate && reason.trim();
  const canSubmitRecurring = loaType === 'recurring' && recurDay !== '' && reason.trim();

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow text-brass text-[11px] mb-3">Members Area</div>
          <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Leave of Absence</h1>
          <p className="text-ash mt-2">Let officers know when you'll be missing events.</p>
        </div>
        {user?.isAdmin && (
          <button
            onClick={() => setShowScheduleAdmin((v) => !v)}
            className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright transition-colors mt-2"
          >
            <Settings className="w-4 h-4" /> {showScheduleAdmin ? 'Close schedule' : 'Manage schedule'}
          </button>
        )}
      </div>
      <div className="rule-fade my-8" />

      {msg && (
        <div className={`mb-6 px-5 py-3 rounded-sm border text-sm ${msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'}`}>{msg.text}</div>
      )}

      {error && <div className="mb-6 px-5 py-3 rounded-sm border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {/* Admin: event schedule config */}
      {showScheduleAdmin && (
        <div className="mb-8 panel rounded-sm p-6">
          <div className="eyebrow text-brass text-[10px] mb-4">Event Schedule</div>
          <div className="flex gap-2 mb-4">
            <input value={newEventName} onChange={(e) => setNewEventName(e.target.value)} placeholder="Event name"
              className="bg-hall border border-line rounded-sm px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
            <select value={newEventDay} onChange={(e) => setNewEventDay(e.target.value)}
              className="bg-hall border border-line rounded-sm px-3 py-2 text-bone focus:outline-none focus:border-brass">
              <option value="">— day —</option>
              {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
            <div className="flex items-center gap-1">
              <input type="time" value={newEventTime} onChange={(e) => setNewEventTime(e.target.value)}
                className="bg-hall border border-line rounded-sm px-3 py-2 text-bone focus:outline-none focus:border-brass"
                title="Event time in ET (optional)" />
              <span className="text-ash text-xs shrink-0">ET</span>
            </div>
            <button onClick={addScheduleEvent} disabled={!newEventName.trim() || newEventDay === ''}
              className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors disabled:opacity-40">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-2">
            {schedule.length === 0 ? (
              <p className="text-ash text-sm">No events scheduled. Add your recurring events above.</p>
            ) : schedule.map((s) => (
              <div key={s.id} className="flex items-center justify-between bg-hall border border-line rounded-sm px-3 py-2">
                <span className="text-bone text-sm">{s.name} <span className="text-ash">— {DAYS[s.day_of_week]}{s.event_time ? ` at ${fmtTimeEst(s.event_time)}` : ''}</span></span>
                <button onClick={() => deleteScheduleEvent(s.id)} className="text-ash hover:text-oxblood"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-20 text-center text-ash">Loading…</div>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 mb-6">
            {[['submit', 'Submit LOA'], ['mine', 'My LOAs'], ['board', 'LOA Board']].map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)}
                className={`px-4 py-2 rounded-sm text-sm font-medium transition-colors ${tab === key ? 'bg-panel text-brassbright' : 'text-ash hover:text-bone'}`}>
                {label}
              </button>
            ))}
          </div>

          {/* Submit */}
          {tab === 'submit' && (
            <div className="panel rounded-sm p-6 space-y-5">
              {user?.isAdmin && (
                <div>
                  <label className="eyebrow text-[10px] text-ash block mb-2">Submit for</label>
                  <select value={submitFor} onChange={(e) => setSubmitFor(e.target.value)}
                    className="w-full md:w-64 bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass">
                    <option value="">Myself</option>
                    {adminMembers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </div>
              )}

              <div className="flex gap-3">
                <button onClick={() => setLoaType('event')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-sm text-sm font-medium border transition-colors ${loaType === 'event' ? 'border-brass bg-panel text-brassbright' : 'border-line text-ash hover:text-bone'}`}>
                  <CalendarX2 className="w-4 h-4" /> Single event
                </button>
                <button onClick={() => setLoaType('range')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-sm text-sm font-medium border transition-colors ${loaType === 'range' ? 'border-brass bg-panel text-brassbright' : 'border-line text-ash hover:text-bone'}`}>
                  <CalendarOff className="w-4 h-4" /> Date range
                </button>
                <button onClick={() => setLoaType('recurring')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-sm text-sm font-medium border transition-colors ${loaType === 'recurring' ? 'border-brass bg-panel text-brassbright' : 'border-line text-ash hover:text-bone'}`}>
                  <Repeat className="w-4 h-4" /> Recurring
                </button>
              </div>

              {loaType === 'event' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Date</label>
                    <input type="date" value={eventDate} onChange={(e) => { setEventDate(e.target.value); setEventScheduleId(''); }}
                      className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Event</label>
                    {eventsOnDate.length === 0 && eventDate ? (
                      <p className="text-ash text-sm py-2.5">No events scheduled for {DAYS[new Date(eventDate + 'T12:00:00').getDay()]}.</p>
                    ) : (
                      <select value={eventScheduleId} onChange={(e) => setEventScheduleId(e.target.value)}
                        className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass">
                        <option value="">— select event —</option>
                        {eventsOnDate.map((s) => <option key={s.id} value={s.id}>{s.name}{s.event_time ? ` (${fmtTime(s.event_time)})` : ''}</option>)}

                      </select>
                    )}
                  </div>
                </div>
              )}

              {loaType === 'range' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Start date</label>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                      className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">End date</label>
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                      className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
                  </div>
                </div>
              )}

              {loaType === 'recurring' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Day</label>
                    <select value={recurDay} onChange={(e) => { setRecurDay(e.target.value); setRecurEventScheduleId(''); }}
                      className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass">
                      <option value="">— select day —</option>
                      {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="eyebrow text-[10px] text-ash block mb-2">Event <span className="text-ash/50">(optional — blank means the whole day)</span></label>
                    <select value={recurEventScheduleId} onChange={(e) => setRecurEventScheduleId(e.target.value)} disabled={recurDay === ''}
                      className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass disabled:opacity-40">
                      <option value="">Whole day</option>
                      {eventsOnRecurDay.map((s) => <option key={s.id} value={s.id}>{s.name}{s.event_time ? ` (${fmtTime(s.event_time)})` : ''}</option>)}
                    </select>
                  </div>
                </div>
              )}

              <div>
                <label className="eyebrow text-[10px] text-ash block mb-2">Reason <span className="text-ash/50">(visible to officers only)</span></label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. vacation, work trip"
                  className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
              </div>

              <button onClick={submit} disabled={submitting || !(canSubmitEvent || canSubmitRange || canSubmitRecurring)}
                className="px-6 py-3 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors disabled:opacity-40">
                {submitting ? 'Submitting…' : 'Submit LOA'}
              </button>
            </div>
          )}

          {/* My LOAs */}
          {tab === 'mine' && (
            <div>
              {myEntries.length === 0 ? (
                <div className="panel rounded-sm p-10 text-center text-ash">You have no LOAs on file.</div>
              ) : (
                <div className="panel rounded-sm divide-y divide-line">
                  {myEntries.map((e) => (
                    <div key={e.id} className="flex items-center gap-4 px-5 py-3">
                      <div className="flex items-center gap-2 shrink-0">
                        {e.type === 'event' && <CalendarX2 className="w-4 h-4 text-brass" />}
                        {e.type === 'range' && <CalendarOff className="w-4 h-4 text-brass" />}
                        {e.type === 'recurring' && <Repeat className="w-4 h-4 text-brass" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-bone text-sm">
                          {e.type === 'event' && formatEventLabel(e)}
                          {e.type === 'range' && formatRangeLabel(e)}
                          {e.type === 'recurring' && formatRecurringLabel(e)}
                        </div>
                        {e.reason && <div className="text-xs text-ash mt-0.5">{e.reason}</div>}
                      </div>
                      <button onClick={() => cancel(e.id)} className="text-ash hover:text-oxblood shrink-0" title="Cancel LOA">
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* LOA Board — recurring absences, then the dated agenda, chronological */}
          {tab === 'board' && (
            <div className="space-y-8">
              {recurringByMember.length > 0 && (
                <div>
                  <div className="eyebrow text-[10px] text-brass mb-2 flex items-center gap-2">
                    <Repeat className="w-3.5 h-3.5" /> Recurring
                  </div>
                  <div className="panel rounded-sm divide-y divide-line">
                    {recurringByMember.map((m) => {
                      const canCancel = user?.isAdmin || m.discord_id === user?.id;
                      return (
                        <div key={m.discord_id} className="flex items-center gap-4 px-5 py-3">
                          <div className="min-w-0 flex-1 text-bone text-sm font-medium truncate">{m.display_name || 'Member'}</div>
                          <div className="flex items-center gap-1 shrink-0">
                            {DAYS.map((d, i) => {
                              const entry = m.byDay[i];
                              const active = !!entry;
                              const title = active
                                ? `${d} — ${formatRecurringOccurrence(entry)}${user?.isAdmin && entry.reason ? ` · ${entry.reason}` : ''}${canCancel ? ' (click to cancel)' : ''}`
                                : d;
                              return (
                                <button
                                  key={d}
                                  onClick={() => active && canCancel && cancel(entry.id)}
                                  disabled={!active || !canCancel}
                                  title={title}
                                  className={`w-6 h-6 rounded-full text-[10px] font-semibold border transition-colors ${
                                    active
                                      ? `bg-brass text-ink border-transparent ${canCancel ? 'hover:bg-oxblood hover:text-bone cursor-pointer' : ''}`
                                      : 'border-line text-ash/30'
                                  }`}
                                >
                                  {d[0]}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {agendaGroups.length === 0 ? (
                recurringEntries.length === 0 && (
                  <div className="panel rounded-sm p-10 text-center text-ash">No upcoming absences on file.</div>
                )
              ) : (
                <div className="space-y-6">
                  {agendaGroups.map(({ date, entries }) => (
                    <div key={date}>
                      <div className="eyebrow text-[10px] text-brass mb-2 flex items-center gap-2">
                        {formatDateHeader(date)}
                        {date === todayStr && <span className="text-oxblood">· Today</span>}
                      </div>
                      <div className="panel rounded-sm divide-y divide-line">
                        {entries.map((e) => (
                          <div key={e.id} className="flex items-center gap-4 px-5 py-3">
                            <div className="flex items-center gap-2 shrink-0">
                              {e.type === 'event' && <CalendarX2 className="w-4 h-4 text-brass" />}
                              {e.type === 'range' && <CalendarOff className="w-4 h-4 text-brass" />}
                              {e.type === 'recurring' && <Repeat className="w-4 h-4 text-brass" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-bone text-sm font-medium">{e.display_name || 'Member'}</div>
                              <div className="text-xs text-ash">
                                {e.type === 'event' && formatEventName(e)}
                                {e.type === 'range' && formatRangeLabel(e)}
                                {e.type === 'recurring' && formatRecurringOccurrence(e)}
                              </div>
                              {user?.isAdmin && e.reason && <div className="text-xs text-brass/70 mt-0.5">{e.reason}</div>}
                            </div>
                            {(user?.isAdmin || e.discord_id === user?.id) && (
                              <button onClick={() => cancel(e.id)} className="text-ash hover:text-oxblood shrink-0" title="Cancel LOA">
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
