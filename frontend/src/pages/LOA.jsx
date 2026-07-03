import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { CalendarOff, CalendarX2, Plus, Trash2, Settings, X } from 'lucide-react';

import { fmtTime, fmtTimeEst } from '../timeUtils';

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
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [showScheduleAdmin, setShowScheduleAdmin] = useState(false);
  const [newEventName, setNewEventName] = useState('');
  const [newEventDay, setNewEventDay] = useState('');
  const [newEventTime, setNewEventTime] = useState('');

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

  const submit = async () => {
    setSubmitting(true); setError('');
    try {
      await axios.post('/api/loa', {
        type: loaType,
        event_date: loaType === 'event' ? eventDate : undefined,
        event_schedule_id: loaType === 'event' ? eventScheduleId : undefined,
        start_date: loaType === 'range' ? startDate : undefined,
        end_date: loaType === 'range' ? endDate : undefined,
        reason,
      });
      flash('LOA submitted.');
      setEventDate(''); setEventScheduleId(''); setStartDate(''); setEndDate(''); setReason('');
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

  const formatDateHeader = (dateStr) =>
    new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

  const upcomingAbsent = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return allEntries.filter((e) => {
      if (e.type === 'event') return e.event_date >= today;
      if (e.type === 'range') return e.end_date >= today;
      return false;
    });
  }, [allEntries]);

  // Agenda: the same upcoming absences, grouped under a date header and sorted
  // chronologically (event date, or a range's start date) instead of a flat list.
  const agendaGroups = useMemo(() => {
    const groups = {};
    upcomingAbsent.forEach((e) => {
      const anchor = e.type === 'event' ? e.event_date : e.start_date;
      (groups[anchor] = groups[anchor] || []).push(e);
    });
    return Object.entries(groups)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, entries]) => ({ date, entries }));
  }, [upcomingAbsent]);

  const todayStr = new Date().toISOString().slice(0, 10);

  const canSubmitEvent = loaType === 'event' && eventDate && eventScheduleId;
  const canSubmitRange = loaType === 'range' && startDate && endDate;

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
              <div className="flex gap-3">
                <button onClick={() => setLoaType('event')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-sm text-sm font-medium border transition-colors ${loaType === 'event' ? 'border-brass bg-panel text-brassbright' : 'border-line text-ash hover:text-bone'}`}>
                  <CalendarX2 className="w-4 h-4" /> Single event
                </button>
                <button onClick={() => setLoaType('range')}
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-sm text-sm font-medium border transition-colors ${loaType === 'range' ? 'border-brass bg-panel text-brassbright' : 'border-line text-ash hover:text-bone'}`}>
                  <CalendarOff className="w-4 h-4" /> Date range
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

              <div>
                <label className="eyebrow text-[10px] text-ash block mb-2">Reason <span className="text-ash/50">(optional, visible to officers only)</span></label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. vacation, work trip"
                  className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
              </div>

              <button onClick={submit} disabled={submitting || !(canSubmitEvent || canSubmitRange)}
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
                        {e.type === 'event'
                          ? <CalendarX2 className="w-4 h-4 text-brass" />
                          : <CalendarOff className="w-4 h-4 text-brass" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-bone text-sm">
                          {e.type === 'event' ? formatEventLabel(e) : formatRangeLabel(e)}
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

          {/* LOA Board — agenda grouped by date, chronological */}
          {tab === 'board' && (
            <div>
              {agendaGroups.length === 0 ? (
                <div className="panel rounded-sm p-10 text-center text-ash">No upcoming absences on file.</div>
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
                              {e.type === 'event'
                                ? <CalendarX2 className="w-4 h-4 text-brass" />
                                : <CalendarOff className="w-4 h-4 text-brass" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-bone text-sm font-medium">{e.display_name || 'Member'}</div>
                              <div className="text-xs text-ash">
                                {e.type === 'event' ? formatEventName(e) : formatRangeLabel(e)}
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
