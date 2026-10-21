import { useState } from 'react';
import axios from 'axios';
import { Plus, Trash2, X, Pencil, Check, RotateCcw } from 'lucide-react';

import { fmtTimeEst, isAfterMidnight, guildDayOfWeek, todayInGuildTz } from '../timeUtils';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const shortDate = (dateStr) =>
  new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const FIELD = 'bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass';

// The recurring event schedule: add, edit, remove. Lived inline on the LOA
// page; it moved to the Event Calendar, which is where the schedule is shown.
//
// The day here is the CALENDAR day an event is stored under, not the night it
// belongs to — that is what the API takes. An after-midnight event is labelled
// with its night as well, so "Sunday at 12:30 AM" isn't misread.
//
// `onChanged` is called after every successful write so the caller can reload.
// Messages are shown inline, because this usually sits in a modal above the
// page's own toast.
export default function ScheduleManager({ schedule, onChanged }) {
  const [msg, setMsg] = useState(null);
  const [newName, setNewName] = useState('');
  const [newDay, setNewDay] = useState('');
  const [newTime, setNewTime] = useState('');

  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editDay, setEditDay] = useState('');
  const [editTime, setEditTime] = useState('');
  const [saving, setSaving] = useState(false);

  const say = (text, ok = true) => setMsg({ text, ok });

  const add = async () => {
    if (!newName.trim() || newDay === '') return;
    try {
      await axios.post('/api/admin/event-schedule', { name: newName.trim(), day_of_week: parseInt(newDay, 10), event_time: newTime || null });
      setNewName(''); setNewDay(''); setNewTime('');
      onChanged();
      say('Event added to schedule.');
    } catch (err) {
      say(err.response?.data?.error || 'Failed to add event.', false);
    }
  };

  const remove = async (s) => {
    if (!window.confirm(`Remove ${s.name} from the schedule?`)) return;
    try {
      await axios.delete(`/api/admin/event-schedule/${s.id}`);
      onChanged();
      say('Event removed from schedule.');
    } catch (err) {
      say(err.response?.data?.error || 'Failed to delete.', false);
    }
  };

  // Put back one night that was removed from the calendar.
  const restore = async (s, date) => {
    try {
      await axios.post(`/api/admin/event-schedule/${s.id}/skip`, { date, skip: false });
      onChanged();
      say(`${s.name} restored for ${shortDate(date)}.`);
    } catch (err) {
      say(err.response?.data?.error || 'Failed to restore.', false);
    }
  };
  const today = todayInGuildTz();
  const upcomingSkips = (s) => (Array.isArray(s.skip_dates) ? s.skip_dates : []).filter((d) => d >= today).sort();

  const startEdit = (s) => {
    setEditingId(s.id);
    setEditName(s.name);
    setEditDay(String(s.day_of_week));
    setEditTime(s.event_time || '');
  };

  const save = async (id) => {
    if (!editName.trim() || editDay === '') return;
    setSaving(true);
    try {
      await axios.put(`/api/admin/event-schedule/${id}`, {
        name: editName.trim(),
        day_of_week: parseInt(editDay, 10),
        event_time: editTime || null,
      });
      setEditingId(null);
      onChanged();
      say('Event updated.');
    } catch (err) {
      say(err.response?.data?.error || 'Failed to update event.', false);
    } finally {
      setSaving(false);
    }
  };

  // Ordered as a week reads, Sunday first, then by stored time.
  const sorted = [...schedule].sort((a, b) => a.day_of_week - b.day_of_week
    || String(a.event_time || '').localeCompare(String(b.event_time || '')));

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-4">
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Event name" className={`${FIELD} flex-1 min-w-[160px]`} />
        <select value={newDay} onChange={(e) => setNewDay(e.target.value)} className={FIELD}>
          <option value="">— day —</option>
          {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
        </select>
        <input type="time" value={newTime} onChange={(e) => setNewTime(e.target.value)} className={FIELD} title="Event time, guild time (optional)" />
        <button
          onClick={add} disabled={!newName.trim() || newDay === ''} title="Add to schedule"
          className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      {msg && <div className={`mb-3 text-sm ${msg.ok ? 'text-brass' : 'text-oxblood'}`}>{msg.text}</div>}

      <div className="space-y-2">
        {sorted.length === 0 ? (
          <p className="text-ash text-sm">No events scheduled. Add your recurring events above.</p>
        ) : sorted.map((s) => (
          editingId === s.id ? (
            <div key={s.id} className="flex flex-wrap gap-2 bg-hall border border-brass/50 rounded-lg px-3 py-2">
              <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Event name"
                className="bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1 min-w-[140px]" />
              <select value={editDay} onChange={(e) => setEditDay(e.target.value)}
                className="bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass">
                {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
              <input type="time" value={editTime} onChange={(e) => setEditTime(e.target.value)}
                className="bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass" />
              <button onClick={() => save(s.id)} disabled={saving || !editName.trim()}
                className="px-3 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
                <Check className="w-4 h-4" />
              </button>
              <button onClick={() => setEditingId(null)} disabled={saving} className="px-3 py-2 text-ash hover:text-bone transition-colors disabled:opacity-40">
                <X className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div key={s.id} className="bg-hall border border-line rounded-lg px-3 py-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-bone text-sm">{s.name} <span className="text-ash">— {DAYS[s.day_of_week]}{s.event_time ? ` at ${fmtTimeEst(s.event_time)}` : ''}</span>
                  {isAfterMidnight(s.event_time) && (
                    <span className="text-brass"> · {DAYS[guildDayOfWeek(s.day_of_week, s.event_time)]} night</span>
                  )}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => startEdit(s)} title="Edit" className="text-ash hover:text-brass p-0.5"><Pencil className="w-3.5 h-3.5" /></button>
                  <button onClick={() => remove(s)} title="Remove" className="text-ash hover:text-oxblood p-0.5"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </div>
              {upcomingSkips(s).length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-xs text-ash">
                  <span>Removed:</span>
                  {upcomingSkips(s).map((d) => (
                    <button
                      key={d} onClick={() => restore(s, d)} title="Put this night back on the calendar"
                      className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 hover:border-brass hover:text-brass"
                    >
                      {shortDate(d)} <RotateCcw className="w-3 h-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        ))}
      </div>
    </div>
  );
}
