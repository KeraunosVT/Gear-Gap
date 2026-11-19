import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays } from 'lucide-react';
import { BUILD_TEXT, BUILD_BORDER } from '../../buildColors';

// The small pieces every member line on the Priority tab carries: who they
// are, their attendance, whether an officer has confirmed their need, and a
// hover card of what they've already received.

export const daysAgo = (iso) => {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
};
export const agoText = (iso) => {
  const d = daysAgo(iso);
  if (d === null) return 'never';
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`;
};

export function Avatar({ member, size = 'sm' }) {
  const box = size === 'xs' ? 'w-5 h-5 text-[9px]' : 'w-7 h-7 text-xs';
  return member.avatar
    ? <img src={member.avatar} alt="" className={`${box} rounded-full border border-line shrink-0`} />
    : <span className={`${box} rounded-full bg-panelup border border-line shrink-0 flex items-center justify-center text-brass`}>{(member.name || '?').slice(0, 1).toUpperCase()}</span>;
}

export function BuildPill({ build }) {
  return (
    <span className={`text-[10px] font-bold tracking-wide rounded-full px-2 py-0.5 border ${BUILD_TEXT[build] || ''} ${BUILD_BORDER[build] || 'border-line'}`}>
      {String(build).toUpperCase()}
    </span>
  );
}

// The class a member will play the weapon in; nothing when they haven't said.
export function ClassTag({ cls }) {
  if (!cls) return null;
  return <span className="text-[11px] text-bone/80 rounded px-1.5 py-px bg-hall whitespace-nowrap">{cls}</span>;
}

// Attendance over the page's window. Missing data (the read failed) shows
// nothing rather than a misleading 0%.
export function AttendanceChip({ att, days }) {
  if (!att) return null;
  const { rate, attended, eligible } = att;
  const tone = rate === null ? 'text-ash' : rate >= 75 ? 'text-bone' : rate >= 50 ? 'text-amber-600 dark:text-amber-400' : 'text-oxblood';
  const title = rate === null
    ? `No nights in the last ${days} days to measure yet`
    : `Attended ${attended} of ${eligible} nights in the last ${days} days`;
  return (
    <span title={title} className={`inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-px bg-hall ${tone}`}>
      <CalendarDays className="w-3 h-3" aria-hidden="true" />
      <span className="font-mono">{rate === null ? 'new' : `${rate}%`}</span>
      <span className="text-ash">att</span>
      <span className="sr-only">{title}</span>
    </span>
  );
}

// An officer's "checked with them, they still need this many". Stale when the
// member's number has changed since — the tick vouched for the old one.
export function ConfirmToggle({ request, confirmation, onToggle, busy }) {
  const unset = request.need === null || request.need === undefined;
  const ok = Boolean(confirmation) && !unset && confirmation.need === request.need;
  const stale = Boolean(confirmation) && !ok;
  const text = unset ? 'Need not set' : ok ? `Confirmed ${agoText(confirmation.at)}` : stale ? 'Changed since confirmed' : 'Confirm need';
  const tone = ok
    ? 'text-sky-700 dark:text-sky-300 border-sky-500/40'
    : stale ? 'text-amber-600 dark:text-amber-400 border-amber-500/40' : 'text-ash border-line';
  const by = confirmation?.by_name || 'an officer';
  const title = unset
    ? `${request.name} hasn't said how many they need yet`
    : ok ? `Confirmed by ${by} ${agoText(confirmation.at)}: still needs ${confirmation.need}`
      : stale ? `${by} confirmed ${confirmation.need} ${agoText(confirmation.at)}; the wishlist now says ${request.need}. Check again.`
        : `Tick once you've checked with ${request.name} that they still need ${request.need}`;
  return (
    <label title={title} className={`inline-flex items-center gap-1.5 text-[11px] rounded border px-1.5 min-h-[22px] ${tone} ${unset ? 'opacity-60' : 'cursor-pointer'}`}>
      <input
        type="checkbox" checked={ok} disabled={unset || busy}
        onChange={() => onToggle(request.key, ok)}
        className="accent-sky-400 w-3 h-3 m-0"
      />
      {text}
      <span className="sr-only">{title}</span>
    </label>
  );
}

