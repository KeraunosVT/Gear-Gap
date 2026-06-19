import { useState, useEffect, useMemo, forwardRef } from 'react';
import axios from 'axios';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, closestCorners,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAuth } from '../auth';
import Sigil from '../components/Sigil';
import { Save, Trash2, Send, Plus, RefreshCw, Users, CalendarOff } from 'lucide-react';

const ROLES = ['Tank', 'DPS', 'Healer'];
const ROLE_STYLE = {
  Tank:   { dot: 'bg-sky-400',     ring: 'border-l-sky-400' },
  DPS:    { dot: 'bg-oxblood',     ring: 'border-l-oxblood' },
  Healer: { dot: 'bg-emerald-400', ring: 'border-l-emerald-400' },
};
const PARTY_SIZE = 6;
const PARTY_IDS = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
const initItems = () => ({ pool: [], ...Object.fromEntries(PARTY_IDS.map((id) => [id, []])) });
const initNames = () => Object.fromEntries(PARTY_IDS.map((id, i) => [id, `Party ${i + 1}`]));
const findContainer = (id, src) => (id in src ? id : Object.keys(src).find((k) => src[k].includes(id)));

export default function Parties() {
  const { user } = useAuth();

  const [members, setMembers] = useState([]);
  const [extra, setExtra] = useState({});
  const [items, setItems] = useState(initItems);
  const [partyNames, setPartyNames] = useState(initNames);
  const [roles, setRoles] = useState({});
  const [saved, setSaved] = useState([]);
  const [rosterId, setRosterId] = useState(null);
  const [rosterName, setRosterName] = useState('');
  const [filter, setFilter] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [membersError, setMembersError] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loaDate, setLoaDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [loaSet, setLoaSet] = useState(new Set());

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const byId = useMemo(() => {
    const m = {};
    members.forEach((x) => { m[x.id] = x; });
    Object.values(extra).forEach((x) => { if (!m[x.id]) m[x.id] = x; });
    return m;
  }, [members, extra]);

  const poolView = useMemo(
    () => items.pool.filter((id) => (byId[id]?.name || '').toLowerCase().includes(filter.toLowerCase())),
    [items.pool, byId, filter]
  );

  const loadMembers = () => {
    setLoadingMembers(true); setMembersError('');
    axios.get('/api/admin/members')
      .then((res) => {
        const ms = res.data.members || [];
        setMembers(ms);
        setRoles((prev) => {
          const seeded = {};
          ms.forEach((m) => { if (m.role) seeded[m.id] = m.role; });
          return { ...seeded, ...prev };
        });
        // Put any members not already assigned to a party into the pool.
        setItems((prev) => {
          const assigned = new Set(PARTY_IDS.flatMap((p) => prev[p]));
          return { ...prev, pool: ms.map((m) => m.id).filter((id) => !assigned.has(id)) };
        });
      })
      .catch((err) => setMembersError(err.response?.data?.error || 'Could not load members.'))
      .finally(() => setLoadingMembers(false));
  };
  const loadSaved = () => {
    axios.get('/api/admin/rosters').then((res) => setSaved(res.data.rosters || [])).catch(() => {});
  };

  const loadLoa = (date) => {
    axios.get(`/api/admin/loa/unavailable?date=${date || loaDate}`)
      .then((res) => setLoaSet(new Set((res.data.unavailable || []).map((u) => u.discord_id))))
      .catch(() => {});
  };

  useEffect(() => { loadMembers(); loadSaved(); loadLoa(); }, []);
  useEffect(() => { loadLoa(loaDate); }, [loaDate]);

  if (!user?.isAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-24 text-center">
        <Sigil className="w-12 h-16 text-oxblood mx-auto mb-6" />
        <h1 className="font-display text-2xl text-bone tracking-[0.08em] mb-3">Restricted</h1>
        <p className="text-ash">The war table is open to officers of the house alone.</p>
      </div>
    );
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
      if (oc !== 'pool' && prev[oc].length >= PARTY_SIZE) return prev; // party full
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

  const setRole = (id, role) =>
    setRoles((r) => {
      const next = r[id] === role ? '' : role;
      axios.put('/api/admin/member-roles', { id, role: next }).catch(() => {});
      return { ...r, [id]: next };
    });

  const renameParty = (id, name) => setPartyNames((n) => ({ ...n, [id]: name }));

  const buildPayloadParties = () =>
    PARTY_IDS.map((pid) => ({
      id: pid,
      name: partyNames[pid],
      members: items[pid].map((id) => ({ id, name: byId[id]?.name || 'Unknown', role: roles[id] || '' })),
    }));

  const resetBoard = () => {
    setItems({ ...initItems(), pool: members.map((m) => m.id) });
    setPartyNames(initNames()); setRoles((r) => r); setRosterId(null); setRosterName(''); setExtra({});
  };

  const save = async () => {
    if (!rosterName.trim()) return flash('Name the roster first.', false);
    setBusy(true);
    const layout = { parties: buildPayloadParties() };
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
      const nextRoles = {};
      const nextExtra = {};
      (r.layout?.parties || []).forEach((lp) => {
        if (!(lp.id in nextItems)) return;
        nextNames[lp.id] = lp.name || nextNames[lp.id];
        (lp.members || []).forEach((m) => {
          nextItems[lp.id].push(m.id);
          if (m.role) nextRoles[m.id] = m.role;
          if (!members.find((x) => x.id === m.id)) nextExtra[m.id] = { id: m.id, name: m.name, missing: true };
        });
      });
      const assigned = new Set(PARTY_IDS.flatMap((p) => nextItems[p]));
      nextItems.pool = members.map((m) => m.id).filter((mid) => !assigned.has(mid));
      setItems(nextItems); setPartyNames(nextNames);
      setRoles((prev) => ({ ...prev, ...nextRoles })); setExtra(nextExtra);
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
      await axios.post('/api/admin/rosters/post', { name: rosterName || 'Roster', parties: buildPayloadParties() });
      flash('Posted to Discord.');
    } catch (err) { flash(err.response?.data?.error || 'Post failed.', false); }
    finally { setBusy(false); }
  };

  const activeMember = activeId ? byId[activeId] : null;

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">War Table</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Parties</h1>
      <p className="text-ash mt-2">Drag members between and within parties, set roles, save rosters, and post to Discord.</p>
      <div className="rule-fade my-8" />

      <div className="panel rounded-sm p-4 mb-6 flex flex-wrap items-center gap-3">
        <input value={rosterName} onChange={(e) => setRosterName(e.target.value)} placeholder="Roster name"
          className="bg-hall border border-line rounded px-3 py-2 text-bone focus:outline-none focus:border-brass w-52" />
        <button onClick={save} disabled={busy} className="inline-flex items-center gap-2 px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors disabled:opacity-40">
          <Save className="w-4 h-4" /> {rosterId ? 'Update' : 'Save'}
        </button>
        <select value={rosterId || ''} onChange={(e) => load(e.target.value)}
          className="bg-hall border border-line rounded px-3 py-2 text-bone focus:outline-none focus:border-brass">
          <option value="">Load roster…</option>
          {saved.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button onClick={resetBoard} className="inline-flex items-center gap-2 px-3 py-2 text-ash hover:text-bone transition-colors"><Plus className="w-4 h-4" /> New</button>
        <button onClick={del} className="inline-flex items-center gap-2 px-3 py-2 text-ash hover:text-oxblood transition-colors"><Trash2 className="w-4 h-4" /> Delete</button>
        <div className="flex items-center gap-2 text-sm text-ash">
          <CalendarOff className="w-4 h-4" />
          <input type="date" value={loaDate} onChange={(e) => setLoaDate(e.target.value)}
            className="bg-hall border border-line rounded px-2 py-1.5 text-bone text-sm focus:outline-none focus:border-brass"
            title="Show LOAs for this date" />
          {loaSet.size > 0 && <span className="text-oxblood font-mono">{loaSet.size} out</span>}
        </div>
        <div className="flex-1" />
        <button onClick={post} disabled={busy} className="inline-flex items-center gap-2 px-5 py-2 border border-brass/50 text-brassbright hover:bg-panelup rounded-sm transition-colors disabled:opacity-40"><Send className="w-4 h-4" /> Post to Discord</button>
      </div>

      {msg && (
        <div className={`mb-6 px-5 py-3 rounded-sm border text-sm ${msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'}`}>{msg.text}</div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCorners}
        onDragStart={({ active }) => setActiveId(active.id)} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
          {/* Pool */}
          <DroppableColumn id="pool" itemIds={poolView} className="panel rounded-sm p-4 lg:sticky lg:top-20">
            <div className="flex items-center justify-between mb-3">
              <div className="eyebrow text-[10px] text-brass flex items-center gap-2"><Users className="w-3.5 h-3.5" /> Pool ({items.pool.length})</div>
              <button onClick={loadMembers} className="text-ash hover:text-brass" title="Reload members"><RefreshCw className="w-3.5 h-3.5" /></button>
            </div>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search…"
              className="w-full bg-hall border border-line rounded px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass mb-3" />
            <div className="space-y-2 max-h-[640px] overflow-auto pr-1 min-h-[60px]">
              {loadingMembers ? <div className="text-ash text-sm py-6 text-center">Loading members…</div>
                : membersError ? (
                  <div className="text-sm text-bone border border-oxblood/40 bg-oxblooddeep/20 rounded p-3">
                    {membersError}<button onClick={loadMembers} className="block mt-2 text-brass hover:text-brassbright">Retry</button>
                  </div>
                ) : poolView.length === 0 ? <div className="text-ash text-sm py-6 text-center">Everyone's assigned.</div>
                : poolView.map((id) => <SortableMember key={id} member={byId[id] || { id, name: 'Unknown' }} role={roles[id]} onRole={setRole} isLoa={loaSet.has(id)} />)}
            </div>
          </DroppableColumn>

          {/* Parties */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {PARTY_IDS.map((pid) => (
              <DroppableColumn key={pid} id={pid} itemIds={items[pid]} className={`rounded-sm border bg-panel p-3 ${items[pid].length >= PARTY_SIZE ? 'border-line' : 'border-line'}`}>
                <div className="flex items-center justify-between mb-3">
                  <input value={partyNames[pid]} onChange={(e) => renameParty(pid, e.target.value)}
                    className="bg-transparent font-display text-bone text-sm tracking-[0.06em] focus:outline-none focus:text-brassbright w-32" />
                  <span className={`font-mono text-xs ${items[pid].length >= PARTY_SIZE ? 'text-oxblood' : 'text-ash'}`}>{items[pid].length}/{PARTY_SIZE}</span>
                </div>
                <div className="space-y-2 min-h-[120px]">
                  {items[pid].length === 0
                    ? <div className="text-ash/50 text-xs text-center py-8 border border-dashed border-line rounded">Drop members here</div>
                    : items[pid].map((id) => <SortableMember key={id} member={byId[id] || { id, name: 'Unknown' }} role={roles[id]} onRole={setRole} inParty isLoa={loaSet.has(id)} />)}
                </div>
              </DroppableColumn>
            ))}
          </div>
        </div>

        <DragOverlay>{activeMember ? <MemberCardBase member={activeMember} role={roles[activeMember.id]} overlay /> : null}</DragOverlay>
      </DndContext>
    </div>
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

const MemberCardBase = forwardRef(function MemberCardBase({ member, role, onRole, inParty, overlay, style, handle, isDragging, isLoa }, ref) {
  const rs = ROLE_STYLE[role];
  return (
    <div
      ref={ref} style={style} {...handle}
      className={`group flex items-center gap-2 bg-hall border border-line ${rs ? `border-l-2 ${rs.ring}` : ''} rounded px-2.5 py-2 cursor-grab active:cursor-grabbing select-none ${isDragging ? 'opacity-30' : ''} ${overlay ? 'shadow-xl ring-1 ring-brass/40' : ''} ${isLoa ? 'opacity-50' : ''}`}
    >
      {member.avatar
        ? <img src={member.avatar} alt="" className="w-6 h-6 rounded-full border border-line shrink-0" />
        : <span className="w-6 h-6 rounded-full bg-panelup border border-line shrink-0 flex items-center justify-center text-[10px] text-brass">{(member.name || '?').slice(0, 1).toUpperCase()}</span>}
      <span className={`text-sm truncate flex-1 ${member.missing ? 'text-ash italic' : isLoa ? 'text-oxblood' : 'text-bone'}`} title={isLoa ? 'On leave of absence' : member.missing ? 'No longer in the server' : member.name}>{member.name}</span>
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
