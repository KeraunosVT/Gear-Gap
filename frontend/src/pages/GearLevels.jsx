import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import Sigil from '../components/Sigil';
import { ArrowUp, ArrowDown, RefreshCw } from 'lucide-react';

const COLUMNS = [
  { key: 'display_name', label: 'Member', align: 'left' },
  { key: 'weapon', label: 'Weapon', align: 'right' },
  { key: 'armor', label: 'Armor', align: 'right' },
  { key: 'accessory', label: 'Accessory', align: 'right' },
  { key: 'average', label: 'Average', align: 'right' },
];

export default function GearLevels() {
  const { user } = useAuth();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [sortKey, setSortKey] = useState('average');
  const [sortDir, setSortDir] = useState('desc');

  const load = () => {
    setLoading(true); setError('');
    axios.get('/api/admin/gear-ilvl')
      .then((res) => setEntries(res.data.entries || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load gear levels.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const sortBy = (key) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir(key === 'display_name' ? 'asc' : 'desc'); }
  };

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const list = entries.filter((e) => (e.display_name || '').toLowerCase().includes(f));
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * dir;
      return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
    });
  }, [entries, filter, sortKey, sortDir]);

  if (!user?.isAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-24 text-center">
        <Sigil className="w-12 h-16 text-oxblood mx-auto mb-6" />
        <h1 className="font-display text-2xl text-bone tracking-[0.08em] mb-3">Restricted</h1>
        <p className="text-ash">The war table is open to officers of the house alone.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">War Table</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Gear Levels</h1>
      <p className="text-ash mt-2">Every member's submitted gear, highest item level per category.</p>
      <div className="rule-fade my-8" />

      <div className="flex flex-wrap items-center justify-between mb-5 gap-4">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
          className="bg-panel border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        <div className="flex items-center gap-4">
          {!loading && !error && <span className="text-sm text-ash">{rows.length} submitted</span>}
          <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {error ? (
        <div className="panel rounded-sm p-8 text-center">
          <p className="text-ash mb-6">{error}</p>
          <button onClick={load} className="px-6 py-2.5 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm">Try again</button>
        </div>
      ) : loading ? (
        <div className="py-20 text-center text-ash">Reading the vault…</div>
      ) : rows.length === 0 ? (
        <div className="py-20 text-center text-ash">No one has submitted their gear yet.</div>
      ) : (
        <div className="panel rounded-sm overflow-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line">
              <tr className="eyebrow text-[10px] text-ash whitespace-nowrap">
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
              {rows.map((e) => (
                <tr key={e.discord_id} className="border-b border-line/60 hover:bg-panelup transition-colors">
                  <td className="p-4 text-bone font-semibold">{e.display_name || 'Member'}</td>
                  <td className="p-4 text-right font-mono text-bone">{e.weapon || '—'}</td>
                  <td className="p-4 text-right font-mono text-bone">{e.armor || '—'}</td>
                  <td className="p-4 text-right font-mono text-bone">{e.accessory || '—'}</td>
                  <td className="p-4 text-right font-mono text-brassbright">{e.average || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
