import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import SHARDS from '../../../shared/shards.json';
import BOSS_WEAPONS from '../../../shared/archbossWeapons.json';
import SHARD_WEAPONS from '../../../shared/shardWeapons.json';
import {
  Check, Loader2, AlertCircle, RefreshCw, Plus, X, ChevronDown, ChevronUp, GripVertical, ListOrdered,
} from 'lucide-react';
import {
  DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import Tabs from '../components/ui/Tabs';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';

// A member's wishlist is a list of weapons, each carrying how many of its shard
// they still need; per-shard totals are the sum over those plus `unlinked`
// (counts carried over from the old per-type table that no single weapon could
// claim). The shape, its caps and the conversion of old rows all live in
// backend/shardWishlist.js — this page reads what the server hands it.
//
// shardFor and costFor mirror that file's. Both read shared/shardWeapons.json,
// so the rule itself ("Snowsoul weapons take the Thunderstruck shard") is
// stated once, in the JSON; only these few lines of reading it are doubled.

const BUILDS = ['PvP', 'PvE'];
// Officer-set and officer-only: the server sends everyone else '' (normal)
// and keeps stored priorities on their saves.
const PRIORITIES = [{ key: 'high', label: 'High' }, { key: '', label: 'Normal' }, { key: 'low', label: 'Low' }];
const PRIORITY_RANK = { high: 0, '': 1, low: 2 };
const SOURCES = SHARD_WEAPONS.sources;
const SOURCE = new Map(SOURCES.map((s) => [s.key, s]));
const WEAPONS_BY_SOURCE = new Map(SOURCES.map((s) => [s.key, s.weapons || BOSS_WEAPONS[s.key] || []]));
const SHARD_LABEL = new Map(SHARDS.types.map((t) => [t.key, t.label]));
// Totals are listed in shards.json order, so every member's chips line up.
const SHARD_ORDER = new Map(SHARDS.types.map((t, i) => [t.key, i]));

const shardFor = (source, weapon) => {
  const s = SOURCE.get(source);
  if (!s) return null;
  return s.snowsoul && String(weapon).includes('Snowsoul') ? s.snowsoul : s.shard;
};
const costFor = (source) => (SOURCE.get(source)?.heroic ? SHARD_WEAPONS.costs.heroic : SHARD_WEAPONS.costs.archboss);
const keyOf = (w) => `${w.boss}|${w.weapon}`;

const emptyWishlist = () => ({ v: 2, weapons: [], unlinked: {} });
const unlinkedTotal = (s) => Object.values(s.unlinked || {}).reduce((a, n) => a + n, 0);
// An unset need (null) counts toward nothing until someone fills it in.
const memberNeed = (s) => s.weapons.reduce((a, w) => a + (w.need || 0), 0) + unlinkedTotal(s);
const memberCost = (s) => s.weapons.reduce((a, w) => a + costFor(w.boss), 0);
const unsetCount = (s) => s.weapons.filter((w) => w.need === null).length;

// Per shard: how many weapons use it, what they still need, what they cost in
// full, and any unlinked count on top.
function shardTotals(list) {
  const out = new Map();
  const at = (k) => {
    if (!out.has(k)) out.set(k, { key: k, label: SHARD_LABEL.get(k) || k, count: 0, need: 0, cost: 0, unlinked: 0 });
    return out.get(k);
  };
  list.forEach((s) => {
    s.weapons.forEach((w) => {
      const t = at(shardFor(w.boss, w.weapon));
      t.count++; t.need += w.need || 0; t.cost += costFor(w.boss);
    });
    Object.entries(s.unlinked || {}).forEach(([k, n]) => { at(k).unlinked += n; });
  });
  return [...out.values()].sort((a, b) => (SHARD_ORDER.get(a.key) ?? 99) - (SHARD_ORDER.get(b.key) ?? 99));
}

function BuildPill({ build }) {
  if (!build) return <span className="text-ash/40 text-xs">—</span>;
  return (
    <span className={`text-[10px] font-bold tracking-wide rounded-full px-2 py-0.5 border ${build === 'PvP' ? 'text-oxblood border-oxblood/40' : 'text-emerald-400 border-emerald-400/40'}`}>
      {build.toUpperCase()}
    </span>
  );
}

// Rendered only for officers; nobody else is shown priority at all.
function PriorityControl({ priority, onChange, label }) {
  return (
    <div className="inline-flex items-center rounded-full border border-line bg-hall p-0.5" role="group" aria-label={`Priority for ${label}`}>
      {PRIORITIES.map((p) => (
        <button
          key={p.key} type="button" onClick={() => onChange(p.key)} aria-pressed={priority === p.key}
          className={`px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide transition-colors ${
            priority === p.key
              ? (p.key === 'high' ? 'bg-brass text-ink' : p.key === 'low' ? 'bg-panelup text-bone' : 'bg-line text-bone')
              : 'text-ash hover:text-bone'
          }`}
        >
          {p.label.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function SourceLabel({ source }) {
  return SOURCE.get(source)?.heroic
    ? <span className="text-[10px] font-bold tracking-wide rounded-full px-2 py-0.5 border text-violet-300 border-violet-400/40">HEROIC</span>
    : <span className="text-ash">{source}</span>;
}

function TotalChip({ t }) {
  return (
    <span className="inline-flex items-center gap-2 bg-hall border border-line rounded-md pl-2.5 pr-1 py-1 text-xs text-ash" title={t.unlinked ? `${t.unlinked} not linked to a weapon` : undefined}>
      <span className="text-bone/80">{t.label}</span>
      {t.count > 0 && <span className="text-ash/70">× {t.count}</span>}
      <span className="font-mono text-bone bg-panelup rounded px-1.5 py-0.5">
        {t.need + t.unlinked}
        {t.count > 0 && <span className="text-ash/50">/{t.cost}</span>}
      </span>
    </span>
  );
}

export default function Shards() {
  const { user, can } = useAuth();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState('member');
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState('name');
  const [status, setStatus] = useState({}); // memberId -> 'saving'|'saved'|'error'
  const [dirty, setDirty] = useState({});   // memberId -> bool
  const [open, setOpen] = useState(() => new Set());
  const [pickerId, setPickerId] = useState(null);

  const canEdit = (id) => user && (can('loot.awards') || user.id === id);
  const canPrioritize = !!user && can('loot.awards');
  // The guild's weapon order, "boss|weapon" keys, first served first.
  // Officers-only, like the per-member priorities, so nobody else loads it.
  const [ranking, setRanking] = useState([]);

  const load = () => {
    setLoading(true); setError('');
    axios.get('/api/members')
      .then((res) => setMembers((res.data.members || []).map((m) => ({ ...m, shards: m.shards?.v === 2 ? m.shards : emptyWishlist() }))))
      .catch((err) => setError(err.response?.data?.error || 'Could not load members.'))
      .finally(() => setLoading(false));
    if (canPrioritize) {
      axios.get('/api/shards/weapon-ranking')
        .then((res) => setRanking(res.data.weapons || []))
        .catch((err) => setError(err.response?.data?.error || 'Could not load the weapon ranking.'));
    }
  };
  useEffect(() => { load(); }, [canPrioritize]);

  // Optimistic: the list moves as soon as it's dropped, and goes back if the
  // save fails.
  const saveRanking = (next) => {
    const before = ranking;
    setRanking(next);
    axios.put('/api/shards/weapon-ranking', { weapons: next })
      .then((res) => setRanking(res.data.weapons || next))
      .catch((err) => {
        setRanking(before);
        setError(err.response?.data?.error || 'Could not save the weapon ranking.');
      });
  };
  const toggleRank = (key) => saveRanking(ranking.includes(key) ? ranking.filter((k) => k !== key) : [...ranking, key]);
  // Your own card starts open: it's the one most people came here to change.
  useEffect(() => { if (user) setOpen((prev) => new Set(prev).add(user.id)); }, [user]);

  const persist = (member) => {
    setDirty((d) => ({ ...d, [member.id]: false }));
    setStatus((s) => ({ ...s, [member.id]: 'saving' }));
    axios.put(`/api/shards/${member.id}`, { shards: member.shards, display_name: member.name })
      .then((res) => {
        // The server stamps Last Updated. Take only those dates back — the
        // rest of the row may have been typed into since this save went out.
        const stamps = new Map((res.data.shards?.weapons || []).map((w) => [keyOf(w), w.updated]));
        setMembers((prev) => prev.map((m) => (m.id !== member.id ? m : {
          ...m,
          shards: { ...m.shards, weapons: m.shards.weapons.map((w) => (stamps.has(keyOf(w)) ? { ...w, updated: stamps.get(keyOf(w)) } : w)) },
        })));
        setStatus((s) => ({ ...s, [member.id]: 'saved' }));
        setTimeout(() => setStatus((s) => ({ ...s, [member.id]: undefined })), 1800);
      })
      .catch((err) => {
        setStatus((s) => ({ ...s, [member.id]: 'error' }));
        setError(err.response?.data?.error || 'Save failed.');
      });
  };

  // Applies `fn` to one member's wishlist; `save` persists straight away
  // (structural changes), otherwise the row is only marked dirty (typing).
  const change = (id, fn, save) => {
    const current = members.find((m) => m.id === id);
    if (!current) return;
    const updated = { ...current, shards: fn(current.shards) };
    setMembers((prev) => prev.map((m) => (m.id === id ? updated : m)));
    if (save) persist(updated);
    else setDirty((d) => ({ ...d, [id]: true }));
  };

  const setNeed = (id, key, raw) => change(id, (s) => ({
    ...s,
    weapons: s.weapons.map((w) => (keyOf(w) !== key ? w : {
      ...w,
      need: raw === '' ? null : Math.max(0, Math.min(costFor(w.boss), parseInt(raw, 10) || 0)),
    })),
  }), false);
  const saveIfDirty = (member) => { if (dirty[member.id]) persist(member); };
  const setPriority = (id, key, priority) => change(id, (s) => ({
    ...s,
    weapons: s.weapons.map((w) => (keyOf(w) !== key ? w : { ...w, priority })),
  }), true);
  const unlink = (id, key) => change(id, (s) => ({ ...s, weapons: s.weapons.filter((w) => keyOf(w) !== key) }), true);
  const clearUnlinked = (m) => {
    if (!window.confirm(`Clear ${unlinkedTotal(m.shards)} shards not linked to a weapon for ${m.name}? Link the weapons they were for first, or that demand is lost.`)) return;
    change(m.id, (s) => ({ ...s, unlinked: {} }), true);
  };
  // A weapon already on the list keeps its need; a newly ticked one starts at
  // its full cost, since nobody farms toward a weapon they're done with.
  const savePicks = (id, picks) => {
    setPickerId(null);
    change(id, (s) => {
      const had = new Map(s.weapons.map((w) => [keyOf(w), w]));
      return {
        ...s,
        weapons: [...picks].map(([key, build]) => {
          const [boss, weapon] = key.split('|');
          const prev = had.get(key);
          return { boss, weapon, build, need: prev ? prev.need : costFor(boss), priority: prev ? prev.priority : '' };
        }),
      };
    }, true);
  };

  const toggleOpen = (id) => setOpen((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  // Self pinned to the top, then by name or by most still needed. Filtered after.
  const ordered = useMemo(() => {
    const f = filter.toLowerCase();
    return [...members]
      .sort((a, b) => {
        if (user && a.id === user.id) return -1;
        if (user && b.id === user.id) return 1;
        if (sortBy === 'need') return memberNeed(b.shards) - memberNeed(a.shards) || (a.name || '').localeCompare(b.name || '');
        return (a.name || '').localeCompare(b.name || '');
      })
      // Names are identity names now; the Discord one still finds them.
      .filter((m) => (m.name || '').toLowerCase().includes(f) || (m.discord_name || '').toLowerCase().includes(f));
  }, [members, filter, user, sortBy]);

  const guildTotals = useMemo(() => shardTotals(members.map((m) => m.shards)), [members]);
  const allOpen = ordered.length > 0 && ordered.every((m) => open.has(m.id));
  const pickerMember = pickerId ? members.find((m) => m.id === pickerId) : null;

  return (
    <PageShell maxWidth="max-w-[1400px]">
      <p className="text-sm text-ash mb-5">
        Link every weapon you&apos;re working toward. Each archboss weapon takes {SHARD_WEAPONS.costs.archboss} of its boss&apos;s shard
        and each Heroic weapon takes {SHARD_WEAPONS.costs.heroic} Otherworldly Mind&apos;s Eye; your shard totals add up from your weapons.
        {' '}{can('loot.awards') ? 'You can edit any member.' : 'You can edit your own; others are read-only.'}
        <span className="block text-bone font-bold uppercase mt-1.5">Put how many you still need, not how many you have AND keep it updated</span>
      </p>

      <Tabs variant="flat" active={view} onChange={setView} items={[{ key: 'member', label: 'By Member' }, { key: 'weapon', label: 'By Weapon' }]} />

      <div className="flex flex-wrap items-center justify-between mb-5 gap-4">
        <div className="flex flex-wrap items-center gap-3 flex-1">
          {view === 'member' && (
            <>
              <input
                value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
                className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
              />
              <label className="inline-flex items-center gap-2 text-sm text-ash">
                Sort
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass">
                  <option value="name">Name</option>
                  <option value="need">Most needed</option>
                </select>
              </label>
              <button
                onClick={() => setOpen(allOpen ? new Set() : new Set(ordered.map((m) => m.id)))}
                className="text-sm text-ash hover:text-brass"
              >
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            </>
          )}
        </div>
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass shrink-0"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>

      {error && (
        <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>
      )}

      {!loading && guildTotals.length > 0 && (
        <div className="panel rounded-lg px-4 py-3 mb-5 flex flex-wrap items-center gap-2">
          <span className="eyebrow text-[10px] text-brass mr-1">Guild still needs</span>
          {guildTotals.map((t) => <TotalChip key={t.key} t={t} />)}
        </div>
      )}

      {loading ? (
        <EmptyState>Reading the vault…</EmptyState>
      ) : view === 'weapon' ? (
        <ByWeapon
          members={members} canPrioritize={canPrioritize} onPriority={setPriority}
          ranking={ranking} onToggleRank={toggleRank} onReorder={saveRanking}
        />
      ) : ordered.length === 0 ? (
        <EmptyState>No members found.</EmptyState>
      ) : (
        <div className="space-y-3">
          {ordered.map((m) => (
            <MemberCard
              key={m.id} m={m}
              mine={user && m.id === user.id}
              editable={canEdit(m.id)}
              canPrioritize={canPrioritize}
              onPriority={(key, p) => setPriority(m.id, key, p)}
              isOpen={open.has(m.id)}
              status={status[m.id]}
              onToggle={() => toggleOpen(m.id)}
              onNeed={(key, raw) => setNeed(m.id, key, raw)}
              onBlur={() => saveIfDirty(m)}
              onUnlink={(key) => unlink(m.id, key)}
              onClearUnlinked={() => clearUnlinked(m)}
              onPick={() => setPickerId(m.id)}
            />
          ))}
        </div>
      )}

      {pickerMember && (
        <WeaponPicker
          member={pickerMember}
          onClose={() => setPickerId(null)}
          onSave={(picks) => savePicks(pickerMember.id, picks)}
        />
      )}
    </PageShell>
  );
}

function MemberCard({ m, mine, editable, canPrioritize, onPriority, isOpen, status, onToggle, onNeed, onBlur, onUnlink, onClearUnlinked, onPick }) {
  const s = m.shards;
  const unlinked = unlinkedTotal(s);
  const unset = unsetCount(s);
  const totals = shardTotals([s]);
  const Chevron = isOpen ? ChevronUp : ChevronDown;

  return (
    <div className={`panel rounded-lg overflow-hidden ${mine ? 'border-brass/40' : ''}`}>
      <button onClick={onToggle} className="w-full flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 text-left hover:bg-panelup/50 transition-colors">
        {m.avatar
          ? <img src={m.avatar} alt="" className="w-8 h-8 rounded-full border border-line shrink-0" />
          : <span className="w-8 h-8 rounded-full bg-panelup border border-line shrink-0 flex items-center justify-center text-xs text-brass">{(m.name || '?').slice(0, 1).toUpperCase()}</span>}
        <span className="flex items-center gap-2 flex-1 min-w-[140px]">
          <span className="text-bone font-semibold truncate">{m.name}</span>
          {mine && <span className="text-[9px] eyebrow text-brass border border-brass/40 rounded-full px-1.5 py-0.5">You</span>}
        </span>
        <span className="text-xs text-ash">{s.weapons.length} weapon{s.weapons.length === 1 ? '' : 's'} linked</span>
        <span className="font-mono text-sm text-brassbright">
          {memberNeed(s)}{s.weapons.length > 0 && <span className="text-ash/50">/{memberCost(s)}</span>}
          <span className="text-ash text-xs font-sans"> needed</span>
        </span>
        {unset > 0 && <span className="text-[11px] text-amber-400 border border-amber-400/40 rounded-full px-2 py-0.5">{unset} to set</span>}
        {unlinked > 0 && <span className="text-[11px] text-amber-400 border border-amber-400/40 rounded-full px-2 py-0.5">{unlinked} not linked</span>}
        <span className="w-4 inline-flex justify-center">
          {status === 'saving' && <Loader2 className="w-4 h-4 text-ash animate-spin" />}
          {status === 'saved' && <Check className="w-4 h-4 text-emerald-400" />}
          {status === 'error' && <AlertCircle className="w-4 h-4 text-oxblood" />}
        </span>
        <Chevron className="w-4 h-4 text-ash" />
      </button>

      {isOpen && (
        <div className="border-t border-line">
          {totals.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-5 py-3 bg-panelup/40">
              <span className="eyebrow text-[10px] text-ash mr-1">Shard totals</span>
              {totals.map((t) => <TotalChip key={t.key} t={t} />)}
            </div>
          )}

          {s.weapons.length === 0 && unlinked === 0 ? (
            <p className="px-5 py-5 text-sm text-ash">No weapons linked yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="eyebrow text-[10px] text-ash text-left">
                    <th className="px-5 py-2.5 font-normal">Weapon</th>
                    <th className="px-3 py-2.5 font-normal">Source</th>
                    <th className="px-3 py-2.5 font-normal">Build</th>
                    {canPrioritize && <th className="px-3 py-2.5 font-normal">Priority</th>}
                    <th className="px-3 py-2.5 font-normal">Shard</th>
                    <th className="px-3 py-2.5 font-normal">Still needed</th>
                    <th className="px-3 py-2.5 font-normal">Last Updated</th>
                    <th className="px-3 py-2.5 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {s.weapons.map((w) => {
                    const cost = costFor(w.boss);
                    const key = keyOf(w);
                    return (
                      <tr key={key} className="border-t border-line/60">
                        <td className="px-5 py-2.5 text-bone">{w.weapon}</td>
                        <td className="px-3 py-2.5"><SourceLabel source={w.boss} /></td>
                        <td className="px-3 py-2.5"><BuildPill build={w.build} /></td>
                        {canPrioritize && (
                          <td className="px-3 py-2.5">
                            <PriorityControl priority={w.priority || ''} label={w.weapon} onChange={(p) => onPriority(key, p)} />
                          </td>
                        )}
                        <td className="px-3 py-2.5 text-ash">{SHARD_LABEL.get(shardFor(w.boss, w.weapon))}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-3">
                            {editable ? (
                              <input
                                type="number" min={0} max={cost} value={w.need ?? ''} placeholder="?"
                                aria-label={`Shards still needed for ${w.weapon}`}
                                onChange={(e) => onNeed(key, e.target.value)}
                                onBlur={onBlur}
                                className={`w-16 bg-hall border rounded px-2 py-1.5 text-center font-mono text-bone focus:outline-none focus:border-brass ${w.need === null ? 'border-amber-400/60' : 'border-line'}`}
                              />
                            ) : (
                              <span className={`font-mono ${w.need === null ? 'text-amber-400' : 'text-bone'}`}>{w.need ?? '?'}</span>
                            )}
                            <span className="font-mono text-ash/60 text-xs">/ {cost}</span>
                            <div className="flex-1 min-w-[60px] max-w-[160px] h-1.5 rounded-full bg-hall overflow-hidden">
                              <div className="h-full rounded-full bg-brass" style={{ width: `${Math.round(((w.need || 0) / cost) * 100)}%` }} />
                            </div>
                          </div>
                        </td>
                        {/* Null for weapons untouched since dates were tracked. */}
                        <td className="px-3 py-2.5 text-xs text-ash whitespace-nowrap" title={w.updated ? new Date(w.updated).toLocaleString() : undefined}>
                          {w.updated ? new Date(w.updated).toLocaleDateString() : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {editable && (
                            <button onClick={() => onUnlink(key)} className="text-ash hover:text-oxblood p-1" aria-label={`Unlink ${w.weapon}`} title="Unlink">
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {unlinked > 0 && (
                    <tr className="border-t border-dashed border-amber-400/30 bg-amber-400/5">
                      <td className="px-5 py-2.5 text-amber-400">Not linked to a weapon</td>
                      <td className="px-3 py-2.5 text-xs text-ash" colSpan={canPrioritize ? 3 : 2}>From before weapons carried shards</td>
                      <td className="px-3 py-2.5" colSpan={3}>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.entries(s.unlinked).map(([k, n]) => (
                            <span key={k} className="inline-flex items-center gap-2 border border-dashed border-amber-400/40 rounded-md pl-2.5 pr-1 py-0.5 text-xs text-ash">
                              {SHARD_LABEL.get(k) || k}
                              <span className="font-mono text-amber-400 bg-panelup rounded px-1.5 py-0.5">{n}</span>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {editable && (
                          <button onClick={onClearUnlinked} className="text-xs text-ash hover:text-oxblood whitespace-nowrap">Clear</button>
                        )}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {editable && (
            <div className="flex justify-end px-5 py-3 border-t border-line/60">
              <Button size="sm" icon={<Plus className="w-4 h-4" />} onClick={onPick}>Link weapons</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// One member wanting one weapon: who, which build, their priority (officers
// only), how many they still need and when they last changed it. Shared by
// the boss tables and the expanded rows of the weapon ranking, so the two
// can't drift into showing different things about the same person.
function Wanter({ x, weaponKey, cost, canPrioritize, onPriority }) {
  const weapon = weaponKey.split('|')[1];
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {x.avatar
        ? <img src={x.avatar} alt="" className="w-5 h-5 rounded-full border border-line" />
        : <span className="w-5 h-5 rounded-full bg-panelup border border-line flex items-center justify-center text-[9px] text-brass">{(x.name || '?')[0].toUpperCase()}</span>}
      <span className="text-bone min-w-[90px]">{x.name}</span>
      <BuildPill build={x.build} />
      {canPrioritize && (
        <PriorityControl
          priority={x.priority} label={`${x.name}'s ${weapon}`}
          onChange={(p) => onPriority(x.id, weaponKey, p)}
        />
      )}
      <span className="text-xs text-ash">
        {x.need === null ? <span className="text-amber-400">not set</span> : <>needs <span className="font-mono text-bone">{x.need}</span> of {cost}</>}
      </span>
      <span className="text-xs text-ash/70 whitespace-nowrap" title={x.updated ? new Date(x.updated).toLocaleString() : undefined}>
        · {x.updated ? `updated ${new Date(x.updated).toLocaleDateString()}` : 'not updated yet'}
      </span>
    </div>
  );
}

// One row of the weapon ranking. The grip is the drag handle (and the keyboard
// handle: space, arrows, space); the rest of the row opens to show who needs
// it, so expanding and dragging never fight over the same click.
function RankRow({ id, rank, info, isOpen, onToggle, onRemove, onPriority }) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id });
  const [boss, weapon] = id.split('|');
  const count = info?.wanters.length || 0;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`bg-panel ${isDragging ? 'relative z-10 shadow-xl ring-1 ring-brass rounded-md' : ''}`}
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          ref={setActivatorNodeRef} {...attributes} {...listeners} type="button"
          aria-label={`Move ${weapon}, ranked ${rank}. Press space, then the arrow keys.`}
          className="p-1 rounded text-ash hover:text-bone hover:bg-panelup cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical className="w-4 h-4" />
        </button>
        <button
          type="button" onClick={onToggle} disabled={!count} aria-expanded={count ? isOpen : undefined}
          className={`flex items-center gap-3 min-w-0 flex-1 text-left rounded ${count ? 'group' : 'cursor-default'}`}
        >
          <span className="font-mono text-brassbright w-7 text-right shrink-0">#{rank}</span>
          <span className="min-w-0 flex-1">
            <span className="text-bone group-hover:text-brassbright transition-colors">{weapon}</span>
            <span className="block text-xs text-ash truncate">
              <SourceLabel source={boss} /> · {SHARD_LABEL.get(shardFor(boss, weapon))}
            </span>
          </span>
          <span className="text-xs text-ash whitespace-nowrap text-right">
            {count
              ? <>{count} want{count === 1 ? 's' : ''} · <span className="font-mono text-bone">{info.need}</span> needed</>
              : <span className="text-ash/60">nobody wants it now</span>}
          </span>
          {count > 0 && <ChevronDown className={`w-4 h-4 text-ash shrink-0 transition-transform group-hover:text-brass ${isOpen ? 'rotate-180' : ''}`} />}
        </button>
        <button type="button" onClick={() => onRemove(id)} aria-label={`Remove ${weapon} from the ranking`}
          className="p-1 rounded text-ash hover:text-oxblood hover:bg-panelup">
          <X className="w-4 h-4" />
        </button>
      </div>
      {isOpen && count > 0 && (
        <div className="pl-[4.75rem] pr-4 pb-3 space-y-1.5 text-sm">
          {info.wanters.map((x) => (
            <Wanter key={x.id} x={x} weaponKey={id} cost={info.cost} canPrioritize onPriority={onPriority} />
          ))}
        </div>
      )}
    </li>
  );
}

// The guild's weapon order, across every boss: whose shards go out first.
// Officers only. A weapon stays ranked when nobody wants it any more, so a
// ranking survives a quiet week; it says so rather than vanishing.
// `visible` is the ranking narrowed by the page's boss and shard filters. Rank
// numbers stay the guild-wide ones, and a drag moves the weapon to the slot of
// the one it was dropped on in the FULL ranking — so reordering while
// filtered only ever swaps weapons the officer can see.
function WeaponRanking({ ranking, visible, filtering, wanted, onReorder, onRemove, onPriority }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const expandable = visible.filter((id) => wanted.get(id)?.wanters.length);
  const allOpen = expandable.length > 0 && expandable.every((id) => open.has(id));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    onReorder(arrayMove(ranking, ranking.indexOf(active.id), ranking.indexOf(over.id)));
  };

  return (
    <section className="mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <h2 className="font-display text-lg text-brassbright tracking-[0.06em] flex items-center gap-2">
          <ListOrdered className="w-4 h-4" /> Weapon priority
        </h2>
        <span className="flex items-baseline gap-4 flex-wrap">
          <span className="text-xs text-ash">
            Officers only. Drag to reorder; #1 gets shards first. Click a weapon to see who needs it.
          </span>
          {expandable.length > 0 && (
            <button type="button" onClick={() => setOpen(allOpen ? new Set() : new Set(expandable))} className="text-sm text-ash hover:text-brass">
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
        </span>
      </div>
      {visible.length === 0 ? (
        <div className="border border-dashed border-line rounded-lg p-5 text-sm text-ash">
          {ranking.length && filtering
            ? 'No ranked weapons match these filters.'
            : <>No weapons ranked yet. Press <span className="text-bone">Rank</span> on a weapon below to start the order.</>}
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={visible} strategy={verticalListSortingStrategy}>
            <ol className="panel rounded-lg divide-y divide-line/60">
              {visible.map((id) => (
                <RankRow
                  key={id} id={id} rank={ranking.indexOf(id) + 1} info={wanted.get(id)}
                  isOpen={open.has(id)} onToggle={() => toggle(id)} onRemove={onRemove} onPriority={onPriority}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {ranking.length > 0 && (
        <p className="text-xs text-ash/70 mt-2">
          {filtering && visible.length < ranking.length && `Showing ${visible.length} of ${ranking.length} ranked weapons. `}
          Add more with <span className="text-ash">Rank</span> on a weapon in the tables below.
        </p>
      )}
    </section>
  );
}

// Every linked weapon in the guild, grouped by where it drops, with who wants
// it — high priority first, then whoever still needs the most. Non-officers
// get every priority as normal, so for them it's need alone and the order
// gives nothing away. For officers, weapons in the guild's ranking come first
// within their boss, in ranked order, and carry their number.
function ByWeapon({ members, canPrioritize, onPriority, ranking, onToggleRank, onReorder }) {
  const [source, setSource] = useState('all');
  const [shard, setShard] = useState('all');
  const rankOf = useMemo(() => new Map(ranking.map((k, i) => [k, i + 1])), [ranking]);

  // The shards a boss filter leaves to choose from: one per source, two for
  // Cordy and Deluzhnoa, whose Snowsoul weapons take a different shard.
  const shardChoices = useMemo(() => {
    const keys = new Set(SOURCES.filter((s) => source === 'all' || s.key === source)
      .flatMap((s) => [s.shard, s.snowsoul].filter(Boolean)));
    return [...keys].sort((a, b) => (SHARD_ORDER.get(a) ?? 99) - (SHARD_ORDER.get(b) ?? 99));
  }, [source]);
  // Picking a boss that doesn't drop the chosen shard would show nothing, so
  // the shard filter falls back to All rather than leaving an empty page.
  useEffect(() => { if (shard !== 'all' && !shardChoices.includes(shard)) setShard('all'); }, [shardChoices, shard]);

  const matches = (boss, weapon) => (source === 'all' || boss === source)
    && (shard === 'all' || shardFor(boss, weapon) === shard);

  const groups = useMemo(() => SOURCES.map((src) => {
    const byWeapon = new Map();
    members.forEach((m) => m.shards.weapons.forEach((w) => {
      if (w.boss !== src.key) return;
      if (!byWeapon.has(w.weapon)) byWeapon.set(w.weapon, []);
      byWeapon.get(w.weapon).push({ id: m.id, name: m.name, avatar: m.avatar, build: w.build, need: w.need, priority: w.priority || '', updated: w.updated });
    }));
    const cost = costFor(src.key);
    const weapons = [...byWeapon.entries()]
      .map(([weapon, wanters]) => ({
        weapon,
        wanters: wanters.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (b.need || 0) - (a.need || 0)),
        need: wanters.reduce((a, x) => a + (x.need || 0), 0),
        cost: cost * wanters.length,
      }))
      .sort((a, b) => (rankOf.get(`${src.key}|${a.weapon}`) ?? Infinity) - (rankOf.get(`${src.key}|${b.weapon}`) ?? Infinity)
        || b.wanters.length - a.wanters.length || a.weapon.localeCompare(b.weapon));
    return { key: src.key, cost, weapons, need: weapons.reduce((a, w) => a + w.need, 0) };
  }), [members, rankOf]);

  // Each ranked weapon's wanters, for the ranking panel — the same list, in
  // the same priority-then-need order, as its row in the boss tables.
  const wanted = useMemo(() => new Map(groups.flatMap((g) => g.weapons.map((w) => [
    `${g.key}|${w.weapon}`, { wanters: w.wanters, need: w.need, cost: g.cost },
  ]))), [groups]);

  // Each boss group cut down to the weapons both filters allow, with its
  // totals recounted so the header matches the rows under it.
  const shown = groups
    .map((g) => {
      const weapons = g.weapons.filter((w) => matches(g.key, w.weapon));
      return { ...g, weapons, need: weapons.reduce((a, w) => a + w.need, 0) };
    })
    .filter((g) => g.weapons.length);
  const filtering = source !== 'all' || shard !== 'all';
  const shownRanking = ranking.filter((k) => { const [boss, weapon] = k.split('|'); return matches(boss, weapon); });

  const chip = (active) => `px-3 py-1.5 rounded-full text-xs border transition-colors ${active ? 'border-brass text-brassbright bg-brass/10' : 'border-line text-ash hover:text-bone'}`;

  return (
    <div>
      <div className="space-y-2 mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow text-[10px] text-ash w-12">Boss</span>
          {[{ key: 'all', label: 'All' }, ...SOURCES.map((s) => ({ key: s.key, label: s.key }))].map((s) => (
            <button key={s.key} type="button" onClick={() => setSource(s.key)} aria-pressed={source === s.key} className={chip(source === s.key)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow text-[10px] text-ash w-12">Shard</span>
          {['all', ...shardChoices].map((k) => (
            <button key={k} type="button" onClick={() => setShard(k)} aria-pressed={shard === k} className={chip(shard === k)}>
              {k === 'all' ? 'All' : SHARD_LABEL.get(k) || k}
            </button>
          ))}
        </div>
      </div>

      {canPrioritize && (
        <WeaponRanking
          ranking={ranking} visible={shownRanking} filtering={filtering} wanted={wanted}
          onReorder={onReorder} onRemove={onToggleRank} onPriority={onPriority}
        />
      )}

      {shown.length === 0 ? (
        <EmptyState>
          Nobody has linked a weapon
          {shard !== 'all' ? ` that takes ${SHARD_LABEL.get(shard) || shard}` : source !== 'all' ? ` from ${source}` : ''} yet.
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {shown.map((g) => (
            <section key={g.key}>
              <div className="flex flex-wrap items-baseline gap-3 mb-3">
                <h2 className="font-display text-lg text-brassbright tracking-[0.06em]">{g.key}</h2>
                <span className="text-xs text-ash">
                  {g.weapons.length} weapon{g.weapons.length === 1 ? '' : 's'} wanted · <span className="font-mono text-bone">{g.need}</span> shards still needed · {g.cost} per weapon
                </span>
              </div>
              <div className="panel rounded-lg overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead>
                    <tr className="eyebrow text-[10px] text-ash text-left">
                      <th className="px-5 py-2.5 font-normal">Weapon</th>
                      <th className="px-3 py-2.5 font-normal text-right">Wants</th>
                      <th className="px-3 py-2.5 font-normal">Members · build{canPrioritize ? ' · priority' : ''} · still needed · last updated</th>
                      <th className="px-5 py-2.5 font-normal text-right">Still needed / total cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.weapons.map((w) => {
                      const rank = rankOf.get(`${g.key}|${w.weapon}`);
                      return (
                      <tr key={w.weapon} className="border-t border-line/60 align-top">
                        <td className="px-5 py-3 text-bone">
                          <span className="flex items-center gap-2 flex-wrap">
                            {canPrioritize && rank && (
                              <span className="font-mono text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-brass text-ink" title={`Ranked #${rank} in weapon priority`}>#{rank}</span>
                            )}
                            {w.weapon}
                          </span>
                          <div className="text-xs text-ash mt-0.5">{SHARD_LABEL.get(shardFor(g.key, w.weapon))}</div>
                          {canPrioritize && (
                            <button
                              type="button" onClick={() => onToggleRank(`${g.key}|${w.weapon}`)}
                              className="mt-1.5 inline-flex items-center gap-1 text-xs text-ash hover:text-brassbright"
                            >
                              <ListOrdered className="w-3 h-3" /> {rank ? 'Unrank' : 'Rank'}
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right font-mono text-bone">{w.wanters.length}</td>
                        <td className="px-3 py-3">
                          <div className="space-y-1.5">
                            {w.wanters.map((x) => (
                              <Wanter
                                key={x.id} x={x} weaponKey={`${g.key}|${w.weapon}`} cost={g.cost}
                                canPrioritize={canPrioritize} onPriority={onPriority}
                              />
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-3 text-right font-mono text-brassbright">
                          {w.need}<span className="text-ash/50">/{w.cost}</span>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

// Tick any number of weapons across every source, each with an optional
// PvP/PvE tag. Keeps its own draft so nothing is written until Save.
function WeaponPicker({ member, onClose, onSave }) {
  const [tab, setTab] = useState(SOURCES[0].key);
  // key -> build ('' when untagged); insertion order is the saved order.
  const [picks, setPicks] = useState(() => new Map(member.shards.weapons.map((w) => [keyOf(w), w.build])));

  const toggle = (key) => setPicks((prev) => {
    const next = new Map(prev);
    next.has(key) ? next.delete(key) : next.set(key, '');
    return next;
  });
  const setBuild = (key, build) => setPicks((prev) => new Map(prev).set(key, prev.get(key) === build ? '' : build));

  const pickedIn = (src) => [...picks.keys()].filter((k) => k.startsWith(`${src}|`)).length;
  const summary = shardTotals([{
    weapons: [...picks.keys()].map((k) => {
      const [boss, weapon] = k.split('|');
      return { boss, weapon, need: costFor(boss) };
    }),
    unlinked: {},
  }]);
  const src = SOURCE.get(tab);

  return (
    <Modal onClose={onClose} maxWidth="max-w-2xl" scrollable>
      <div className="flex items-start gap-3 mb-1">
        <div className="eyebrow text-brass text-[11px]">Link weapons</div>
        <button onClick={onClose} className="ml-auto text-ash hover:text-bone" aria-label="Close"><X className="w-4 h-4" /></button>
      </div>
      <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-1">{member.name}</h2>
      <p className="text-xs text-ash mb-4">
        Tick every weapon you&apos;re working toward, across as many sources as you like. A new one starts at its full cost; lower it to what you still need after saving.
      </p>

      <div className="flex flex-wrap gap-1.5 mb-3">
        {SOURCES.map((s) => {
          const n = pickedIn(s.key);
          return (
            <button
              key={s.key} onClick={() => setTab(s.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-colors ${tab === s.key ? 'border-brass text-brassbright bg-brass/10' : 'border-line text-ash hover:text-bone'}`}
            >
              {s.key}
              {n > 0 && <span className={`font-mono text-[10px] rounded-full px-1.5 ${tab === s.key ? 'bg-brass text-ink' : 'bg-panelup text-bone'}`}>{n}</span>}
            </button>
          );
        })}
      </div>

      <div className="text-xs text-ash mb-2">
        {src.heroic ? 'Heroic weapons' : `${tab} weapons`} use <span className="text-bone">{SHARD_LABEL.get(src.shard)}</span>
        {src.snowsoul && <> (Snowsoul: <span className="text-bone">{SHARD_LABEL.get(src.snowsoul)}</span>)</>}
        {' '}· <span className="font-mono text-bone">{costFor(tab)}</span> each
      </div>

      <div className="border border-line rounded-lg divide-y divide-line/60 mb-4">
        {WEAPONS_BY_SOURCE.get(tab).map((weapon) => {
          const key = `${tab}|${weapon}`;
          const on = picks.has(key);
          const build = picks.get(key);
          return (
            <div key={key} className="flex items-center gap-2 px-3 py-2">
              <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer select-none">
                <input type="checkbox" checked={on} onChange={() => toggle(key)} className="accent-brass shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm text-bone truncate">{weapon}</span>
                  {src.snowsoul && <span className="block text-[11px] text-ash">{SHARD_LABEL.get(shardFor(tab, weapon))}</span>}
                </span>
              </label>
              {on && (
                <div className="inline-flex items-center rounded-full border border-line bg-hall p-0.5 shrink-0">
                  {BUILDS.map((b) => (
                    <button
                      key={b} type="button" onClick={() => setBuild(key, b)}
                      className={`px-2 py-0.5 rounded-full text-[9px] font-bold tracking-wide transition-colors ${
                        build === b ? (b === 'PvP' ? 'bg-oxblood text-bone' : 'bg-emerald-500 text-ink') : 'text-ash hover:text-bone'
                      }`}
                    >
                      {b.toUpperCase()}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-5">
        <span className="eyebrow text-[10px] text-ash mr-1">Selected · {picks.size}</span>
        {summary.length === 0
          ? <span className="text-xs text-ash/60">nothing yet</span>
          : summary.map((t) => (
            <span key={t.key} className="inline-flex items-center gap-2 bg-hall border border-line rounded-md pl-2.5 pr-1 py-1 text-xs text-ash">
              {t.label} <span className="text-ash/70">× {t.count}</span>
              <span className="font-mono text-brassbright bg-panelup rounded px-1.5 py-0.5">{t.cost}</span>
            </span>
          ))}
      </div>

      <div className="flex justify-end gap-3">
        <Button variant="neutral" size="none" className="px-4 py-2" onClick={onClose}>Cancel</Button>
        <Button size="none" className="px-5 py-2" onClick={() => onSave(picks)}>Save</Button>
      </div>
    </Modal>
  );
}
