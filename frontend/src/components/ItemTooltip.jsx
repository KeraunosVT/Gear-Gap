import { useState, useRef } from 'react';
import STATS from '../../../shared/stats.json';

const SUPABASE_ASSETS = 'https://yukrxjxaedioymfpaseu.supabase.co/storage/v1/object/public/assets';
const ICON_BG = `${SUPABASE_ASSETS}/loot-icons/bgs/BG_ItemGrade_04.webp`;

const GRADE = {
  11: { label: 'Common',    color: 'text-gray-400',   border: 'border-gray-500/50',  bg: 'bg-gray-500/10' },
  21: { label: 'Uncommon',  color: 'text-green-400',  border: 'border-green-500/50',  bg: 'bg-green-500/10' },
  31: { label: 'Rare',      color: 'text-blue-400',   border: 'border-blue-500/50',   bg: 'bg-blue-500/10' },
  41: { label: 'Epic',      color: 'text-purple-400', border: 'border-purple-500/50', bg: 'bg-purple-500/10', iconBg: true },
  51: { label: 'Legendary', color: 'text-amber-400',  border: 'border-amber-500/50',  bg: 'bg-amber-500/10', iconBg: true },
};

// Names and units both come from shared/stats.json, read here and by the
// questlog import, which bakes the same names and numbers into stored item
// descriptions — one table, so a tooltip and a description can't disagree about
// what a stat is called or what it's worth.
//
// A few stats are fixed-point: `skill_cooldown_modifier 210` means 2.1%
// Cooldown Speed, `hp_regen 110250` means 110.25 Health Regen. Anything with no
// divisor is flat and prints as-is.
function fmtStatValue(key, val) {
  // Guarded before coercion: Number(null) is 0, so a missing value would
  // otherwise render as a confident "0%" rather than as absent.
  if (val === null || val === undefined) return '—';
  const n = Number(val);
  if (!Number.isFinite(n)) return String(val);
  const scale = STATS[key];
  if (!scale || !scale.divisor) return n.toLocaleString();
  return (n / scale.divisor).toLocaleString(undefined, { maximumFractionDigits: 2 }) + (scale.suffix || '');
}

function statLabel(key) {
  return STATS[key]?.label || String(key || '').replace(/_/g, ' ');
}

export function gradeStyle(grade) {
  return GRADE[grade] || null;
}

export default function ItemTooltip({ item, children }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef(null);

  const hasTooltip = item?.image_url || item?.description || item?.questlog_data;
  const g = GRADE[item?.grade];

  const onEnter = (e) => {
    if (!hasTooltip) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const spaceRight = window.innerWidth - rect.right;
    setPos({
      x: spaceRight > 380 ? rect.right + 8 : rect.left - 368,
      y: Math.max(8, Math.min(rect.top, window.innerHeight - 400)),
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
        <GradeIcon src={item.image_url} grade={item.grade} size={36} />
      )}
      {children}
      {show && hasTooltip && (
        <div
          className={`fixed z-[100] w-[360px] panel rounded-lg shadow-2xl border ${g ? g.border : 'border-brass/40'} overflow-hidden`}
          style={{ left: pos.x, top: pos.y }}
        >
          <TooltipContent item={item} g={g} />
        </div>
      )}
    </div>
  );
}

// questlog keys stats by enhancement level, and the levels differ by grade:
// Epic gear runs 21–50, Legendary gear is a single entry at 75. These were
// hardcoded to '21' and '50', so every Legendary item looked up two levels it
// doesn't have and rendered no stats whatsoever — the exact items anyone opens
// a tooltip to look at. Read off the data instead.
function levelBounds(byLevel) {
  const levels = Object.keys(byLevel || {}).map(Number).filter(Number.isFinite);
  if (levels.length === 0) return { minLvl: null, maxLvl: null };
  return { minLvl: String(Math.min(...levels)), maxLvl: String(Math.max(...levels)) };
}

