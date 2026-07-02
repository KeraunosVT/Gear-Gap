import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import Sigil from '../components/Sigil';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { fmtDatetime } from '../timeUtils';
import ItemTooltip, { gradeStyle } from '../components/ItemTooltip';

export default function LootHistory() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [awards, setAwards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [member, setMember] = useState('');

  const load = () => {
    setLoading(true); setError('');
    Promise.all([axios.get('/api/loot/catalog'), axios.get('/api/admin/loot/awards')])
      .then(([catRes, aw]) => { setCatalog(catRes.data); setAwards(aw.data.awards || []); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load loot history.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

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
      <Link to="/admin/loot" className="inline-flex items-center gap-1.5 text-sm text-ash hover:text-brass mb-6 transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> Back to Loot Council
      </Link>
      <div className="eyebrow text-brass text-[11px] mb-3">War Table</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Loot History</h1>
      <p className="text-ash mt-2">Every item awarded by Loot Council, in order.</p>
      <div className="rule-fade my-8" />

      {error && <div className="mb-6 px-5 py-3 rounded-sm border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <select value={member} onChange={(e) => setMember(e.target.value)}
          className="bg-panel border border-line rounded-sm px-3 py-2.5 text-bone focus:outline-none focus:border-brass">
          <option value="">All members</option>
          {members.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <span className="text-ash text-sm">{filtered.length} award{filtered.length === 1 ? '' : 's'}</span>
        <div className="flex-1" />
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass transition-colors"><RefreshCw className="w-4 h-4" /></button>
      </div>

      {loading ? (
        <div className="py-20 text-center text-ash">Reading the ledger…</div>
      ) : filtered.length === 0 ? (
        <div className="py-20 text-center text-ash">{member ? 'No awards for this member.' : 'Nothing has been awarded yet.'}</div>
      ) : (
        <div className="panel rounded-sm divide-y divide-line">
          {filtered.map((a) => {
            const item = itemByKey[a.item_key];
            return (
              <div key={a.id} className="flex items-center gap-3 px-5 py-3">
                {item?.image_url && <img src={item.image_url} alt="" className="w-8 h-8 rounded border border-line object-cover shrink-0" />}
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
                <div className="text-xs text-ash shrink-0 text-right">
                  {fmtDatetime(a.awarded_at)}
                  {a.awarded_by && <div className="text-ash/60">by {a.awarded_by}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
