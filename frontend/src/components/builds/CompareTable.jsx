import { useState } from 'react';
import { COMPARE_SECTIONS, PVP_BASE, STAT, fmtStat, shownValue, fullLabel } from '../../buildStats';

// The same label with where it comes from, since this table mixes base, Boss
// and PvP rows under one column.
const rowLabel = (id) => (PVP_BASE[id] ? `${fullLabel(id)} (total)` : fullLabel(id));

const fmtDiff = (id, d) => {
  const unit = STAT[id]?.unit || '';
  const n = Math.abs(d).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${d > 0 ? '▲ +' : '▼ −'}${n}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
};

// PvE and PvP side by side, differences as PvP minus PvE. PvP matrix stats
// compare their totals, the same numbers the build pages show.
export default function CompareTable({ pve, pvp }) {
  const [onlyDiffs, setOnlyDiffs] = useState(true);
  let total = 0;
  let differ = 0;

  const sections = COMPARE_SECTIONS.map(([title, ids]) => {
    const rows = ids.map((id) => {
      const a = shownValue(pve.stats, id);
      const b = shownValue(pvp.stats, id);
      if (a === undefined && b === undefined) return null;
      total += 1;
      const same = a === b;
      if (!same) differ += 1;
      if (onlyDiffs && same) return null;
      const both = Number.isFinite(a) && Number.isFinite(b);
      const d = both ? b - a : null;
      return (
        <tr key={id} className="border-t border-line">
          <th className="px-4 py-1.5 text-left font-medium text-bone">{rowLabel(id)}</th>
          <td className="px-4 py-1.5 text-right tabular-nums text-bone">{fmtStat(id, a)}</td>
          <td className="px-4 py-1.5 text-right tabular-nums text-bone">{fmtStat(id, b)}</td>
          <td className={`px-4 py-1.5 text-right tabular-nums font-semibold ${
            same ? 'text-ash font-normal' : !both ? 'text-ash' : d > 0 ? 'text-oxblood' : 'text-emerald-400'
          }`}>
            {same ? 'same' : both ? fmtDiff(id, d) : 'only in one'}
          </td>
        </tr>
      );
    }).filter(Boolean);
    if (!rows.length) return null;
    return [
      <tr key={title} className="border-t border-line bg-hall/60">
        <th colSpan={4} className="px-4 py-1.5 text-left eyebrow text-[10px] text-ash">{title}</th>
      </tr>,
      ...rows,
    ];
  });

  return (
    <div className="panel rounded-lg overflow-hidden">
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-line">
        <h3 className="font-display text-bone text-sm tracking-[0.06em]">PvE vs PvP</h3>
        <span className="text-xs text-ash">{differ} of {total} stats differ</span>
        <label className="inline-flex items-center gap-2 text-sm text-ash cursor-pointer">
          <input type="checkbox" checked={onlyDiffs} onChange={(e) => setOnlyDiffs(e.target.checked)} className="accent-current" />
          Only show stats that differ
        </label>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left eyebrow text-[10px] text-ash">Stat</th>
              <th className="px-4 py-2 text-right eyebrow text-[10px] text-emerald-400">PvE</th>
              <th className="px-4 py-2 text-right eyebrow text-[10px] text-oxblood">PvP</th>
              <th className="px-4 py-2 text-right eyebrow text-[10px] text-ash">Difference</th>
            </tr>
          </thead>
          <tbody>{sections}</tbody>
        </table>
      </div>
    </div>
  );
}
