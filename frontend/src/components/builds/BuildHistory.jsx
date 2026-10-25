import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { fmtStat, fullLabel } from '../../buildStats';

export const HOW_LABEL = { upload: 'First upload', scan: 'New scan', edit: 'Manual fix' };

export const fmtWhen = (iso) => new Date(iso).toLocaleString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
});

// "23 stats changed", or the change itself when it's a single fix — the case
// where the old and new number are the whole point.
export function summarise(h) {
  if (h.how === 'upload') return `${h.changed_count} stats`;
  const changes = Array.isArray(h.changes) ? h.changes : [];
  if (changes.length === 1) {
    const c = changes[0];
    return `${fullLabel(c.id)} ${fmtStat(c.id, c.from)} → ${fmtStat(c.id, c.to)}`;
  }
  return `${h.changed_count} stats changed`;
}

// Every change to one build, newest first. A row with several changes opens to
// list them, so "41 stats changed" can be checked rather than taken on trust.
export default function BuildHistory({ history }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  if (!history.length) return <div className="panel rounded-lg p-4 text-sm text-ash">No history yet.</div>;

  return (
    <ol className="panel rounded-lg divide-y divide-line text-sm">
      {history.map((h, i) => {
        const changes = Array.isArray(h.changes) ? h.changes : [];
        const expandable = changes.length > 1;
        const isOpen = open.has(h.id);
        return (
          <li key={h.id}>
            <button
              type="button" onClick={() => expandable && toggle(h.id)} disabled={!expandable} aria-expanded={expandable ? isOpen : undefined}
              className={`w-full grid grid-cols-[1fr_auto] sm:grid-cols-[190px_100px_1fr_auto] gap-x-4 gap-y-0.5 items-center px-4 py-2.5 text-left ${expandable ? 'hover:bg-panelup' : 'cursor-default'}`}
            >
              <span className="tabular-nums text-bone">{fmtWhen(h.changed_at)}</span>
              <span className={`text-[10px] eyebrow font-semibold ${h.how === 'edit' ? 'text-amber-400' : 'text-ash'}`}>{HOW_LABEL[h.how] || h.how}</span>
              <span className="text-ash min-w-0 truncate col-span-2 sm:col-span-1">
                <span className="text-bone">{h.changed_by_name || 'Someone'}</span> · {summarise(h)}
              </span>
              <span className="flex items-center gap-2 justify-self-end row-start-1 col-start-2 sm:row-start-auto sm:col-start-auto">
                {i === 0 && <span className="text-[10px] font-semibold rounded px-1.5 py-0.5 bg-panelup text-bone">Current</span>}
                {expandable && <ChevronDown className={`w-3.5 h-3.5 text-ash transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
              </span>
            </button>
            {isOpen && (
              <ul className="px-4 pb-3 grid sm:grid-cols-2 gap-x-6 gap-y-0.5 text-xs">
                {changes.map((c) => (
                  <li key={c.id} className="flex justify-between gap-3">
                    <span className="text-ash truncate">{fullLabel(c.id)}</span>
                    <span className="tabular-nums text-bone shrink-0">{fmtStat(c.id, c.from)} → {fmtStat(c.id, c.to)}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
