import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import weaponToClass from '../../../shared/weaponClasses.json';
import { ArrowLeft, Sword, Target, Heart, ShieldAlert, Trophy } from 'lucide-react';

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

  const ledger = [
    { label: 'Matches', value: fmt(p.matches), icon: <Trophy className="w-4 h-4" /> },
    { label: 'Kills', value: fmt(p.kills), icon: <Sword className="w-4 h-4" /> },
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
    <div className="max-w-6xl mx-auto px-6 py-12">
      {/* Back link */}
      <Link to="/roster" className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass mb-8 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Roster
      </Link>

      {/* Header */}
      <div className="mb-2">
        <div className="eyebrow text-brass text-[11px] mb-3">Player Profile</div>
        <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">{p.name}</h1>
        {p.aliases && p.aliases.length > 0 && (
          <p className="text-ash mt-2">
            Also known as <span className="text-bone/70">{p.aliases.join(' · ')}</span>
          </p>
        )}
      </div>
      <div className="rule-fade my-8" />

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
        {ledger.map((item) => (
          <div key={item.label} className="panel rounded-sm p-5 text-center">
            <div className="flex items-center justify-center gap-2 text-brass mb-3">{item.icon}</div>
            <div className="font-mono text-3xl text-brassbright tabular-nums">{item.value}</div>
            <div className="eyebrow text-[10px] text-ash mt-2">{item.label}</div>
          </div>
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
                    {h.match_date ? new Date(h.match_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
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
    </div>
  );
}
