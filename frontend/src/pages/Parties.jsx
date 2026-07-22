import { useState, useEffect, useMemo, useRef, forwardRef } from 'react';
import axios from 'axios';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, closestCorners,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAuth } from '../auth';
import RestrictedGate from '../components/ui/RestrictedGate';
import Button from '../components/ui/Button';
import { PageShell } from '../components/ui/PageShell';
import { todayInGuildTz } from '../timeUtils';
import { Save, Trash2, Send, Plus, RefreshCw, Users, CalendarOff } from 'lucide-react';

const ROLES = ['Tank', 'DPS', 'Healer'];
const ROLE_STYLE = {
  Tank:   { dot: 'bg-sky-400',     ring: 'border-l-sky-400' },
  DPS:    { dot: 'bg-oxblood',     ring: 'border-l-oxblood' },
  Healer: { dot: 'bg-emerald-400', ring: 'border-l-emerald-400' },
};
const PARTY_SIZE = 6;
const PARTY_IDS = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);

// Members sit in a role-specific pool (or "unassigned" if no role is set yet).
const POOL_ROLE_KEY = { Tank: 'pool_tank', DPS: 'pool_dps', Healer: 'pool_healer' };
const POOL_KEYS = ['pool_unassigned', 'pool_tank', 'pool_dps', 'pool_healer'];
const poolForRole = (role) => POOL_ROLE_KEY[role] || 'pool_unassigned';
const POOL_META = [
  { key: 'pool_tank', label: 'Tank', dot: 'bg-sky-400' },
  { key: 'pool_dps', label: 'DPS', dot: 'bg-oxblood' },
  { key: 'pool_healer', label: 'Healer', dot: 'bg-emerald-400' },
  { key: 'pool_unassigned', label: 'Unassigned', dot: 'bg-ash' },
];

const initItems = () => ({
  ...Object.fromEntries(POOL_KEYS.map((k) => [k, []])),
  absent: [],
  ...Object.fromEntries(PARTY_IDS.map((id) => [id, []])),
});
const initNames = () => Object.fromEntries(PARTY_IDS.map((id, i) => [id, `Party ${i + 1}`]));
const findContainer = (id, src) => (id in src ? id : Object.keys(src).find((k) => src[k].includes(id)));

const ROLE_COLOR = { Tank: '#38bdf8', DPS: '#b0423a', Healer: '#4ade80' };
const ROLE_SYMBOL = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };

