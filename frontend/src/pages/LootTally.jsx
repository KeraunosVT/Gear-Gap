import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import { ChevronDown, RefreshCw, Gavel, X, ScrollText, UserPlus, Search, Star } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { guildDateOf, todayInGuildTz, fmtGuildDay } from '../timeUtils';
import ItemTooltip, { gradeStyle } from '../components/ItemTooltip';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import Tabs from '../components/ui/Tabs';
import { PageShell } from '../components/ui/PageShell';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';
import ErrorBanner from '../components/ui/ErrorBanner';
import LootNav from '../components/LootNav';
import { BUILDS, BUILD_SHORT, BUILD_DOT, BUILD_TEXT, BUILD_CHIP_ON, BUILD_CHIP_OFF } from '../lootBuilds';
import { rankCandidates, lastAwardMap } from '../lootCandidates';

// How far back the Recent awards panel reaches. Older ones are on History.
const RECENT_DAYS = 14;
const WEEK_MS = 7 * 86_400_000;
// The same "low attendance" line Who's Owed colours against.
const LOW_RATE = 70;

const SORTS = [{ key: 'cat', label: 'By category' }, { key: 'want', label: 'Most wanted' }];
const WINDOWS = [{ key: '30', label: '30 days' }, { key: 'all', label: 'All time' }];

const shortDay = (iso) => (iso ? fmtGuildDay(guildDateOf(iso), { weekday: false }) : null);
const windowLabel = (w) => (w === 'all' ? 'all time' : `last ${w} days`);

