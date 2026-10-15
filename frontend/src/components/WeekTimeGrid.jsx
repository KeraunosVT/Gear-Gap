import { daySlot } from '../timeUtils';

// ── A WEEK, LAID OUT ON TIME ────────────────────────────────────────────────
// Seven columns of guild nights with time running down the side. Shared by the
// Event Calendar and My Attendance, which put different things in the cells
// but must agree on where a time sits.
//
// Time runs down in guild-night slots (daySlot), not clock hours, so a 12:30am
// event sits at the bottom of the night it belongs to instead of at the top of
// the next column. Items have no stored length; every block is drawn as
// BLOCK_MIN long, which is also what decides whether two of them overlap.
//
// The grid only places things. What a block looks like is the caller's:
// `renderItem(item, { date, fill })` draws one, `fill` true when it is sized
// by the grid (timed) and false in the "any time" strip (untimed).
//
//   columns   [{ date: 'YYYY-MM-DD', items: [{ key, eventTime: 'HH:MM' | null, ... }] }]
//   today     the guild night to highlight
//   nowSlot   where the red now-line goes in today's column; null for none
//   footer    anything under the grid — a legend, usually
const HOUR_PX = 52;
const BLOCK_MIN = 30;
const DEFAULT_RANGE = [18 * 60, 24 * 60]; // 6pm–midnight when nothing is timed

const shortDay = (dateStr) =>
  new Date(`${dateStr}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });

function hourLabel(slot) {
  const h = Math.floor(slot / 60) % 24;
  return `${h % 12 || 12}${h >= 12 ? 'pm' : 'am'}`;
}

// Side-by-side lanes for blocks that would otherwise sit on top of each other.
// Greedy per cluster of overlapping blocks: each takes the first free lane,
// and every block in the cluster is narrowed to the cluster's lane count.
function layoutLanes(items) {
  const out = [];
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds = [];
    const placed = cluster.map((it) => {
      let lane = laneEnds.findIndex((end) => end <= it.slot);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = it.slot + BLOCK_MIN;
      return { ...it, lane };
    });
    placed.forEach((p) => out.push({ ...p, lanes: laneEnds.length }));
    cluster = [];
  };
  [...items].sort((a, b) => a.slot - b.slot).forEach((it) => {
    if (cluster.length && it.slot >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.slot + BLOCK_MIN);
  });
  if (cluster.length) flush();
  return out;
}

export default function WeekTimeGrid({ columns, today, nowSlot = null, renderItem, footer = null }) {
  // Only the hours that hold something, an hour either side. A full 24-hour
  // column is mostly empty scrolling for a guild that plays in the evening.
  const slots = columns.flatMap((c) => c.items.filter((it) => it.eventTime).map((it) => daySlot(it.eventTime)));
  const [lo, hi] = slots.length ? [Math.min(...slots), Math.max(...slots) + BLOCK_MIN] : DEFAULT_RANGE;
  const start = Math.max(0, Math.floor(lo / 60) * 60 - 60);
  const end = Math.ceil(hi / 60) * 60 + 60;
  const hours = Array.from({ length: (end - start) / 60 }, (_, i) => start + i * 60);
  const height = ((end - start) / 60) * HOUR_PX;
  const anyUntimed = columns.some((c) => c.items.some((it) => !it.eventTime));

  return (
    <div className="panel rounded-lg overflow-hidden">
      <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))]">
        {/* Header row */}
        <div className="border-b border-line" />
        {columns.map((c) => (
          <div
            key={c.date}
            className={`border-b border-l border-line px-2 py-2 text-center text-sm ${c.date === today ? 'text-brass font-semibold' : c.date < today ? 'text-ash/50' : 'text-bone'}`}
          >
            {shortDay(c.date)}
          </div>
        ))}

        {/* Items with no time can't be placed on the axis; they get a strip
            of their own rather than being guessed into a slot. */}
        {anyUntimed && (
          <>
            <div className="border-b border-line text-[10px] text-ash/60 px-1 py-1.5 text-right">any time</div>
            {columns.map((c) => (
              <div key={c.date} className={`border-b border-l border-line p-1 space-y-1 ${c.date === today ? 'bg-brass/5' : ''}`}>
                {c.items.filter((it) => !it.eventTime).map((it) => (
                  <div key={it.key}>{renderItem(it, { date: c.date, fill: false })}</div>
                ))}
              </div>
            ))}
          </>
        )}

        {/* Hour gutter */}
        <div className="relative" style={{ height }}>
          {hours.map((h, i) => (
            <div key={h} className="absolute right-1.5 text-[11px] text-ash/70 -translate-y-1/2" style={{ top: i * HOUR_PX }}>
              {i === 0 ? '' : hourLabel(h)}
            </div>
          ))}
        </div>

        {columns.map((c) => {
          const placed = layoutLanes(c.items.filter((it) => it.eventTime).map((it) => ({ item: it, slot: daySlot(it.eventTime) })));
          const isToday = c.date === today;
          return (
            <div key={c.date} className={`relative border-l border-line ${isToday ? 'bg-brass/5' : ''}`} style={{ height }}>
              {hours.map((h, i) => (
                <div key={h} className="absolute inset-x-0 border-t border-line/60" style={{ top: i * HOUR_PX }} />
              ))}
              {placed.map(({ item, slot, lane, lanes }) => (
                <div
                  key={item.key}
                  className="absolute px-0.5"
                  style={{
                    top: ((slot - start) / 60) * HOUR_PX + 1,
                    height: (BLOCK_MIN / 60) * HOUR_PX - 2,
                    left: `${(lane / lanes) * 100}%`,
                    width: `${100 / lanes}%`,
                  }}
                >
                  {renderItem(item, { date: c.date, fill: true })}
                </div>
              ))}
              {isToday && nowSlot != null && nowSlot >= start && nowSlot <= end && (
                <div className="absolute inset-x-0 h-px bg-oxblood pointer-events-none" style={{ top: ((nowSlot - start) / 60) * HOUR_PX }}>
                  <div className="absolute -left-1 -top-1 w-2 h-2 rounded-full bg-oxblood" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {footer && <div className="border-t border-line">{footer}</div>}
    </div>
  );
}