function renderRosterImage(partyIds, items, partyNames, roles, byId, classMode, classAssignments) {
  const parties = partyIds.filter((pid) => items[pid].length > 0);
  if (parties.length === 0) return null;

  const cols = Math.min(parties.length, 4);
  const rows = Math.ceil(parties.length / cols);
  const colW = 260;
  const rowH = 32;
  const headerH = 36;
  const padX = 20;
  const padY = 20;
  const gapX = 16;
  const gapY = 16;
  const titleH = 48;

  const maxMembers = Math.max(...parties.map((pid) => items[pid].length));
  const cardH = headerH + maxMembers * rowH + 12;
  const w = padX * 2 + cols * colW + (cols - 1) * gapX;
  const h = padY + titleH + rows * cardH + (rows - 1) * gapY + padY;

  const canvas = document.createElement('canvas');
  canvas.width = w * 2;
  canvas.height = h * 2;
  const ctx = canvas.getContext('2d');
  ctx.scale(2, 2);

  // Background
  ctx.fillStyle = '#121214';
  ctx.fillRect(0, 0, w, h);

  // Title
  ctx.fillStyle = '#d64545';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ROSTER', w / 2, padY + 14);
  ctx.fillStyle = '#ececeb';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(partyNames[parties[0]]?.replace(/Party \d+/, '').trim() ? '' : 'Parties', w / 2, padY + 36);

  parties.forEach((pid, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = padX + col * (colW + gapX);
    const y = padY + titleH + row * (cardH + gapY);

    // Card background
    ctx.fillStyle = '#1b1b1e';
    ctx.strokeStyle = '#2c2c30';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, colW, cardH, 4);
    ctx.fill();
    ctx.stroke();

    // Party name header
    ctx.fillStyle = '#d64545';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(partyNames[pid] || `Party ${idx + 1}`, x + 10, y + 22);

    // Count
    ctx.fillStyle = '#8a8a8d';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${items[pid].length}/${PARTY_SIZE}`, x + colW - 10, y + 22);

    // Members
    items[pid].forEach((memberId, mi) => {
      const member = byId[memberId] || { name: 'Unknown' };
      const role = roles[memberId] || '';
      const my = y + headerH + mi * rowH;

      const classes = ((classMode === 'pve' ? member.pve_classes : member.pvp_classes) || []).filter(Boolean);
      const cls = classAssignments?.[classMode]?.[memberId] || classes[0] || '';

      // Role color bar
      if (ROLE_COLOR[role]) {
        ctx.fillStyle = ROLE_COLOR[role];
        ctx.fillRect(x + 8, my + 2, 3, rowH - 6);
      }

      // Role symbol
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillStyle = '#8a8a8d';
      if (ROLE_SYMBOL[role]) {
        ctx.fillText(ROLE_SYMBOL[role], x + 16, my + 20);
      }

      // Class (right-aligned)
      const classW = 78;
      if (cls) {
        ctx.fillStyle = '#d64545';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(cls, x + colW - 10, my + 20, classW);
      }

      // Name
      ctx.fillStyle = '#ececeb';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'left';
      const nameX = x + (role ? 36 : 16);
      const maxW = colW - nameX + x - 10 - (cls ? classW + 6 : 0);
      ctx.fillText(member.name || 'Unknown', nameX, my + 20, maxW);
    });
  });

  return canvas;
}

export default function Parties() {
  const { user } = useAuth();

  const [members, setMembers] = useState([]);
  const [extra, setExtra] = useState({});
  const [items, setItems] = useState(initItems);
  const [partyNames, setPartyNames] = useState(initNames);
  // Role (Tank/DPS/Healer) is tracked separately per PvP/PvE mode, same as
  // classAssignments — someone can be a Tank for one and a Healer for the other.
  const [rolesByMode, setRolesByMode] = useState({ pvp: {}, pve: {} });
  const [saved, setSaved] = useState([]);
  const [rosterId, setRosterId] = useState(null);
  const [rosterName, setRosterName] = useState('');
  const [filter, setFilter] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [membersError, setMembersError] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loaDate, setLoaDate] = useState(todayInGuildTz);
  const [loaEvent, setLoaEvent] = useState('');
  const [loaSet, setLoaSet] = useState(new Set());
  const [schedule, setSchedule] = useState([]);
  const [classMode, setClassMode] = useState('pvp');
  const [classAssignments, setClassAssignments] = useState({ pvp: {}, pve: {} });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const loaSetRef = useRef(loaSet);
  useEffect(() => { loaSetRef.current = loaSet; }, [loaSet]);

  const rolesByModeRef = useRef(rolesByMode);
  useEffect(() => { rolesByModeRef.current = rolesByMode; }, [rolesByMode]);

  // The role map for whichever mode is currently active — most of the
  // component just reads/writes this and doesn't need to know about modes.
  const roles = rolesByMode[classMode];

  const byId = useMemo(() => {
    const m = {};
    members.forEach((x) => { m[x.id] = x; });
    Object.values(extra).forEach((x) => { if (!m[x.id]) m[x.id] = x; });
    return m;
  }, [members, extra]);

  const poolViews = useMemo(() => {
    const f = filter.toLowerCase();
    const views = {};
    POOL_KEYS.forEach((k) => { views[k] = items[k].filter((id) => (byId[id]?.name || '').toLowerCase().includes(f)); });
    return views;
  }, [items, byId, filter]);

  const loadMembers = () => {
    setLoadingMembers(true); setMembersError('');
    axios.get('/api/admin/members')
      .then((res) => {
        const ms = res.data.members || [];
        setMembers(ms);
        const seededPvp = {}; const seededPve = {};
        ms.forEach((m) => {
          if (m.pvp_role) seededPvp[m.id] = m.pvp_role;
          if (m.pve_role) seededPve[m.id] = m.pve_role;
        });
        const merged = {
          pvp: { ...seededPvp, ...rolesByModeRef.current.pvp },
          pve: { ...seededPve, ...rolesByModeRef.current.pve },
        };
        setRolesByMode(merged);
        // Put any members not already placed into the pool matching their role
        // in the currently active mode, or the absent box if they're on LOA.
        setItems((prev) => {
          const placed = new Set([...PARTY_IDS, 'absent'].flatMap((k) => prev[k]));
          const unplaced = ms.map((m) => m.id).filter((id) => !placed.has(id));
          const loa = loaSetRef.current;
          const currentRoles = merged[classMode];
          const next = { ...prev };
          POOL_KEYS.forEach((k) => { next[k] = []; });
          unplaced.forEach((id) => {
            if (!loa.has(id)) next[poolForRole(currentRoles[id])].push(id);
          });
          next.absent = [...prev.absent, ...unplaced.filter((id) => loa.has(id))];
          return next;
        });
      })
      .catch((err) => setMembersError(err.response?.data?.error || 'Could not load members.'))
      .finally(() => setLoadingMembers(false));
  };
  const loadSaved = () => {
    axios.get('/api/admin/rosters').then((res) => setSaved(res.data.rosters || [])).catch(() => {});
  };

  const loadSchedule = () => {
    axios.get('/api/event-schedule')
      .then((res) => setSchedule(res.data.schedule || []))
      .catch(() => {});
  };

  const loadLoa = (date, event) => {
    const d = date ?? loaDate;
    const e = event ?? loaEvent;
    const params = `date=${d}${e ? `&event=${e}` : ''}`;
    axios.get(`/api/admin/loa/unavailable?${params}`)
      .then((res) => setLoaSet(new Set((res.data.unavailable || []).map((u) => u.discord_id))))
      .catch(() => {});
  };

  const eventsForDate = useMemo(() => {
    if (!loaDate) return [];
    const dow = new Date(loaDate + 'T12:00:00').getDay();
    return schedule.filter((s) => s.day_of_week === dow);
  }, [loaDate, schedule]);

  useEffect(() => { loadMembers(); loadSaved(); loadSchedule(); loadLoa(); }, []);
  useEffect(() => { loadLoa(loaDate, loaEvent); }, [loaDate, loaEvent]);
  useEffect(() => { setLoaEvent(''); }, [loaDate]);

  // Pull anyone newly marked LOA out of the pool/parties and into the absent box.
  useEffect(() => {
    setItems((prev) => {
      const moving = [];
      const next = { ...prev };
      [...POOL_KEYS, ...PARTY_IDS].forEach((key) => {
        const stay = prev[key].filter((id) => {
          if (loaSet.has(id)) { moving.push(id); return false; }
          return true;
        });
        next[key] = stay;
      });
      if (moving.length === 0) return prev;
      next.absent = [...prev.absent, ...moving];
      return next;
    });
  }, [loaSet]);

  // Re-bucket anyone sitting in an unassigned pool column (never an actual
  // party or the absent box — those are deliberate placements) to match their
  // role in whichever mode was just switched to.
  useEffect(() => {
    setItems((prev) => {
      const next = { ...prev };
      POOL_KEYS.forEach((k) => { next[k] = []; });
      POOL_KEYS.forEach((k) => {
        prev[k].forEach((id) => { next[poolForRole(roles[id])].push(id); });
      });
      return next;
    });
  }, [classMode]);

  if (!user?.isAdmin) {
    return <RestrictedGate />;
  }

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  const onDragOver = ({ active, over }) => {
    if (!over) return;
    const activeId = active.id;
    const overId = over.id;
    setItems((prev) => {
      const ac = findContainer(activeId, prev);
      const oc = findContainer(overId, prev);
      if (!ac || !oc || ac === oc) return prev;
      if (!POOL_KEYS.includes(oc) && oc !== 'absent' && prev[oc].length >= PARTY_SIZE) return prev; // party full
      const activeItems = prev[ac];
      const overItems = prev[oc];
      const overIndex = overItems.indexOf(overId);
      let newIndex;
      if (overId in prev) {
        newIndex = overItems.length;
      } else {
        const below = active.rect.current.translated && over.rect &&
          active.rect.current.translated.top > over.rect.top + over.rect.height / 2;
        newIndex = overIndex >= 0 ? overIndex + (below ? 1 : 0) : overItems.length;
      }
      return {
        ...prev,
        [ac]: activeItems.filter((id) => id !== activeId),
        [oc]: [...overItems.slice(0, newIndex), activeId, ...overItems.slice(newIndex)],
      };
    });
  };

  const onDragEnd = ({ active, over }) => {
    setActiveId(null);
    if (!over) return;
    const activeId = active.id;
    const overId = over.id;
    setItems((prev) => {
      const ac = findContainer(activeId, prev);
      const oc = findContainer(overId, prev);
      if (!ac || !oc || ac !== oc) return prev;
      const list = prev[ac];
      const oldIndex = list.indexOf(activeId);
      const newIndex = overId in prev ? list.length - 1 : list.indexOf(overId);
      if (newIndex < 0 || oldIndex === newIndex) return prev;
      return { ...prev, [ac]: arrayMove(list, oldIndex, newIndex) };
    });
  };

  const setRole = (id, role) => {
    const next = roles[id] === role ? '' : role;
    setRolesByMode((prev) => ({ ...prev, [classMode]: { ...prev[classMode], [id]: next } }));
    axios.put('/api/admin/member-roles', { id, mode: classMode, role: next }).catch(() => {});
    // If they're sitting in a pool (not a party or absent), move them to the pool matching their new role.
    setItems((prev) => {
      const container = findContainer(id, prev);
      if (!POOL_KEYS.includes(container)) return prev;
      const dest = poolForRole(next);
      if (dest === container) return prev;
      return {
        ...prev,
        [container]: prev[container].filter((x) => x !== id),
        [dest]: [...prev[dest], id],
      };
    });
  };

  const renameParty = (id, name) => setPartyNames((n) => ({ ...n, [id]: name }));

  const setMemberClass = (mode, id, cls) =>
    setClassAssignments((prev) => ({ ...prev, [mode]: { ...prev[mode], [id]: cls } }));

  const buildPayloadParties = () =>
    PARTY_IDS.map((pid) => ({
      id: pid,
      name: partyNames[pid],
      members: items[pid].map((id) => ({ id, name: byId[id]?.name || 'Unknown' })),
    }));

  const buildPayloadAbsent = () =>
    items.absent.map((id) => ({ id, name: byId[id]?.name || 'Unknown' }));

  const resetBoard = () => {
    const next = initItems();
    members.forEach((m) => {
      if (loaSet.has(m.id)) next.absent.push(m.id);
      else next[poolForRole(roles[m.id])].push(m.id);
    });
    setItems(next);
    setPartyNames(initNames()); setRosterId(null); setRosterName(''); setExtra({});
    setClassAssignments({ pvp: {}, pve: {} });
  };

  const save = async () => {
    if (!rosterName.trim()) return flash('Name the roster first.', false);
    setBusy(true);
    const layout = { parties: buildPayloadParties(), absent: buildPayloadAbsent(), classAssignments, rolesByMode };
    try {
      if (rosterId) await axios.put(`/api/admin/rosters/${rosterId}`, { name: rosterName, layout });
      else { const res = await axios.post('/api/admin/rosters', { name: rosterName, layout }); setRosterId(res.data.id); }
      loadSaved(); flash('Roster saved.');
    } catch (err) { flash(err.response?.data?.error || 'Save failed.', false); }
    finally { setBusy(false); }
  };

  const load = async (id) => {
    if (!id) return;
    try {
      const res = await axios.get(`/api/admin/rosters/${id}`);
      const r = res.data.roster;
      const nextItems = initItems();
      const nextNames = initNames();
      // Rosters saved before roles were split by mode only have a flat m.role —
      // fall back to applying it to both, same as it behaved before the split.
      const legacyRoles = {};
      const nextExtra = {};
      (r.layout?.parties || []).forEach((lp) => {
        if (!(lp.id in nextItems)) return;
        nextNames[lp.id] = lp.name || nextNames[lp.id];
        (lp.members || []).forEach((m) => {
          nextItems[lp.id].push(m.id);
          if (m.role) legacyRoles[m.id] = m.role;
          if (!members.find((x) => x.id === m.id)) nextExtra[m.id] = { id: m.id, name: m.name, missing: true };
        });
      });
      // Absent membership is whatever was saved with the roster, not the current LOA status.
      (r.layout?.absent || []).forEach((m) => {
        nextItems.absent.push(m.id);
        if (m.role) legacyRoles[m.id] = m.role;
        if (!members.find((x) => x.id === m.id)) nextExtra[m.id] = { id: m.id, name: m.name, missing: true };
      });
      const savedRolesByMode = r.layout?.rolesByMode || { pvp: legacyRoles, pve: legacyRoles };
      const mergedRolesByMode = {
        pvp: { ...rolesByMode.pvp, ...savedRolesByMode.pvp },
        pve: { ...rolesByMode.pve, ...savedRolesByMode.pve },
      };
      const assigned = new Set([...PARTY_IDS, 'absent'].flatMap((p) => nextItems[p]));
      const unassigned = members.map((m) => m.id).filter((mid) => !assigned.has(mid));
      unassigned.forEach((id) => {
        if (loaSet.has(id)) nextItems.absent.push(id);
        else nextItems[poolForRole(mergedRolesByMode[classMode][id])].push(id);
      });
      setItems(nextItems); setPartyNames(nextNames);
      setRolesByMode(mergedRolesByMode); setExtra(nextExtra);
      setClassAssignments(r.layout?.classAssignments || { pvp: {}, pve: {} });
      setRosterId(r.id); setRosterName(r.name);
      flash(`Loaded "${r.name}".`);
    } catch (err) { flash(err.response?.data?.error || 'Load failed.', false); }
  };

  const del = async () => {
    if (!rosterId) return resetBoard();
    if (!window.confirm(`Delete roster "${rosterName}"?`)) return;
    try { await axios.delete(`/api/admin/rosters/${rosterId}`); loadSaved(); resetBoard(); flash('Roster deleted.'); }
    catch (err) { flash(err.response?.data?.error || 'Delete failed.', false); }
  };

  const post = async () => {
    setBusy(true);
    try {
      const canvas = renderRosterImage(PARTY_IDS, items, partyNames, roles, byId, classMode, classAssignments);
      if (!canvas) { flash('No parties to post.', false); setBusy(false); return; }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const form = new FormData();
      form.append('image', blob, 'roster.png');
      form.append('name', rosterName || 'Roster');
      await axios.post('/api/admin/rosters/post', form);
      flash('Posted to Discord.');
    } catch (err) { flash(err.response?.data?.error || 'Post failed.', false); }
    finally { setBusy(false); }
  };

  const activeMember = activeId ? byId[activeId] : null;

  return (
    <PageShell maxWidth="max-w-none" paddingX="px-2">
      <div className="panel rounded-lg p-4 mb-6 flex flex-wrap items-center gap-3">
        <input value={rosterName} onChange={(e) => setRosterName(e.target.value)} placeholder="Roster name"
          className="bg-hall border border-line rounded px-3 py-2 text-bone focus:outline-none focus:border-brass w-52" />
        <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
          <Save className="w-4 h-4" /> {rosterId ? 'Update' : 'Save'}
        </button>
        <select value={rosterId || ''} onChange={(e) => load(e.target.value)}
          className="bg-hall border border-line rounded px-3 py-2 text-bone focus:outline-none focus:border-brass">
          <option value="">Load roster…</option>
          {saved.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button onClick={resetBoard} className="inline-flex items-center gap-2 px-3 py-2 text-ash hover:text-bone transition-colors"><Plus className="w-4 h-4" /> New</button>
        <Button variant="destructive" size="none" className="px-3 py-2" onClick={del}><Trash2 className="w-4 h-4" /> Delete</Button>
        <div className="flex items-center gap-2 text-sm text-ash">
          <CalendarOff className="w-4 h-4" />
          <input type="date" value={loaDate} onChange={(e) => setLoaDate(e.target.value)}
            className="bg-hall border border-line rounded px-2 py-1.5 text-bone text-sm focus:outline-none focus:border-brass"
            title="Show LOAs for this date" />
          <select value={loaEvent} onChange={(e) => setLoaEvent(e.target.value)}
            className="bg-hall border border-line rounded px-2 py-1.5 text-bone text-sm focus:outline-none focus:border-brass">
            <option value="">All events</option>
            {eventsForDate.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {loaSet.size > 0 && <span className="text-oxblood font-mono">{loaSet.size} out</span>}
        </div>
        <button onClick={() => setClassMode((m) => m === 'pvp' ? 'pve' : 'pvp')}
          className="inline-flex items-center gap-0 rounded-full border border-line bg-hall p-0.5 cursor-pointer shrink-0" title="Toggle PvP / PvE classes and roles">
          <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${classMode === 'pvp' ? 'bg-oxblood text-bone' : 'text-ash'}`}>PVP</span>
          <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${classMode === 'pve' ? 'bg-emerald-500 text-ink' : 'text-ash'}`}>PVE</span>
        </button>
        <div className="flex-1" />
        <Button variant="secondary" size="none" className="px-5 py-2" disabled={busy} onClick={post}><Send className="w-4 h-4" /> Post to Discord</Button>
      </div>

      {msg && (
        <div className={`mb-6 px-5 py-3 rounded-lg border text-sm ${msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'}`}>{msg.text}</div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCorners}
        onDragStart={({ active }) => setActiveId(active.id)} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
          {/* Pools + Absent */}
          <div className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
            <div className="panel rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="eyebrow text-[10px] text-brass flex items-center gap-2"><Users className="w-3.5 h-3.5" /> Pool</div>
                <button onClick={loadMembers} className="text-ash hover:text-brass" title="Reload members"><RefreshCw className="w-3.5 h-3.5" /></button>
              </div>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search…"
                className="w-full bg-hall border border-line rounded px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass" />
            </div>

            {loadingMembers ? (
              <div className="panel rounded-lg p-6 text-ash text-sm text-center">Loading members…</div>
            ) : membersError ? (
              <div className="panel rounded-lg p-4 text-sm text-bone border border-oxblood/40 bg-oxblooddeep/20">
                {membersError}<button onClick={loadMembers} className="block mt-2 text-brass hover:text-brassbright">Retry</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4">
                {POOL_META.filter(({ key }) => activeId || items[key].length > 0).map(({ key, label, dot }) => (
                  <DroppableColumn key={key} id={key} itemIds={poolViews[key]} className="panel rounded-lg p-3">
                    <div className="eyebrow text-[10px] text-ash flex items-center gap-2 mb-2">
                      <span className={`w-2 h-2 rounded-full ${dot}`} /> {label} ({items[key].length})
                    </div>
                    <div className="space-y-2 max-h-[260px] overflow-auto pr-1 min-h-[50px]">
                      {poolViews[key].length === 0
                        ? <div className="text-ash/50 text-xs py-4 text-center">Empty</div>
                        : poolViews[key].map((id) => <SortableMember key={id} member={byId[id] || { id, name: 'Unknown' }} role={roles[id]} onRole={setRole} isLoa={loaSet.has(id)} classMode={classMode} assignedClass={classAssignments[classMode][id]} onClassChange={(cls) => setMemberClass(classMode, id, cls)} />)}
                    </div>
                  </DroppableColumn>
                ))}
              </div>
            )}

            <DroppableColumn id="absent" itemIds={items.absent} className="panel rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="eyebrow text-[10px] text-oxblood flex items-center gap-2"><CalendarOff className="w-3.5 h-3.5" /> Absent ({items.absent.length})</div>
              </div>
              <div className="space-y-2 max-h-[300px] overflow-auto pr-1 min-h-[60px]">
                {items.absent.length === 0
                  ? <div className="text-ash/50 text-xs text-center py-6">Drop absent members here</div>
                  : items.absent.map((id) => <SortableMember key={id} member={byId[id] || { id, name: 'Unknown' }} role={roles[id]} onRole={setRole} isLoa={loaSet.has(id)} classMode={classMode} assignedClass={classAssignments[classMode][id]} onClassChange={(cls) => setMemberClass(classMode, id, cls)} />)}
              </div>
            </DroppableColumn>
          </div>

          {/* Parties */}
          <div className="flex flex-col gap-1.5">
            {[PARTY_IDS.slice(0, 6), PARTY_IDS.slice(6, 12)].map((row, i) => (
              <div key={i} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3 items-start">
                {row.map((pid) => (
                  <DroppableColumn key={pid} id={pid} itemIds={items[pid]} className={`rounded-lg border bg-panel p-2 ${items[pid].length >= PARTY_SIZE ? 'border-line' : 'border-line'}`}>
                    <div className="flex items-center justify-between mb-1.5">
                      <input value={partyNames[pid]} onChange={(e) => renameParty(pid, e.target.value)}
                        className="bg-transparent font-display text-bone text-sm tracking-[0.06em] focus:outline-none focus:text-brassbright w-24" />
                      <span className={`font-mono text-xs ${items[pid].length >= PARTY_SIZE ? 'text-oxblood' : 'text-ash'}`}>{items[pid].length}/{PARTY_SIZE}</span>
                    </div>
                    <div className="space-y-1">
                      {items[pid].length === 0
                        ? <div className="text-ash/50 text-xs text-center py-3 border border-dashed border-line rounded">Drop members here</div>
                        : items[pid].map((id) => <SortableMember key={id} member={byId[id] || { id, name: 'Unknown' }} role={roles[id]} onRole={setRole} inParty isLoa={loaSet.has(id)} classMode={classMode} assignedClass={classAssignments[classMode][id]} onClassChange={(cls) => setMemberClass(classMode, id, cls)} />)}
                    </div>
                  </DroppableColumn>
                ))}
              </div>
            ))}
          </div>
        </div>

        <DragOverlay>{activeMember ? <MemberCardBase member={activeMember} role={roles[activeMember.id]} overlay /> : null}</DragOverlay>
      </DndContext>
    </PageShell>
  );
}

