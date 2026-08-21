import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, CalendarOff, ClipboardCheck, Gauge, AlertTriangle, ArrowRight } from 'lucide-react';
import { todayInGuildTz, fmtTimeEst, isAfterMidnight, loaStillApplies } from '../timeUtils';
import axios from 'axios';

// ── WHAT YOU OWE ────────────────────────────────────────────────────────────
// Home was entirely guild-facing: six requests, not one of them personal. A
// member's own state was spread across four pages they had to remember to
// visit, which is how a 24-hour window to claim a missed night quietly expires.
//
// Reads four endpoints that already exist and are already scoped to the caller
// in their WHERE clauses, so nothing here can surface another member's data.
// Each fails independently, matching how Home's other panels behave — a broken
// gear endpoint should cost you the gear tile, not the panel.
//
// Deliberately NOT a copy of the Event Calendar's projection. Working out which
// scheduled nights you haven't answered means re-deriving the whole schedule
// overlay, and a second implementation of that would drift. This links there.

const STALE_DAYS = 30;

const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null);

function Fact({ icon, value, label, tone = 'text-bone', to, title }) {
  const body = (
    <>
      <span className="text-brass/70 shrink-0">{icon}</span>
      <span className={`font-mono text-lg leading-none ${tone}`}>{value}</span>
      <span className="eyebrow text-[10px] text-ash/75 leading-none">{label}</span>
    </>
  );
  const cls = 'flex items-center gap-2 min-w-0';
  return to
    ? <Link to={to} title={title} className={`${cls} hover:text-brassbright transition-colors`}>{body}</Link>
    : <span className={cls} title={title}>{body}</span>;
}

// An action row exists only when there is something to do. A permanent
// "nothing to action" line is a cost paid on every visit for no information.
function Action({ tone, icon, children, to, cta }) {
  return (
    <div className={`flex items-center gap-2 flex-wrap text-sm ${tone}`}>
      {icon}
      <span>{children}</span>
      {to && (
        <Link to={to} className="inline-flex items-center gap-1 text-brass hover:text-brassbright underline underline-offset-2">
          {cta} <ArrowRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}

export default function YourStanding() {
  const [signups, setSignups] = useState(null);
  const [loa, setLoa] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [gear, setGear] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const done = () => setReady(true);
    axios.get('/api/signups').then((r) => setSignups(r.data.signups || [])).catch(() => setSignups([])).finally(done);
    axios.get('/api/loa').then((r) => setLoa(r.data.entries || [])).catch(() => setLoa([]));
    axios.get('/api/attendance/mine').then((r) => setAttendance(r.data.events || [])).catch(() => setAttendance([]));
    axios.get('/api/gear-ilvl/mine').then((r) => setGear(r.data.entry || null)).catch(() => setGear(null));
  }, []);

  if (!ready) return null;

  const today = todayInGuildTz();

  const mine = (signups || []).filter((s) => s.my_status);
  const going = mine.filter((s) => s.my_status === 'going');
  const waitlisted = mine.filter((s) => s.my_status === 'waitlist');
  const nextUp = mine[0] || null; // list() already returns them soonest-first

  const away = (loa || []).filter((e) => loaStillApplies(e, today));

  const logged = attendance || [];
  const attended = logged.filter((e) => e.attended).length;
  const rate = logged.length ? Math.round((attended / logged.length) * 100) : null;
  // The time-sensitive one. The window is 24 hours from when attendance was
  // taken, so a member who doesn't happen to open the attendance page loses it.
  const canClaim = logged.filter((e) => e.can_request);

  const gearAge = daysSince(gear?.submitted_at);
  const gearStale = gear && gearAge !== null && gearAge >= STALE_DAYS;

  const actions = [];
  if (canClaim.length) {
    actions.push(
      <Action
        key="claim" tone="text-brassbright" to="/attendance" cta="Ask to be added"
        icon={<AlertTriangle className="w-4 h-4 shrink-0" />}
      >
        Attendance missed you on {canClaim.length} night{canClaim.length === 1 ? '' : 's'} you can still claim.
      </Action>,
    );
  }
  if (!gear) {
    actions.push(
      <Action key="nogear" tone="text-ash" to="/gear" cta="Upload one" icon={<Gauge className="w-4 h-4 shrink-0" />}>
        No gear level on file.
      </Action>,
    );
  } else if (gearStale) {
    actions.push(
      <Action key="stalegear" tone="text-ash" to="/gear" cta="Update it" icon={<Gauge className="w-4 h-4 shrink-0" />}>
        Your gear level is {gearAge} days old.
      </Action>,
    );
  }

  return (
    <section className="border-b border-line bg-hall">
      <div className="max-w-6xl mx-auto px-6 py-7">
        <div className="flex items-baseline justify-between gap-4 mb-4 flex-wrap">
          <div className="eyebrow text-ash text-[11px]">Where You Stand</div>
          <Link to="/attendance/calendar" className="text-xs text-brass hover:text-brassbright transition-colors">
            The week ahead →
          </Link>
        </div>

        <div className="panel rounded-lg px-5 py-4 flex flex-col gap-4">
          <div className="flex items-center gap-x-8 gap-y-3 flex-wrap">
            <Fact
              icon={<ClipboardList className="w-4 h-4" />}
              value={going.length}
              label={`signed up${waitlisted.length ? ` · ${waitlisted.length} waitlisted` : ''}`}
              tone={going.length ? 'text-bone' : 'text-ash/50'}
              to="/signups"
              title="Upcoming events you've said you're coming to"
            />
            <Fact
              icon={<CalendarOff className="w-4 h-4" />}
              value={away.length}
              label="LOA on file"
              tone={away.length ? 'text-bone' : 'text-ash/50'}
              to="/loa"
              title="Your absences that still apply"
            />
            <Fact
              icon={<ClipboardCheck className="w-4 h-4" />}
              value={rate === null ? '—' : `${rate}%`}
              label="attendance · 30d"
              tone={rate === null ? 'text-ash/50' : rate >= 70 ? 'text-bone' : 'text-brassbright'}
              to="/attendance"
              title={rate === null ? 'No events logged in the last 30 days' : `${attended} of ${logged.length} nights`}
            />
            <Fact
              icon={<Gauge className="w-4 h-4" />}
              value={gear?.average ?? '—'}
              label={gear ? `gear · ${gearAge}d ago` : 'no gear level'}
              tone={gear ? (gearStale ? 'text-brassbright' : 'text-bone') : 'text-ash/50'}
              to="/gear"
              title={gear ? 'Your equipment level' : 'Upload a Watermark Upload to record one'}
            />
          </div>

          {/* The next thing you've committed to, spelled out — a count alone
              doesn't tell you whether it's tonight. */}
          {nextUp && (
            <div className="text-sm text-ash border-t border-line pt-3">
              Next up{' '}
              <span className="text-bone">{nextUp.title}</span>
              {' · '}
              {new Date(`${nextUp.event_date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
              {nextUp.event_time && <> at {fmtTimeEst(nextUp.event_time)}</>}
              {isAfterMidnight(nextUp.event_time) && <span className="text-ash/60"> (after midnight)</span>}
              {nextUp.my_status === 'waitlist' && <span className="text-brass"> — you're on the waitlist</span>}
            </div>
          )}

          {actions.length > 0 && (
            <div className="border-t border-line pt-3 flex flex-col gap-2">{actions}</div>
          )}
        </div>
      </div>
    </section>
  );
}
