import { useState, useEffect, useRef, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { Users, Check, Loader2, ChevronDown, Gavel } from 'lucide-react';

const PRIO_SHORT = { 'PvP': 'PvP', 'Second Build': '2nd', 'PvE': 'PvE' };
const PRIO_STYLE = {
  'PvP':          { on: 'bg-oxblood text-bone border-transparent',     off: 'border-line text-ash hover:text-bone' },
  'Second Build': { on: 'bg-brass text-ink border-transparent',        off: 'border-line text-ash hover:text-bone' },
  'PvE':          { on: 'bg-emerald-500 text-ink border-transparent',  off: 'border-line text-ash hover:text-bone' },
};

export default function Loot() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [picks, setPicks] = useState({});
  const [counts, setCounts] = useState({});
  const [tally, setTally] = useState(null);   // admin only
  const [awarded, setAwarded] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState(null); // 'saving' | 'saved'
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(null);
  const timer = useRef(null);

  const load = () => {
    setLoading(true); setError('');
    Promise.all([axios.get('/api/loot/catalog'), axios.get('/api/loot')])
      .then(([catRes, lootRes]) => {
        setCatalog(catRes.data);
        setPicks(lootRes.data.mine || {}); setCounts(lootRes.data.counts || {}); setTally(lootRes.data.tally || null); setAwarded(new Set(lootRes.data.awarded || []));
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the wishlist.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); return () => clearTimeout(timer.current); }, []);

  const scheduleSave = (next) => {
    setSaveState('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      axios.put(`/api/loot/${user.id}`, { picks: next, display_name: user.username })
        .then(() => { setSaveState('saved'); setTimeout(() => setSaveState(null), 1500); })
        .catch((err) => { setSaveState(null); setError(err.response?.data?.error || 'Save failed.'); });
    }, 700);
  };

  const toggle = (itemKey, prio) => {
    setPicks((prev) => {
      const next = { ...prev };
      if (next[itemKey] === prio) delete next[itemKey];
      else next[itemKey] = prio;
      scheduleSave(next);
      return next;
    });
  };

  const categories = useMemo(() => {
    if (!catalog) return [];
    const f = filter.toLowerCase();
    if (!f) return catalog.categories;
    return catalog.categories
      .map((c) => ({ ...c, items: c.items.filter((i) => i.name.toLowerCase().includes(f)) }))
      .filter((c) => c.items.length > 0);
  }, [filter, catalog]);

  const myCount = Object.keys(picks).length;

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow text-brass text-[11px] mb-3">Members Area</div>
          <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Loot Wishlist</h1>
          <p className="text-ash mt-2">Mark the drops you want and how you'd use them. You're editing your own list.</p>
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl text-brassbright">{myCount}</div>
          <div className="eyebrow text-[10px] text-ash mt-1">your picks</div>
        </div>
      </div>
      <div className="rule-fade my-8" />

      <div className="flex items-center justify-between mb-6 gap-4">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search items…"
          className="bg-panel border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        <div className="flex items-center gap-4 text-sm shrink-0">
          <Legend />
          {saveState === 'saving' && <span className="text-ash inline-flex items-center gap-1"><Loader2 className="w-4 h-4 animate-spin" /> Saving</span>}
          {saveState === 'saved' && <span className="text-emerald-400 inline-flex items-center gap-1"><Check className="w-4 h-4" /> Saved</span>}
        </div>
      </div>

      {error && <div className="mb-6 px-5 py-3 rounded-sm border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {loading ? (
        <div className="py-20 text-center text-ash">Reading the ledger…</div>
      ) : categories.length === 0 ? (
        <div className="py-20 text-center text-ash">No items match.</div>
      ) : (
        <div className="space-y-8">
          {categories.map((cat) => (
            <section key={cat.key}>
              <h2 className="font-display text-lg text-bone tracking-[0.08em] mb-3">{cat.label}</h2>
              <div className="panel rounded-sm divide-y divide-line">
                {cat.items.map((item) => {
                  const mine = picks[item.key];
                  const n = counts[item.key] || 0;
                  const isOpen = expanded === item.key;
                  return (
                    <div key={item.key}>
                      <div className="flex items-center gap-3 px-4 py-2.5">
                        <span className={`flex-1 min-w-0 truncate ${mine ? 'text-bone' : 'text-ash'}`}>{item.name}</span>

                        {/* demand badge (admins can expand) */}
                        {n > 0 && (
                          <button
                            onClick={() => tally && setExpanded(isOpen ? null : item.key)}
                            className={`inline-flex items-center gap-1 text-xs font-mono px-2 py-1 rounded-full border border-line text-ash ${tally ? 'hover:text-bone hover:border-brass/40' : 'cursor-default'}`}
                            title={tally ? 'Who wants this' : `${n} want this`}
                          >
                            <Users className="w-3 h-3" /> {n}
                            {tally && <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
                          </button>
                        )}

                        {/* priority chips, or a locked Loot Counciled badge if awarded */}
                        {awarded.has(item.key) ? (
                          <span className="inline-flex items-center gap-1 text-[11px] eyebrow text-brass border border-brass/40 rounded-full px-2.5 py-1 shrink-0">
                            <Gavel className="w-3 h-3" /> Loot Counciled
                          </span>
                        ) : (
                        <div className="flex gap-1.5 shrink-0">
                          {(catalog?.priorities || []).map((p) => {
                            const st = PRIO_STYLE[p];
                            const active = mine === p;
                            return (
                              <button
                                key={p} onClick={() => toggle(item.key, p)} title={p}
                                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${active ? st.on : st.off}`}
                              >
                                {PRIO_SHORT[p]}
                              </button>
                            );
                          })}
                        </div>
                        )}
                      </div>

                      {isOpen && tally && (
                        <div className="px-4 pb-3 -mt-1">
                          <div className="flex flex-wrap gap-2">
                            {(tally[item.key] || []).map((w, idx) => (
                              <span key={idx} className="text-xs bg-hall border border-line rounded-full px-3 py-1 text-ash">
                                {w.name} <span className="text-brass">· {PRIO_SHORT[w.priority] || w.priority}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="hidden md:flex items-center gap-2 text-[11px]">
      {Object.entries(PRIO_SHORT).map(([full, short]) => (
        <span key={full} className={`px-2 py-0.5 rounded-full border ${PRIO_STYLE[full].on}`}>{short} = {full}</span>
      ))}
    </div>
  );
}
