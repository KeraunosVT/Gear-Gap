import { useState, useEffect, useMemo, useCallback } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { RefreshCw, Scale } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { Table, Thead, SortableTh, Tr } from '../components/ui/Table';
import CurrencyIcon from '../components/ui/CurrencyIcon';

// ── THE ARGUMENT, AS A COLUMN SORT ──────────────────────────────────────────
// Attendance, gear awarded and currency granted were all stored and never
// joined, so "who has shown up the most and received the least" was settled
// from memory across three pages. This is that join.
//
// The window governs BOTH halves. A 30-day attendance rate beside an all-time
// loot count isn't a comparison — it's a way to make a long-standing member
// look greedy.

const WINDOWS = [
  { key: '7', label: '1 week' },
  { key: '14', label: '2 weeks' },
  { key: '30', label: '30 days' },
  { key: 'all', label: 'All time' },
];

// Same three colours the tally and the party board use for builds.
const BUILD_TONE = { 'PvP': 'text-oxblood', 'Second Build': 'text-brass', 'PvE': 'text-emerald-400' };
const BUILD_SHORT = { 'PvP': 'PvP', 'Second Build': '2nd', 'PvE': 'PvE' };

const fmt = (n) => (n || 0).toLocaleString();

export default function LootFairness() {
  const { can } = useAuth();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [window_, setWindow_] = useState('30');
  const [filter, setFilter] = useState('');
  const [hideEmpty, setHideEmpty] = useState(true);
  const [sortKey, setSortKey] = useState('rate');
  const [sortDir, setSortDir] = useState('desc');

  const load = useCallback(() => {
    setLoading(true); setError('');
    axios.get('/api/admin/loot/fairness', { params: { window: window_ } })
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not build the fairness table.'))
      .finally(() => setLoading(false));
  }, [window_]);

  useEffect(() => { load(); }, [load]);

  const showCurrency = Boolean(data?.can_see_currency);
  const priorities = data?.priorities || [];

  const columns = useMemo(() => [
    { key: 'display_name', label: 'Member', align: 'left' },
    { key: 'rate', label: 'Attendance', align: 'right' },
    { key: 'attended', label: 'Nights', align: 'right' },
    { key: 'items', label: 'Items', align: 'right' },
    ...priorities.map((p) => ({ key: `build:${p}`, label: BUILD_SHORT[p] || p, align: 'right' })),
    { key: 'build:Untagged', label: 'Untagged', align: 'right' },
    ...(showCurrency ? [
      { key: 'lucent', label: 'Lucent', align: 'right' },
      { key: 'shards', label: 'Shards', align: 'right' },
    ] : []),
  ], [priorities, showCurrency]);

  const valueOf = (m, key) => {
    if (key.startsWith('build:')) return m.items_by_build?.[key.slice(6)] || 0;
    if (key === 'rate') return m.rate ?? -1;
    return m[key];
  };

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    let list = (data?.members || []).filter((m) => (m.display_name || '').toLowerCase().includes(f));
    // Someone with nothing on either side is noise. Someone with attendance and
    // no loot is the whole point, so the filter is on BOTH being zero.
    if (hideEmpty) list = list.filter((m) => m.attended > 0 || m.items > 0 || m.lucent > 0 || m.shards > 0);
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = valueOf(a, sortKey);
      const vb = valueOf(b, sortKey);
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va || '').localeCompare(String(vb || '')) * dir;
      }
      return ((Number(va) || 0) - (Number(vb) || 0)) * dir
        || String(a.display_name || '').localeCompare(String(b.display_name || ''));
    });
  }, [data, filter, hideEmpty, sortKey, sortDir]);

  const sortBy = (key) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir(key === 'display_name' ? 'asc' : 'desc'); }
  };

  if (!can('loot.awards')) return <RestrictedGate />;

  return (
    <PageShell maxWidth="max-w-5xl">
      <div className="flex items-center gap-3 mb-2">
        <Scale className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">WHO'S OWED</h1>
      </div>
      <p className="text-ash text-sm mb-6">
        Attendance against what each member has actually received. Sort by attendance and read up from the
        bottom of the Items column — that's the list this page exists for.
        {' '}<span className="text-ash/70">The window covers both halves, so the two numbers on a row always describe the same period.</span>
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
          className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        <div className="flex items-center gap-1">
          {WINDOWS.map(({ key, label }) => (
            <button
              key={key} onClick={() => setWindow_(key)}
              className={`px-3 py-1 rounded-full text-xs font-semibold tracking-wide transition-colors border ${
                window_ === key ? 'bg-brass text-ink border-transparent' : 'border-line text-ash hover:text-bone'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-2 text-sm text-ash cursor-pointer select-none">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} className="accent-brass" />
          Hide members with nothing either side
        </label>
        <div className="flex-1" />
        {!loading && data && (
          <span className="text-sm text-ash">
            <span className="font-mono text-bone">{data.total_events}</span> night{data.total_events === 1 ? '' : 's'} logged
          </span>
        )}
        <button onClick={load} title="Refresh" className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : loading ? (
        <EmptyState>Weighing the ledger…</EmptyState>
      ) : data.total_events === 0 ? (
        <EmptyState>No events logged in this window — there's no attendance to weigh loot against.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>{filter ? 'Nobody matching.' : 'Nothing recorded in this window.'}</EmptyState>
      ) : (
        <>
          <Table maxHeight="max-h-[70vh]" minWidth={showCurrency ? 'min-w-[880px]' : 'min-w-[680px]'}>
            <Thead sticky>
              {columns.map((c) => (
                <SortableTh
                  key={c.key} label={c.label} sortKey={c.key} align={c.align} dense
                  activeKey={sortKey} dir={sortDir} onSort={sortBy}
                />
              ))}
            </Thead>
            <tbody>
              {rows.map((m) => (
                <Tr key={m.discord_id}>
                  <td className="p-2.5 text-bone font-semibold">{m.display_name}</td>
                  <td className="p-2.5 text-right font-mono">
                    {m.rate === null ? <span className="text-ash/40">—</span> : (
                      // Coloured against the same 70% line the officer table
                      // uses, so "low" means the same thing on both pages.
                      <span className={m.rate >= 70 ? 'text-bone' : 'text-brassbright'}>{m.rate}%</span>
                    )}
                  </td>
                  <td className="p-2.5 text-right font-mono text-ash">{m.attended}</td>
                  <td className="p-2.5 text-right font-mono">
                    <span className={m.items ? 'text-brassbright' : 'text-ash/30'}>{m.items}</span>
                  </td>
                  {priorities.map((p) => (
                    <td key={p} className="p-2.5 text-right font-mono">
                      <span className={m.items_by_build?.[p] ? BUILD_TONE[p] : 'text-ash/25'}>
                        {m.items_by_build?.[p] || 0}
                      </span>
                    </td>
                  ))}
                  <td className="p-2.5 text-right font-mono">
                    <span className={m.items_by_build?.Untagged ? 'text-ash' : 'text-ash/25'}>
                      {m.items_by_build?.Untagged || 0}
                    </span>
                  </td>
                  {showCurrency && (
                    <>
                      <td className="p-2.5 text-right font-mono">
                        <span className={m.lucent ? 'text-bone' : 'text-ash/25'}>{fmt(m.lucent)}</span>
                      </td>
                      <td className="p-2.5 text-right font-mono">
                        <span className={m.shards ? 'text-bone' : 'text-ash/25'}>{fmt(m.shards)}</span>
                      </td>
                    </>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>

          <p className="text-ash/60 text-xs mt-4 flex items-center gap-1.5 flex-wrap">
            {showCurrency ? (
              <>
                <CurrencyIcon currency="lucent" />
                Lucent and shards are totals granted in this window.
              </>
            ) : (
              <>Currency columns are hidden — they need the <span className="text-ash">Loot — Lucent &amp; Shards</span> permission.</>
            )}
            {' '}Untagged items were awarded before builds were recorded, and are counted in the Items total.
          </p>
        </>
      )}
    </PageShell>
  );
}