const KIND_TAG = {
  shard: { label: 'SHARD', cls: 'bg-brass/15 text-brassbright' },
  gear: { label: 'GEAR', cls: 'bg-line text-bone' },
  lucent: { label: 'LUCENT', cls: 'bg-amber-400/15 text-amber-600 dark:text-amber-400' },
};

// The member's name, with a card of what they've received in the last
// `days` days on hover or focus. The card is portalled to <body> and placed
// against the window: the request tables scroll sideways and the priority
// rows are transformed while sorting, and either would clip or misplace it.
export function LootHover({ name, loot, days }) {
  const triggerRef = useRef(null);
  const timer = useRef(null);
  const [pos, setPos] = useState(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const open = () => {
    clearTimeout(timer.current);
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const room = window.innerHeight - r.bottom;
    const above = room < 340 && r.top > room;
    setPos({
      left: Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 328))),
      ...(above ? { bottom: Math.round(window.innerHeight - r.top + 6) } : { top: Math.round(r.bottom + 6) }),
    });
  };
  // A short delay so the pointer can cross from the name onto the card.
  const close = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setPos(null), 120); };

  const entries = loot || [];
  const shards = entries.filter((e) => e.kind === 'shard');
  const gear = entries.filter((e) => e.kind === 'gear').length;

  return (
    <>
      <button
        ref={triggerRef} type="button"
        onMouseEnter={open} onMouseLeave={close} onFocus={open} onBlur={close}
        className="text-bone underline decoration-dotted decoration-ash/50 underline-offset-4 cursor-help text-left"
      >
        {name}
      </button>
      {pos && createPortal(
        <div
          role="tooltip" onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={close}
          style={{ position: 'fixed', zIndex: 60, width: 320, ...pos }}
          className="panel rounded-lg shadow-2xl p-3.5 space-y-2.5 text-sm"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-bone font-semibold">{name}</span>
            <span className="eyebrow text-[10px] text-ash">Loot · last {days} days</span>
          </div>
          {loot === null ? (
            <p className="text-xs text-ash">Loot history couldn&apos;t be loaded.</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  [shards.reduce((a, e) => a + (e.amount || 0), 0), 'shards'],
                  [gear, gear === 1 ? 'gear item' : 'gear items'],
                  [shards.length ? agoText(shards[0].at) : 'none', 'last shard'],
                ].map(([value, label]) => (
                  <div key={label} className="bg-hall border border-line rounded-md px-2 py-1.5">
                    <div className="font-mono text-bone">{value}</div>
                    <div className="text-[10px] text-ash">{label}</div>
                  </div>
                ))}
              </div>
              {entries.length === 0 ? (
                <p className="text-xs text-ash">Nothing received in the last {days} days.</p>
              ) : (
                <ul className="space-y-1.5">
                  {entries.slice(0, 5).map((e, i) => (
                    <li key={i} className="flex items-baseline gap-2 text-xs">
                      <span className="w-12 shrink-0 font-mono text-ash">{new Date(e.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                      <span className={`shrink-0 text-[9px] font-bold tracking-wider rounded px-1.5 py-px ${KIND_TAG[e.kind]?.cls || ''}`}>{KIND_TAG[e.kind]?.label || e.kind}</span>
                      <span className="flex-1 min-w-0 text-bone">{e.label}</span>
                      {e.amount != null && <span className="font-mono text-bone">+{e.amount.toLocaleString()}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-line pt-2 text-[11px] text-ash">
                {entries.length > 5 ? `${entries.length - 5} more in Loot › History` : 'Full history in Loot › History'}
              </div>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
