import { Link } from 'react-router-dom';
import { CalendarDays, Check, Clock, Loader2, Hourglass, X, ThumbsDown } from 'lucide-react';

import { fmtDatetime, getGuildTz } from '../timeUtils';
import Button from './ui/Button';

// ── YOUR ATTENDANCE, ONE NIGHT AT A TIME ────────────────────────────────────
// Where a member stands on a logged night, and the one thing they can do about
// it: ask to be added to a night the snapshot missed. Lived on its own My
// Attendance page; the Event Calendar shows it now, on the past nights of the
// same grid that offers signups for the future ones.
//
// Nothing here writes an attendance record. Officers decide these requests on
// /admin/attendance, and the 24-hour window is enforced server-side — the
// button disappearing is a courtesy, not the check.

// "3h left" / "45m left". Rounded down: a window shown as an hour that closes
// in fifty minutes is worse than the reverse.
export function timeLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'closing now';
  const mins = Math.floor(ms / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h left` : `${mins}m left`;
}

// Where a logged night goes on the time axis: its scheduled time, else the
// time attendance was taken, on the guild's clock. A one-off night has no
// schedule entry, and the snapshot is the best record of when it ran.
export function placeTime(ev) {
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
export function standing(ev) {
  if (ev.attended) return 'attended';
  if (ev.request?.status === 'pending') return 'pending';
  if (ev.request?.status === 'denied') return 'denied';
  if (ev.can_request) return 'askable';
  return 'missed';
}

export const STANDING_ICON = { attended: Check, pending: Hourglass, denied: ThumbsDown, askable: Clock, missed: X };
export const STANDING_LABEL = {
  attended: 'Attended', pending: 'Waiting on an officer', denied: 'Request declined',
  askable: 'Missed — you can still ask', missed: 'Not on the roll',
};

export function StatusLine({ ev }) {
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
// `late` carries the request state the page owns: { asking, setAsking, reason,
// setReason, busy, onRequest, onWithdraw }.
export function NightCard({ ev, late, showTitle = true }) {
  const { asking, setAsking, reason, setReason, busy, onRequest, onWithdraw } = late;
  return (
    <div>
      <div className="flex items-start gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          {/* Straight through to the full roll for that night — this answers
              "was I counted", the event page answers "who else was". */}
          {showTitle ? (
            <Link to={`/attendance/${ev.id}`} className="font-medium text-bone hover:text-brass transition-colors">
              {ev.title}
            </Link>
          ) : (
            <Link to={`/attendance/${ev.id}`} className="text-xs text-brass hover:text-brassbright">See the full roll →</Link>
          )}
          {showTitle && (
            <div className="flex items-center gap-3 text-xs text-ash mt-1">
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="w-3 h-3" />
                {ev.event_date
                  ? new Date(`${ev.event_date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                  : 'No date'}
              </span>
            </div>
          )}
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
              {/* The deadline, stated where the decision is made — and kept on
                  screen while the reason box is open, which is exactly when
                  someone is deciding whether to bother. */}
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
