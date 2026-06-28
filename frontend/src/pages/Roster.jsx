import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { ArrowUp, ArrowDown } from 'lucide-react';

const fmt = (n) => (Number(n) || 0).toLocaleString();
const fmtM = (n) => ((Number(n) || 0) / 1e6).toFixed(1) + 'M';
const fmtAvg = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });

const PLAYER_COL = { key: 'player_name', label: 'Player', align: 'left', render: (p) => <Link to={`/roster/${encodeURIComponent(p.player_name)}`} className={`hover:text-brassbright transition-colors ${p.is_member ? 'text-emerald-400' : 'text-ash'}`}>{p.player_name}</Link>, cls: 'font-semibold' };
const MATCHES_COL = { key: 'matches', label: 'Matches', align: 'right', render: (p) => fmt(p.matches) };

const TABS = {
  totals: {
    label: 'Totals',
    columns: [
      PLAYER_COL,
      MATCHES_COL,
      { key: 'kills',        label: 'Kills',     align: 'right', render: (p) => fmt(p.kills), cls: 'text-brassbright' },
      { key: 'assists',      label: 'Assists',   align: 'right', render: (p) => fmt(p.assists) },
      { key: 'ka',           label: 'K+A',       align: 'right', render: (p) => fmt(p.ka), cls: 'text-brassbright' },
      { key: 'damage_dealt', label: 'Dmg Dealt', align: 'right', render: (p) => fmtM(p.damage_dealt) },
      { key: 'damage_taken', label: 'Dmg Taken', align: 'right', render: (p) => fmtM(p.damage_taken) },
      { key: 'healing',      label: 'Healing',   align: 'right', render: (p) => fmtM(p.healing) },
    ],
    defaultSort: 'kills',
  },
  averages: {
    label: 'Averages',
    columns: [
      PLAYER_COL,
      MATCHES_COL,
      { key: 'avg_kills',   label: 'Avg Kills',   align: 'right', render: (p) => fmtAvg(p.avg_kills), cls: 'text-brassbright' },
      { key: 'avg_assists', label: 'Avg Assists',  align: 'right', render: (p) => fmtAvg(p.avg_assists) },
      { key: 'avg_ka',      label: 'Avg K+A',      align: 'right', render: (p) => fmtAvg(p.avg_ka), cls: 'text-brassbright' },
      { key: 'avg_dealt',   label: 'Avg Dmg',      align: 'right', render: (p) => fmtM(p.avg_dealt) },
      { key: 'avg_taken',   label: 'Avg Dmg Taken', align: 'right', render: (p) => fmtM(p.avg_taken) },
      { key: 'avg_healing', label: 'Avg Healing',  align: 'right', render: (p) => fmtM(p.avg_healing) },
    ],
    defaultSort: 'avg_kills',
  },
};

export default function Roster() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState('');
  const [membersOnly, setMembersOnly] = useState(true);
  const [tab, setTab] = useState('totals');
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
          avg_ka: per((Number(p.kills) || 0) + (Number(p.assists) || 0)),
          avg_dealt: per(p.damage_dealt),
          avg_taken: per(p.damage_taken),
          avg_healing: per(p.healing),
        };
      })))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchPlayers(); }, []);

  const switchTab = (key) => {
    setTab(key);
    setSortKey(TABS[key].defaultSort);
    setSortDir('desc');
  };

  const sortBy = (key) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir(key === 'player_name' ? 'asc' : 'desc'); }
  };

  const columns = TABS[tab].columns;

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const list = players.filter((p) => (p.player_name || '').toLowerCase().includes(f) && (!membersOnly || p.is_member));
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * dir;
      return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
    });
  }, [players, filter, sortKey, sortDir, membersOnly]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">The Roll</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Roster of the House</h1>
      <p className="text-ash mt-2">Every member's all-time record across every engagement.</p>
      <div className="rule-fade my-8" />

      <div className="flex flex-wrap items-center justify-between mb-5 gap-4">
        <div className="flex items-center gap-4">
          <input
            value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
            className="bg-panel border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
          />
          <button onClick={() => setMembersOnly((v) => !v)}
            className="inline-flex items-center gap-0 rounded-full border border-line bg-hall p-0.5 cursor-pointer shrink-0" title="Toggle current members only">
            <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${membersOnly ? 'bg-emerald-500 text-ink' : 'text-ash'}`}>Members</span>
            <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${!membersOnly ? 'bg-brass text-ink' : 'text-ash'}`}>All</span>
          </button>
          <div className="flex gap-1">
            {Object.entries(TABS).map(([key, t]) => (
              <button key={key} onClick={() => switchTab(key)}
                className={`px-4 py-2 rounded-sm text-sm font-medium transition-colors ${tab === key ? 'bg-panel text-brassbright' : 'text-ash hover:text-bone'}`}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
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
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr className="eyebrow text-[10px] text-ash whitespace-nowrap">
                <th className="p-4 text-center font-normal w-12">#</th>
                {columns.map((c) => (
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
                  {columns.map((c) => (
                    <td key={c.key} className={`p-4 whitespace-nowrap ${c.align === 'right' ? 'text-right font-mono' : ''} ${c.cls || 'text-bone'}`}>
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
