import {
  DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Star, GripVertical, X } from 'lucide-react';
import { KIND_LABEL, KIND_CHIP, PVP_BASE, IN_YOUR_FAVOUR, fmtStat, shownValue, fullLabel, STAT } from '../../buildStats';

// Where a pinned stat comes from, under its number on the card.
function contextFor(id, stats) {
  const base = PVP_BASE[id];
  if (base) return `PvP total · ${fmtStat(base, stats?.[base])} + ${fmtStat(id, stats?.[id])}`;
  const panel = STAT[id]?.panel;
  return { boss: 'Boss bonus', pvp: 'PvP', status: 'Crowd control', basic: 'Basic', weapon: 'Weapon', combat: 'Combat' }[panel] || '';
}

function Card({ id, build, editable, onRemove }) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id, disabled: !editable });
  const stats = build?.stats || {};
  const value = shownValue(stats, id);
  const flag = build?.flags?.[id];
  const tone = flag ? 'text-oxblood' : IN_YOUR_FAVOUR.has(id) && value < 0 ? 'text-emerald-400' : 'text-bone';

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`panel rounded-lg py-3 pr-3 relative min-w-0 ${editable ? 'pl-8' : 'pl-4'} ${isDragging ? 'z-10 border-brass shadow-xl opacity-90' : ''}`}
    >
      {editable && (
        <button
          ref={setActivatorNodeRef} {...attributes} {...listeners} type="button"
          aria-label={`Move ${fullLabel(id)}. Press space, then the arrow keys.`}
          className="absolute left-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-ash hover:text-bone hover:bg-panelup cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical className="w-4 h-4" />
        </button>
      )}
      <div className="text-sm text-bone font-medium pr-5 truncate" title={fullLabel(id)}>{fullLabel(id)}</div>
      <div className={`font-display text-xl tabular-nums ${tone}`}>{fmtStat(id, value)}</div>
      <div className="text-xs text-ash truncate">{contextFor(id, stats)}{flag ? ' · check in game' : ''}</div>
      {editable && (
        <button type="button" onClick={() => onRemove(id)} aria-label={`Remove ${fullLabel(id)} from key stats`}
          className="absolute top-1.5 right-1.5 p-1 rounded text-ash hover:text-bone hover:bg-panelup">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

// The guild's pinned stats for one build type, at the top of every member's
// build. Officers with 'builds' add them by clicking values in the sheet, and
// drag them here into whatever order they want; everyone sees that order.
export default function KeyStats({ kind, ids, build, editable, onChange }) {
  // Pointer covers mouse and touch alike; the handle is `touch-none` so a drag
  // on a phone moves the card instead of scrolling the page.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    onChange(arrayMove(ids, ids.indexOf(active.id), ids.indexOf(over.id)));
  };

  return (
    <section>
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <h2 className="font-display text-bone text-lg tracking-[0.06em] flex items-center gap-2">
          <Star className="w-4 h-4 text-brass fill-brass" /> Key stats
          <span className={`text-[10px] font-bold tracking-wide rounded-full px-2 py-0.5 border ${KIND_CHIP[kind]}`}>{KIND_LABEL[kind]}</span>
        </h2>
        <span className="text-xs text-ash">
          {editable
            ? `Drag to reorder. Click any value below to add or remove it. The ${KIND_LABEL[kind === 'pve' ? 'pvp' : 'pve']} build has its own.`
            : 'Picked by your officers.'}
        </span>
      </div>
      {ids.length === 0 ? (
        <div className="border border-dashed border-line rounded-lg p-5 text-sm text-ash">
          {editable
            ? `No ${KIND_LABEL[kind]} key stats yet. Click a value in the tables below to pin it here for the whole guild.`
            : 'Your officers haven\'t picked any key stats yet.'}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {ids.map((id) => (
                <Card key={id} id={id} build={build} editable={editable} onRemove={(x) => onChange(ids.filter((i) => i !== x))} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}