function TooltipContent({ item, g }) {
  const qd = item.questlog_data;

  const mainStats = qd?.itemStats?.main;
  const extraStats = qd?.itemStats?.extra;
  const passive = qd?.passiveAbility;
  const active = qd?.activeAbility;

  return (
    <div className="max-h-[380px] overflow-auto">
      {/* Header */}
      <div className={`flex items-start gap-3 p-4 ${g ? g.bg : ''}`}>
        {item.image_url && (
          <GradeIcon src={item.image_url} grade={item.grade} size={48} />
        )}
        <div className="min-w-0">
          <div className={`font-display tracking-wide text-sm ${g ? g.color : 'text-brassbright'}`}>{item.name}</div>
          <div className="flex items-center gap-2 mt-0.5">
            {g && <span className={`text-[10px] font-semibold ${g.color}`}>{g.label}</span>}
            {item.category && <span className="eyebrow text-[9px] text-ash">{item.category}</span>}
          </div>
        </div>
      </div>

      {/* Main stats. Bounds read per block — main and extra are keyed
          independently and there's no guarantee they span the same levels. */}
      {mainStats && (
        <div className="px-4 py-2.5 border-t border-line/50">
          <StatBlock stats={mainStats} {...levelBounds(mainStats)} />
        </div>
      )}

      {/* Extra stats */}
      {extraStats && (
        <div className="px-4 py-2.5 border-t border-line/50">
          <ExtraStatBlock stats={extraStats} {...levelBounds(extraStats)} />
        </div>
      )}

      {/* Passive ability */}
      {passive && (
        <div className="px-4 py-2.5 border-t border-line/50">
          <div className={`text-xs font-semibold mb-1 ${g ? g.color : 'text-brass'}`}>
            {passive.name || 'Passive'}
          </div>
          {passive.description && (
            <p className="text-ash text-[11px] leading-relaxed">{passive.description}</p>
          )}
        </div>
      )}

      {/* Active ability */}
      {active && (
        <div className="px-4 py-2.5 border-t border-line/50">
          <div className={`text-xs font-semibold mb-1 ${g ? g.color : 'text-brass'}`}>
            {active.name || 'Active'}
          </div>
          {active.description && (
            <p className="text-ash text-[11px] leading-relaxed">{active.description}</p>
          )}
        </div>
      )}

      {/* Description */}
      {item.description && (
        <div className="px-4 py-2.5 border-t border-line/50">
          <p className="text-ash/70 text-[11px] leading-relaxed italic">{item.description}</p>
        </div>
      )}
    </div>
  );
}

function extractStats(levelData) {
  const rows = [];
  if (!levelData || typeof levelData !== 'object') return rows;
  Object.entries(levelData).forEach(([group, val]) => {
    if (val === null || val === undefined) return;
    if (typeof val === 'number') {
      rows.push({ key: group, value: val });
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      Object.entries(val).forEach(([k, v]) => {
        if (k === 'statId' || v === null || v === undefined) return;
        if (typeof v === 'number') rows.push({ key: k, value: v });
      });
    }
  });
  return rows;
}

function StatBlock({ stats, minLvl, maxLvl }) {
  const loRows = extractStats(stats[minLvl]);
  const hiRows = extractStats(stats[maxLvl]);
  const loMap = {};
  loRows.forEach((r) => { loMap[r.key] = r.value; });
  const hiMap = {};
  hiRows.forEach((r) => { hiMap[r.key] = r.value; });
  const allKeys = [...new Set([...Object.keys(loMap), ...Object.keys(hiMap)])];

  // Keyed by stat id, not label: "Attack Range" and "Attack Speed" each label
  // two different stat ids, which as a React key collide into one row.
  const rows = allKeys.map((key) => ({
    key,
    label: statLabel(key),
    lo: loMap[key] ?? null,
    hi: hiMap[key] ?? null,
  }));

  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.key} className="flex justify-between text-[11px]">
          <span className="text-ash">{r.label}</span>
          <span className="text-bone font-mono">
            {r.lo != null && r.hi != null && r.lo !== r.hi
              ? `${fmtStatValue(r.key, r.lo)} – ${fmtStatValue(r.key, r.hi)}`
              : fmtStatValue(r.key, r.hi ?? r.lo)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ExtraStatBlock({ stats, minLvl, maxLvl }) {
  const minStats = stats[minLvl] || {};
  const maxStats = stats[maxLvl] || {};
  const allKeys = new Set([...Object.keys(minStats), ...Object.keys(maxStats)]);

  const rows = [];
  allKeys.forEach((key) => {
    rows.push({ key, label: statLabel(key), lo: minStats[key], hi: maxStats[key] });
  });

  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.key} className="flex justify-between text-[11px]">
          <span className="text-ash">{r.label}</span>
          <span className="text-emerald-400 font-mono">
            +{r.lo != null && r.hi != null && r.lo !== r.hi
              ? `${fmtStatValue(r.key, r.lo)} – ${fmtStatValue(r.key, r.hi)}`
              : fmtStatValue(r.key, r.hi ?? r.lo)}
          </span>
        </div>
      ))}
    </div>
  );
}

// Exported so currency icons can render identically — same grade backdrop,
// border and box — rather than reimplementing the layering and drifting from it.
export function GradeIcon({ src, grade, size = 36 }) {
  const g = GRADE[grade];
  const showBg = g?.iconBg;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {showBg && (
        <img src={ICON_BG} alt="" className="absolute inset-0 w-full h-full rounded object-cover" />
      )}
      <img src={src} alt=""
        className={`relative z-10 w-full h-full rounded object-cover border ${g ? g.border : 'border-line'}`} />
    </div>
  );
}

export function ItemIcon({ item, size = 36 }) {
  if (!item?.image_url) return null;
  return <GradeIcon src={item.image_url} grade={item.grade} size={size} />;
}
