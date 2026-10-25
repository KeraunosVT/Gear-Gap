import { useState } from 'react';
import { Check } from 'lucide-react';
import { BUILD_STATS, STAT } from '../../buildStats';

// In the order the screenshots are taken, so checking a number means looking
// at one screenshot at a time rather than hunting across all seven.
const PANELS = [
  ['weapon', 'Weapons'],
  ['combat', 'Defense, Attack & Protection'],
  ['basic', 'Basic'],
  ['status', 'Status effects'],
  ['boss', 'Boss'],
  ['pvp', 'PvP (the bonus as the PvP tab shows it)'],
];

// What someone types → a number, or NaN. Accepts what the game prints:
// "2,123.4", "+96.5%", "0.392s", "−31.81%".
export const parseInput = (s) => parseFloat(String(s ?? '').replace(/[,+%\s]|[sm]$/gi, '').replace('−', '-'));

export const toInputs = (stats) => Object.fromEntries(Object.entries(stats || {}).map(([id, v]) => [id, String(v)]));

// Inputs → { stats, invalid }. A blank input drops the stat; anything else
// that isn't a number blocks saving.
export function fromInputs(inputs) {
  const stats = {};
  const invalid = [];
  for (const [id, s] of Object.entries(inputs)) {
    if (String(s).trim() === '') continue;
    const n = parseInput(s);
    if (Number.isFinite(n)) stats[id] = n;
    else invalid.push(id);
  }
  return { stats, invalid };
}

// Every stat as an editable number, flagged ones first. Editing a flagged
// value clears its flag — the person has looked at it — and "Looks right"
// clears it without a change.
export default function BuildReview({ inputs, flags, onInput, onConfirm }) {
  const [showAll, setShowAll] = useState(() => Object.keys(flags).length === 0);
  const flagged = BUILD_STATS.filter((s) => flags[s.id]);
  const missing = BUILD_STATS.filter((s) => !(s.id in inputs) || String(inputs[s.id]).trim() === '').length;

  const row = (id) => {
    const s = STAT[id];
    const bad = id in inputs && String(inputs[id]).trim() !== '' && !Number.isFinite(parseInput(inputs[id]));
    return (
      <div key={id} className="flex items-center gap-3 py-1">
        <label htmlFor={`bv-${id}`} className="flex-1 min-w-0 text-sm text-bone truncate">
          {s.label}
          {flags[id] && <span className="block text-xs text-amber-400 whitespace-normal">{flags[id]}</span>}
        </label>
        {flags[id] && (
          <button type="button" onClick={() => onConfirm(id)}
            className="inline-flex items-center gap-1 text-xs text-ash hover:text-bone shrink-0">
            <Check className="w-3.5 h-3.5" /> Looks right
          </button>
        )}
        <span className="relative shrink-0">
          <input
            id={`bv-${id}`} value={inputs[id] ?? ''} onChange={(e) => onInput(id, e.target.value)} inputMode="decimal"
            placeholder="—"
            className={`w-28 bg-hall border rounded-md pl-2 pr-6 py-1 text-right text-sm tabular-nums text-bone focus:outline-none ${
              bad ? 'border-oxblood' : flags[id] ? 'border-amber-400/60 focus:border-brass' : 'border-line focus:border-brass'
            }`}
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ash pointer-events-none">{s.unit}</span>
        </span>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {flagged.length > 0 && (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 px-4 py-3">
          <div className="text-sm text-bone font-medium mb-1">Check {flagged.length === 1 ? 'this value' : `these ${flagged.length} values`} against the game</div>
          <div className="divide-y divide-line">{flagged.map((s) => row(s.id))}</div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap text-xs text-ash">
        <span>
          {missing > 0
            ? `${missing} stat${missing === 1 ? ' was' : 's were'} not found. If a whole tab is missing, add that screenshot.`
            : 'Every stat was found.'}
        </span>
        {flagged.length > 0 && (
          <button type="button" onClick={() => setShowAll((v) => !v)} className="text-brass hover:text-brassbright">
            {showAll ? 'Hide the rest' : 'Show every stat'}
          </button>
        )}
      </div>

      {showAll && PANELS.map(([panel, title]) => (
        <div key={panel}>
          <div className="eyebrow text-[10px] text-brass mb-1">{title}</div>
          <div className="divide-y divide-line">
            {BUILD_STATS.filter((s) => s.panel === panel && !flags[s.id]).map((s) => row(s.id))}
          </div>
        </div>
      ))}
    </div>
  );
}
