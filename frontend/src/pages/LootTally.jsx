import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import Sigil from '../components/Sigil';
import { ChevronDown, RefreshCw, Gavel, X, ScrollText, Plus, Pencil, Trash2, Upload, History } from 'lucide-react';
import { fmtDatetime } from '../timeUtils';
import ItemTooltip, { gradeStyle } from '../components/ItemTooltip';

const PRIO_SHORT = { 'PvP': 'PvP', 'Second Build': '2nd', 'PvE': 'PvE' };
const PRIO_DOT = { 'PvP': 'bg-oxblood', 'Second Build': 'bg-brass', 'PvE': 'bg-emerald-500' };
const PRIO_TEXT = { 'PvP': 'text-oxblood', 'Second Build': 'text-brass', 'PvE': 'text-emerald-400' };

export default function LootTally() {
  const { user } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [counts, setCounts] = useState({});
  const [tally, setTally] = useState({});
  const [awards, setAwards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('');
  const [showZero, setShowZero] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [pending, setPending] = useState(null); // { item, watcher }
  const [busy, setBusy] = useState(false);
  const [managing, setManaging] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newItemName, setNewItemName] = useState('');
  const [newItemCat, setNewItemCat] = useState('');
  const [editingItem, setEditingItem] = useState(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [qlSearch, setQlSearch] = useState('');
  const [qlResults, setQlResults] = useState([]);
  const [qlSearching, setQlSearching] = useState(false);
  const [qlAddCat, setQlAddCat] = useState('');

  const toggleCat = (key) => setCollapsed((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const load = () => {
    setLoading(true); setError('');
    Promise.all([axios.get('/api/loot/catalog'), axios.get('/api/loot'), axios.get('/api/admin/loot/awards')])
      .then(([catRes, loot, aw]) => {
        setCatalog(catRes.data);
        setCounts(loot.data.counts || {});
        setTally(loot.data.tally || {});
        setAwards(aw.data.awards || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the tally.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const PRIO_INDEX = useMemo(() => catalog ? Object.fromEntries(catalog.priorities.map((p, i) => [p, i])) : {}, [catalog]);

  const allItems = useMemo(() => catalog ? catalog.categories.flatMap((c) => c.items.map((i) => ({ ...i, category: c.label }))) : [], [catalog]);
  const itemByKey = useMemo(() => Object.fromEntries(allItems.map((i) => [i.key, i])), [allItems]);

  const awardsByItem = useMemo(() => {
    const m = {};
    awards.forEach((a) => { (m[a.item_key] = m[a.item_key] || []).push(a); });
    return m;
  }, [awards]);
  const awardFor = (itemKey, discordId) => (awardsByItem[itemKey] || []).find((a) => a.discord_id === discordId);

  const groupedRows = useMemo(() => {
    if (!catalog) return [];
    const f = filter.toLowerCase();
    return catalog.categories
      .map((cat) => {
        const items = (cat.items || [])
          .map((it) => {
            const awarded = awardsByItem[it.key] || [];
            const awardedIds = new Set(awarded.map((a) => a.discord_id));
            const watchers = [...(tally[it.key] || [])]
              .filter((w) => !awardedIds.has(w.discord_id))
              .sort((a, b) => (PRIO_INDEX[a.priority] - PRIO_INDEX[b.priority]) || (a.name || '').localeCompare(b.name || ''));
            const byPrio = {};
            catalog.priorities.forEach((p) => { byPrio[p] = 0; });
            watchers.forEach((w) => { if (byPrio[w.priority] != null) byPrio[w.priority]++; });
            return { ...it, category: cat.label, total: watchers.length, watchers, byPrio, awarded };
          })
          .filter((it) => (showZero || it.total > 0 || it.awarded.length > 0)
            && (it.name.toLowerCase().includes(f) || cat.label.toLowerCase().includes(f)));
        return { ...cat, items };
      })
      .filter((cat) => cat.items.length > 0 && (!category || cat.label === category));
  }, [counts, tally, awardsByItem, filter, category, showZero, catalog, PRIO_INDEX]);

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 3500); };

  const toggle = (key) => setOpen((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const confirmAward = () => {
    if (!pending) return;
    setBusy(true);
    axios.post('/api/admin/loot/awards', {
      item_key: pending.item.key, discord_id: pending.watcher.discord_id, display_name: pending.watcher.name,
    })
      .then(() => { setPending(null); load(); })
      .catch((err) => setError(err.response?.data?.error || 'Award failed.'))
      .finally(() => setBusy(false));
  };

  const revoke = (id) => {
    axios.delete(`/api/admin/loot/awards/${id}`).then(load).catch((err) => setError(err.response?.data?.error || 'Revoke failed.'));
  };

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
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">War Table</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Loot Council</h1>
      <p className="text-ash mt-2">Every wishlisted item by demand. Award an item to mark it Loot Counciled.</p>
      <div className="rule-fade my-8" />

      {error && <div className="mb-6 px-5 py-3 rounded-sm border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}
      {msg && <div className={`mb-6 px-5 py-3 rounded-sm border text-sm ${msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'}`}>{msg.text}</div>}

      <div className="mb-8 flex items-center gap-5">
        <button
          onClick={() => setManaging((v) => !v)}
          className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright transition-colors"
        >
          <Pencil className="w-4 h-4" /> {managing ? 'Close item manager' : 'Manage items'}
        </button>
        <Link to="/admin/loot/history" className="inline-flex items-center gap-2 text-sm text-brass hover:text-brassbright transition-colors">
          <History className="w-4 h-4" /> Loot History
        </Link>
      </div>

      {managing && catalog && (
        <div className="mb-10 panel rounded-sm p-6 space-y-6">
          <div className="eyebrow text-brass text-[10px] mb-2">Item Manager</div>

          {/* Add category */}
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Add category</label>
            <div className="flex gap-2">
              <input value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="e.g. Boots"
                className="bg-hall border border-line rounded-sm px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
              <button
                onClick={() => {
                  if (!newCatName.trim()) return;
                  axios.post('/api/admin/loot/categories', { label: newCatName.trim() })
                    .then(() => { setNewCatName(''); load(); })
                    .catch((err) => setError(err.response?.data?.error || 'Failed to add category.'));
                }}
                disabled={!newCatName.trim()}
                className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors disabled:opacity-40"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Add item */}
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Add item</label>
            <div className="flex gap-2">
              <select value={newItemCat} onChange={(e) => setNewItemCat(e.target.value)}
                className="bg-hall border border-line rounded-sm px-3 py-2 text-bone focus:outline-none focus:border-brass">
                <option value="">— category —</option>
                {catalog.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <input value={newItemName} onChange={(e) => setNewItemName(e.target.value)} placeholder="Item name"
                className="bg-hall border border-line rounded-sm px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
              <button
                onClick={() => {
                  if (!newItemCat || !newItemName.trim()) return;
                  axios.post('/api/admin/loot/items', { category: newItemCat, name: newItemName.trim() })
                    .then(() => { setNewItemName(''); load(); })
                    .catch((err) => setError(err.response?.data?.error || 'Failed to add item.'));
                }}
                disabled={!newItemCat || !newItemName.trim()}
                className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors disabled:opacity-40"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Item database */}
          <div>
            <label className="eyebrow text-[10px] text-ash block mb-2">Item Database</label>

            {/* Sync reference data */}
            <div className="flex items-center gap-3 mb-4">
              <button
                onClick={() => {
                  setImporting(true); setImportResult(null); setError('');
                  axios.post('/api/admin/loot/import-questlog')
                    .then(() => {
                      const poll = setInterval(() => {
                        axios.get('/api/admin/loot/import-status').then((res) => {
                          if (!res.data.running) {
                            clearInterval(poll);
                            setImporting(false);
                            if (res.data.error) setError('Sync failed: ' + res.data.error);
                            else setImportResult(res.data.result);
                          }
                        }).catch(() => {});
                      }, 3000);
                    })
                    .catch((err) => { setError(err.response?.data?.error || 'Failed to start sync.'); setImporting(false); });
                }}
                disabled={importing}
                className="px-4 py-2 border border-brass/50 text-brassbright hover:bg-panelup rounded-sm text-sm transition-colors disabled:opacity-40"
              >
                {importing ? 'Syncing…' : 'Sync Item Database'}
              </button>
              <span className="text-ash text-xs">{importing ? 'This may take a few minutes' : 'Pull latest Epic+ items from game data'}</span>
              {importResult && (
                <span className="text-emerald-400 text-xs">
                  {importResult.imported} new, {importResult.skipped || 0} existing ({(importResult.duration_ms / 1000).toFixed(0)}s)
                </span>
              )}
            </div>

            {/* Search and add */}
            <div className="flex gap-2 mb-3">
              <input value={qlSearch} onChange={(e) => setQlSearch(e.target.value)} placeholder="Search items…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && qlSearch.trim()) {
                    setQlSearching(true);
                    axios.get('/api/admin/loot/questlog-search', { params: { q: qlSearch.trim() } })
                      .then((res) => setQlResults(res.data.items || []))
                      .catch(() => setQlResults([]))
                      .finally(() => setQlSearching(false));
                  }
                }}
                className="bg-hall border border-line rounded-sm px-3 py-2 text-bone focus:outline-none focus:border-brass flex-1" />
              <select value={qlAddCat} onChange={(e) => setQlAddCat(e.target.value)}
                className="bg-hall border border-line rounded-sm px-3 py-2 text-bone focus:outline-none focus:border-brass">
                <option value="">— category —</option>
                {(catalog?.categories || []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
              <button
                onClick={() => {
                  if (!qlSearch.trim()) return;
                  setQlSearching(true);
                  axios.get('/api/admin/loot/questlog-search', { params: { q: qlSearch.trim() } })
                    .then((res) => setQlResults(res.data.items || []))
                    .catch(() => setQlResults([]))
                    .finally(() => setQlSearching(false));
                }}
                disabled={qlSearching || !qlSearch.trim()}
                className="px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors disabled:opacity-40">
                {qlSearching ? '…' : 'Search'}
              </button>
            </div>
            {qlResults.length > 0 && (
              <div className="space-y-1 max-h-[300px] overflow-auto">
                {qlResults.map((it) => {
                  const g = it.grade >= 51 ? 'text-amber-400' : it.grade >= 41 ? 'text-purple-400' : 'text-bone';
                  return (
                    <div key={it.id} className="flex items-center gap-2 bg-hall border border-line rounded-sm px-3 py-2">
                      {it.icon && <img src={it.icon} alt="" className="w-8 h-8 rounded border border-line object-cover shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm truncate ${g}`}>{it.name}</div>
                        <div className="text-[10px] text-ash">{it.sub_category}</div>
                      </div>
                      <button
                        onClick={() => {
                          if (!qlAddCat) { setError('Select a category first.'); return; }
                          axios.post('/api/admin/loot/add-from-questlog', { questlog_id: it.id, category: qlAddCat })
                            .then(() => { load(); flash(`Added "${it.name}".`); })
                            .catch((err) => setError(err.response?.data?.error || 'Failed to add.'));
                        }}
                        disabled={!qlAddCat}
                        className="px-3 py-1 text-xs bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors disabled:opacity-40 shrink-0">
                        Add
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Existing items by category */}
          <div className="space-y-4">
            {catalog.categories.map((cat) => (
              <div key={cat.key}>
                <div className="flex items-center gap-2 mb-2">
                  <h4 className="font-display text-bone tracking-wide">{cat.label}</h4>
                  <button
                    onClick={() => {
                      if (!confirm(`Delete the "${cat.label}" category and all its items?`)) return;
                      axios.delete(`/api/admin/loot/categories/${cat.key}`)
                        .then(load)
                        .catch((err) => setError(err.response?.data?.error || 'Failed to delete category.'));
                    }}
                    className="text-ash hover:text-oxblood" title="Delete category"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="space-y-1">
                  {cat.items.map((item) => (
                    <div key={item.key} className="bg-hall border border-line rounded-sm px-3 py-1.5">
                      {editingItem === item.key ? (
                        <div className="space-y-2 py-1">
                          <input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Item name"
                            className="bg-panel border border-line rounded px-2 py-1 text-bone focus:outline-none focus:border-brass w-full text-sm" />
                          <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Description (optional)" rows={2}
                            className="bg-panel border border-line rounded px-2 py-1 text-bone focus:outline-none focus:border-brass w-full text-sm resize-none" />
                          <div className="flex items-center gap-2">
                            <label className="inline-flex items-center gap-1.5 text-xs text-brass hover:text-brassbright cursor-pointer">
                              <Upload className="w-3.5 h-3.5" /> Upload icon
                              <input type="file" accept="image/*" className="hidden" onChange={(e) => {
                                const f = e.target.files[0];
                                if (!f) return;
                                const form = new FormData();
                                form.append('image', f);
                                axios.post(`/api/admin/loot/items/${item.key}/image`, form)
                                  .then(() => load())
                                  .catch((err) => setError(err.response?.data?.error || 'Upload failed.'));
                              }} />
                            </label>
                            {item.image_url && <img src={item.image_url} alt="" className="w-6 h-6 rounded border border-line object-cover" />}
                            {!item.questlog_data && (
                              <button onClick={() => {
                                const name = item.name || editName;
                                axios.get('/api/admin/loot/questlog-search', { params: { q: name } })
                                  .then((res) => {
                                    const items = res.data.items || [];
                                    if (items.length === 0) { setError(`No match for "${name}". Sync the item database first.`); return; }
                                    const match = items.find((r) => r.name.toLowerCase() === name.toLowerCase()) || items[0];
                                    return axios.put(`/api/admin/loot/link-questlog/${item.key}`, { questlog_id: match.id })
                                      .then(() => { load(); flash(`Linked "${match.name}".`); });
                                  })
                                  .catch((err) => setError(err.response?.data?.error || err.message || 'Link failed.'));
                              }} className="text-brass hover:text-brassbright text-xs">Auto-link</button>
                            )}
                            {item.questlog_data && (
                              <button onClick={() => {
                                axios.put(`/api/admin/loot/unlink-questlog/${item.key}`)
                                  .then(() => { load(); flash('Unlinked.'); })
                                  .catch((err) => setError(err.response?.data?.error || 'Unlink failed.'));
                              }} className="text-emerald-400 hover:text-oxblood text-[10px]">linked ✕</button>
                            )}
                            <div className="flex-1" />
                            <button onClick={() => {
                              axios.put(`/api/admin/loot/items/${item.key}`, { name: editName.trim(), description: editDesc })
                                .then(() => { setEditingItem(null); load(); })
                                .catch((err) => setError(err.response?.data?.error || 'Failed to save.'));
                            }} className="text-emerald-400 hover:text-emerald-300 text-xs font-semibold">Save</button>
                            <button onClick={() => setEditingItem(null)} className="text-ash hover:text-bone text-xs">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          {item.image_url && <img src={item.image_url} alt="" className="w-6 h-6 rounded border border-line object-cover shrink-0" />}
                          <span className="text-bone text-sm flex-1">{item.name}</span>
                          {item.description && <span className="text-ash text-[10px] shrink-0">has desc</span>}
                          <button onClick={() => { setEditingItem(item.key); setEditName(item.name); setEditDesc(item.description || ''); }}
                            className="text-ash hover:text-brass" title="Edit">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => {
                            if (!confirm(`Delete "${item.name}"?`)) return;
                            axios.delete(`/api/admin/loot/items/${item.key}`)
                              .then(load)
                              .catch((err) => setError(err.response?.data?.error || 'Failed to delete item.'));
                          }} className="text-ash hover:text-oxblood" title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {cat.items.length === 0 && <p className="text-ash text-xs pl-1">No items — add one above or delete this category.</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8">
        {/* Main list */}
        <div>
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search items…"
              className="bg-panel border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass flex-1 min-w-[160px]" />
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="bg-panel border border-line rounded-sm px-3 py-2.5 text-bone focus:outline-none focus:border-brass">
              <option value="">All categories</option>
              {(catalog?.categories || []).map((c) => <option key={c.key} value={c.label}>{c.label}</option>)}
            </select>
            <label className="inline-flex items-center gap-2 text-sm text-ash cursor-pointer select-none">
              <input type="checkbox" checked={showZero} onChange={(e) => setShowZero(e.target.checked)} className="accent-brass" /> Show unwanted
            </label>
            <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass"><RefreshCw className="w-4 h-4" /></button>
          </div>

          {loading ? (
            <div className="py-20 text-center text-ash">Counting the claims…</div>
          ) : groupedRows.length === 0 ? (
            <div className="py-20 text-center text-ash">{showZero ? 'No items.' : 'No one has wishlisted anything yet.'}</div>
          ) : (
            <div className="space-y-8">
              {groupedRows.map((cat) => (
                <section key={cat.key}>
                  <button onClick={() => toggleCat(cat.key)} className="flex items-center gap-2 mb-3 group w-full text-left">
                    <ChevronDown className={`w-4 h-4 text-ash transition-transform ${collapsed.has(cat.key) ? '-rotate-90' : ''}`} />
                    <h2 className="font-display text-lg text-bone tracking-[0.08em] group-hover:text-brassbright transition-colors">{cat.label}</h2>
                    <span className="text-xs text-ash font-mono">{cat.items.length}</span>
                  </button>
                  {!collapsed.has(cat.key) && <div className="panel rounded-sm divide-y divide-line">
              {cat.items.map((it) => {
                const isOpen = open.has(it.key);
                const canOpen = it.watchers.length > 0;
                return (
                  <div key={it.key}>
                    <button onClick={() => canOpen && toggle(it.key)}
                      className={`w-full flex items-center gap-3 px-4 py-3 text-left ${canOpen ? 'hover:bg-panelup' : 'cursor-default'} transition-colors`}>
                      <div className="min-w-0 flex-1">
                        <ItemTooltip item={it}>
                          <span className={`truncate ${gradeStyle(it.grade)?.color || 'text-bone'}`}>{it.name}</span>
                        </ItemTooltip>
                      </div>
                      <div className="hidden sm:flex items-center gap-2 shrink-0">
                        {(catalog?.priorities || []).map((p) => (
                          <span key={p} className={`inline-flex items-center gap-1 text-xs font-mono ${it.byPrio[p] ? PRIO_TEXT[p] : 'text-ash/30'}`} title={p}>
                            <span className={`w-2 h-2 rounded-full ${it.byPrio[p] ? PRIO_DOT[p] : 'bg-line'}`} />{it.byPrio[p]}
                          </span>
                        ))}
                      </div>
                      <div className="w-8 text-right font-mono text-brassbright shrink-0">{it.total}</div>
                      <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${canOpen ? 'text-ash' : 'text-transparent'} ${isOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {isOpen && canOpen && (
                      <div className="px-4 pb-3 space-y-1.5">
                        {it.watchers.map((w) => {
                          const award = awardFor(it.key, w.discord_id);
                          return (
                            <div key={w.discord_id} className="flex items-center gap-2 text-sm">
                              <span className={`w-2 h-2 rounded-full ${PRIO_DOT[w.priority] || 'bg-line'} shrink-0`} />
                              <span className="text-bone">{w.name}</span>
                              <span className="text-ash text-xs">· {PRIO_SHORT[w.priority] || w.priority}</span>
                              {w.added_at && <span className="text-ash/60 text-[10px]">· added {fmtDatetime(w.added_at)}</span>}
                              <div className="flex-1" />
                              {award ? (
                                <span className="inline-flex items-center gap-1 text-xs text-brass">
                                  <Gavel className="w-3 h-3" /> Awarded
                                  <button onClick={() => revoke(award.id)} className="ml-1 text-ash hover:text-oxblood" title="Revoke"><X className="w-3 h-3" /></button>
                                </span>
                              ) : (
                                <button onClick={() => setPending({ item: it, watcher: w })}
                                  className="inline-flex items-center gap-1 text-xs px-2.5 py-1 border border-brass/50 text-brassbright hover:bg-panelup rounded-sm transition-colors">
                                  <Gavel className="w-3 h-3" /> Award
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
                  </div>}
                </section>
              ))}
            </div>
          )}
        </div>

        {/* Awarded tracker sidebar */}
        <aside className="lg:sticky lg:top-20 self-start">
          <div className="panel rounded-sm p-4">
            <div className="eyebrow text-[10px] text-brass flex items-center gap-2 mb-4"><ScrollText className="w-3.5 h-3.5" /> Awarded ({awards.length})</div>
            {awards.length === 0 ? (
              <p className="text-ash text-sm">Nothing awarded yet. Expand an item and award it to a member.</p>
            ) : (
              <div className="space-y-3 max-h-[640px] overflow-auto pr-1">
                {awards.map((a) => (
                  <div key={a.id} className="flex items-start gap-2 border-b border-line/50 pb-3 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-bone truncate">{itemByKey[a.item_key]?.name || a.item_key}</div>
                      <div className="text-xs text-brass truncate">{a.display_name || 'Member'}</div>
                      <div className="text-[10px] text-ash mt-0.5">{fmtDatetime(a.awarded_at)}{a.awarded_by ? ` · by ${a.awarded_by}` : ''}</div>
                    </div>
                    <button onClick={() => revoke(a.id)} className="text-ash hover:text-oxblood shrink-0" title="Revoke"><X className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Confirmation modal */}
      {pending && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-ink/70 backdrop-blur-sm" onClick={() => !busy && setPending(null)}>
          <div className="panel rounded-sm p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 text-brass eyebrow text-[11px] mb-3"><Gavel className="w-4 h-4" /> Loot Council</div>
            <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-2">Award this item?</h2>
            <p className="text-ash text-sm mb-1">Award <span className="text-bone font-medium">{pending.item.name}</span> to <span className="text-bone font-medium">{pending.watcher.name}</span>.</p>
            <p className="text-ash text-sm mb-6">It will be marked <span className="text-brass">Loot Counciled</span> on the tally and on their wishlist.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setPending(null)} disabled={busy} className="px-4 py-2 text-ash hover:text-bone transition-colors disabled:opacity-40">Cancel</button>
              <button onClick={confirmAward} disabled={busy} className="inline-flex items-center gap-2 px-5 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors disabled:opacity-40">
                <Gavel className="w-4 h-4" /> {busy ? 'Awarding…' : 'Award'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
