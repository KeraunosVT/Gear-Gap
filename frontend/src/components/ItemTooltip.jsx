import { useState, useRef } from 'react';

export default function ItemTooltip({ item, children }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef(null);

  const hasTooltip = item?.image_url || item?.description;

  const onEnter = (e) => {
    if (!hasTooltip) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const spaceRight = window.innerWidth - rect.right;
    setPos({
      x: spaceRight > 320 ? rect.right + 8 : rect.left - 308,
      y: Math.min(rect.top, window.innerHeight - 200),
    });
    setShow(true);
  };

  return (
    <div
      ref={ref}
      onMouseEnter={onEnter}
      onMouseLeave={() => setShow(false)}
      className="inline-flex items-center gap-2"
    >
      {item?.image_url && (
        <img src={item.image_url} alt="" className="w-9 h-9 rounded border border-line object-cover shrink-0" />
      )}
      {children}
      {show && hasTooltip && (
        <div
          className="fixed z-[100] w-[300px] panel rounded-sm border border-brass/40 shadow-2xl p-4"
          style={{ left: pos.x, top: pos.y }}
        >
          <div className="flex items-start gap-3 mb-3">
            {item.image_url && (
              <img src={item.image_url} alt="" className="w-12 h-12 rounded border border-line object-cover shrink-0" />
            )}
            <div>
              <div className="font-display text-brassbright tracking-wide text-sm">{item.name}</div>
              {item.category && <div className="eyebrow text-[9px] text-ash mt-0.5">{item.category}</div>}
            </div>
          </div>
          {item.description && (
            <p className="text-ash text-xs leading-relaxed whitespace-pre-line">{item.description}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function ItemIcon({ item, size = 36 }) {
  if (!item?.image_url) return null;
  return (
    <img
      src={item.image_url} alt={item.name || ''}
      className="rounded border border-line object-cover shrink-0"
      style={{ width: size, height: size }}
    />
  );
}
