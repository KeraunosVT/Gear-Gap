import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { RefreshCw } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { Table, Thead, SortableTh, Tr } from '../components/ui/Table';

const MAX_LEVEL = 80;
const isMaxed = (e) => e.weapon === MAX_LEVEL && e.armor === MAX_LEVEL && e.accessory === MAX_LEVEL;

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
      // Members who've hit 80/80/80 keep a fixed order among themselves —
      // first to achieve it ranks first — instead of being reshuffled every
      // time they're tied at the cap.
      if (sortKey === 'average' && isMaxed(a) && isMaxed(b)) {
        return new Date(a.maxed_at || 0) - new Date(b.maxed_at || 0);
      }
      const va = a[sortKey], vb = b[sortKey];
      if (typeof va === 'string' || typeof vb === 'string') return String(va || '').localeCompare(String(vb || '')) * dir;
      return ((Number(va) || 0) - (Number(vb) || 0)) * dir;
    });
  }, [entries, filter, sortKey, sortDir]);

  if (!user?.isAdmin) {
    return <RestrictedGate />;
  }

  return (
    <PageShell maxWidth="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between mb-5 gap-4">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
          className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        <div className="flex items-center gap-4">
          {!loading && !error && <span className="text-sm text-ash">{rows.length} submitted</span>}
          <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <EmptyState>Reading the vault…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>No one has submitted their gear yet.</EmptyState>
      ) : (
        <Table maxHeight="max-h-[70vh]">
          <Thead sticky>
            {COLUMNS.map((c) => (
              <SortableTh key={c.key} label={c.label} sortKey={c.key} activeKey={sortKey} dir={sortDir} onSort={sortBy} align={c.align} />
            ))}
          </Thead>
          <tbody>
            {rows.map((e) => (
              <Tr key={e.discord_id}>
                <td className="p-4 text-bone font-semibold">{e.display_name || 'Member'}</td>
                <td className="p-4 text-right font-mono text-bone">{e.weapon || '—'}</td>
                <td className="p-4 text-right font-mono text-bone">{e.armor || '—'}</td>
                <td className="p-4 text-right font-mono text-bone">{e.accessory || '—'}</td>
                <td className="p-4 text-right font-mono text-brassbright">{e.average || '—'}</td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </PageShell>
  );
}
