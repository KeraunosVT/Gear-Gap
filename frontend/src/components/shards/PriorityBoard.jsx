import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { RefreshCw, Send } from 'lucide-react';
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter, pointerWithin,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import ErrorBanner from '../ui/ErrorBanner';
import Toast from '../ui/Toast';
import { useFlash } from '../ui/useFlash';
import { SOURCES, SHARD_LABEL, costFor, shardFor } from '../../shardRules';
import RequestTables from './RequestTables';
import PriorityList from './PriorityList';
import PostPriorityModal from './PostPriorityModal';
import { BuildPill } from './MemberBits';

// ── THE SHARDS PAGE'S PRIORITY TAB ──────────────────────────────────────────
// Officers only. Left two-thirds: every PvP/PvE request not yet ranked, laid
// out like the By Weapon tab. Right third: one combined list across every
// shard and both builds — whoever is first gets the next shard. Members are
// dragged (or +'d) from left to right, and the list is posted to Discord.
//
// A request is one member wanting one weapon, keyed "discordId|boss|weapon"
// (backend/shardPriority.js). Requests come from the wishlists the page has
// already loaded; the list, the table order, confirmations, attendance and
// loot history come from /api/admin/shard-priority.
//
// Every change saves straight away and goes back if the save fails, like the
// weapon ranking on the By Weapon tab.

const BUILDS = ['PvP', 'PvE'];
const SOURCE_ORDER = SOURCES.map((s) => s.key);
const kindOf = (id) => String(id).split(':')[0];
const centreY = (rect) => (rect ? rect.top + rect.height / 2 : 0);
const byNeed = (a, b) => (b.need ?? 0) - (a.need ?? 0) || (a.name || '').localeCompare(b.name || '');
const placedIn = (order) => (name) => {
  const i = order.indexOf(name);
  return i === -1 ? Infinity : i;
};
// Officers' own order, then anything not yet placed after it — names that
// dropped out of view (everyone ranked) keep their slot for when they return.
const withRest = (shown, previous) => [...shown, ...(previous || []).filter((n) => !shown.includes(n))];

