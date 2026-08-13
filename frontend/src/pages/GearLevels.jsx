import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { RefreshCw, History, Image as ImageIcon, EyeOff } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { Table, Thead, SortableTh, Tr } from '../components/ui/Table';
import Modal from '../components/ui/Modal';
import { fmtDatetime } from '../timeUtils';

const MAX_LEVEL = 80;
const isMaxed = (e) => e.weapon === MAX_LEVEL && e.armor === MAX_LEVEL && e.accessory === MAX_LEVEL;

// Which screenshot produced a member's row. These are not the same measurement
// — the popup's maxima count Heroic items and the window's don't — so two rows
// sitting next to each other can be scored by different rules. Marking the
// window rows is the cheapest honest way to say so; an unmarked row is the
// long-standing default and needs no explaining.
const SOURCE_NOTE = {
  popup: 'From the Equipment Level popup — Heroic items counted',
  window: 'From the full equipment window — Heroic items excluded',
};

const COLUMNS = [
  { key: 'display_name', label: 'Member', align: 'left' },
  { key: 'weapon', label: 'Weapon', align: 'right' },
  { key: 'armor', label: 'Armor', align: 'right' },
  { key: 'accessory', label: 'Accessory', align: 'right' },
  { key: 'average', label: 'Average', align: 'right' },
  { key: 'maxed_at', label: 'Maxed', align: 'right' },
];