// Droppable container that also provides a SortableContext for its items.
function DroppableColumn({ id, itemIds, className, children }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <SortableContext id={id} items={itemIds} strategy={verticalListSortingStrategy}>
      <div ref={setNodeRef} className={`${className} transition-colors ${isOver ? 'border-brass/70 ring-1 ring-brass/40' : ''}`}>
        {children}
      </div>
    </SortableContext>
  );
}

function SortableMember(props) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.member.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return <MemberCardBase ref={setNodeRef} style={style} handle={{ ...attributes, ...listeners }} isDragging={isDragging} {...props} />;
}

const MemberCardBase = forwardRef(function MemberCardBase({ member, role, onRole, inParty, overlay, style, handle, isDragging, isLoa, classMode, assignedClass, onClassChange }, ref) {
  const rs = ROLE_STYLE[role];
  const classes = ((classMode === 'pve' ? member.pve_classes : member.pvp_classes) || []).filter(Boolean);
  const current = assignedClass || classes[0];
  return (
    <div
      ref={ref} style={style} {...handle}
      className={`group relative flex items-center gap-1.5 bg-hall border border-line ${rs ? `border-l-2 ${rs.ring}` : ''} rounded px-2 py-1.5 cursor-grab active:cursor-grabbing select-none ${isDragging ? 'opacity-30' : ''} ${overlay ? 'shadow-xl ring-1 ring-brass/40' : ''} ${isLoa ? 'opacity-50' : ''}`}
    >
      {member.avatar
        ? <img src={member.avatar} alt="" className="w-6 h-6 rounded-full border border-line shrink-0" />
        : <span className="w-6 h-6 rounded-full bg-panelup border border-line shrink-0 flex items-center justify-center text-[10px] text-brass">{(member.name || '?').slice(0, 1).toUpperCase()}</span>}
      <div className="min-w-0 flex-1">
        <span className={`text-sm truncate block ${member.missing ? 'text-ash italic' : isLoa ? 'text-oxblood' : 'text-bone'}`} title={isLoa ? 'On leave of absence' : member.missing ? 'No longer in the server' : member.name}>{member.name}</span>
        {classes.length === 1 && (
          <span className="text-[10px] text-brass truncate block">{classes[0]}</span>
        )}
        {classes.length > 1 && onClassChange && (
          <select
            value={current} onChange={(e) => onClassChange(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
            className="text-[10px] bg-transparent text-brass border-none focus:outline-none cursor-pointer truncate w-full -ml-px"
          >
            {classes.map((c, i) => <option key={c} value={c} className="bg-panelup text-bone">{c}{i === 0 ? ' ★' : ''}</option>)}
          </select>
        )}
      </div>
      {isLoa && <CalendarOff className="w-3.5 h-3.5 text-oxblood shrink-0" title="LOA" />}
      {onRole && (
        <div className="flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity" onPointerDown={(e) => e.stopPropagation()}>
          {ROLES.map((r) => (
            <button key={r} onClick={() => onRole(member.id, r)} title={r}
              className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center border transition-colors ${role === r ? `${ROLE_STYLE[r].dot} text-ink border-transparent` : 'border-line text-ash hover:text-bone'}`}>
              {r[0]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
