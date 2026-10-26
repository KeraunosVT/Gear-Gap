import { Star } from 'lucide-react';
import {
  COMBAT, DAMAGE, CC, RESOURCES, HEALING, DMG, PVP_BASE, IN_YOUR_FAVOUR, baseOf, fmtStat, shownValue, fullLabel,
} from '../../buildStats';

// One stat. For an officer with 'builds' it is a toggle that pins it to the
// key stats; for everyone else it is just the number. PvP matrix stats (and
// Boss ones on a PvE build) show the total, with the bonus underneath.
function Value({ id, kind, build, picked, onToggle }) {
  if (!id) return <span className="text-ash/30 px-1.5">—</span>;
  const stats = build?.stats || {};
  const flag = build?.flags?.[id];
  const value = shownValue(stats, id, kind);
  const on = picked?.includes(id);
  const base = baseOf(id, kind);
  const bonus = PVP_BASE[id] ? 'PvP' : 'Boss';
  const tone = flag ? 'text-oxblood' : IN_YOUR_FAVOUR.has(id) && value < 0 ? 'text-emerald-400' : 'text-bone';

  const inner = (
    <>
      {flag && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" title={flag} />}
      <span className={`inline-grid justify-items-end leading-tight ${tone}`}>
        <span>{fmtStat(id, value)}</span>
        {base && stats[id] !== undefined && (
          <span className="text-[10px] text-ash" title={`${fmtStat(base, stats[base])} base + ${fmtStat(id, stats[id])} ${bonus}`}>+{fmtStat(id, stats[id])}</span>
        )}
      </span>
      <Star className={`w-3 h-3 shrink-0 ${on ? 'text-brass fill-brass' : onToggle ? 'text-transparent group-hover:text-ash/60' : 'text-transparent'}`} />
    </>
  );
  const cls = `inline-flex items-center justify-end gap-1.5 w-full px-1.5 py-1 rounded tabular-nums ${on ? 'bg-brass/10' : ''}`;
  if (!onToggle) return <span className={cls}>{inner}</span>;
  return (
    <button
      type="button" onClick={() => onToggle(id)} aria-pressed={on}
      title={`${on ? 'Remove from' : 'Add to'} key stats: ${fullLabel(id)}`}
      className={`${cls} group border border-transparent hover:border-line`}
    >
      {inner}
    </button>
  );
}

function Card({ title, note, children }) {
  return (
    <div className="panel rounded-lg overflow-hidden min-w-0">
      <div className="flex items-baseline justify-between gap-3 flex-wrap px-4 py-3 border-b border-line">
        <h3 className="font-display text-bone text-sm tracking-[0.06em]">{title}</h3>
        {note && <span className="text-xs text-ash">{note}</span>}
      </div>
      {children}
    </div>
  );
}

const th = 'px-3 py-2 text-[10px] eyebrow text-ash font-semibold text-right whitespace-nowrap';

export default function BuildSheet({ kind, build, picked, onToggle }) {
  const v = (id) => <Value id={id} kind={kind} build={build} picked={picked} onToggle={onToggle} />;
  // The group that matters most for this build gets the build's colour.
  const focus = (g) => (kind === 'pve' && g === 'boss' ? 'text-emerald-400' : kind === 'pvp' && g === 'pvp' ? 'text-oxblood' : 'text-bone');

  const list = (sections) => sections.map(([sub, ids]) => (
    <div key={sub || 'main'}>
      {sub && <div className="px-4 pt-2 pb-1 eyebrow text-[10px] text-ash bg-hall/50 border-t border-line">{sub}</div>}
      {ids.map((id) => (
        <div key={id} className="flex items-center justify-between gap-3 pl-4 pr-2 py-0.5 border-t border-line first:border-t-0 text-sm">
          <span className="text-bone">{fullLabel(id)}</span>
          <span className="shrink-0">{v(id)}</span>
        </div>
      ))}
    </div>
  ));

  return (
    <div className="space-y-6">
      <Card title="Combat" note={kind === 'pve'
        ? 'Boss columns are the total against bosses: base + Boss bonus. PvP columns are the total against players: base + PvP bonus.'
        : 'Boss columns are the bonus on top of base. PvP columns are the total against players: base + PvP bonus.'}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th />
                {[['base', 'Base'], ['boss', kind === 'pve' ? 'Boss total' : 'Boss'], ['pvp', 'PvP total']].map(([g, label], gi) => (
                  <th key={g} colSpan={3} className={`px-3 pt-2 text-[10px] eyebrow text-center ${gi ? 'border-l border-line' : ''} ${focus(g)}`}>{label}</th>
                ))}
              </tr>
              <tr>
                <th className={`${th} text-left`}>Stat</th>
                {[0, 1, 2].map((g) => DMG.map((d, i) => <th key={`${g}${d}`} className={`${th} ${g && !i ? 'border-l border-line' : ''}`}>{d}</th>))}
              </tr>
            </thead>
            <tbody>
              {COMBAT.map((r) => (
                <tr key={r.name} className="border-t border-line">
                  <th className="px-3 py-0.5 text-left font-medium text-bone whitespace-nowrap">{r.name}</th>
                  {['base', 'boss', 'pvp'].map((g, gi) => [0, 1, 2].map((i) => (
                    <td key={`${g}${i}`} className={`px-1 py-0.5 ${gi && !i ? 'border-l border-line' : ''}`}>{v(r[g]?.[i])}</td>
                  )))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Damage" note="Dealt vs. taken">
          <table className="w-full text-sm">
            <thead><tr><th className={`${th} text-left`}>Stat</th><th className={th}>Dealt</th><th className={th}>Taken</th></tr></thead>
            <tbody>
              {DAMAGE.map(([name, d, t]) => (
                <tr key={name} className="border-t border-line">
                  <th className="px-3 py-0.5 text-left font-medium text-bone">{name}</th>
                  <td className="px-1 py-0.5">{v(d)}</td>
                  <td className="px-1 py-0.5">{v(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Crowd Control" note="Chance vs. resistance">
          <table className="w-full text-sm">
            <thead><tr><th className={`${th} text-left`}>Effect</th><th className={th}>Chance</th><th className={th}>Resistance</th></tr></thead>
            <tbody>
              {CC.map((r) => (
                <tr key={r.name} className="border-t border-line">
                  <th className="px-3 py-0.5 text-left font-medium text-bone">{r.name}</th>
                  <td className="px-1 py-0.5">{v(r.chance)}</td>
                  <td className="px-1 py-0.5">{v(r.res)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Resources">
          <div className="flex items-center justify-between gap-3 pl-4 pr-3 py-1.5 text-sm">
            <span className="text-bone">Base Damage</span>
            <span className="tabular-nums text-bone">
              {fmtStat('min_damage', build?.stats?.min_damage)} – {fmtStat('max_damage', build?.stats?.max_damage)}
            </span>
          </div>
          <div className="border-t border-line">{list(RESOURCES)}</div>
        </Card>
        <Card title="Healing & Shields">{list(HEALING)}</Card>
      </div>

      <p className="text-xs text-ash/70 flex flex-wrap gap-x-5 gap-y-1">
        <span className="inline-flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> A value the scan wasn&apos;t sure about. Hover for details.</span>
        <span><span className="text-emerald-400">Green</span> marks a reduction in your favour, such as less PvP damage taken.</span>
      </p>
    </div>
  );
}