// Per-officer layout choices, kept in this browser only. Storage can be
// missing or refuse (private windows), so every read and write is guarded.
const PREF = 'gg.shardPriority.';
const readPref = (k, fallback) => {
  try { const v = localStorage.getItem(PREF + k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
};
const writePref = (k, v) => { try { localStorage.setItem(PREF + k, JSON.stringify(v)); } catch { /* not kept */ } };

// Which drop targets a drag can land on. Weapons only move within their own
// boss's table and tables only among tables; a member line goes into the
// priority list (onto a row, or the empty panel); a priority row moves within
// the list or back onto the request area to come off it.
function collide(args) {
  const { active } = args;
  const k = kindOf(active.id);
  const all = args.droppableContainers;
  if (k === 'boss') return closestCenter({ ...args, droppableContainers: all.filter((c) => kindOf(c.id) === 'boss') });
  if (k === 'wpn') {
    const boss = active.data.current?.boss;
    return closestCenter({ ...args, droppableContainers: all.filter((c) => kindOf(c.id) === 'wpn' && c.data.current?.boss === boss) });
  }
  const zones = pointerWithin({ ...args, droppableContainers: all.filter((c) => kindOf(c.id) === 'zone') });
  if (zones.some((z) => z.id === 'zone:priority')) {
    const rows = all.filter((c) => kindOf(c.id) === 'pri');
    const near = rows.length ? closestCenter({ ...args, droppableContainers: rows }) : [];
    return near.length ? near : zones.filter((z) => z.id === 'zone:priority');
  }
  if (k === 'pri' && zones.some((z) => z.id === 'zone:requests')) return zones.filter((z) => z.id === 'zone:requests');
  return [];
}

export default function PriorityBoard({ members, onRefreshMembers }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [list, setList] = useState([]);
  const [weaponOrder, setWeaponOrder] = useState({});
  const [bossOrder, setBossOrder] = useState([]);
  const [confirmations, setConfirmations] = useState({});
  const [confirmBusy, setConfirmBusy] = useState(() => new Set());
  const [posted, setPosted] = useState(null);
  const [posting, setPosting] = useState(false);
  const [active, setActive] = useState(null);
  const [hint, setHint] = useState(null);
  const [mode, setModeState] = useState(() => readPref('mode', 'weapon'));
  const [collapsed, setCollapsedState] = useState(() => new Set(readPref('collapsed', [])));
  const [msg, flash] = useFlash();

  const setMode = (m) => { setModeState(m); writePref('mode', m); };
  const setCollapsed = (next) => { setCollapsedState(next); writePref('collapsed', [...next]); };

  const load = useCallback(() => {
    setLoading(true); setError('');
    axios.get('/api/admin/shard-priority')
      .then((res) => {
        const d = res.data;
        setData(d);
        setList(d.requests || []);
        setWeaponOrder(d.weapon_order || {});
        setBossOrder(d.boss_order || []);
        setConfirmations(d.confirmations || {});
        setPosted(d.posted || null);
        if (d.attendance === null || d.loot === null) {
          setError(`${[d.attendance === null && 'Attendance', d.loot === null && 'Loot history'].filter(Boolean).join(' and ')} couldn't be loaded; the list still works.`);
        }
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the priority list.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  // ── Requests, from the wishlists already on the page ──
  const { requests, untagged } = useMemo(() => {
    const out = new Map();
    let none = 0;
    members.forEach((m) => (m.shards?.weapons || []).forEach((w) => {
      if (!BUILDS.includes(w.build)) { none++; return; }
      const key = `${m.id}|${w.boss}|${w.weapon}`;
      out.set(key, {
        key, discordId: String(m.id), name: m.name, avatar: m.avatar, boss: w.boss, weapon: w.weapon,
        build: w.build, need: w.need, cost: costFor(w.boss), shard: shardFor(w.boss, w.weapon), updated: w.updated,
      });
    }));
    return { requests: out, untagged: none };
  }, [members]);

  // The saved list narrowed to requests that still exist; every edit starts
  // from this, so an entry whose weapon was unlinked drops out on next save.
  const live = useMemo(() => list.filter((k) => requests.has(k)), [list, requests]);
  const ranked = useMemo(() => new Set(live), [live]);
  const rows = useMemo(() => live.map((k) => requests.get(k)), [live, requests]);
  const unranked = useMemo(() => [...requests.values()].filter((r) => !ranked.has(r.key)).sort(byNeed), [requests, ranked]);

  const groups = useMemo(() => {
    const bySource = new Map();
    unranked.forEach((r) => {
      if (!bySource.has(r.boss)) bySource.set(r.boss, new Map());
      const weapons = bySource.get(r.boss);
      if (!weapons.has(r.weapon)) weapons.set(r.weapon, { weapon: r.weapon, shard: r.shard, PvP: [], PvE: [], all: [] });
      const w = weapons.get(r.weapon);
      w[r.build].push(r);
      w.all.push(r);
    });
    const bossPlace = placedIn(bossOrder);
    return [...bySource.keys()]
      .sort((a, b) => bossPlace(a) - bossPlace(b) || SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b))
      .map((boss) => {
        const place = placedIn(weaponOrder[boss] || []);
        const weapons = [...bySource.get(boss).values()]
          .map((w) => ({ ...w, wants: w.all.length, need: w.all.reduce((a, r) => a + (r.need || 0), 0), total: costFor(boss) * w.all.length }))
          .sort((a, b) => place(a.weapon) - place(b.weapon) || b.wants - a.wants || b.need - a.need || a.weapon.localeCompare(b.weapon));
        return { boss, weapons, need: weapons.reduce((a, w) => a + w.need, 0), cost: costFor(boss) };
      });
  }, [unranked, bossOrder, weaponOrder]);

  const flat = useMemo(() => ({ PvP: unranked.filter((r) => r.build === 'PvP'), PvE: unranked.filter((r) => r.build === 'PvE') }), [unranked]);
  const counts = { PvP: flat.PvP.length, PvE: flat.PvE.length, total: requests.size };

  // ── Saving ──
  const saveList = (next) => {
    const before = list;
    setList(next);
    axios.put('/api/admin/shard-priority/list', { requests: next })
      .catch((err) => {
        setList(before);
        setError(err.response?.data?.error || 'Could not save the priority list.');
      });
  };
  const insertAt = (keys, index) => {
    const rest = live.filter((k) => !keys.includes(k));
    const at = Math.max(0, Math.min(index ?? rest.length, rest.length));
    saveList([...rest.slice(0, at), ...keys, ...rest.slice(at)]);
  };
  const add = (key) => insertAt([key]);
  const addMany = (reqs) => insertAt(reqs.map((r) => r.key).filter((k) => !ranked.has(k)));
  const remove = (key) => saveList(live.filter((k) => k !== key));
  const moveRow = (key, delta) => {
    const i = live.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= live.length) return;
    saveList(arrayMove(live, i, j));
  };
  const clearList = () => {
    if (!window.confirm(`Take all ${live.length} entries off the priority list?`)) return;
    saveList([]);
  };

  const saveOrder = (patch) => {
    const before = { weaponOrder, bossOrder };
    if (patch.weapon_order) setWeaponOrder(patch.weapon_order);
    if (patch.boss_order) setBossOrder(patch.boss_order);
    axios.put('/api/admin/shard-priority/order', patch).catch((err) => {
      setWeaponOrder(before.weaponOrder);
      setBossOrder(before.bossOrder);
      setError(err.response?.data?.error || 'Could not save the table order.');
    });
  };
  const moveWeaponTo = (boss, from, to) => {
    const names = groups.find((g) => g.boss === boss)?.weapons.map((w) => w.weapon) || [];
    if (from < 0 || to < 0 || to >= names.length || from === to) return;
    saveOrder({ weapon_order: { ...weaponOrder, [boss]: withRest(arrayMove(names, from, to), weaponOrder[boss]) } });
  };
  const moveWeapon = (boss, weapon, delta) => {
    const names = groups.find((g) => g.boss === boss)?.weapons.map((w) => w.weapon) || [];
    const i = names.indexOf(weapon);
    moveWeaponTo(boss, i, i + delta);
  };
  const moveBossTo = (from, to) => {
    const names = groups.map((g) => g.boss);
    if (from < 0 || to < 0 || to >= names.length || from === to) return;
    saveOrder({ boss_order: withRest(arrayMove(names, from, to), bossOrder) });
  };
  const moveBoss = (boss, delta) => {
    const i = groups.findIndex((g) => g.boss === boss);
    moveBossTo(i, i + delta);
  };

  const toggleConfirm = (key, isOn) => {
    setConfirmBusy((s) => new Set(s).add(key));
    const call = isOn
      ? axios.delete('/api/admin/shard-priority/confirmations', { params: { key } })
      : axios.put('/api/admin/shard-priority/confirmations', { key });
    call
      .then((res) => setConfirmations((c) => {
        const next = { ...c };
        if (isOn) delete next[key];
        else next[key] = { need: res.data.need, by_name: res.data.by_name, at: res.data.at };
        return next;
      }))
      .catch((err) => setError(err.response?.data?.error || 'Could not save the confirmation.'))
      .finally(() => setConfirmBusy((s) => { const n = new Set(s); n.delete(key); return n; }));
  };

  const bits = {
    attendanceFor: (id) => data?.attendance?.[id] || null,
    attendanceDays: data?.attendance_days || 14,
    lootFor: (id) => (data?.loot ? data.loot[id] || [] : null),
    lootDays: data?.loot_days || 90,
    confirmations, onConfirm: toggleConfirm, confirmBusy, onAdd: add,
  };

  // ── Dragging ──
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragStart = ({ active: a }) => setActive({ id: String(a.id), ...(a.data.current || {}) });
  // Where a member line dragged in from the tables will land.
  const onDragMove = ({ active: a, over }) => {
    if (kindOf(a.id) !== 'req') return;
    const next = over && kindOf(over.id) === 'pri'
      ? { key: over.data.current?.key, after: centreY(a.rect.current.translated) > centreY(over.rect) }
      : null;
    setHint((h) => (h?.key === next?.key && h?.after === next?.after ? h : next));
  };
  const reset = () => { setActive(null); setHint(null); };
  const onDragEnd = ({ active: a, over }) => {
    reset();
    if (!over) return;
    const k = kindOf(a.id);
    const target = String(over.id);
    if (k === 'boss' && kindOf(target) === 'boss') {
      const names = groups.map((g) => g.boss);
      moveBossTo(names.indexOf(String(a.id).slice(5)), names.indexOf(target.slice(5)));
    } else if (k === 'wpn' && kindOf(target) === 'wpn') {
      const boss = a.data.current?.boss;
      const names = groups.find((g) => g.boss === boss)?.weapons.map((w) => w.weapon) || [];
      const weaponOf = (id) => id.slice(4 + boss.length + 1);
      moveWeaponTo(boss, names.indexOf(weaponOf(String(a.id))), names.indexOf(weaponOf(target)));
    } else if (k === 'req') {
      const key = a.data.current?.key;
      if (kindOf(target) === 'pri') {
        const after = centreY(a.rect.current.translated) > centreY(over.rect);
        insertAt([key], live.indexOf(over.data.current?.key) + (after ? 1 : 0));
      } else if (target === 'zone:priority') {
        add(key);
      }
    } else if (k === 'pri') {
      const key = a.data.current?.key;
      if (kindOf(target) === 'pri') {
        const from = live.indexOf(key);
        const to = live.indexOf(over.data.current?.key);
        if (from !== to && from >= 0 && to >= 0) saveList(arrayMove(live, from, to));
      } else if (target === 'zone:requests') {
        remove(key);
      }
    }
  };

  const changed = posted ? posted.requests.join(',') !== live.join(',') : live.length > 0;
  const rankedBy = (b) => rows.filter((r) => r.build === b).length;
  const dragged = active?.type === 'req' ? requests.get(active.key) : null;

  if (loading && !data) return <EmptyState>Reading the priority list…</EmptyState>;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex flex-wrap items-center gap-2 text-sm text-ash">
          {BUILDS.map((b) => (
            <span key={b} className="inline-flex items-center gap-2 panel rounded-full px-3 py-1.5">
              <BuildPill build={b} />
              <span><span className="font-mono text-bone">{counts[b] + rankedBy(b)}</span> requests · <span className="font-mono text-bone">{rankedBy(b)}</span> ranked</span>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-xs text-ash">
            {posted
              ? <>Last posted <span className="text-bone">{new Date(posted.at).toLocaleString()}</span>{posted.by_name ? ` by ${posted.by_name}` : ''}</>
              : 'Not posted yet'}
            {posted && changed && <span className="text-amber-600 dark:text-amber-400"> · changed since</span>}
          </span>
          <button type="button" onClick={() => { load(); onRefreshMembers?.(); }} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <Button size="sm" icon={<Send className="w-4 h-4" />} onClick={() => setPosting(true)} disabled={!rows.length}>
            Post to Loot Council
          </Button>
        </div>
      </div>

      <ErrorBanner>{error}</ErrorBanner>
      <Toast msg={msg} />

      <DndContext sensors={sensors} collisionDetection={collide} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd} onDragCancel={reset}>
        <div className="grid gap-5 xl:grid-cols-3 items-start">
          <div className="xl:col-span-2 min-w-0">
            <RequestTables
              mode={mode} onMode={setMode} groups={groups} flat={flat} counts={counts} untagged={untagged}
              collapsed={collapsed}
              onToggleBoss={(boss) => { const n = new Set(collapsed); n.has(boss) ? n.delete(boss) : n.add(boss); setCollapsed(n); }}
              onToggleAll={(anyOpen) => setCollapsed(anyOpen ? new Set(groups.map((g) => g.boss)) : new Set())}
              bits={bits} onMoveBoss={moveBoss} onMoveWeapon={moveWeapon} onAddAll={addMany}
              dropActive={active?.type === 'pri'}
            />
          </div>
          <div className="min-w-0 xl:sticky xl:top-4">
            <PriorityList
              rows={rows} bits={bits} hint={hint} dropActive={active?.type === 'req'}
              onMove={moveRow} onRemove={remove} onFillByNeed={() => addMany(unranked)} onClear={clearList}
              canFill={unranked.length > 0}
            />
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragged ? (
            <div className="panel rounded-md shadow-2xl ring-1 ring-brass px-3 py-2 text-sm flex items-center gap-2 max-w-xs">
              <span className="text-bone font-semibold">{dragged.name}</span>
              <BuildPill build={dragged.build} />
              <span className="text-xs text-ash truncate">{SHARD_LABEL.get(dragged.shard)} · {dragged.weapon}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {posting && (
        <PostPriorityModal
          onClose={() => setPosting(false)}
          onPosted={(p, channelName, count) => {
            setPosting(false);
            setPosted(p);
            flash(`Posted ${count} ${count === 1 ? 'entry' : 'entries'}${channelName ? ` to #${channelName}` : ''}.`);
          }}
        />
      )}
    </div>
  );
}
