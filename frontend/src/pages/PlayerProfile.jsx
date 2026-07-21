import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import weaponToClass from '../../../shared/weaponClasses.json';
import { ArrowLeft, Sword, Target, Heart, ShieldAlert, Trophy, TrendingUp, Shield, Gem, BarChart3 } from 'lucide-react';
import { PageShell, PageHeader } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import StatTile from '../components/ui/StatTile';

const fmt = (n) => (Number(n) || 0).toLocaleString();
const fmtM = (n) => ((Number(n) || 0) / 1e6).toFixed(1) + 'M';
const fmtAvg = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });

function getClassName(w1, w2) {
  if (!w1) return 'Unknown';
  const a = (w1 || '').trim(), b = (w2 || '').trim();
  let key = (a + b).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];
  key = (b + a).replace(/\s+/g, '');
  if (weaponToClass[key]) return weaponToClass[key];
  return `${a} ${b}`.trim() || 'Unknown';
}

export default function PlayerProfile() {
  const { name } = useParams();
  const [player, setPlayer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true); setError('');
    axios.get(`/api/player/${encodeURIComponent(name)}`)
      .then((res) => setPlayer(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not load player profile.'))
      .finally(() => setLoading(false));
  }, [name]);

  if (loading) return <div className="max-w-6xl mx-auto px-6 py-20 text-center text-ash">Reading the record…</div>;

  if (error) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-20 text-center">
        <div className="font-display text-oxblood tracking-wide text-lg mb-2">Player not found</div>
        <p className="text-ash mb-6">{error}</p>
        <Link to="/roster" className="text-brass hover:text-brassbright">← Back to Roster</Link>
      </div>
    );
  }

  if (!player) return null;

  const p = player;
  const m = p.matches || 1;

  const ka = (Number(p.kills) || 0) + (Number(p.assists) || 0);

  const ledger = [
    { label: 'Matches', value: fmt(p.matches), icon: <Trophy className="w-4 h-4" /> },
    { label: 'Kills', value: fmt(p.kills), icon: <Sword className="w-4 h-4" /> },
    { label: 'K+A', value: fmt(ka), icon: <Sword className="w-4 h-4" /> },
    { label: 'Damage Dealt', value: fmtM(p.damage_dealt), icon: <Target className="w-4 h-4" /> },
    { label: 'Healing', value: fmtM(p.healing), icon: <Heart className="w-4 h-4" /> },
  ];

  const averages = [
    { label: 'Avg Kills', value: fmtAvg(p.avg_kills) },
    { label: 'Avg Assists', value: fmtAvg(p.avg_assists) },
    { label: 'Avg Damage', value: fmtM(p.avg_damage) },
    { label: 'Avg Healing', value: fmtM(p.avg_healing) },
  ];

  return (
    <PageShell>
      {/* Back link */}
      <Link to="/roster" className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass mb-8 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Roster
      </Link>

      <PageHeader
        eyebrow="Player Profile"
        title={p.name}
        subtitle={p.aliases && p.aliases.length > 0 && (
          <>Also known as <span className="text-bone/70">{p.aliases.join(' · ')}</span></>
        )}
      />

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-10">
        {ledger.map((item) => (
          <StatTile key={item.label} icon={item.icon} value={item.value} label={item.label} />
        ))}
      </div>

      {/* Averages + Class breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-14">
        {/* Averages */}
        <div className="panel rounded-sm p-6">
          <h3 className="eyebrow text-[10px] text-brass mb-5">Per-Match Averages</h3>
          <div className="space-y-4 font-mono">
            {averages.map((a) => (
              <div key={a.label} className="flex justify-between items-baseline">
                <span className="font-sans text-ash text-sm">{a.label}</span>
                <span className="text-bone">{a.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Class breakdown */}
        <div className="panel rounded-sm p-6">
          <h3 className="eyebrow text-[10px] text-brass mb-5">Classes Played</h3>
          {p.classBreakdown.length > 0 ? (
            <div className="space-y-3">
              {p.classBreakdown.map((cls) => {
                const pct = Math.round((cls.count / p.matches) * 100);
                return (
                  <div key={cls.name}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-bone font-medium">{cls.name}</span>
                      <span className="font-mono text-ash">{cls.count} <span className="text-xs">({pct}%)</span></span>
                    </div>
                    <div className="h-1.5 bg-hall rounded-full overflow-hidden">
                      <div className="h-full bg-brass rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-ash text-sm">No class data.</p>
          )}
        </div>
      </div>

      {/* Gear Level */}
      {p.gear && (
        <div className="mb-14">
          <h3 className="font-display text-xl text-bone tracking-[0.08em] mb-5 flex items-center gap-3">
            <Shield className="w-5 h-5 text-brass" /> Gear Level
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Weapon', value: p.gear.weapon, icon: <Sword className="w-4 h-4" /> },
              { label: 'Armor', value: p.gear.armor, icon: <Shield className="w-4 h-4" /> },
              { label: 'Accessory', value: p.gear.accessory, icon: <Gem className="w-4 h-4" /> },
              { label: 'Average', value: p.gear.average, icon: <BarChart3 className="w-4 h-4" /> },
            ].map((g) => (
              <StatTile key={g.label} icon={g.icon} value={g.value || '—'} label={g.label} />
            ))}
          </div>
        </div>
      )}

      {/* Performance Trends */}
      {p.matchHistory.length >= 3 && <TrendSection history={p.matchHistory} />}

      {/* Match history */}
      <div>
        <h3 className="font-display text-xl text-bone tracking-[0.08em] mb-5 flex items-center gap-3">
          <Sword className="w-5 h-5 text-brass" /> Match History
        </h3>
        <div className="panel rounded-sm overflow-auto max-h-[620px]">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="sticky top-0 bg-panelup border-b border-line">
              <tr className="eyebrow text-[10px] text-ash">
                <th className="text-left p-4 font-normal">Date</th>
                <th className="text-left p-4 font-normal">Match</th>
                <th className="text-left p-4 font-normal">Class</th>
                <th className="text-center p-4 font-normal">Rank</th>
                <th className="text-center p-4 font-normal">Kills</th>
                <th className="text-center p-4 font-normal">Assists</th>
                <th className="text-center p-4 font-normal">Dmg Dealt</th>
                <th className="text-center p-4 font-normal">Dmg Taken</th>
                <th className="text-center p-4 font-normal">Healing</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {p.matchHistory.map((h, i) => (
                <tr key={i} className="border-b border-line/60 hover:bg-panelup transition-colors">
                  <td className="p-4 font-sans text-ash">
                    {h.match_date ? new Date(h.match_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                  </td>
                  <td className="p-4 font-sans text-bone">
                    <Link to={`/war-record?match=${h.match_id}`} className="hover:text-brassbright transition-colors">
                      {h.title || 'Wargame'}
                    </Link>
                  </td>
                  <td className="p-4 font-sans font-medium text-brassbright">{getClassName(h.weapon_1, h.weapon_2)}</td>
                  <td className="p-4 text-center text-brass">{h.rank || '—'}</td>
                  <td className="p-4 text-center text-brassbright">{h.kills}</td>
                  <td className="p-4 text-center text-bone">{h.assists}</td>
                  <td className="p-4 text-center text-bone">{fmtM(h.damage_dealt)}</td>
                  <td className="p-4 text-center text-bone">{fmtM(h.damage_taken)}</td>
                  <td className="p-4 text-center text-bone">{fmtM(h.healing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </PageShell>
  );
}

/* ── Performance Trends ──────────────────────────────────────── */

function rollingAvg(values, window = 3) {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

function TrendSection({ history }) {
  const chronological = useMemo(() => [...history].reverse(), [history]);

  const trends = useMemo(() => [
    { label: 'Kills', field: 'kills', color: '#c9973a', format: (v) => v.toFixed(0), icon: <Sword className="w-4 h-4" /> },
    { label: 'Damage Dealt', field: 'damage_dealt', color: '#e2c07a', format: (v) => (v / 1e6).toFixed(1) + 'M', icon: <Target className="w-4 h-4" /> },
    { label: 'Healing', field: 'healing', color: '#4ade80', format: (v) => (v / 1e6).toFixed(1) + 'M', icon: <Heart className="w-4 h-4" /> },
  ], []);

  return (
    <div className="mb-14">
      <h3 className="font-display text-xl text-bone tracking-[0.08em] mb-5 flex items-center gap-3">
        <TrendingUp className="w-5 h-5 text-brass" /> Performance Trends
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {trends.map((t) => {
          const values = chronological.map((h) => Number(h[t.field]) || 0);
          const avg = rollingAvg(values);
          const latest = values[values.length - 1];
          const prevAvg = avg.length >= 2 ? avg[avg.length - 2] : latest;
          const delta = latest - prevAvg;
          return (
            <div key={t.field} className="panel rounded-sm p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-ash text-sm">
                  <span style={{ color: t.color }}>{t.icon}</span>
                  {t.label}
                </div>
                <div className="text-right">
                  <span className="font-mono text-bone text-lg">{t.format(latest)}</span>
                  {Math.abs(delta) > 0.01 && (
                    <span className={`ml-2 text-xs font-mono ${delta > 0 ? 'text-emerald-400' : 'text-oxblood'}`}>
                      {delta > 0 ? '▲' : '▼'} {t.format(Math.abs(delta))}
                    </span>
                  )}
                </div>
              </div>
              <Sparkline values={values} avg={avg} color={t.color} />
              <div className="flex justify-between text-[10px] text-ash mt-1.5 font-mono">
                <span>{chronological[0]?.match_date ? new Date(chronological[0].match_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}</span>
                <span>{chronological[chronological.length - 1]?.match_date ? new Date(chronological[chronological.length - 1].match_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Sparkline({ values, avg, color, height = 56 }) {
  const w = 200;
  const pad = 2;
  if (values.length < 2) return null;

  const allVals = [...values, ...avg];
  const max = Math.max(...allVals);
  const min = Math.min(...allVals);
  const range = max - min || 1;

  const x = (i) => pad + (i / (values.length - 1)) * (w - pad * 2);
  const y = (v) => pad + (1 - (v - min) / range) * (height - pad * 2);

  const linePath = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  const avgPath = avg.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ');
  const fillPath = `${linePath} L${x(values.length - 1)},${height} L${x(0)},${height} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={`fill-${color.replace('#', '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={fillPath} fill={`url(#fill-${color.replace('#', '')})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeOpacity="0.5" />
      <path d={avgPath} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {values.map((v, i) => (
        <circle key={i} cx={x(i)} cy={y(v)} r="2.5" fill={i === values.length - 1 ? color : 'transparent'} stroke={color} strokeWidth="1" strokeOpacity="0.4" />
      ))}
    </svg>
  );
}
