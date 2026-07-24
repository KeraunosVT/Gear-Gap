import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { RefreshCw, Upload } from 'lucide-react';
import { fmtDatetime } from '../timeUtils';
import ItemTooltip, { gradeStyle } from '../components/ItemTooltip';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';

const PRIO_SHORT = { 'PvP': 'PvP', 'Second Build': '2nd', 'PvE': 'PvE' };
const PRIO_STYLE = {
  'PvP':          { on: 'bg-oxblood text-bone border-transparent',     off: 'border-line text-ash hover:text-bone' },
  'Second Build': { on: 'bg-brass text-ink border-transparent',        off: 'border-line text-ash hover:text-bone' },
  'PvE':          { on: 'bg-emerald-500 text-ink border-transparent',  off: 'border-line text-ash hover:text-bone' },
};

export default function LootHistory() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [awards, setAwards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [member, setMember] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [savingBuild, setSavingBuild] = useState(null); // award id currently being updated

  const load = () => {
    setLoading(true); setError('');
    Promise.all([axios.get('/api/loot/catalog'), axios.get('/api/admin/loot/awards')])
      .then(([catRes, aw]) => { setCatalog(catRes.data); setAwards(aw.data.awards || []); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load loot history.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  // Set or correct which build an award was for — most useful on awards made
  // before builds were tracked, but works to fix a mistagged one too.
  const setBuild = (id, priority) => {
    setSavingBuild(id);
    axios.patch(`/api/admin/loot/awards/${id}`, { priority })
      .then(() => setAwards((prev) => prev.map((a) => (a.id === id ? { ...a, priority } : a))))
      .catch((err) => setError(err.response?.data?.error || 'Failed to set build.'))
      .finally(() => setSavingBuild(null));
  };

  const itemByKey = useMemo(() => {
    if (!catalog) return {};
    return Object.fromEntries(catalog.categories.flatMap((c) => c.items.map((i) => [i.key, { ...i, category: c.label }])));
  }, [catalog]);

  const members = useMemo(() => {
    const m = new Map();
    awards.forEach((a) => { if (a.discord_id && !m.has(a.discord_id)) m.set(a.discord_id, a.display_name || a.discord_id); });
    return [...m.entries()].sort((a, b) => (a[1] || '').localeCompare(b[1] || ''));
  }, [awards]);

  const filtered = useMemo(
    () => (member ? awards.filter((a) => a.discord_id === member) : awards),
    [awards, member]
  );

  const handleImport = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    setImporting(true); setImportResult(null); setError('');
    const form = new FormData();
    form.append('file', f);
    axios.post('/api/admin/loot/awards/import', form)
      .then((res) => { setImportResult(res.data); load(); })
      .catch((err) => setError(err.response?.data?.error || 'Import failed.'))
      .finally(() => setImporting(false));
  };

  if (!user?.isAdmin) {
    return <RestrictedGate />;
  }

  return (
    <PageShell maxWidth="max-w-4xl">
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      <div className="panel rounded-lg p-4 mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <label className={`inline-flex items-center gap-2 px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg text-sm cursor-pointer transition-colors ${importing ? 'opacity-40 pointer-events-none' : ''}`}>
            <Upload className="w-4 h-4" /> {importing ? 'Importing…' : 'Upload CSV'}
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleImport} disabled={importing} />
          </label>
          <span className="text-ash text-xs">Columns: item, member, date (optional), awarded_by (optional), build (optional — PvP / Second Build / PvE)</span>
        </div>
        {importResult && (
          <div className="mt-3 text-sm">
            <span className="text-emerald-400">{importResult.imported} imported</span>
            {importResult.skipped > 0 && <span className="text-oxblood ml-3">{importResult.skipped} skipped</span>}
            {importResult.errors?.length > 0 && (
              <ul className="mt-2 text-xs text-ash space-y-0.5 max-h-32 overflow-auto">
                {importResult.errors.map((e, i) => <li key={i}>Row {e.row}: {e.reason}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <select value={member} onChange={(e) => setMember(e.target.value)}
          className="bg-panel border border-line rounded-lg px-3 py-2.5 text-bone focus:outline-none focus:border-brass">
          <option value="">All members</option>
          {members.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <span className="text-ash text-sm">{filtered.length} award{filtered.length === 1 ? '' : 's'}</span>
        <div className="flex-1" />
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass transition-colors"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {loading ? (
        <EmptyState>Reading the ledger…</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>{member ? 'No awards for this member.' : 'Nothing has been awarded yet.'}</EmptyState>
      ) : (
        <div className="panel rounded-lg divide-y divide-line">
          {filtered.map((a) => {
            const item = itemByKey[a.item_key];
            return (
              <div key={a.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  {item ? (
                    <ItemTooltip item={item}>
                      <span className={`truncate ${gradeStyle(item.grade)?.color || 'text-bone'}`}>{item.name}</span>
                    </ItemTooltip>
                  ) : (
                    <span className="text-bone truncate">{a.item_key}</span>
                  )}
                </div>
                <div className="text-sm text-brass shrink-0 w-40 truncate">{a.display_name || 'Member'}</div>
                <div className="flex gap-1 shrink-0" title="Build this was awarded for">
                  {(catalog?.priorities || []).map((p) => {
                    const st = PRIO_STYLE[p];
                    const active = a.priority === p;
                    return (
                      <button
                        key={p} title={p} disabled={savingBuild === a.id}
                        onClick={() => setBuild(a.id, active ? null : p)}
                        className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border transition-colors disabled:opacity-40 ${active ? st.on : st.off}`}
                      >
                        {PRIO_SHORT[p]}
                      </button>
                    );
                  })}
                </div>
                <div className="text-xs text-ash shrink-0 text-right">
                  {fmtDatetime(a.awarded_at)}
                  {a.awarded_by && <div className="text-ash/60">by {a.awarded_by}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
