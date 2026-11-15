import { useDraggable, useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical, Plus } from 'lucide-react';
import { SHARD_LABEL } from '../../shardRules';
import { Avatar, AttendanceChip, BuildPill, ConfirmToggle, LootHover, agoText, daysAgo } from './MemberBits';

// The left side of the Priority tab: every request not yet ranked. By weapon,
// it reads like the By Weapon tab — a section per boss, a row per weapon —
// with PvP and PvE wanters side by side. By need, it's two flat lists.
//
// Drag ids: `req:<key>` for a member line (into the priority list),
// `wpn:<boss>|<weapon>` for a weapon row and `boss:<boss>` for a whole table
// (both reordered in place). The whole area is the `zone:requests` drop
// target, where a priority row is dropped to take it off the list.

const GRID = { gridTemplateColumns: 'minmax(170px, 1fr) minmax(240px, 1.6fr) minmax(240px, 1.6fr) 110px' };

function NeedText({ r }) {
  const stale = (daysAgo(r.updated) ?? 0) >= 30;
  return (
    <span className="text-[11px] text-ash">
      {r.need === null || r.need === undefined
        ? <span className="text-amber-600 dark:text-amber-400">need not set</span>
        : <>needs <span className="font-mono text-bone">{r.need}</span> of {r.cost}</>}
      <span className={stale ? 'text-amber-600 dark:text-amber-400' : ''}> · {r.updated ? `updated ${agoText(r.updated)}` : 'not updated yet'}{stale ? ' · stale' : ''}</span>
    </span>
  );
}

// One member wanting one weapon. The grip is the drag handle, so the
// checkbox, the name's hover card and + all keep their own clicks.
export function MemberLine({ r, bits, showWeapon = false, card = false }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `req:${r.key}`, data: { type: 'req', key: r.key } });
  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-2 rounded-md ${card ? 'bg-panelup border border-line px-1.5 py-2' : 'px-1 py-1 hover:bg-panelup/60'} ${isDragging ? 'opacity-40' : ''}`}
    >
      <button
        type="button" {...attributes} {...listeners}
        aria-label={`Drag ${r.name}'s ${r.weapon} into priority`}
        className="p-1 rounded text-ash hover:text-bone cursor-grab active:cursor-grabbing touch-none shrink-0"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      <Avatar member={r} size="xs" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <LootHover name={r.name} loot={bits.lootFor(r.discordId)} days={bits.lootDays} />
          {card && <BuildPill build={r.build} />}
          <AttendanceChip att={bits.attendanceFor(r.discordId)} days={bits.attendanceDays} />
        </div>
        {showWeapon && (
          <div className="text-xs text-ash truncate">{SHARD_LABEL.get(r.shard)} · {r.weapon}</div>
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <NeedText r={r} />
          <ConfirmToggle request={r} confirmation={bits.confirmations[r.key]} onToggle={bits.onConfirm} busy={bits.confirmBusy.has(r.key)} />
        </div>
      </div>
      <button
        type="button" onClick={() => bits.onAdd(r.key)}
        aria-label={`Add ${r.name}'s ${r.weapon} to the end of the priority list`} title="Add to priority"
        className="p-1.5 rounded text-ash hover:text-bone hover:bg-panelup shrink-0"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
}

function WeaponRow({ boss, w, index, count, bits, onMove, onAddAll }) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: `wpn:${boss}|${w.weapon}`, data: { type: 'weapon', boss } });
  return (
    <div
      ref={setNodeRef} style={{ ...GRID, transform: CSS.Transform.toString(transform), transition }}
      className={`grid items-stretch border-t border-line/60 text-sm bg-panel ${isDragging ? 'relative z-10 shadow-xl ring-1 ring-brass' : ''}`}
    >
      <div className="flex items-start gap-1 py-2 pl-1.5 pr-3">
        <div className="flex flex-col items-center shrink-0">
          <button type="button" onClick={() => onMove(boss, w.weapon, -1)} disabled={index === 0}
            aria-label={`Move ${w.weapon} up`} className="p-0.5 rounded text-ash hover:text-bone disabled:opacity-30">
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button" ref={setActivatorNodeRef} {...attributes} {...listeners}
            aria-label={`Move ${w.weapon}, row ${index + 1} of ${count}. Press space, then the arrow keys.`}
            className="p-0.5 rounded text-ash hover:text-bone cursor-grab active:cursor-grabbing touch-none"
          >
            <GripVertical className="w-3.5 h-3.5" />
          </button>
          <button type="button" onClick={() => onMove(boss, w.weapon, 1)} disabled={index === count - 1}
            aria-label={`Move ${w.weapon} down`} className="p-0.5 rounded text-ash hover:text-bone disabled:opacity-30">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="min-w-0 pt-1">
          <div className="text-bone">{w.weapon}</div>
          <div className="text-xs text-ash mt-0.5">{SHARD_LABEL.get(w.shard)}</div>
          <div className="text-xs text-ash">{w.wants} request{w.wants === 1 ? '' : 's'}</div>
          <button type="button" onClick={() => onAddAll(w.all)}
            className="mt-1 inline-flex items-center gap-1 text-xs text-ash hover:text-brassbright">
            <Plus className="w-3 h-3" /> Add all to priority
          </button>
        </div>
      </div>
      {['PvP', 'PvE'].map((build) => (
        <div key={build} className="border-l border-line/60 px-2 py-1.5 space-y-0.5">
          {w[build].length === 0
            ? <div className="text-ash/50 px-1 py-1" aria-label={`No ${build} requests`}>—</div>
            : w[build].map((r) => <MemberLine key={r.key} r={r} bits={bits} />)}
        </div>
      ))}
      <div className="border-l border-line/60 px-4 py-3 text-right font-mono text-brassbright">
        {w.need}<span className="text-ash/50">/{w.total}</span>
      </div>
    </div>
  );
}

