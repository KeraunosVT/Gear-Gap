import { useState, useRef } from 'react';

const GRADE = {
  11: { label: 'Common',    color: 'text-gray-400',   border: 'border-gray-500/50',  bg: 'bg-gray-500/10' },
  21: { label: 'Uncommon',  color: 'text-green-400',  border: 'border-green-500/50',  bg: 'bg-green-500/10' },
  31: { label: 'Rare',      color: 'text-blue-400',   border: 'border-blue-500/50',   bg: 'bg-blue-500/10' },
  41: { label: 'Epic',      color: 'text-purple-400', border: 'border-purple-500/50', bg: 'bg-purple-500/10' },
  51: { label: 'Legendary', color: 'text-amber-400',  border: 'border-amber-500/50',  bg: 'bg-amber-500/10' },
};

const STAT_LABELS = {
  str: 'Strength', dex: 'Dexterity', int: 'Intelligence', per: 'Perception', wis: 'Wisdom',
  hp_max: 'Max HP', cost_max: 'Max Mana', hp_regen: 'HP Regen', cost_regen: 'Mana Regen',
  all_accuracy: 'Accuracy', all_critical_attack: 'Critical Hit', all_double_attack: 'Double Attack',
  attack_speed_modifier: 'Attack Speed', skill_cooldown_modifier: 'Cooldown Speed',
  stun_accuracy: 'Stun Accuracy', bind_accuracy: 'Bind Accuracy', weaken_accuracy: 'Weaken Accuracy',
  collide_amplification: 'Collision Amp', skill_power_amplification: 'Skill Power',
  buff_given_duration_modifier: 'Buff Duration', magic_armor: 'Magic Defense',
  physical_armor: 'Physical Defense',
};

function fmtStat(key, val) {
  const label = STAT_LABELS[key] || key.replace(/_/g, ' ');
  return { label, value: typeof val === 'number' ? val.toLocaleString() : String(val) };
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
        <img src={item.image_url} alt=""
          className={`w-9 h-9 rounded object-cover shrink-0 border ${g ? g.border : 'border-line'}`} />
      )}
      {children}
      {show && hasTooltip && (
        <div
          className={`fixed z-[100] w-[360px] panel rounded-sm shadow-2xl border ${g ? g.border : 'border-brass/40'} overflow-hidden`}
          style={{ left: pos.x, top: pos.y }}
        >
          <TooltipContent item={item} g={g} />
        </div>
      )}
    </div>
  );
}

function TooltipContent({ item, g }) {
  const qd = item.questlog_data;
  const maxLvl = '50';
  const minLvl = '21';

  const mainStats = qd?.itemStats?.main;
  const extraStats = qd?.itemStats?.extra;
  const passive = qd?.passiveAbility;
  const active = qd?.activeAbility;

  return (
    <div className="max-h-[380px] overflow-auto">
      {/* Header */}
      <div className={`flex items-start gap-3 p-4 ${g ? g.bg : ''}`}>
        {item.image_url && (
          <img src={item.image_url} alt=""
            className={`w-12 h-12 rounded object-cover shrink-0 border ${g ? g.border : 'border-line'}`} />
        )}
        <div className="min-w-0">
          <div className={`font-display tracking-wide text-sm ${g ? g.color : 'text-brassbright'}`}>{item.name}</div>
          <div className="flex items-center gap-2 mt-0.5">
            {g && <span className={`text-[10px] font-semibold ${g.color}`}>{g.label}</span>}
            {item.category && <span className="eyebrow text-[9px] text-ash">{item.category}</span>}
          </div>
        </div>
      </div>

      {/* Main stats */}
      {mainStats && (
        <div className="px-4 py-2.5 border-t border-line/50">
          <StatBlock stats={mainStats} minLvl={minLvl} maxLvl={maxLvl} />
        </div>
      )}

      {/* Extra stats */}
      {extraStats && (
        <div className="px-4 py-2.5 border-t border-line/50">
          <ExtraStatBlock stats={extraStats} minLvl={minLvl} maxLvl={maxLvl} />
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

function StatBlock({ stats, minLvl, maxLvl }) {
  const minStats = stats[minLvl] || {};
  const maxStats = stats[maxLvl] || {};
  const allKeys = new Set([...Object.keys(minStats), ...Object.keys(maxStats)]);

  const rows = [];
  allKeys.forEach((group) => {
    const minGroup = minStats[group] || {};
    const maxGroup = maxStats[group] || {};
    const keys = new Set([...Object.keys(minGroup), ...Object.keys(maxGroup)]);
    keys.forEach((key) => {
      const lo = minGroup[key];
      const hi = maxGroup[key];
      const s = fmtStat(key, hi ?? lo);
      rows.push({ label: s.label, lo, hi });
    });
  });

  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between text-[11px]">
          <span className="text-ash">{r.label}</span>
          <span className="text-bone font-mono">
            {r.lo != null && r.hi != null && r.lo !== r.hi
              ? `${Number(r.lo).toLocaleString()} – ${Number(r.hi).toLocaleString()}`
              : Number(r.hi ?? r.lo).toLocaleString()}
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
    const lo = minStats[key];
    const hi = maxStats[key];
    const s = fmtStat(key, hi ?? lo);
    rows.push({ label: s.label, lo, hi });
  });

  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.label} className="flex justify-between text-[11px]">
          <span className="text-ash">{r.label}</span>
          <span className="text-emerald-400 font-mono">
            +{r.lo != null && r.hi != null && r.lo !== r.hi
              ? `${Number(r.lo).toLocaleString()} – ${Number(r.hi).toLocaleString()}`
              : Number(r.hi ?? r.lo).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ItemIcon({ item, size = 36 }) {
  if (!item?.image_url) return null;
  const g = GRADE[item?.grade];
  return (
    <img
      src={item.image_url} alt={item.name || ''}
      className={`rounded object-cover shrink-0 border ${g ? g.border : 'border-line'}`}
      style={{ width: size, height: size }}
    />
  );
}
