import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical, ListOrdered, X } from 'lucide-react';
import { SHARD_LABEL, SHARD_TYPES } from '../../shardRules';
import { AttendanceChip, BuildPill, ClassTag, ConfirmToggle, LootHover, agoText, daysAgo } from './MemberBits';

// The right side of the Priority tab: one list across every shard and both
// builds, first gets the next shard. Rows are `pri:<key>` sortables; the
// whole panel is the `zone:priority` drop target for member lines dragged in
// from the tables, which land above or below the row they're dropped on
// (`hint` marks where while dragging).

function Row({ r, index, count, bits, hint, onMove, onRemove }) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: `pri:${r.key}`, data: { type: 'pri', key: r.key } });
  const first = index === 0;
  const stale = (daysAgo(r.updated) ?? 0) >= 30;
  const line = hint?.key === r.key ? (hint.after ? 'shadow-[0_3px_0_0_rgb(var(--color-brassbright))]' : 'shadow-[0_-3px_0_0_rgb(var(--color-brassbright))]') : '';
  return (
    <li
      ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-md bg-panelup border px-1.5 py-2 ${first ? 'border-brass/50' : 'border-line'} ${line} ${isDragging ? 'relative z-10 shadow-xl ring-1 ring-brass' : ''}`}
    >
      <button
        type="button" ref={setActivatorNodeRef} {...attributes} {...listeners}
        aria-label={`Move ${r.name}, ranked ${index + 1}. Press space, then the arrow keys.`}
        className="p-1 rounded text-ash hover:text-bone cursor-grab active:cursor-grabbing touch-none shrink-0"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      <span className={`font-mono text-xs min-w-[34px] text-center rounded-full px-1.5 py-0.5 shrink-0 ${first ? 'bg-brass text-ink' : 'bg-line text-bone'}`}>#{index + 1}</span>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <LootHover name={r.name} loot={bits.lootFor(r.discordId)} days={bits.lootDays} />
          <BuildPill build={r.build} />
          <ClassTag cls={r.class} />
          <AttendanceChip att={bits.attendanceFor(r.discordId)} days={bits.attendanceDays} />
          {first && <span className="eyebrow text-[10px] text-brassbright">Next in line</span>}
        </div>
        <div className="text-xs text-ash truncate">{SHARD_LABEL.get(r.shard)} · {r.weapon}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ash">
          <span>
            {r.need === null || r.need === undefined
              ? <span className="text-amber-600 dark:text-amber-400">need not set</span>
              : <><span className="font-mono text-bone">{r.need}</span> / {r.cost}</>}
            <span className={stale ? 'text-amber-600 dark:text-amber-400' : ''}> · {r.updated ? `updated ${agoText(r.updated)}` : 'not updated yet'}</span>
          </span>
          <ConfirmToggle request={r} confirmation={bits.confirmations[r.key]} onToggle={bits.onConfirm} busy={bits.confirmBusy.has(r.key)} />
        </div>
      </div>
      <div className="flex items-center shrink-0">
        <button type="button" onClick={() => onMove(r.key, -1)} disabled={index === 0} aria-label={`Move ${r.name} up`}
          className="p-1 rounded text-ash hover:text-bone hover:bg-line disabled:opacity-30"><ChevronUp className="w-4 h-4" /></button>
        <button type="button" onClick={() => onMove(r.key, 1)} disabled={index === count - 1} aria-label={`Move ${r.name} down`}
          className="p-1 rounded text-ash hover:text-bone hover:bg-line disabled:opacity-30"><ChevronDown className="w-4 h-4" /></button>
        <button type="button" onClick={() => onRemove(r.key)} aria-label={`Take ${r.name}'s ${r.weapon} off the priority list`} title="Back to requests"
          className="p-1 rounded text-ash hover:text-oxblood hover:bg-line"><X className="w-4 h-4" /></button>
      </div>
    </li>
  );
}

export default function PriorityList({ rows, bits, hint, dropActive, onMove, onRemove, onFillByNeed, onClear, canFill }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'zone:priority' });
  const confirmed = rows.filter((r) => {
    const c = bits.confirmations[r.key];
    return c && r.need !== null && r.need !== undefined && c.need === r.need;
  }).length;
  // What the list adds up to, per shard type (shards.json order): how many
  // ranked weapons use it, what they still need, what they cost in full.
  const totals = SHARD_TYPES.map((t) => {
    const mine = rows.filter((r) => r.shard === t.key);
    return { key: t.key, label: t.label, count: mine.length, need: mine.reduce((a, r) => a + (r.need || 0), 0), cost: mine.reduce((a, r) => a + r.cost, 0) };
  }).filter((t) => t.count);
  const totalNeed = rows.reduce((a, r) => a + (r.need || 0), 0);

  return (
    <section
      ref={setNodeRef}
      className={`panel rounded-lg flex flex-col ${dropActive && isOver ? 'border-brass bg-panelup/40' : ''}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2 className="font-display text-base text-brassbright tracking-[0.06em] flex items-center gap-2">
            <ListOrdered className="w-4 h-4" /> Combined priority
          </h2>
          <span className="text-xs text-ash">{rows.length} ranked · <span className="text-sky-700 dark:text-sky-300">{confirmed} confirmed</span></span>
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={onFillByNeed} disabled={!canFill} className="text-xs text-ash hover:text-bone px-2 py-1 disabled:opacity-40">Add the rest by need</button>
          <button type="button" onClick={onClear} disabled={!rows.length} className="text-xs text-ash hover:text-oxblood px-2 py-1 disabled:opacity-40">Clear</button>
        </div>
      </div>
      <p className="px-4 text-xs text-ash">PvP and PvE across every shard. #1 gets the next shard.</p>

      {rows.length > 0 && (
        <div className="mx-3 mt-3 bg-hall border border-line rounded-md px-3 py-2.5 space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="eyebrow text-[10px] text-brass">Shards needed</span>
            <span className="text-xs text-ash"><span className="font-mono text-bone">{totalNeed}</span> total</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {totals.map((t) => (
              <span key={t.key} title={`${t.count} ranked weapon${t.count === 1 ? '' : 's'} still need ${t.need} ${t.label}`}
                className="inline-flex items-center gap-2 bg-panel border border-line rounded-md pl-2.5 pr-1 py-1 text-xs text-ash">
                <span className="text-bone/80">{t.label}</span>
                <span className="text-ash/70">× {t.count}</span>
                <span className="font-mono text-bone bg-panelup rounded px-1.5 py-0.5">{t.need}<span className="text-ash/50">/{t.cost}</span></span>
              </span>
            ))}
          </div>
        </div>
      )}

      <SortableContext items={rows.map((r) => `pri:${r.key}`)} strategy={verticalListSortingStrategy}>
        <ol className="p-3 space-y-1.5 min-h-[160px]">
          {rows.map((r, i) => (
            <Row key={r.key} r={r} index={i} count={rows.length} bits={bits} hint={hint} onMove={onMove} onRemove={onRemove} />
          ))}
          {rows.length === 0 && (
            <li className="border border-dashed border-line rounded-md p-6 text-center text-sm text-ash">
              <span className="block text-bone font-semibold mb-1">No priority set</span>
              Drag requests here, or press + on one.
            </li>
          )}
        </ol>
      </SortableContext>
      <p className="px-4 pb-3 text-[11px] text-ash/80">Members never see this list. Changes save as you go; nothing reaches Discord until you post.</p>
    </section>
  );
}
