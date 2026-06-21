import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { ArrowUp, ArrowDown } from 'lucide-react';

const fmt = (n) => (Number(n) || 0).toLocaleString();
const fmtM = (n) => ((Number(n) || 0) / 1e6).toFixed(1) + 'M';
const fmtAvg = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });

const COLUMNS = [
  { key: 'player_name',  label: 'Player',       align: 'left',  render: (p) => <Link to={`/roster/${encodeURIComponent(p.player_name)}`} className="hover:text-brassbright transition-colors">{p.player_name}</Link>, cls: 'font-semibold text-bone' },
  { key: 'matches',      label: 'Matches',      align: 'right', render: (p) => fmt(p.matches) },
  { key: 'kills',        label: 'Kills',        align: 'right', render: (p) => fmt(p.kills), cls: 'text-brassbright' },
  { key: 'assists',      label: 'Assists',      align: 'right', render: (p) => fmt(p.assists) },
  { key: 'ka',           label: 'K+A',          align: 'right', render: (p) => fmt(p.ka), cls: 'text-brassbright' },
  { key: 'damage_dealt', label: 'Dmg Dealt',    align: 'right', render: (p) => fmtM(p.damage_dealt) },
  { key: 'damage_taken', label: 'Dmg Taken',    align: 'right', render: (p) => fmtM(p.damage_taken) },
  { key: 'healing',      label: 'Healing',      align: 'right', render: (p) => fmtM(p.healing) },
  { key: 'avg_kills',    label: 'Avg Kills',    align: 'right', render: (p) => fmtAvg(p.avg_kills),   cls: 'text-brassbright' },
  { key: 'avg_assists',  label: 'Avg Assists',  align: 'right', render: (p) => fmtAvg(p.avg_assists) },
  { key: 'avg_dealt',    label: 'Avg Dmg',      align: 'right', render: (p) => fmtM(p.avg_dealt) },
  { key: 'avg_healing',  label: 'Avg Healing',  align: 'right', render: (p) => fmtM(p.avg_healing) },
];

export default function Roster() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState('kills');
  const [sortDir, setSortDir] = useState('desc');

  const fetchPlayers = () => {
    setLoading(true); setError(false);
    axios.get('/api/players')
      .then((res) => setPlayers((res.data.players || []).map((p) => {
        const m = Number(p.matches) || 0;
        const per = (v) => (m ? (Number(v) || 0) / m : 0);
        return {
          ...p,
          ka: (Number(p.kills) || 0) + (Number(p.assists) || 0),
          avg_kills: per(p.kills),
          avg_assists: per(p.assists),
          avg_dealt: per(p.damage_dealt),
          avg_healing: per(p.healing),
        };
      })))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchPlayers(); }, []);

  const sortBy = (key) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir(key === 'player_name' ? 'asc' : 'desc'); }
  };

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const list = players.filter((p) => (p.player_name || '').toLowerCase().includes(f));
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * dir;
      return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
    });
  }, [players, filter, sortKey, sortDir]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">The Roll</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Roster of the House</h1>
      <p className="text-ash mt-2">Every member's all-time record across every engagement.</p>
      <div className="rule-fade my-8" />

      <div className="flex items-center justify-between mb-5 gap-4">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
          className="bg-panel border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        {!loading && !error && <span className="text-sm text-ash shrink-0">{rows.length} members</span>}
      </div>

      {error ? (
        <div className="panel rounded-sm p-8 text-center">
          <div className="font-display text-oxblood tracking-wide text-lg mb-2">The roll is sealed</div>
          <p className="text-ash mb-6">The record couldn't be read. Try again.</p>
          <button onClick={fetchPlayers} className="px-6 py-2.5 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors">Try again</button>
        </div>
      ) : loading ? (
        <div className="py-20 text-center text-ash">Reading the roll…</div>
      ) : rows.length === 0 ? (
        <div className="py-20 text-center text-ash">No members on record yet.</div>
      ) : (
        <div className="panel rounded-sm overflow-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="border-b border-line">
              <tr className="eyebrow text-[10px] text-ash">
                <th className="p-4 text-center font-normal w-12">#</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className={`p-4 font-normal cursor-pointer hover:text-bone select-none ${c.align === 'right' ? 'text-right' : 'text-left'}`} onClick={() => sortBy(c.key)}>
                    <span className="inline-flex items-center gap-1">
                      {c.label}
                      {sortKey === c.key && (sortDir === 'desc' ? <ArrowDown className="w-3 h-3 text-brass" /> : <ArrowUp className="w-3 h-3 text-brass" />)}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <tr key={p.player_name + i} className="border-b border-line/60 hover:bg-panelup transition-colors">
                  <td className="p-4 text-center font-mono text-ash">{i + 1}</td>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className={`p-4 ${c.align === 'right' ? 'text-right font-mono' : ''} ${c.cls || 'text-bone'}`}>
                      {c.render(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