export default function GearLevels() {
  const { user, can } = useAuth();
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

  const guildAverage = useMemo(() => {
    if (entries.length === 0) return 0;
    return entries.reduce((sum, e) => sum + (Number(e.average) || 0), 0) / entries.length;
  }, [entries]);

  const [historyMember, setHistoryMember] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const openHistory = (entry) => {
    setHistoryMember(entry);
    setHistoryLoading(true);
    axios.get(`/api/admin/gear-ilvl/${entry.discord_id}/history`)
      .then((res) => setHistoryEntries(res.data.entries || []))
      .catch(() => setHistoryEntries([]))
      .finally(() => setHistoryLoading(false));
  };

  const [shotMember, setShotMember] = useState(null);
  const [shot, setShot] = useState(null);
  const [shotLoading, setShotLoading] = useState(false);
  const [shotError, setShotError] = useState('');

  // Fetched per-view rather than with the leaderboard. The image URL is a
  // signed one that expires in minutes, so handing out sixty of them on page
  // load would mean most had died before anyone clicked.
  const openShot = (entry) => {
    setShotMember(entry); setShot(null); setShotError('');
    setShotLoading(true);
    axios.get(`/api/gear-screenshot/${entry.discord_id}`)
      .then((res) => setShot(res.data.screenshot))
      .catch((err) => setShotError(err.response?.data?.error || 'Could not load that screenshot.'))
      .finally(() => setShotLoading(false));
  };

  if (!can('gear')) {
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
          {!loading && !error && (
            <>
              <span className="text-sm text-ash">Guild average <span className="text-brassbright font-mono">{guildAverage.toLocaleString(undefined, { maximumFractionDigits: 1 })}</span></span>
              <span className="text-sm text-ash">{rows.length} submitted</span>
            </>
          )}
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
            <th className="p-4 w-20"></th>
          </Thead>
          <tbody>
            {rows.map((e) => (
              <Tr key={e.discord_id}>
                <td className="p-4 text-bone font-semibold">
                  <span className="inline-flex items-center gap-2">
                    {e.display_name || 'Member'}
                    {e.source === 'window' && (
                      <span title={SOURCE_NOTE.window}
                        className="inline-flex items-center gap-1 text-[10px] eyebrow border border-brass/40 rounded-full px-1.5 py-0.5 text-brass">
                        <EyeOff className="w-2.5 h-2.5" />
                        {e.excluded_count > 0 ? `−${e.excluded_count}` : 'window'}
                      </span>
                    )}
                  </span>
                </td>
                <td className="p-4 text-right font-mono text-bone">{e.weapon || '—'}</td>
                <td className="p-4 text-right font-mono text-bone">{e.armor || '—'}</td>
                <td className="p-4 text-right font-mono text-bone">{e.accessory || '—'}</td>
                <td className="p-4 text-right font-mono text-brassbright">{e.average || '—'}</td>
                <td className="p-4 text-right text-ash text-xs">{e.maxed_at ? fmtDatetime(e.maxed_at) : '—'}</td>
                <td className="p-4">
                  <span className="flex items-center justify-center gap-2">
                    {/* Only offered when there is one — a button that reliably
                        says "nothing on file" is a button people stop trusting. */}
                    {e.has_screenshot && (
                      <button onClick={() => openShot(e)} className="text-ash hover:text-brass" title="View their equipment window">
                        <ImageIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={() => openHistory(e)} className="text-ash hover:text-brass" title="View submission history">
                      <History className="w-3.5 h-3.5" />
                    </button>
                  </span>
                </td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {historyMember && (
        <Modal onClose={() => setHistoryMember(null)} maxWidth="max-w-lg" scrollable>
          <div className="eyebrow text-brass text-[11px] mb-3">Gear Level History</div>
          <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-4">{historyMember.display_name || 'Member'}</h2>
          {historyLoading ? (
            <p className="text-ash text-sm">Loading…</p>
          ) : historyEntries.length === 0 ? (
            <p className="text-ash text-sm">No submission history on file.</p>
          ) : (
            <div className="space-y-2">
              {historyEntries.map((h) => (
                <div key={h.id} className="flex items-center gap-3 bg-hall border border-line rounded-lg px-3 py-2 text-sm">
                  <span className="text-ash text-xs w-36 shrink-0">{fmtDatetime(h.submitted_at)}</span>
                  <span className="font-mono text-bone">W {h.weapon}</span>
                  <span className="font-mono text-bone">A {h.armor}</span>
                  <span className="font-mono text-bone">Ac {h.accessory}</span>
                  <span className="font-mono text-brassbright ml-auto">Avg {h.average}</span>
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}

      {shotMember && (
        <Modal onClose={() => setShotMember(null)} maxWidth="max-w-3xl" scrollable>
          <div className="eyebrow text-brass text-[11px] mb-3">Equipment Window</div>
          <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-1">{shotMember.display_name || 'Member'}</h2>
          {shot?.submitted_at && <p className="text-ash text-xs mb-4">Uploaded {fmtDatetime(shot.submitted_at)}</p>}

          {shotLoading ? (
            <p className="text-ash text-sm">Loading…</p>
          ) : shotError ? (
            <p className="text-bone text-sm px-4 py-2.5 rounded-lg border border-oxblood/50 bg-oxblooddeep/20">{shotError}</p>
          ) : !shot ? (
            <p className="text-ash text-sm">No equipment window on file.</p>
          ) : (
            <div className="space-y-4">
              {shot.excluded_count > 0 && (
                <p className="text-brass text-xs inline-flex items-center gap-1.5">
                  <EyeOff className="w-3 h-3" />
                  {shot.excluded_count} Heroic item{shot.excluded_count === 1 ? '' : 's'} excluded from these levels
                </p>
              )}

              {/* Every item, excluded ones struck through rather than dropped.
                  "Why is their weapon 68 when I know they have a 74" is the
                  question this modal exists to answer, and hiding the 74 is
                  precisely what would make it unanswerable. */}
              <div className="rounded-lg border border-line overflow-auto max-h-72">
                <table className="w-full text-sm">
                  <thead className="border-b border-line bg-hall sticky top-0">
                    <tr className="eyebrow text-[10px] text-ash">
                      <th className="p-2.5 font-normal text-left">Slot</th>
                      <th className="p-2.5 font-normal text-left">Item</th>
                      <th className="p-2.5 font-normal text-left">Tier</th>
                      <th className="p-2.5 font-normal text-right">Lv.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(shot.items || []).map((it, i) => (
                      <tr key={`${it.slot}-${i}`} className={`border-b border-line/60 ${it.excluded ? 'text-ash/50' : ''}`}>
                        <td className="p-2.5 whitespace-nowrap">{it.slot}</td>
                        <td className={`p-2.5 ${it.excluded ? '' : 'text-bone'}`}>{it.name}</td>
                        <td className="p-2.5 whitespace-nowrap">{it.tier}</td>
                        <td className={`p-2.5 text-right font-mono text-xs ${it.excluded ? 'line-through' : 'text-bone'}`}>{it.level}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {shot.image_url ? (
                <a href={shot.image_url} target="_blank" rel="noreferrer">
                  <img src={shot.image_url} alt={`${shotMember.display_name || 'Member'}'s equipment window`}
                    className="max-w-full rounded-lg border border-line hover:border-brass/50 transition-colors" />
                </a>
              ) : (
                <p className="text-ash text-xs">The stored image is missing — only the parsed items are on file.</p>
              )}
            </div>
          )}
        </Modal>
      )}
    </PageShell>
  );
}