function BossSection({ g, index, count, open, onToggle, bits, onMoveBoss, onMoveWeapon, onAddAll }) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id: `boss:${g.boss}`, data: { type: 'boss' } });
  return (
    <section
      ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`space-y-2.5 rounded-lg ${isDragging ? 'relative z-20 ring-1 ring-brass bg-ink shadow-2xl' : ''}`}
    >
      <div className="flex items-center gap-0.5">
        <div className="flex items-center shrink-0">
          <button type="button" onClick={() => onMoveBoss(g.boss, -1)} disabled={index === 0}
            aria-label={`Move the ${g.boss} table up`} className="p-1 rounded text-ash hover:text-bone disabled:opacity-30">
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button" ref={setActivatorNodeRef} {...attributes} {...listeners}
            aria-label={`Move the ${g.boss} table, ${index + 1} of ${count}. Press space, then the arrow keys.`}
            className="p-1 rounded text-ash hover:text-bone cursor-grab active:cursor-grabbing touch-none"
          >
            <GripVertical className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => onMoveBoss(g.boss, 1)} disabled={index === count - 1}
            aria-label={`Move the ${g.boss} table down`} className="p-1 rounded text-ash hover:text-bone disabled:opacity-30">
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>
        <h3 className="flex-1 min-w-0">
          <button type="button" onClick={onToggle} aria-expanded={open}
            className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 rounded-md hover:bg-panel text-left">
            <ChevronDown className={`w-4 h-4 text-ash shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
            <span className="font-display text-lg text-brassbright tracking-[0.06em]">{g.boss}</span>
            <span className="text-xs text-ash">
              {g.weapons.length} weapon{g.weapons.length === 1 ? '' : 's'} wanted · <span className="font-mono text-bone">{g.need}</span> shards still needed · {g.cost} per weapon
            </span>
            <span className="ml-auto text-xs text-ash">{open ? 'Hide' : 'Show'}</span>
          </button>
        </h3>
      </div>
      {open && (
        <div className="panel rounded-lg overflow-x-auto">
          <div className="min-w-[780px]">
            <div style={GRID} className="grid items-center eyebrow text-[10px] text-ash">
              <div className="px-4 py-2.5">Weapon</div>
              <div className="px-3 py-2.5 border-l border-line/60 flex items-center gap-2"><BuildPill build="PvP" /> Members · att · need</div>
              <div className="px-3 py-2.5 border-l border-line/60 flex items-center gap-2"><BuildPill build="PvE" /> Members · att · need</div>
              <div className="px-4 py-2.5 border-l border-line/60 text-right">Needed / cost</div>
            </div>
            <SortableContext items={g.weapons.map((w) => `wpn:${g.boss}|${w.weapon}`)} strategy={verticalListSortingStrategy}>
              {g.weapons.map((w, i) => (
                <WeaponRow
                  key={w.weapon} boss={g.boss} w={w} index={i} count={g.weapons.length} bits={bits}
                  onMove={onMoveWeapon} onAddAll={onAddAll}
                />
              ))}
            </SortableContext>
          </div>
        </div>
      )}
    </section>
  );
}

export default function RequestTables({
  mode, onMode, groups, flat, counts, untagged, collapsed, onToggleBoss, onToggleAll,
  bits, onMoveBoss, onMoveWeapon, onAddAll, dropActive,
}) {
  const { setNodeRef, isOver } = useDroppable({ id: 'zone:requests' });
  const anyOpen = groups.some((g) => !collapsed.has(g.boss));
  return (
    <div
      ref={setNodeRef}
      className={`space-y-4 rounded-lg border ${dropActive && isOver ? 'border-brass' : 'border-transparent'}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="eyebrow text-[11px] text-bone">Requests</h2>
          <span className="text-xs text-ash">
            <span className="text-rose-600 dark:text-rose-400">{counts.PvP} PvP</span> · <span className="text-emerald-700 dark:text-emerald-400">{counts.PvE} PvE</span> not ranked
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {mode === 'weapon' && groups.length > 0 && (
            <button type="button" onClick={() => onToggleAll(anyOpen)} className="text-sm text-ash hover:text-brass">
              {anyOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          <div className="inline-flex items-center rounded-full border border-line bg-hall p-0.5" role="group" aria-label="Group requests">
            {[['weapon', 'By weapon'], ['need', 'By need']].map(([k, label]) => (
              <button key={k} type="button" onClick={() => onMode(k)} aria-pressed={mode === k}
                className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide ${mode === k ? 'bg-bone text-ink' : 'text-ash hover:text-bone'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {counts.PvP + counts.PvE === 0 ? (
        <div className="border border-dashed border-line rounded-lg p-6 text-center text-sm text-ash">
          {counts.total ? 'Everyone who asked is ranked.' : 'Nobody has linked a PvP or PvE weapon yet.'}
        </div>
      ) : mode === 'weapon' ? (
        <SortableContext items={groups.map((g) => `boss:${g.boss}`)} strategy={verticalListSortingStrategy}>
          <div className="space-y-4">
            {groups.map((g, i) => (
              <BossSection
                key={g.boss} g={g} index={i} count={groups.length} open={!collapsed.has(g.boss)}
                onToggle={() => onToggleBoss(g.boss)} bits={bits}
                onMoveBoss={onMoveBoss} onMoveWeapon={onMoveWeapon} onAddAll={onAddAll}
              />
            ))}
          </div>
        </SortableContext>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {['PvP', 'PvE'].map((build) => (
            <div key={build} className="panel rounded-lg p-2.5 space-y-1.5">
              <div className="flex items-center gap-2 px-1 pb-1">
                <BuildPill build={build} />
                <span className="text-xs text-ash">{flat[build].length} not ranked · most needed first</span>
              </div>
              {flat[build].length === 0
                ? <p className="text-sm text-ash px-1 py-4 text-center">Nobody left to rank.</p>
                : flat[build].map((r) => <MemberLine key={r.key} r={r} bits={bits} showWeapon card />)}
            </div>
          ))}
        </div>
      )}

      {untagged > 0 && (
        <p className="text-xs text-ash">
          <span className="text-amber-600 dark:text-amber-400">{untagged} linked weapon{untagged === 1 ? ' has' : 's have'} no build tag</span>, so {untagged === 1 ? "it isn't" : "they aren't"} shown here. Tag them PvP or PvE in By Member.
        </p>
      )}
    </div>
  );
}