export default function LootTally() {
  const { can } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [tally, setTally] = useState({});
  const [awards, setAwards] = useState([]);
  const [members, setMembers] = useState([]);
  const [openRequests, setOpenRequests] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash(3500);

  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('');
  const [wantedOnly, setWantedOnly] = useState(true);
  const [sort, setSort] = useState('cat');
  const [open, setOpen] = useState(() => new Set());
  const [collapsed, setCollapsed] = useState(() => new Set());

  // Who's Owed numbers for the candidate tables. Soft-failed: without them
  // the tables still list who wants what, just without the context columns.
  const [statsWindow, setStatsWindow] = useState('30');
  const [stats, setStats] = useState(null); // Map discord_id -> member row

  const [pending, setPending] = useState(null); // { item, row, others }
  const [busy, setBusy] = useState(false);
  const [pickBusy, setPickBusy] = useState(false);

  const canRequests = can('loot.requests');

  const load = useCallback(() => {
    setLoading(true); setError('');
    Promise.all([
      axios.get('/api/loot/catalog'), axios.get('/api/loot'), axios.get('/api/admin/loot/awards'),
      axios.get('/api/admin/members'),
    ])
      .then(([catRes, loot, aw, mem]) => {
        setCatalog(catRes.data);
        setTally(loot.data.tally || {});
        setAwards(aw.data.awards || []);
        setMembers(mem.data.members || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the tally.'))
      .finally(() => setLoading(false));
    // Only a count for the summary tile, so a failure just hides the number.
    if (canRequests) {
      axios.get('/api/admin/lucent-requests')
        .then((res) => setOpenRequests((res.data.requests || [])
          .filter((r) => r.status === 'pending' || r.status === 'approved').length))
        .catch(() => setOpenRequests(null));
    }
  }, [canRequests]);

  const loadStats = useCallback(() => {
    axios.get('/api/admin/loot/fairness', { params: { window: statsWindow } })
      .then((res) => setStats(new Map((res.data.members || []).map((m) => [m.discord_id, m]))))
      .catch(() => setStats(null));
  }, [statsWindow]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadStats(); }, [loadStats]);
  const refresh = () => { load(); loadStats(); };

  const priorities = catalog?.priorities || BUILDS;
  const lastAward = useMemo(() => lastAwardMap(awards), [awards]);

  // Every catalog item with the watchers still waiting on it. A watcher only
  // drops off once THIS build has been awarded to them — an award for a
  // different build (or an older award with no recorded build) leaves their
  // wishlist entry open.
  const allItems = useMemo(() => {
    if (!catalog) return [];
    const awardedBy = new Set(awards.map((a) => `${a.item_key}|${a.discord_id}|${a.priority}`));
    return catalog.categories.flatMap((cat) => cat.items.map((it) => {
      const watchers = (tally[it.key] || [])
        .filter((w) => !awardedBy.has(`${it.key}|${w.discord_id}|${w.priority}`));
      const byPrio = Object.fromEntries(priorities.map((p) => [p, 0]));
      watchers.forEach((w) => { if (byPrio[w.priority] != null) byPrio[w.priority]++; });
      return { ...it, category: cat.label, categoryKey: cat.key, watchers, byPrio, total: watchers.length };
    }));
  }, [catalog, tally, awards, priorities]);

  const itemByKey = useMemo(() => Object.fromEntries(allItems.map((i) => [i.key, i])), [allItems]);

  const summary = useMemo(() => {
    const since = Date.now() - WEEK_MS;
    return {
      openWishes: allItems.reduce((n, it) => n + it.total, 0),
      itemsWanted: allItems.filter((it) => it.total > 0).length,
      awarded7d: awards.filter((a) => new Date(a.awarded_at).getTime() >= since).length,
    };
  }, [allItems, awards]);

  // Search and Wanted only narrow everything; the category chip narrows the
  // list but not the chip counts, so each chip says what clicking it shows.
  const matching = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return allItems.filter((it) => (!wantedOnly || it.total > 0)
      && (!f || it.name.toLowerCase().includes(f) || it.category.toLowerCase().includes(f)));
  }, [allItems, filter, wantedOnly]);

  const chips = useMemo(() => {
    if (!catalog) return [];
    return [{ key: '', label: 'All', n: matching.length },
      ...catalog.categories.map((c) => ({ key: c.key, label: c.label, n: matching.filter((it) => it.categoryKey === c.key).length }))
        .filter((c) => c.n > 0 || c.key === category)];
  }, [catalog, matching, category]);

  const groups = useMemo(() => {
    if (!catalog) return [];
    const shown = matching.filter((it) => !category || it.categoryKey === category);
    if (sort === 'want') {
      const items = [...shown].sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
      return items.length ? [{ key: '__wanted', label: 'Most wanted', items, flat: true }] : [];
    }
    return catalog.categories
      .map((c) => ({ key: c.key, label: c.label, items: shown.filter((it) => it.categoryKey === c.key) }))
      .filter((g) => g.items.length > 0);
  }, [catalog, matching, category, sort]);

  // The last RECENT_DAYS of awards, one group per guild night, newest first.
  const recent = useMemo(() => {
    const today = todayInGuildTz();
    const cutoff = Date.now() - RECENT_DAYS * 86_400_000;
    const byDay = new Map();
    awards
      .filter((a) => new Date(a.awarded_at).getTime() >= cutoff)
      .sort((a, b) => String(b.awarded_at).localeCompare(String(a.awarded_at)))
      .forEach((a) => {
        const day = guildDateOf(a.awarded_at);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(a);
      });
    return [...byDay.entries()].map(([day, list]) => ({
      day, list, label: day === today ? `Tonight · ${fmtGuildDay(day)}` : fmtGuildDay(day),
    }));
  }, [awards]);

  const toggleIn = (setter) => (key) => setter((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const toggleItem = toggleIn(setOpen);
  const toggleCat = toggleIn(setCollapsed);

  const confirmAward = () => {
    if (!pending) return;
    setBusy(true);
    const { item, row } = pending;
    axios.post('/api/admin/loot/awards', {
      item_key: item.key, discord_id: row.discord_id, display_name: row.name, priority: row.priority,
    })
      .then(() => { setPending(null); flash(`Awarded ${item.name} to ${row.name}.`); refresh(); })
      .catch((err) => setError(err.response?.data?.error || 'Award failed.'))
      .finally(() => setBusy(false));
  };

  const revoke = (a) => {
    const name = itemByKey[a.item_key]?.name || a.item_key;
    if (!confirm(`Revoke ${name} from ${a.display_name || 'this member'}? They'll be back on its wishlist.`)) return;
    axios.delete(`/api/admin/loot/awards/${a.id}`)
      .then(() => { flash(`Revoked ${name}.`); refresh(); })
      .catch((err) => setError(err.response?.data?.error || 'Revoke failed.'));
  };

  // Reverse-index the per-item tally into per-member picks, so an officer can
  // add or remove one member's entry without a separate endpoint.
  const picksByMember = useMemo(() => {
    const m = {};
    Object.entries(tally).forEach(([itemKey, watchers]) => {
      watchers.forEach((w) => { (m[w.discord_id] = m[w.discord_id] || {})[itemKey] = w.priority; });
    });
    return m;
  }, [tally]);

  // Plain { itemKey: priority } tells the backend to keep each item's added_at.
  const saveMemberPicks = async (discordId, picks, done) => {
    const member = members.find((m) => m.id === discordId);
    setPickBusy(true);
    try {
      await axios.put(`/api/loot/${discordId}`, { picks, display_name: member?.name });
      load();
      flash(done(member?.name || 'their'));
    } catch (err) { flash(err.response?.data?.error || 'Failed to update wishlist.', false); }
    finally { setPickBusy(false); }
  };

  const addPick = (item, discordId, priority) => {
    const current = picksByMember[discordId] || {};
    if (current[item.key] === priority) return;
    saveMemberPicks(discordId, { ...current, [item.key]: priority }, (n) => `Added "${item.name}" to ${n}'s wishlist.`);
  };

  const removePick = (item, discordId) => {
    const next = { ...(picksByMember[discordId] || {}) };
    delete next[item.key];
    saveMemberPicks(discordId, next, (n) => `Removed "${item.name}" from ${n}'s wishlist.`);
  };

  if (!can('loot.awards')) {
    return <RestrictedGate />;
  }

  return (
    <PageShell maxWidth="max-w-none">
      <LootNav />
      <ErrorBanner>{error}</ErrorBanner>
      <Toast msg={msg} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <SummaryTile value={!catalog ? '—' : summary.openWishes} label="Open wishes" accent />
        <SummaryTile value={!catalog ? '—' : summary.itemsWanted} label="Items wanted" />
        <SummaryTile value={!catalog ? '—' : summary.awarded7d} label="Awarded · 7 days" />
        {canRequests && (
          <Link to="/admin/loot/currency" className="panel rounded-lg px-4 py-3 hover:border-brass/50 transition-colors">
            <div className="font-mono text-2xl text-amber-700 dark:text-amber-400">{openRequests ?? '—'}</div>
            <div className="eyebrow text-[10px] text-ash mt-1">Lucent requests open →</div>
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-8">
        <section aria-label="Items" className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <label className="relative flex-1 min-w-[180px]">
              <span className="sr-only">Search items</span>
              <Search className="w-4 h-4 text-ash absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search items…"
                className="w-full bg-panel border border-line rounded-lg pl-9 pr-4 py-2.5 text-bone focus:outline-none focus:border-brass" />
            </label>
            <button type="button" onClick={() => setWantedOnly((v) => !v)} aria-pressed={wantedOnly}
              title="Hide items nobody is waiting on"
              className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-full border text-sm font-semibold transition-colors ${
                wantedOnly ? 'border-brass/60 text-bone' : 'border-line text-ash hover:text-bone'}`}>
              <span className={`relative w-7 h-4 rounded-full transition-colors ${wantedOnly ? 'bg-brass' : 'bg-line'}`}>
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-bone transition-all ${wantedOnly ? 'left-3.5' : 'left-0.5'}`} />
              </span>
              Wanted only
            </button>
            <Tabs items={SORTS} active={sort} onChange={setSort} />
            <button onClick={refresh} title="Refresh" aria-label="Refresh" className="p-2 text-ash hover:text-brass">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5 mb-6">
            {chips.map((c) => (
              <button key={c.key || 'all'} type="button" onClick={() => setCategory(c.key)} aria-pressed={category === c.key}
                className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                  category === c.key ? 'bg-brass text-ink border-transparent' : 'border-line text-ash hover:text-bone'}`}>
                {c.label} <span className="font-mono opacity-75">{c.n}</span>
              </button>
            ))}
          </div>

          {loading && !catalog ? (
            <div className="py-20 text-center text-ash">Counting the claims…</div>
          ) : groups.length === 0 ? (
            <div className="py-16 px-6 text-center text-ash border border-dashed border-line rounded-lg">
              {wantedOnly && !filter
                ? <>Nobody is waiting on anything{category ? ' in this category' : ''}. Turn off <span className="text-bone">Wanted only</span> to see the full catalog.</>
                : 'No items match.'}
            </div>
          ) : (
            <div className="space-y-8">
              {groups.map((g) => {
                const isCollapsed = !g.flat && collapsed.has(g.key);
                return (
                  <section key={g.key}>
                    {g.flat ? (
                      <h2 className="flex items-center gap-2 mb-3 font-display text-lg text-bone tracking-[0.08em]">
                        {g.label} <span className="text-xs text-ash font-mono">{g.items.length}</span>
                      </h2>
                    ) : (
                      <button onClick={() => toggleCat(g.key)} aria-expanded={!isCollapsed}
                        className="flex items-center gap-2 mb-3 group w-full text-left">
                        <ChevronDown className={`w-4 h-4 text-ash transition-transform ${isCollapsed ? '-rotate-90' : ''}`} />
                        <h2 className="font-display text-lg text-bone tracking-[0.08em] group-hover:text-brassbright transition-colors">{g.label}</h2>
                        <span className="text-xs text-ash font-mono">{g.items.length}</span>
                      </button>
                    )}
                    {!isCollapsed && (
                      <div className="panel rounded-lg divide-y divide-line">
                        {g.items.map((it) => (
                          <ItemRow
                            key={it.key} item={it} showCategory={g.flat} priorities={priorities}
                            isOpen={open.has(it.key)} onToggle={() => toggleItem(it.key)}
                            stats={stats} statsWindow={statsWindow} onStatsWindow={setStatsWindow}
                            lastAward={lastAward} members={members} pickBusy={pickBusy}
                            onAward={(row, rows) => setPending({
                              item: it, row,
                              others: rows.filter((r) => r.priority === row.priority && r.discord_id !== row.discord_id).map((r) => r.name),
                            })}
                            onRemove={(w) => removePick(it, w.discord_id)}
                            onAdd={(discordId, prio) => addPick(it, discordId, prio)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </section>

        <aside aria-label="Recent awards" className="lg:sticky lg:top-20 self-start">
          <div className="panel rounded-lg p-4">
            <div className="eyebrow text-[10px] text-brassbright flex items-center gap-2 mb-4">
              <ScrollText className="w-3.5 h-3.5" /> Recent awards
            </div>
            {recent.length === 0 ? (
              <p className="text-ash text-sm">Nothing awarded in the last {RECENT_DAYS} days. Open an item and award it to a member.</p>
            ) : (
              <div className="space-y-4 max-h-[640px] overflow-auto pr-1">
                {recent.map((g) => (
                  <div key={g.day}>
                    <div className="text-xs font-semibold text-ash mb-1.5">{g.label}</div>
                    {g.list.map((a) => (
                      <div key={a.id} className="flex items-start gap-2 py-1.5 border-b border-line/50 last:border-0">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-bone truncate">{itemByKey[a.item_key]?.name || a.item_key}</div>
                          <div className="flex items-center gap-1.5 text-xs text-ash truncate">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${(a.priority && BUILD_DOT[a.priority]) || 'bg-line'}`} />
                            <span className="truncate">{a.display_name || 'Member'}</span>
                            <span className="text-ash/70 shrink-0">· {a.priority ? BUILD_SHORT[a.priority] || a.priority : 'build unset'}</span>
                          </div>
                        </div>
                        <button onClick={() => revoke(a)} className="p-1 text-ash hover:text-oxblood shrink-0"
                          title="Revoke" aria-label={`Revoke ${itemByKey[a.item_key]?.name || 'award'} from ${a.display_name || 'member'}`}>
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <Link to="/admin/loot/history" className="inline-block mt-4 text-sm text-brassbright hover:text-brass">View full history →</Link>
          </div>
        </aside>
      </div>

      {pending && (
        <AwardModal pending={pending} statsWindow={statsWindow} busy={busy}
          onCancel={() => !busy && setPending(null)} onConfirm={confirmAward} />
      )}
    </PageShell>
  );
}

function SummaryTile({ value, label, accent = false }) {
  return (
    <div className="panel rounded-lg px-4 py-3">
      <div className={`font-mono text-2xl ${accent ? 'text-brassbright' : 'text-bone'}`}>{value}</div>
      <div className="eyebrow text-[10px] text-ash mt-1">{label}</div>
    </div>
  );
}

// One catalog item: the summary row, and when open, the candidate table.
function ItemRow({
  item, showCategory, priorities, isOpen, onToggle, stats, statsWindow, onStatsWindow,
  lastAward, members, pickBusy, onAward, onRemove, onAdd,
}) {
  const rows = useMemo(
    () => (isOpen ? rankCandidates(item.watchers, stats, lastAward) : []),
    [isOpen, item.watchers, stats, lastAward],
  );
  const eligible = useMemo(() => {
    if (!isOpen) return [];
    const watching = new Set(item.watchers.map((w) => w.discord_id));
    return members.filter((m) => !watching.has(m.id)).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [isOpen, item.watchers, members]);
  const starred = rows.some((r) => r.mostOwed);

  return (
    <div className={isOpen ? 'bg-panelup/40' : ''}>
      <button onClick={onToggle} aria-expanded={isOpen}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-panelup transition-colors">
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <ItemTooltip item={item}>
            <span className={`truncate ${gradeStyle(item.grade)?.color || 'text-bone'}`}>{item.name}</span>
          </ItemTooltip>
          {showCategory && <span className="text-[11px] text-ash border border-line rounded-full px-2 py-0.5">{item.category}</span>}
        </div>
        <div className="hidden sm:flex items-center gap-3 shrink-0">
          {priorities.map((p) => (
            <span key={p} className={`inline-flex items-center gap-1 text-xs font-mono ${item.byPrio[p] ? BUILD_TEXT[p] : 'text-ash/30'}`}
              title={`${item.byPrio[p]} want it for ${p}`}>
              <span className={`w-2 h-2 rounded-full ${item.byPrio[p] ? BUILD_DOT[p] : 'bg-line'}`} />
              {BUILD_SHORT[p]} {item.byPrio[p]}
            </span>
          ))}
        </div>
        <div className="w-8 text-right font-mono text-brassbright shrink-0">{item.total}</div>
        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform text-ash ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="px-4 pb-4">
          {rows.length === 0 ? (
            <div className="text-ash/70 text-sm py-1">Nobody has wishlisted this.</div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <span className="text-xs text-ash">
                  {stats ? `Attendance and items over the ${windowLabel(statsWindow)}, as on Who's Owed.` : 'Attendance figures are unavailable right now.'}
                </span>
                <Tabs items={WINDOWS} active={statsWindow} onChange={onStatsWindow} />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="text-left eyebrow text-[10px] text-ash border-b border-line">
                      <th className="w-6 py-2 font-normal"><span className="sr-only">Most owed</span></th>
                      <th className="py-2 font-normal">Member</th>
                      <th className="py-2 font-normal">Build</th>
                      <th className="py-2 font-normal text-right">Attendance</th>
                      <th className="py-2 font-normal text-right">Items</th>
                      <th className="py-2 pl-4 font-normal">Last award</th>
                      <th className="py-2 font-normal">Wished</th>
                      <th className="py-2"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.discord_id}|${r.priority}`} className={`border-b border-line/50 ${r.mostOwed ? 'bg-brass/5' : ''}`}>
                        <td className="py-2">
                          {r.mostOwed && <Star className="w-3.5 h-3.5 text-brassbright fill-current" aria-label="Most owed" />}
                        </td>
                        <td className="py-2 text-bone font-semibold">{r.name}</td>
                        <td className="py-2">
                          <span className={`inline-flex items-center gap-1.5 text-xs ${BUILD_TEXT[r.priority] || 'text-ash'}`}>
                            <span className={`w-2 h-2 rounded-full ${BUILD_DOT[r.priority] || 'bg-line'}`} />
                            {BUILD_SHORT[r.priority] || r.priority}
                          </span>
                        </td>
                        <td className="py-2 text-right font-mono" title={r.eligible != null ? `${r.attended} of the ${r.eligible} nights since they joined` : undefined}>
                          {r.rate == null ? <span className="text-ash/40">—</span> : (
                            <>
                              <span className={r.rate >= LOW_RATE ? 'text-bone' : 'text-brassbright'}>{r.rate}%</span>
                              <span className="text-ash text-xs ml-1.5">{r.attended}/{r.eligible}</span>
                            </>
                          )}
                        </td>
                        <td className="py-2 text-right font-mono">
                          {r.items == null ? <span className="text-ash/40">—</span>
                            : <span className={r.items ? 'text-bone' : 'text-ash/50'}>{r.items}</span>}
                        </td>
                        <td className="py-2 pl-4 text-xs text-ash">{shortDay(r.lastAward) || '—'}</td>
                        <td className="py-2 text-xs text-ash">{shortDay(r.added_at) || '—'}</td>
                        <td className="py-2">
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => onAward(r, rows)} aria-label={`Award ${item.name} to ${r.name}`}
                              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 border border-brass/50 text-brassbright hover:bg-panelup rounded-lg transition-colors">
                              <Gavel className="w-3 h-3" /> Award
                            </button>
                            <button onClick={() => onRemove(r)} disabled={pickBusy}
                              className="p-1 text-ash hover:text-oxblood disabled:opacity-40" title="Remove from their wishlist"
                              aria-label={`Remove ${r.name} from the wishlist for ${item.name}`}>
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {starred && (
                <p className="text-xs text-ash mt-2 flex items-start gap-1.5">
                  <Star className="w-3 h-3 mt-0.5 text-brassbright fill-current shrink-0" aria-hidden="true" />
                  <span>
                    Most owed: the best attendance with the fewest items in this window, among those wanting it for the same build.
                    A hint, not a rule. Award whoever the council picks.
                  </span>
                </p>
              )}
            </>
          )}
          <AddPickRow itemName={item.name} members={eligible} priorities={priorities} busy={pickBusy} onAdd={onAdd} />
        </div>
      )}
    </div>
  );
}

function AwardModal({ pending, statsWindow, busy, onCancel, onConfirm }) {
  const { item, row, others } = pending;
  const short = BUILD_SHORT[row.priority] || row.priority;
  return (
    <Modal onClose={onCancel}>
      <div className="flex items-center gap-2 text-brassbright eyebrow text-[11px] mb-3"><Gavel className="w-4 h-4" /> Loot Council</div>
      <h2 className="font-display text-xl text-bone tracking-[0.04em] mb-4">
        Award <span className={gradeStyle(item.grade)?.color || ''}>{item.name}</span> to {row.name}?
      </h2>
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-sm bg-ink border border-line rounded-lg p-4 mb-4">
        <dt className="text-ash">Build</dt>
        <dd className={`flex items-center gap-1.5 ${BUILD_TEXT[row.priority] || 'text-bone'}`}>
          <span className={`w-2 h-2 rounded-full ${BUILD_DOT[row.priority] || 'bg-line'}`} />{row.priority}
        </dd>
        <dt className="text-ash first-letter:uppercase">{windowLabel(statsWindow)}</dt>
        <dd className="text-bone">
          {row.rate == null ? 'No attendance figures' : (
            <><span className={row.rate >= LOW_RATE ? '' : 'text-brassbright'}>{row.rate}%</span> attendance · {row.items} item{row.items === 1 ? '' : 's'}</>
          )}
        </dd>
        <dt className="text-ash">Last award</dt>
        <dd className="text-bone">{shortDay(row.lastAward) || 'Never'}</dd>
        <dt className="text-ash">Wished</dt>
        <dd className="text-bone">{row.added_at ? `Since ${shortDay(row.added_at)}` : 'Date not recorded'}</dd>
      </dl>
      <p className="text-ash text-sm mb-1">
        {others.length
          ? `${others.length} other${others.length === 1 ? '' : 's'} want${others.length === 1 ? 's' : ''} this for ${short}: ${others.join(', ')}.`
          : `Nobody else wants this for ${short}.`}
      </p>
      <p className="text-ash text-sm mb-6">It will be marked <span className="text-brassbright">Loot Counciled</span> on the tally and on their wishlist.</p>
      <div className="flex justify-end gap-3">
        <Button variant="neutral" size="none" className="px-4 py-2" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button size="none" className="px-5 py-2" disabled={busy} onClick={onConfirm}>
          <Gavel className="w-4 h-4" /> {busy ? 'Awarding…' : 'Award'}
        </Button>
      </div>
    </Modal>
  );
}

// Inline "add a member to this item's wishlist" control, used inside each expanded item.
// Kept as its own component so its in-progress selection doesn't leak between items.
function AddPickRow({ itemName, members, priorities, busy, onAdd }) {
  const [memberId, setMemberId] = useState('');
  const [prio, setPrio] = useState('');

  const submit = () => {
    if (!memberId || !prio) return;
    onAdd(memberId, prio);
    setMemberId(''); setPrio('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3 mt-3 border-t border-line/50">
      <label className="flex-1 min-w-[140px]">
        <span className="sr-only">Add a member to the wishlist for {itemName}</span>
        <select value={memberId} onChange={(e) => setMemberId(e.target.value)}
          className="w-full bg-hall border border-line rounded-lg px-2 py-1.5 text-xs text-bone focus:outline-none focus:border-brass">
          <option value="">— add member —</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
      {priorities.map((p) => (
        <button key={p} type="button" onClick={() => setPrio(p)} aria-pressed={prio === p}
          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition-colors ${prio === p ? BUILD_CHIP_ON[p] : BUILD_CHIP_OFF}`}>
          {BUILD_SHORT[p]}
        </button>
      ))}
      <button type="button" onClick={submit} disabled={!memberId || !prio || busy}
        title={`Add to wishlist for ${itemName}`}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
        <UserPlus className="w-3.5 h-3.5" /> Add
      </button>
    </div>
  );
}
