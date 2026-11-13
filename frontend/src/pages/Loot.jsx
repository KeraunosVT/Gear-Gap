import { useState, useEffect, useRef, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { Users, Check, Loader2, ChevronDown, Gavel, Search } from 'lucide-react';
import ItemTooltip, { gradeStyle } from '../components/ItemTooltip';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import ErrorBanner from '../components/ui/ErrorBanner';
import { BUILDS, BUILD_SHORT, BUILD_DOT, BUILD_TEXT, BUILD_CHIP_ON, BUILD_CHIP_OFF } from '../buildColors';

export default function Loot() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [picks, setPicks] = useState({});
  const [counts, setCounts] = useState({});
  const [tally, setTally] = useState(null);   // admin only
  const [awardedBuilds, setAwardedBuilds] = useState({}); // item_key -> builds already awarded to you
  const [received, setReceived] = useState([]); // every award to you, [{ item_key, priority }]
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState(null); // 'saving' | 'saved'
  const [filter, setFilter] = useState('');
  const [mineOnly, setMineOnly] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const timer = useRef(null);

  const load = () => {
    setLoading(true); setError('');
    Promise.all([axios.get('/api/loot/catalog'), axios.get('/api/loot')])
      .then(([catRes, lootRes]) => {
        setCatalog(catRes.data);
        setPicks(lootRes.data.mine || {}); setCounts(lootRes.data.counts || {}); setTally(lootRes.data.tally || null);
        setAwardedBuilds(lootRes.data.awardedBuilds || {}); setReceived(lootRes.data.received || []);
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

  const priorities = catalog?.priorities || BUILDS;
  const receivedKeys = useMemo(() => new Set(received.map((r) => r.item_key)), [received]);

  const categories = useMemo(() => {
    if (!catalog) return [];
    const f = filter.trim().toLowerCase();
    return catalog.categories
      .map((c) => ({
        ...c,
        items: c.items.filter((i) => (!f || i.name.toLowerCase().includes(f))
          && (!mineOnly || picks[i.key] || receivedKeys.has(i.key))),
      }))
      .filter((c) => c.items.length > 0);
  }, [filter, mineOnly, catalog, picks, receivedKeys]);

  const byBuild = useMemo(() => priorities.map((p) => ({
    build: p, n: Object.values(picks).filter((v) => v === p).length,
  })), [priorities, picks]);

  const jumpTo = (key) => document.getElementById(`loot-cat-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const myCount = Object.keys(picks).length;

  return (
    <PageShell maxWidth="max-w-none">
      <div className="flex items-baseline justify-between gap-4 flex-wrap mb-2">
        <p className="text-sm text-ash">Mark the drops you want and how you'd use them. Changes save as you click.</p>
        <span className="text-sm min-h-[20px]" aria-live="polite">
          {saveState === 'saving' && <span className="text-ash inline-flex items-center gap-1"><Loader2 className="w-4 h-4 animate-spin" /> Saving</span>}
          {saveState === 'saved' && <span className="text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1"><Check className="w-4 h-4" /> Saved</span>}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-4 mb-6">
        <div className="panel rounded-lg px-4 py-3">
          <div className="font-mono text-2xl text-brassbright">{loading ? '—' : myCount}</div>
          <div className="eyebrow text-[10px] text-ash mt-1">Your picks</div>
        </div>
        <div className="panel rounded-lg px-4 py-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-lg pt-1">
            {byBuild.map(({ build, n }) => (
              <span key={build} className={`inline-flex items-center gap-1.5 ${n ? BUILD_TEXT[build] : 'text-ash/40'}`} title={`${n} for ${build}`}>
                <span className={`w-2 h-2 rounded-full ${n ? BUILD_DOT[build] : 'bg-line'}`} />
                {n} <span className="font-sans text-xs">{BUILD_SHORT[build]}</span>
              </span>
            ))}
          </div>
          <div className="eyebrow text-[10px] text-ash mt-2">By build</div>
        </div>
        <div className="panel rounded-lg px-4 py-3">
          <div className="font-mono text-2xl text-amber-700 dark:text-amber-400">{loading ? '—' : received.length}</div>
          <div className="eyebrow text-[10px] text-ash mt-1">Received from council</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <label className="relative flex-1 min-w-[200px] max-w-sm">
          <span className="sr-only">Search items</span>
          <Search className="w-4 h-4 text-ash absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search items…"
            className="w-full bg-panel border border-line rounded-lg pl-9 pr-4 py-2.5 text-bone focus:outline-none focus:border-brass"
          />
        </label>
        <button type="button" onClick={() => setMineOnly((v) => !v)} aria-pressed={mineOnly}
          title="Only items you've picked or received"
          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-full border text-sm font-semibold transition-colors ${
            mineOnly ? 'border-brass/60 text-bone' : 'border-line text-ash hover:text-bone'}`}>
          <span className={`relative w-7 h-4 rounded-full transition-colors ${mineOnly ? 'bg-brass' : 'bg-line'}`}>
            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-bone transition-all ${mineOnly ? 'left-3.5' : 'left-0.5'}`} />
          </span>
          Mine only
        </button>
        <div className="flex-1" />
        <Legend />
      </div>

      {/* Sticks to the top of the scrolling <main> while the catalog scrolls. */}
      {categories.length > 1 && (
        <nav aria-label="Jump to category" className="sticky top-0 z-10 bg-ink/95 backdrop-blur-sm py-2.5 mb-4 border-b border-line flex flex-wrap items-center gap-1.5">
          <span className="eyebrow text-[10px] text-ash mr-1">Jump to</span>
          {categories.map((c) => (
            <button key={c.key} type="button" onClick={() => jumpTo(c.key)}
              className="px-3 py-1 rounded-full border border-line text-xs font-semibold text-bone hover:border-brass/50 transition-colors">
              {c.label} <span className="font-mono text-ash">{c.items.length}</span>
            </button>
          ))}
        </nav>
      )}

      <ErrorBanner>{error}</ErrorBanner>

      {loading ? (
        <EmptyState>Reading the ledger…</EmptyState>
      ) : categories.length === 0 ? (
        <EmptyState>
          {mineOnly && !filter ? "You haven't picked anything yet. Turn off Mine only to browse the catalog."
            : mineOnly ? 'Nothing on your list matches.' : 'No items match.'}
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {categories.map((cat) => (
            <section key={cat.key} id={`loot-cat-${cat.key}`} className="scroll-mt-16">
              <h2 className="font-display text-lg text-bone tracking-[0.08em] mb-3">{cat.label}</h2>
              <div className="panel rounded-lg divide-y divide-line">
                {cat.items.map((item) => {
                  const mine = picks[item.key];
                  const n = counts[item.key] || 0;
                  const isOpen = expanded === item.key;
                  const lockedBuilds = awardedBuilds[item.key] || [];
                  const fullyLocked = priorities.length > 0 && lockedBuilds.length >= priorities.length;
                  return (
                    <div key={item.key} className={mine ? 'bg-panelup/40' : ''}>
                      <div className="flex items-center gap-3 flex-wrap px-4 py-2.5">
                        <div className="flex-1 min-w-[160px]">
                          <ItemTooltip item={{ ...item, category: cat.label }}>
                            <span className={`truncate ${gradeStyle(item.grade)?.color || (mine ? 'text-bone' : 'text-ash')}`}>{item.name}</span>
                          </ItemTooltip>
                        </div>

                        {/* demand badge (admins can expand) */}
                        {n > 0 && (
                          <button
                            onClick={() => tally && setExpanded(isOpen ? null : item.key)}
                            aria-expanded={tally ? isOpen : undefined}
                            className={`inline-flex items-center gap-1 text-xs font-mono px-2 py-1 rounded-full border border-line text-ash ${tally ? 'hover:text-bone hover:border-brass/40' : 'cursor-default'}`}
                            title={tally ? 'Who wants this' : `${n} want this`}
                          >
                            <Users className="w-3 h-3" /> {n}
                            {tally && <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />}
                          </button>
                        )}

                        {/* priority chips — chips for already-awarded builds are locked so a
                            member can still request a different build for the same item, or a
                            single badge once every build has been Loot Counciled */}
                        {fullyLocked ? (
                          <span className="inline-flex items-center gap-1 text-[11px] eyebrow text-brassbright border border-brass/40 rounded-full px-2.5 py-1 shrink-0">
                            <Gavel className="w-3 h-3" /> Loot Counciled
                          </span>
                        ) : (
                          <div className="flex gap-1.5 shrink-0" role="group" aria-label={`Build you want ${item.name} for`}>
                            {priorities.map((p) => {
                              const active = mine === p;
                              const locked = lockedBuilds.includes(p);
                              return (
                                <button
                                  key={p} onClick={() => !locked && toggle(item.key, p)} disabled={locked} aria-pressed={active}
                                  title={locked ? `${p} — already Loot Counciled` : p}
                                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                                    locked ? 'border-brass/40 text-brassbright/80 opacity-70 cursor-default' : active ? BUILD_CHIP_ON[p] : BUILD_CHIP_OFF
                                  }`}
                                >
                                  {locked && <Gavel className="w-2.5 h-2.5" />}
                                  {BUILD_SHORT[p]}
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
                                {w.name} <span className={BUILD_TEXT[w.priority] || 'text-brass'}>· {BUILD_SHORT[w.priority] || w.priority}</span>
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
    </PageShell>
  );
}

function Legend() {
  return (
    <div className="hidden md:flex items-center gap-2 text-[11px]">
      {Object.entries(BUILD_SHORT).map(([full, short]) => (
        <span key={full} className={`px-2 py-0.5 rounded-full border ${BUILD_CHIP_ON[full]}`}>{short === full ? full : `${short} = ${full}`}</span>
      ))}
    </div>
  );
}
