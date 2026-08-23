import { useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

// The panel-wrapped, sortable table shape duplicated identically between
// Roster and GearLevels (single header row, sort-icon wiring, row hover).

export function Table({ maxHeight, minWidth, children }) {
  return (
    <div className={`panel rounded-lg overflow-auto ${maxHeight || ''}`}>
      <table className={`w-full text-sm ${minWidth || ''}`}>{children}</table>
    </div>
  );
}

export function Thead({ sticky, children }) {
  return (
    <thead className={`border-b border-line ${sticky ? 'sticky top-0 bg-panelup' : ''}`}>
      <tr className="eyebrow text-[10px] text-ash whitespace-nowrap">{children}</tr>
    </thead>
  );
}

// 'center' is here for the stat tables on the War Record page, whose numeric
// columns are centred rather than right-aligned. The arrow rides inside the
// inline-flex span, so it stays beside the label under any of the three.
const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' };

export function SortableTh({ label, sortKey, activeKey, dir, onSort, align = 'left', dense = false, className = '' }) {
  const active = activeKey === sortKey;
  return (
    <th
      className={`${dense ? 'p-2.5' : 'p-4'} font-normal cursor-pointer hover:text-bone select-none ${ALIGN[align] || ALIGN.left} ${className}`}
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (dir === 'desc' ? <ArrowDown className="w-3 h-3 text-brass" /> : <ArrowUp className="w-3 h-3 text-brass" />)}
      </span>
    </th>
  );
}

export function Tr({ children, className = '' }) {
  return <tr className={`border-b border-line/60 hover:bg-panelup transition-colors ${className}`}>{children}</tr>;
}

// ── SORT STATE AND THE SORT ITSELF ──────────────────────────────────────────
// Written for the War Record's two tables, moved here when the Feuds page
// became the third consumer — a copy is how two tables end up sorting
// differently a month later.
//
// Starts with NO column selected, so what loads is the order the server sent.
// That order is usually meaningful (rank order, most-played first, most-met
// first) and a forced initial sort would quietly discard it.
//
// `textKeys` decides which way a column opens: names read best A–Z, numbers
// best highest-first. Having to click twice to get the obvious direction is the
// thing that makes sortable headers feel broken.
export function useSort(textKeys = [], initialKey = null, initialDir = 'desc') {
  const [key, setKey] = useState(initialKey);
  const [dir, setDir] = useState(initialDir);
  const sortBy = (k) => {
    if (k === key) setDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setKey(k); setDir(textKeys.includes(k) ? 'asc' : 'desc'); }
  };
  return { key, dir, sortBy };
}

// `value(row, key)` so a column can be sorted by something the row doesn't
// store — a class computed from two weapon fields, a count nested under another
// object. Strings compare with localeCompare, everything else numerically; a
// missing number sorts as 0 rather than NaN, which would scatter those rows
// unpredictably instead of grouping them at one end.
export function sortRows(rows, key, dir, value = (r, k) => r[k]) {
  if (!key) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a, key);
    const vb = value(b, key);
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va ?? '').localeCompare(String(vb ?? '')) * sign;
    }
    return ((Number(va) || 0) - (Number(vb) || 0)) * sign;
  });
}
