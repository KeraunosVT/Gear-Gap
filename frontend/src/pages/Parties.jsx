import { useState, useEffect, useMemo, useRef, forwardRef } from 'react';
import axios from 'axios';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable, closestCorners,
} from '@dnd-kit/core';
import {
  SortableContext, useSortable, arrayMove, verticalListSortingStrategy, rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAuth } from '../auth';
import RestrictedGate from '../components/ui/RestrictedGate';
import Button from '../components/ui/Button';
import { PageShell } from '../components/ui/PageShell';
import { todayInGuildTz, fmtTimeEst, eventsForGuildDay, isAfterMidnight } from '../timeUtils';
import {
  Save, Trash2, Send, Plus, Copy, RefreshCw, CalendarOff, CalendarDays, CalendarCheck, ClipboardList, X,
  MoreHorizontal, Check, AlertTriangle, Clock, Pencil,
} from 'lucide-react';
import { BUILD_CHIP_ON, KIND_BUILD } from '../buildColors';
import ErrorBanner from '../components/ui/ErrorBanner';
import { ROLES, PARTY_SIZE, partyMakeup, poolView, boardSignature } from '../partyBoard';

const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Tank blue, healer green, DPS orange. Red is kept for problems only (LOA,
// conflicts), so a party full of DPS no longer looks like an error.
const ROLE_STYLE = {
  Tank:   { dot: 'bg-sky-400',     ring: 'border-l-sky-400',     text: 'text-sky-600 dark:text-sky-400' },
  Healer: { dot: 'bg-emerald-400', ring: 'border-l-emerald-400', text: 'text-emerald-700 dark:text-emerald-400' },
  DPS:    { dot: 'bg-orange-400',  ring: 'border-l-orange-400',  text: 'text-orange-600 dark:text-orange-400' },
};
const WARN_TEXT = 'text-amber-700 dark:text-amber-400';
const GOOD_TEXT = 'text-emerald-700 dark:text-emerald-400';
const PARTY_IDS = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
// The last slot is the overflow/standby group rather than a numbered party, so
// it's named for what it's used for and sits on the bench beside Absent. It is
// still saved and posted like any other party, and still renameable.
const FILL_PARTY_ID = 'p12';
const BOARD_PARTY_IDS = PARTY_IDS.filter((id) => id !== FILL_PARTY_ID);

// Everyone not placed in a party or Absent sits in one pool. Role is a filter
// on it, not a column, so changing a role or the PvP/PvE mode moves nobody.
const initItems = () => ({
  pool: [],
  absent: [],
  ...Object.fromEntries(PARTY_IDS.map((id) => [id, []])),
});
const initNames = () => Object.fromEntries(
  PARTY_IDS.map((id, i) => [id, id === FILL_PARTY_ID ? 'Fill' : `Party ${i + 1}`]),
);
const findContainer = (id, src) => (id in src ? id : Object.keys(src).find((k) => src[k].includes(id)));

const ROLE_COLOR = { Tank: '#38bdf8', DPS: '#fb923c', Healer: '#4ade80' };
const ROLE_SYMBOL = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };
// Seeding falls back to whoever's left in this order when the role a seat
// wants has run out, so a party missing a tank takes a DPS before a healer.
const SEED_FALLBACK = ['Tank', 'DPS', 'Healer'];

// Whether an absence is definite enough to act on. A `partial` entry from
// /loa/unavailable is time-scoped and couldn't be checked against an event time
// (because no single event was picked), so it's a prompt to look at the window
// rather than grounds for benching — someone out after 8pm is fine for the 6pm.
// Those stay on the board flagged; only definite absences are moved.
const isFullyOut = (loa, id) => {
  const entry = loa.get(id);
  return Boolean(entry) && !entry.partial;
};

const LOA_TYPE_LABEL = { event: 'Out this event', range: 'Away (date range)', recurring: 'Out weekly' };

// Compact time for the inline card label, where a full "7:00 PM ET – 8:00 PM ET"
// is far too wide. The tooltip carries the fully qualified version.
const shortTime = (t) => fmtTimeEst(t).replace(' ET', '').replace(':00', '');

// Human summary of an absence for a card tooltip: the window if there is one,
// otherwise what kind of absence it is, plus the reason.
function loaSummary(loa) {
  if (!loa) return null;
  const when = loa.start_time
    ? (loa.end_time
      ? `Out ${fmtTimeEst(loa.start_time)} – ${fmtTimeEst(loa.end_time)}`
      : `Out from ${fmtTimeEst(loa.start_time)} on`)
    : LOA_TYPE_LABEL[loa.type] || 'On leave of absence';
  return loa.reason ? `${when} — ${loa.reason}` : when;
}

// Greedy wrap of a comma-separated name list to a pixel width.
function wrapNames(names, ctx, maxW) {
  const lines = [];
  let line = '';
  names.forEach((name, i) => {
    const piece = name + (i < names.length - 1 ? ',' : '');
    const candidate = line ? `${line} ${piece}` : piece;
    if (line && ctx.measureText(candidate).width > maxW) { lines.push(line); line = piece; }
    else line = candidate;
  });
  if (line) lines.push(line);
  return lines;
}

function renderRosterImage(partyIds, items, partyNames, roles, byId, classMode, classAssignments, absentWhy) {
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

  // Members an LOA is holding out, posted so they can see they were accounted
  // for and so anyone who forgot to file notices they were expected. Members an
  // officer benched are deliberately left off: that's a roster decision, not an
  // availability fact, and publishing it reads as a callout.
  const onLeave = (items.absent || [])
    .filter((id) => (absentWhy || {})[id] === 'loa')
    .map((id) => byId[id]?.name || 'Unknown');
  // Wrapping needs text metrics before the real canvas can be sized, so measure
  // on a throwaway context using the same font the footer renders with.
  const leaveLineH = 16;
  let leaveLines = [];
  if (onLeave.length) {
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = '12px sans-serif';
    leaveLines = wrapNames(onLeave, measure, w - padX * 2 - 24);
  }
  const leaveH = leaveLines.length ? 34 + leaveLines.length * leaveLineH : 0;

  const h = padY + titleH + rows * cardH + (rows - 1) * gapY
    + (leaveH ? gapY + leaveH : 0) + padY;

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

  if (leaveLines.length) {
    const fy = padY + titleH + rows * cardH + (rows - 1) * gapY + gapY;
    ctx.fillStyle = '#1b1b1e';
    ctx.strokeStyle = '#2c2c30';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(padX, fy, w - padX * 2, leaveH, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#d64545';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`ON LEAVE (${onLeave.length})`, padX + 12, fy + 20);

    ctx.fillStyle = '#8a8a8d';
    ctx.font = '12px sans-serif';
    leaveLines.forEach((line, i) => ctx.fillText(line, padX + 12, fy + 40 + i * leaveLineH));
  }

  return canvas;
}

export default function Parties() {
  const { can } = useAuth();

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
  const [roleFilter, setRoleFilter] = useState('all');
  const [signedOnly, setSignedOnly] = useState(false);
  const [activeId, setActiveId] = useState(null);
  // Click-to-place: the member picked up by a click, waiting for a click on
  // where they go. The drag-free way to build a board.
  const [selected, setSelected] = useState(null);
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [membersError, setMembersError] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loaDate, setLoaDate] = useState(todayInGuildTz);
  const [loaEvent, setLoaEvent] = useState('');
  // discord_id → the absence that applies to the current occasion (type, time
  // window, reason, and whether it's `partial`). A Map rather than a set of ids
  // so cards can explain *how* someone is out, not just that they are.
  const [loaById, setLoaById] = useState(new Map());
  // What changed in the LOA picture between when a roster was saved and now.
  // Set by load(), cleared once the officer acts on it or moves the occasion.
  const [loaDiff, setLoaDiff] = useState(null);
  // discord_id → why they're in the Absent box: 'loa' if an absence put them
  // there, 'benched' if an officer did. Kept live (not derived at save time) so
  // a bench can be reconsidered when the occasion moves — a member parked for
  // Tuesday's LOA shouldn't stay parked once you switch to Saturday.
  const [absentWhy, setAbsentWhy] = useState({});
  const [schedule, setSchedule] = useState([]);
  // One-off events opened for the picked night (signups with no schedule
  // entry). They sit in the event picker beside the weekly ones, as
  // `signup:<id>` so the two kinds of id can't collide.
  const [oneOffs, setOneOffs] = useState([]);
  const [classMode, setClassMode] = useState('pvp');
  const [classAssignments, setClassAssignments] = useState({ pvp: {}, pve: {} });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const loaRef = useRef(loaById);
  useEffect(() => { loaRef.current = loaById; }, [loaById]);

  // discord_id → 'going' | 'waitlist' for the current occasion, or null when
  // nobody has opened a signup for it. Mirrored into a ref for the same reason
  // loaById is: loadMembers() reads it while bucketing, before React commits.
  const [signupById, setSignupById] = useState(() => new Map());
  const signupRef = useRef(signupById);
  useEffect(() => { signupRef.current = signupById; }, [signupById]);

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

  const pool = useMemo(() => poolView(items.pool, {
    nameOf: (id) => byId[id]?.name,
    roleOf: (id) => roles[id],
    signupOf: (id) => signupById.get(id),
    query: filter,
    signedOnly,
    role: roleFilter,
  }), [items.pool, byId, roles, signupById, filter, signedOnly, roleFilter]);

  // ── Saved / Unsaved changes ────────────────────────────────────────────
  // The board is compared with a signature of what was last saved or loaded,
  // so undoing a move by hand reads as Saved again. markClean() asks for the
  // next committed board to become the new baseline; the tick makes that
  // happen even when the board itself didn't change.
  const sigFor = (name) => boardSignature({
    items, partyIds: PARTY_IDS, partyNames, classAssignments, rosterName: name, date: loaDate, event: loaEvent,
  });
  const boardSig = sigFor(rosterName);
  const [cleanSig, setCleanSig] = useState(null);
  const [cleanTick, setCleanTick] = useState(0);
  const cleanPending = useRef(true);
  const markClean = () => { cleanPending.current = true; setCleanTick((t) => t + 1); };
  useEffect(() => {
    if (!cleanPending.current) return;
    cleanPending.current = false;
    setCleanSig(boardSig);
  }, [boardSig, cleanTick]);
  const dirty = cleanSig !== null && boardSig !== cleanSig;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Closing the tab or reloading with unsaved work asks first.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // Escape puts down whoever was picked up for click-to-place.
  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSelected(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

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
        setRolesByMode({
          pvp: { ...seededPvp, ...rolesByModeRef.current.pvp },
          pve: { ...seededPve, ...rolesByModeRef.current.pve },
        });
        // Put any members not already placed into the pool, or the Absent box
        // if they're on LOA.
        setItems((prev) => {
          const placed = new Set([...PARTY_IDS, 'absent'].flatMap((k) => prev[k]));
          const unplaced = ms.map((m) => m.id).filter((id) => !placed.has(id));
          const loa = loaRef.current;
          return {
            ...prev,
            pool: unplaced.filter((id) => !isFullyOut(loa, id)),
            absent: [...prev.absent, ...unplaced.filter((id) => isFullyOut(loa, id))],
          };
        });
        // Benching people on LOA is automatic, not an edit. If the board was
        // clean, it stays clean.
        if (!dirtyRef.current) markClean();
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

  // Resolves to who's out for a date/event instead of setting state itself —
  // load() needs the roster's own LOA picture in hand to diff it against what
  // was saved, before any of it reaches the board.
  // The query for an occasion. A one-off is asked about by its signup id: the
  // server reads its time from that, and (date, no schedule id) couldn't tell
  // two one-offs on the same night apart anyway.
  const occasionParams = (date, event) => (String(event).startsWith('signup:')
    ? `signup=${event.slice('signup:'.length)}`
    : `date=${date}${event ? `&event=${event}` : ''}`);

  const fetchLoa = (date, event) => {
    const params = occasionParams(date, event);
    return axios.get(`/api/admin/loa/unavailable?${params}`)
      .then((res) => new Map((res.data.unavailable || []).map((u) => [u.discord_id, u])))
      .catch(() => new Map());
  };

  // Same shape and the same contract as fetchLoa: resolves, never sets state.
  // An empty map is the normal answer — most occasions have no signup open, and
  // this route is deliberately readable with the 'parties' capability alone.
  const fetchSignups = (date, event) => {
    const params = occasionParams(date, event);
    return axios.get(`/api/admin/signups/by-occasion?${params}`)
      .then((res) => new Map([
        ...(res.data.going || []).map((e) => [e.discord_id, 'going']),
        ...(res.data.waitlist || []).map((e) => [e.discord_id, 'waitlist']),
      ]))
      .catch(() => new Map());
  };

  const eventsForDate = useMemo(() => {
    if (!loaDate) return [];
    return eventsForGuildDay(schedule, new Date(loaDate + 'T12:00:00').getDay(), loaDate);
  }, [loaDate, schedule]);

  useEffect(() => {
    if (!loaDate) { setOneOffs([]); return undefined; }
    let live = true;
    axios.get(`/api/admin/signups/by-occasion/one-offs?date=${loaDate}`)
      .then((res) => { if (live) setOneOffs(res.data.events || []); })
      .catch(() => { if (live) setOneOffs([]); });
    return () => { live = false; };
  }, [loaDate]);

  // Which date+event the LOA set in state was fetched for. Keeps load() — which
  // fetches its roster's occasion itself — from triggering a duplicate round
  // trip when it then sets loaDate/loaEvent.
  const loaFetchedFor = useRef(null);

  // LOA is fetched before members on purpose: loadMembers() routes anyone
  // already known to be out straight into the Absent box as it buckets the
  // pool, which is the only place absence is applied automatically.
  useEffect(() => {
    loadSaved(); loadSchedule();
    loaFetchedFor.current = `${loaDate}|${loaEvent}`;
    Promise.all([fetchLoa(loaDate, loaEvent), fetchSignups(loaDate, loaEvent)])
      .then(([out, up]) => {
        setLoaById(out); loaRef.current = out;
        setSignupById(up); signupRef.current = up;
        loadMembers();
      });
  }, []);

  useEffect(() => {
    const key = `${loaDate}|${loaEvent}`;
    if (loaFetchedFor.current === key) return;
    loaFetchedFor.current = key;
    fetchLoa(loaDate, loaEvent).then(setLoaById);
    fetchSignups(loaDate, loaEvent).then(setSignupById);
  }, [loaDate, loaEvent]);

  // Moving the occasion changes who's flagged, but never moves anyone: the
  // picker is a view onto a different night, and silently yanking people out of
  // parties an officer just built (with no way back) loses real work. Conflicts
  // surface in the status strip instead — see loaConflicts.
  const changeLoaDate = (date) => {
    // Events are tied to one weekday, so a previously picked one may not exist
    // on the new date. Both setters land in the same React batch, so the fetch
    // effect fires once with the new pair rather than once with a stale event
    // id and again with the cleared one.
    setLoaDate(date); setLoaEvent(''); setLoaDiff(null);
  };
  const changeLoaEvent = (event) => { setLoaEvent(event); setLoaDiff(null); };

  // Anyone on LOA for the current occasion who's still sitting on the board,
  // split by how definite the absence is (see isFullyOut). Only `full` is ever
  // bulk-moved; `partial` is surfaced so an officer can check the window and
  // decide, since it may not collide with this event at all.
  const loaConflicts = useMemo(() => {
    const onBoard = [...PARTY_IDS, 'pool'].flatMap((k) => items[k].filter((id) => loaById.has(id)));
    const inParties = PARTY_IDS.flatMap((pid) => items[pid].filter((id) => loaById.has(id)));
    return {
      full: onBoard.filter((id) => isFullyOut(loaById, id)),
      partial: onBoard.filter((id) => !isFullyOut(loaById, id)),
      // Definite absences sitting in a party — the case that breaks a roster,
      // as opposed to one just cluttering the pool.
      fullInParties: inParties.filter((id) => isFullyOut(loaById, id)),
    };
  }, [items, loaById]);

  // Headline numbers for the signups chip, plus how many of them are still
  // sitting in the pool — which is what "Seed parties" would actually move, so
  // the button can say nothing rather than promise a no-op.
  const signupCounts = useMemo(() => {
    let going = 0; let waitlist = 0;
    // Composition of who's coming, read off the same rolesByMode the seed uses
    // — so the chip is a preview of what "Seed parties" would actually build.
    const byRole = { Tank: 0, DPS: 0, Healer: 0, unroled: 0 };
    signupById.forEach((s, id) => {
      if (s !== 'going') { waitlist += 1; return; }
      going += 1;
      if (ROLES.includes(roles[id])) byRole[roles[id]] += 1; else byRole.unroled += 1;
    });
    const inPool = items.pool.filter((id) => signupById.has(id)).length;
    return { going, waitlist, inPool, byRole };
  }, [signupById, items.pool, roles]);

  // Keep absentWhy in step with the Absent box. Anyone arriving without an
  // already-recorded reason is classified once, on arrival: a definite absence
  // covering them means the absence put them there, otherwise an officer
  // dragged them in. The reason then sticks — it records why they were benched,
  // which doesn't change retroactively when the occasion moves. Reading LOA off
  // the ref keeps this firing on Absent-box changes only.
  useEffect(() => {
    setAbsentWhy((prev) => {
      const next = {};
      let changed = items.absent.length !== Object.keys(prev).length;
      items.absent.forEach((id) => {
        next[id] = prev[id] || (isFullyOut(loaRef.current, id) ? 'loa' : 'benched');
        if (prev[id] !== next[id]) changed = true;
      });
      return changed ? next : prev;
    });
  }, [items.absent]);

  // Benched by an absence that no longer applies to the current occasion —
  // the mirror of loaConflicts, and what stops the Absent box accumulating
  // people as an officer moves between dates. Deliberate benches never appear
  // here; the officer meant those.
  const staleBenches = useMemo(
    () => items.absent.filter((id) => absentWhy[id] === 'loa' && !isFullyOut(loaById, id)),
    [items.absent, absentWhy, loaById],
  );

  // A click that ends a drag must not also pick the card up for click-to-place.
  const justDragged = useRef(false);

  if (!can('parties')) {
    return <RestrictedGate />;
  }

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  // Unsaved work is only thrown away on purpose.
  const okToDiscard = () => !dirty || window.confirm('This board has unsaved changes. Discard them?');

  // Names for a list of ids, truncated — the strip names who's affected
  // without growing unbounded when a whole night's worth of people are out.
  const namesFor = (ids, max = 3) => {
    const names = ids.slice(0, max).map((id) => byId[id]?.name || 'Unknown');
    return ids.length > max ? `${names.join(', ')} +${ids.length - max} more` : names.join(', ');
  };

  const isFullParty = (key, list) => PARTY_IDS.includes(key) && list.length >= PARTY_SIZE;

  const onDragStart = ({ active }) => { setActiveId(active.id); setSelected(null); };

  const onDragOver = ({ active, over }) => {
    if (!over) return;
    const activeId = active.id;
    const overId = over.id;
    setItems((prev) => {
      const ac = findContainer(activeId, prev);
      const oc = findContainer(overId, prev);
      if (!ac || !oc || ac === oc) return prev;
      if (isFullParty(oc, prev[oc])) return prev;
      const activeItems = prev[ac];
      const overItems = prev[oc];
      const overIndex = overItems.indexOf(overId);
      let newIndex;
      // The pool is shown sorted, so where in it someone lands means nothing.
      if (overId in prev || oc === 'pool') {
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

  const endDrag = () => {
    setActiveId(null);
    justDragged.current = true;
    setTimeout(() => { justDragged.current = false; }, 0);
  };

  const onDragEnd = ({ active, over }) => {
    endDrag();
    if (!over) return;
    const activeId = active.id;
    const overId = over.id;
    setItems((prev) => {
      const ac = findContainer(activeId, prev);
      const oc = findContainer(overId, prev);
      if (!ac || !oc || ac !== oc || ac === 'pool') return prev;
      const list = prev[ac];
      const oldIndex = list.indexOf(activeId);
      const newIndex = overId in prev ? list.length - 1 : list.indexOf(overId);
      if (newIndex < 0 || oldIndex === newIndex) return prev;
      return { ...prev, [ac]: arrayMove(list, oldIndex, newIndex) };
    });
  };

  // Move one member to the end of another container: click-to-place, and
  // double-click back to the pool.
  const moveMember = (id, dest) => {
    const from = findContainer(id, items);
    if (!from || from === dest) return;
    if (isFullParty(dest, items[dest])) { flash(`${partyNames[dest] || 'That party'} is full.`, false); return; }
    setItems((prev) => {
      const src = findContainer(id, prev);
      if (!src || src === dest) return prev;
      return { ...prev, [src]: prev[src].filter((x) => x !== id), [dest]: [...prev[dest], id] };
    });
  };

  const selectMember = (id) => {
    if (justDragged.current) return;
    setSelected((cur) => (cur === id ? null : id));
  };
  // Where a click lands while someone is picked up.
  const placeAt = (dest) => () => {
    if (!selected) return;
    const id = selected;
    setSelected(null);
    moveMember(id, dest);
  };

  // Double-click a member in a party, Fill or Absent to send them back.
  const returnToPool = (id) => { setSelected(null); moveMember(id, 'pool'); };

  // Roles are saved per member the moment they change, so they carry into
  // every roster and into the signup counts.
  const setRole = (id, role) => {
    const next = roles[id] === role ? '' : role;
    setRolesByMode((prev) => ({ ...prev, [classMode]: { ...prev[classMode], [id]: next } }));
    axios.put('/api/admin/member-roles', { id, mode: classMode, role: next })
      .catch(() => flash(`Couldn't save ${byId[id]?.name || 'that member'}'s role.`, false));
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

  // `why` separates an LOA-driven bench from a deliberate one, so loading this
  // roster later can tell "their LOA was cancelled, want them back?" from "the
  // officer sat them out on purpose" and only ask about the former.
  const buildPayloadAbsent = () =>
    items.absent.map((id) => ({
      id, name: byId[id]?.name || 'Unknown', why: absentWhy[id] || 'benched',
    }));

  const resetBoard = () => {
    const next = initItems();
    members.forEach((m) => {
      if (isFullyOut(loaById, m.id)) next.absent.push(m.id);
      else next.pool.push(m.id);
    });
    setItems(next);
    setPartyNames(initNames()); setRosterId(null); setRosterName(''); setExtra({});
    setClassAssignments({ pvp: {}, pve: {} }); setLoaDiff(null); setAbsentWhy({}); setSelected(null);
    markClean();
  };
  const newBoard = () => { if (okToDiscard()) resetBoard(); };

  // Move everyone definitely out off the board in one go — the explicit version
  // of what used to happen silently on every date change. Partial absences are
  // deliberately left alone; the officer resolves those per-person.
  const benchLoaConflicts = () => {
    const moving = loaConflicts.full;
    if (moving.length === 0) return;
    const movingSet = new Set(moving);
    setItems((prev) => {
      const next = { ...prev, absent: [...prev.absent, ...moving] };
      ['pool', ...PARTY_IDS].forEach((key) => { next[key] = prev[key].filter((id) => !movingSet.has(id)); });
      return next;
    });
    setLoaDiff(null);
    flash(`Moved ${moving.length} member${moving.length === 1 ? '' : 's'} to Absent.`);
  };

  // Seed the board from who said they're coming. Explicit, like every other
  // bulk move here — the occasion changing must never rearrange a board an
  // officer is in the middle of building.
  //
  // Only people currently sitting in the pool are touched: anyone already in a
  // party or parked in Absent was put there deliberately. And nobody is ever
  // moved to Absent, because not signing up means undecided, not out — that
  // distinction is the whole reason signups are opt-in only.
  const seedFromSignups = () => {
    const going = items.pool.filter((id) => signupById.get(id) === 'going');
    const waiting = items.pool.filter((id) => signupById.get(id) === 'waitlist');
    if (going.length === 0 && waiting.length === 0) {
      return flash('Nobody in the pool has signed up for this occasion.', false);
    }

    // Roles come straight from rolesByMode, which loadMembers() already seeded
    // from member_roles — nobody picks a role at signup time.
    const queue = { Tank: [], Healer: [], DPS: [] };
    const unroled = [];
    going.forEach((id) => (queue[roles[id]] ? queue[roles[id]].push(id) : unroled.push(id)));

    const pull = (role) => {
      if (queue[role].length) return queue[role].shift();
      // Fall back to whoever's left rather than leaving a party short just
      // because nobody who signed up is a healer.
      const other = SEED_FALLBACK.find((r) => queue[r].length);
      return other ? queue[other].shift() : null;
    };

    // One tank, one healer, four DPS — the standard six. Parties that already
    // have people in them are topped up from the seat they left off at.
    const SEATS = ['Tank', 'Healer', 'DPS', 'DPS', 'DPS', 'DPS'];
    const placed = {};
    for (const pid of BOARD_PARTY_IDS) {
      if (items[pid].length >= PARTY_SIZE) continue;
      const taking = [];
      for (let seat = items[pid].length; seat < PARTY_SIZE; seat += 1) {
        const id = pull(SEATS[seat]);
        if (!id) break;
        taking.push(id);
      }
      if (taking.length) placed[pid] = taking;
      if (!ROLES.some((r) => queue[r].length)) break;
    }

    // Waitlist plus anyone the parties couldn't hold goes to Fill, which is
    // already the board's standby group. Fill respects the party size like any
    // other column; the remainder simply stays in the pool.
    const standby = [...waiting, ...SEED_FALLBACK.flatMap((r) => queue[r])];
    const fill = standby.slice(0, Math.max(0, PARTY_SIZE - items[FILL_PARTY_ID].length));
    const stayed = standby.length - fill.length;

    const seated = Object.values(placed).flat();
    const moving = new Set([...seated, ...fill]);
    setItems((prev) => {
      const next = { ...prev, pool: prev.pool.filter((id) => !moving.has(id)) };
      Object.entries(placed).forEach(([pid, ids]) => { next[pid] = [...prev[pid], ...ids]; });
      next[FILL_PARTY_ID] = [...prev[FILL_PARTY_ID], ...fill];
      return next;
    });

    const tail = [
      fill.length ? `${fill.length} to ${partyNames[FILL_PARTY_ID] || 'Fill'}` : '',
      stayed ? `${stayed} left in the pool, no room` : '',
      unroled.length ? `${unroled.length} left in the pool with no role set` : '',
    ].filter(Boolean);
    flash(`Seeded ${seated.length} from signups${tail.length ? `. ${tail.join(', ')}.` : '.'}`);
  };

  // Put members whose LOA no longer applies back into the pool, out of the
  // Absent box they were parked in when the roster was saved.
  const returnFromAbsent = (ids) => {
    const returning = new Set(ids.filter((id) => items.absent.includes(id)));
    if (returning.size === 0) return;
    setItems((prev) => ({
      ...prev,
      absent: prev.absent.filter((id) => !returning.has(id)),
      pool: [...prev.pool, ...returning],
    }));
  };

  // The board as a savable roster. Shared by save and duplicate, so a copy is
  // always of what's on screen — including edits not yet written back.
  const buildBody = (name) => ({
    name,
    layout: { parties: buildPayloadParties(), absent: buildPayloadAbsent(), classAssignments, rolesByMode },
    // The occasion the board is currently set to is the occasion the roster is
    // for — that's what makes re-checking LOA on load possible.
    event_date: loaDate || null,
    // A one-off has no schedule id; the roster keeps just its night.
    event_schedule_id: loaEvent && !loaEvent.startsWith('signup:') ? loaEvent : null,
  });

  const save = async () => {
    if (!rosterName.trim()) return flash('Name the roster first.', false);
    setBusy(true);
    const body = buildBody(rosterName);
    const sig = boardSig;
    try {
      if (rosterId) await axios.put(`/api/admin/rosters/${rosterId}`, body);
      else { const res = await axios.post('/api/admin/rosters', body); setRosterId(res.data.id); }
      setCleanSig(sig);
      loadSaved(); flash('Roster saved.');
    } catch (err) { flash(err.response?.data?.error || 'Save failed.', false); }
    finally { setBusy(false); }
  };

  // "Siege" → "Siege (copy)" → "Siege (copy 2)" … an existing suffix is stripped
  // first so repeated duplication doesn't pile them up, and taken names are
  // skipped so the menu never shows two entries reading the same.
  const copyName = (name) => {
    const base = name.replace(/ \(copy(?: \d+)?\)$/, '').trim() || 'Roster';
    const taken = new Set(saved.map((r) => r.name));
    let candidate = `${base} (copy)`;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${base} (copy ${n})`;
    return candidate.slice(0, 120);
  };

  // Save the board as a new roster, leaving the loaded one untouched, and switch
  // to editing the copy. This is how a roster gets reused for another night:
  // duplicate it, move the date, and the strip re-checks LOA for the new
  // occasion against the copy — where load-change-date-Save overwrites last week's.
  const duplicate = async () => {
    if (!rosterId) return;
    setBusy(true);
    const name = copyName(rosterName);
    const sig = sigFor(name);
    try {
      const res = await axios.post('/api/admin/rosters', buildBody(name));
      setRosterId(res.data.id); setRosterName(name); setCleanSig(sig);
      // The LOA-changed note is about the roster that was loaded; the copy is
      // freshly saved, so there's nothing to have changed since.
      setLoaDiff(null);
      loadSaved(); flash(`Duplicated as "${name}".`);
    } catch (err) { flash(err.response?.data?.error || 'Duplicate failed.', false); }
    finally { setBusy(false); }
  };

  const load = async (id) => {
    if (!id || !okToDiscard()) return;
    try {
      const res = await axios.get(`/api/admin/rosters/${id}`);
      const r = res.data.roster;
      // Re-check LOA against the occasion this roster was built for, not
      // whatever the picker happens to be showing. Rosters saved before the
      // occasion was recorded have none — leave the picker alone and skip the
      // diff, since there's no date to say "since you saved this" about.
      const date = r.event_date || null;
      const event = r.event_schedule_id || '';
      const loa = date ? await fetchLoa(date, event) : loaById;

      const nextItems = initItems();
      const nextNames = initNames();
      // Rosters saved before roles were split by mode only have a flat m.role —
      // fall back to applying it to both, same as it behaved before the split.
      const legacyRoles = {};
      const nextExtra = {};
      (r.layout?.parties || []).forEach((lp) => {
        if (!PARTY_IDS.includes(lp.id)) return;
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
      unassigned.forEach((mid) => {
        if (isFullyOut(loa, mid)) nextItems.absent.push(mid);
        else nextItems.pool.push(mid);
      });

      // Assigned members who have filed since this was saved. Only this half of
      // the comparison lives here, because it names which party each one is in
      // — something nothing else can say. The reverse case (benched for an
      // absence that no longer applies) is covered live by staleBenches, which
      // reads the restored `why` markers below and stays correct as the
      // occasion moves, so repeating it here would say the same thing twice.
      // Names come from byId where possible — the layout's copy is whatever it
      // was when saved, which goes stale when someone changes their name.
      const nameNow = (m) => byId[m.id]?.name || m.name || 'Unknown';
      const nowOut = (r.layout?.parties || []).flatMap((lp) =>
        (lp.members || []).filter((m) => isFullyOut(loa, m.id))
          .map((m) => ({ id: m.id, name: nameNow(m), party: lp.name || lp.id })));
      const savedWhy = {};
      (r.layout?.absent || []).forEach((m) => { savedWhy[m.id] = m.why || 'benched'; });

      setItems(nextItems); setPartyNames(nextNames); setAbsentWhy(savedWhy);
      setRolesByMode(mergedRolesByMode); setExtra(nextExtra);
      setClassAssignments(r.layout?.classAssignments || { pvp: {}, pve: {} });
      setRosterId(r.id); setRosterName(r.name); setSelected(null);
      if (date) {
        loaFetchedFor.current = `${date}|${event}`;
        setLoaDate(date); setLoaEvent(event); setLoaById(loa);
      }
      setLoaDiff(date && nowOut.length ? { nowOut } : null);
      markClean();
      flash(`Loaded "${r.name}".`);
    } catch (err) { flash(err.response?.data?.error || 'Load failed.', false); }
  };

  const del = async () => {
    if (!rosterId) return;
    if (!window.confirm(`Delete roster "${rosterName}"?`)) return;
    try { await axios.delete(`/api/admin/rosters/${rosterId}`); loadSaved(); resetBoard(); flash('Roster deleted.'); }
    catch (err) { flash(err.response?.data?.error || 'Delete failed.', false); }
  };

  const post = async () => {
    // Last check before it's public: posting a roster that has people in it who
    // are known to be out is the failure this whole flow exists to prevent.
    if (loaConflicts.fullInParties.length > 0
      && !window.confirm(`${namesFor(loaConflicts.fullInParties)} ${loaConflicts.fullInParties.length === 1 ? 'is' : 'are'} on LOA but still in a party. Post anyway?`)) return;
    setBusy(true);
    try {
      const canvas = renderRosterImage(PARTY_IDS, items, partyNames, roles, byId, classMode, classAssignments, absentWhy);
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

  // Fill is standby, not a real party, so it's counted apart from the total.
  const slottedCount = BOARD_PARTY_IDS.reduce((n, pid) => n + items[pid].length, 0);
  const fillCount = items[FILL_PARTY_ID].length;

  const saveState = dirty
    ? { label: 'Unsaved changes', cls: `${WARN_TEXT} border-amber-500/50`, dot: 'bg-amber-500' }
    : rosterId
      ? { label: 'Saved', cls: `${GOOD_TEXT} border-emerald-500/40`, dot: 'bg-emerald-500' }
      : { label: 'New board', cls: 'text-ash border-line', dot: 'bg-ash' };

  const memberCard = (id, { returnable = false } = {}) => (
    <SortableMember key={id} member={byId[id] || { id, name: 'Unknown' }} role={roles[id]} onRole={setRole}
      loa={loaById.get(id)} signup={signupById.get(id)} classMode={classMode}
      assignedClass={classAssignments[classMode][id]} onClassChange={(cls) => setMemberClass(classMode, id, cls)}
      selected={selected === id} onSelect={selectMember} onReturn={returnable ? returnToPool : undefined} />
  );

  const roleChips = [
    { key: 'all', label: 'All', dot: 'bg-ash' },
    ...ROLES.map((r) => ({ key: r, label: r, dot: ROLE_STYLE[r].dot })),
    { key: 'none', label: 'No role', dot: 'bg-ash/40' },
  ];

  return (
    <PageShell width="full" paddingX="px-2">
      {/* Header, split by job: the night you're building for, the roster
          itself, then what you do with it. Load, New, Duplicate and Delete
          live in the ⋯ menu. */}
      <header className="panel rounded-lg p-3 mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-[10px] text-ash flex items-center gap-1.5">
            <CalendarDays className="w-3.5 h-3.5" /> Building for
          </span>
          <div className="flex flex-wrap gap-2">
            <input type="date" value={loaDate} onChange={(e) => changeLoaDate(e.target.value)} aria-label="Date"
              className="bg-hall border border-line rounded px-2 py-1.5 text-bone text-sm focus:outline-none focus:border-brass"
              title="The occasion this roster is for. LOAs and signups are checked against it, and it's saved with the roster." />
            <select value={loaEvent} onChange={(e) => changeLoaEvent(e.target.value)} aria-label="Event"
              className="bg-hall border border-line rounded px-2 py-1.5 text-bone text-sm focus:outline-none focus:border-brass max-w-[16rem]">
              <option value="">All events</option>
              {/* After-midnight events belong to this night but land on the next
                  calendar day, so the day is shown to head off "why is the 12:30
                  AM one under Saturday?". */}
              {eventsForDate.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.event_time ? ` — ${fmtTimeEst(s.event_time)}` : ''}
                  {isAfterMidnight(s.event_time) ? ` ${DAY_ABBR[s.day_of_week]}` : ''}
                </option>
              ))}
              {oneOffs.map((o) => (
                <option key={o.id} value={`signup:${o.id}`}>
                  {o.title}{o.event_time ? ` — ${fmtTimeEst(o.event_time)}` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3 flex-1 basis-64 justify-center min-w-0">
          <label className="relative min-w-0 flex items-center gap-1.5">
            <span className="sr-only">Roster name</span>
            <input value={rosterName} onChange={(e) => setRosterName(e.target.value)} placeholder="Name this roster"
              className="bg-transparent border-0 border-b border-dashed border-line focus:border-brass focus:outline-none font-display text-lg text-bone placeholder:text-ash/60 px-0 py-0.5 w-56 min-w-0" />
            <Pencil className="w-3.5 h-3.5 text-ash/60 shrink-0" aria-hidden="true" />
          </label>
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold border rounded-full px-2.5 py-0.5 whitespace-nowrap ${saveState.cls}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${saveState.dot}`} />{saveState.label}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Classes and roles for" className="inline-flex rounded-full border border-line bg-hall p-0.5">
            {['pvp', 'pve'].map((m) => (
              <button key={m} type="button" aria-pressed={classMode === m} onClick={() => setClassMode(m)}
                className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-colors ${classMode === m ? BUILD_CHIP_ON[KIND_BUILD[m]] : 'text-ash hover:text-bone'}`}>
                {KIND_BUILD[m]}
              </button>
            ))}
          </div>
          <RosterMenu saved={saved} rosterId={rosterId} loaDate={loaDate} busy={busy}
            onLoad={load} onNew={newBoard} onDuplicate={duplicate} onDelete={del} />
          <Button size="none" className="px-4 py-2" disabled={busy} onClick={save}><Save className="w-4 h-4" /> Save</Button>
          <Button variant="secondary" size="none" className="px-4 py-2" disabled={busy} onClick={post}><Send className="w-4 h-4" /> Post to Discord</Button>
        </div>
      </header>

      {/* One status strip in place of the stacked bars: signups, LOA trouble,
          and the result of the last action. Each chip only appears when it has
          something to say, except signups, which always reports. */}
      <div aria-label="Board status" className="panel rounded-lg px-2.5 py-2 mb-4 flex flex-wrap items-center gap-2 text-sm">
        {signupById.size > 0 ? (
          <StatusChip title="Who said they're coming. Everyone else just hasn't answered.">
            <ClipboardList className={`w-4 h-4 shrink-0 ${GOOD_TEXT}`} />
            <span className="text-bone">
              <b className="font-mono">{signupCounts.going}</b> signed up
              {signupCounts.waitlist > 0 && <>, <b className="font-mono">{signupCounts.waitlist}</b> waitlist</>}
            </span>
            {ROLES.map((r) => (
              <span key={r} title={`${r}s signed up`} className={`font-mono text-xs ${ROLE_STYLE[r].text}`}>
                {r[0]} {signupCounts.byRole[r]}
              </span>
            ))}
            {signupCounts.byRole.unroled > 0 && (
              <span className={`text-xs ${WARN_TEXT}`} title="Signed up with no role set. Seed parties leaves them in the pool.">
                +{signupCounts.byRole.unroled} no role
              </span>
            )}
            {signupCounts.inPool > 0 && (
              <button type="button" onClick={seedFromSignups}
                className={`px-2 py-0.5 rounded border border-emerald-500/60 text-xs font-semibold hover:bg-emerald-500/10 ${GOOD_TEXT}`}>
                Seed parties
              </button>
            )}
          </StatusChip>
        ) : (
          <StatusChip tone="muted">
            <ClipboardList className="w-4 h-4 shrink-0" /> No signups for this night yet
          </StatusChip>
        )}

        {/* Which parties lost someone since this roster was saved. Every change
            is applied by the officer, never automatically. */}
        {loaDiff && (
          <StatusChip tone="warn">
            <CalendarOff className="w-4 h-4 shrink-0" />
            <span>On LOA since this was saved: <span className="text-bone">{loaDiff.nowOut.map((m) => `${m.name} (${m.party})`).join(', ')}</span></span>
            <button type="button" onClick={() => setLoaDiff(null)} className="p-0.5 text-ash hover:text-bone" aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </StatusChip>
        )}

        {/* Members definitely out, still on the board. */}
        {loaConflicts.full.length > 0 && (
          <StatusChip tone="danger">
            <AlertTriangle className="w-4 h-4 shrink-0 text-oxblood" />
            <span className="text-bone">
              {loaConflicts.fullInParties.length > 0 ? (
                <>
                  <b>{namesFor(loaConflicts.fullInParties)}</b> on LOA but in a party
                  {loaConflicts.full.length > loaConflicts.fullInParties.length
                    && `, ${loaConflicts.full.length - loaConflicts.fullInParties.length} more in the pool`}
                </>
              ) : (
                <><b className="font-mono">{loaConflicts.full.length}</b> in the pool on LOA</>
              )}
            </span>
            <button type="button" onClick={benchLoaConflicts}
              className="px-2 py-0.5 rounded bg-oxblood text-white text-xs font-semibold hover:opacity-90">
              Move {loaConflicts.full.length} to Absent
            </button>
          </StatusChip>
        )}

        {/* Benched for an absence that no longer applies: the counterpart to
            the conflict chip, and what keeps Absent from silting up as an
            officer moves between dates. */}
        {staleBenches.length > 0 && (
          <StatusChip tone="good">
            <CalendarCheck className={`w-4 h-4 shrink-0 ${GOOD_TEXT}`} />
            <span className="text-bone"><b>{namesFor(staleBenches)}</b> in Absent for an LOA that doesn&apos;t apply</span>
            <button type="button" onClick={() => returnFromAbsent(staleBenches)}
              className={`px-2 py-0.5 rounded border border-emerald-500/60 text-xs font-semibold hover:bg-emerald-500/10 ${GOOD_TEXT}`}>
              Return {staleBenches.length} to pool
            </button>
          </StatusChip>
        )}

        {/* Time-scoped absences that may or may not collide with what's being
            built. No bulk action: picking a specific event resolves them into a
            definite yes or no, and the card tooltips show each window. */}
        {loaConflicts.partial.length > 0 && (
          <StatusChip tone="warn">
            <Clock className="w-4 h-4 shrink-0" />
            <span>
              <b>{namesFor(loaConflicts.partial)}</b> out for part of the day. Hover for the window
              {!loaEvent && ', or pick an event to check it exactly'}.
            </span>
          </StatusChip>
        )}

        <span className="flex-1" />
        <span role="status" className={`text-xs ${msg ? (msg.ok ? GOOD_TEXT : 'text-oxblood') : 'sr-only'}`}>{msg?.text || ''}</span>
        <span className="text-xs text-ash whitespace-nowrap">
          <b className="font-mono text-bone">{slottedCount}</b> slotted
          {' · '}<b className="font-mono text-bone">{fillCount}</b> in {partyNames[FILL_PARTY_ID] || 'Fill'}
          {loaById.size > 0 && <>{' · '}<b className="font-mono text-oxblood">{loaById.size}</b> on LOA</>}
        </span>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCorners}
        onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={endDrag}>
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 items-start">
          {/* The pool: everyone not placed, in one list. Role is a filter. */}
          <DroppableColumn id="pool" itemIds={pool.list} onClick={placeAt('pool')} selecting={Boolean(selected)}
            className="panel rounded-lg p-3 flex flex-col lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]">
            {/* Controls don't count as a click on the pool. */}
            <div onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <h2 className="font-display text-bone text-[15px]">
                  Pool <span className="font-mono text-xs text-ash font-normal">{items.pool.length}</span>
                </h2>
                <div className="flex items-center gap-3">
                  <button type="button" role="switch" aria-checked={signedOnly} onClick={() => setSignedOnly((v) => !v)}
                    className={`inline-flex items-center gap-1.5 text-xs ${signedOnly ? 'text-bone' : 'text-ash hover:text-bone'}`}>
                    <span className={`relative inline-block w-6 h-3.5 rounded-full transition-colors ${signedOnly ? 'bg-emerald-500' : 'bg-line'}`}>
                      <span className={`absolute top-0.5 w-2.5 h-2.5 rounded-full bg-bone transition-all ${signedOnly ? 'left-3' : 'left-0.5'}`} />
                    </span>
                    Signed up only
                  </button>
                  <button type="button" onClick={loadMembers} className="text-ash hover:text-brass" title="Reload members" aria-label="Reload members">
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search…" aria-label="Search the pool"
                className="w-full bg-hall border border-line rounded px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass mb-2" />
              <div className="flex flex-wrap gap-1.5 mb-2">
                {roleChips.map(({ key, label, dot }) => {
                  const on = roleFilter === key;
                  return (
                    <button key={key} type="button" aria-pressed={on} onClick={() => setRoleFilter(key)}
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold border transition-colors ${on ? 'border-ash/60 bg-panelup text-bone' : 'border-line text-ash hover:text-bone'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />{label}
                      <span className="font-mono opacity-80">{pool.counts[key]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex-1 min-h-[60px] max-h-[60vh] lg:max-h-none overflow-auto space-y-1 pr-1">
              {loadingMembers ? (
                <div className="text-ash text-sm text-center py-6">Loading members…</div>
              ) : membersError ? (
                <ErrorBanner className="" compact>
                  {membersError}<button type="button" onClick={loadMembers} className="block mt-2 text-brass hover:text-brassbright">Retry</button>
                </ErrorBanner>
              ) : pool.list.length === 0 ? (
                <div className="text-ash/60 text-xs text-center py-4 border border-dashed border-line rounded">
                  {items.pool.length === 0 ? 'Everyone is placed.' : 'Nobody here matches.'}
                </div>
              ) : pool.list.map((id) => memberCard(id))}
            </div>
          </DroppableColumn>

          <div className="min-w-0">
            {/* Six across on wide screens, so the 11 parties read as a row of
                6 and a row of 5. Narrower screens step down the columns. */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3 items-start">
              {BOARD_PARTY_IDS.map((pid) => (
                <PartyCard key={pid} pid={pid} name={partyNames[pid]} onRename={(v) => renameParty(pid, v)}
                  ids={items[pid]} roles={roles} selecting={Boolean(selected)} onPlace={placeAt(pid)}
                  renderMember={(id) => memberCard(id, { returnable: true })} />
              ))}
            </div>

            {/* The bench: Fill (standby) and Absent, side by side under the
                parties, laid out as wrapping grids. */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-4">
              <BenchBox id={FILL_PARTY_ID} ids={items[FILL_PARTY_ID]} selecting={Boolean(selected)} onPlace={placeAt(FILL_PARTY_ID)}
                tone="border-amber-500/40 bg-amber-500/[0.03]" dot="bg-amber-500"
                title={(
                  <input value={partyNames[FILL_PARTY_ID]} onChange={(e) => renameParty(FILL_PARTY_ID, e.target.value)}
                    onClick={(e) => e.stopPropagation()} aria-label="Standby group name"
                    className="bg-transparent font-display text-bone text-sm tracking-[0.06em] focus:outline-none focus:text-brassbright w-28" />
                )}
                count={`${fillCount}/${PARTY_SIZE}`} hint="Standby: fills in if someone drops" emptyText="Drop backups here"
                renderMember={(id) => memberCard(id, { returnable: true })} />
              <BenchBox id="absent" ids={items.absent} selecting={Boolean(selected)} onPlace={placeAt('absent')}
                tone="border-oxblood/40 bg-oxblood/[0.03]" dot="bg-oxblood"
                title={<h2 className="font-display text-bone text-sm tracking-[0.06em]">Absent</h2>}
                count={String(items.absent.length)} hint="Not playing this night" emptyText="Drop absent members here"
                renderMember={(id) => memberCard(id, { returnable: true })} />
            </div>

            <p className="mt-3 text-xs text-ash">
              Drag members between the pool, parties and bench, or click a member and then click where they go (Esc to cancel).
              Double-click someone in a party or on the bench to send them back to the pool.
              T / H / D on a card sets that member&apos;s {KIND_BUILD[classMode]} role for every roster.
            </p>
          </div>
        </div>

        <DragOverlay>{activeMember ? <MemberCardBase member={activeMember} role={roles[activeMember.id]} loa={loaById.get(activeMember.id)} signup={signupById.get(activeMember.id)} overlay /> : null}</DragOverlay>
      </DndContext>
    </PageShell>
  );
}

const CHIP_TONE = {
  neutral: 'border-line bg-panelup/40',
  muted: 'border-line text-ash',
  warn: `border-amber-500/40 ${WARN_TEXT}`,
  danger: 'border-oxblood/50 bg-oxblood/10',
  good: 'border-emerald-500/40',
};

function StatusChip({ tone = 'neutral', title, children }) {
  return (
    <span title={title} className={`inline-flex flex-wrap items-center gap-2 px-2.5 py-1 rounded-md border ${CHIP_TONE[tone]}`}>
      {children}
    </span>
  );
}

// Load, New, Duplicate and Delete, out of the header's way.
function RosterMenu({ saved, rosterId, loaDate, busy, onLoad, onNew, onDuplicate, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = (fn) => () => { setOpen(false); fn(); };
  const item = 'w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 hover:bg-panelup disabled:opacity-40 disabled:hover:bg-transparent';

  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        aria-label="Roster menu: load, new, duplicate, delete" title="Load, new, duplicate, delete"
        className="w-9 h-9 inline-flex items-center justify-center rounded-lg border border-line text-ash hover:text-bone">
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-11 z-30 w-72 max-w-[calc(100vw-2rem)] bg-panel border border-line rounded-lg p-1.5 shadow-xl">
          <div className="eyebrow text-[10px] text-ash px-2 py-1.5">Load roster</div>
          <div className="max-h-72 overflow-auto">
            {saved.length === 0 && <div className="px-2 py-1.5 text-sm text-ash/70">No saved rosters yet.</div>}
            {saved.map((r) => (
              <button key={r.id} type="button" role="menuitem" onClick={pick(() => onLoad(r.id))}
                className={`${item} ${r.id === rosterId ? 'text-bone font-semibold' : 'text-ash hover:text-bone'}`}>
                <span className="truncate flex-1">{r.name}</span>
                {r.event_date === loaDate
                  ? <span className={`text-xs shrink-0 ${GOOD_TEXT}`}>this night</span>
                  : r.event_date && <span className="text-xs font-mono text-ash/70 shrink-0">{r.event_date}</span>}
                {r.id === rosterId && <Check className="w-3.5 h-3.5 shrink-0" aria-label="Open now" />}
              </button>
            ))}
          </div>
          <div className="h-px bg-line my-1.5" />
          <button type="button" role="menuitem" onClick={pick(onNew)} className={`${item} text-bone`}>
            <Plus className="w-4 h-4 text-ash" /> New board
          </button>
          <button type="button" role="menuitem" onClick={pick(onDuplicate)} disabled={!rosterId || busy}
            title={rosterId ? 'Save this board as a new roster, leaving the original untouched' : 'Load or save a roster first'}
            className={`${item} text-bone`}>
            <Copy className="w-4 h-4 text-ash" /> Duplicate
          </button>
          {rosterId && (
            <button type="button" role="menuitem" onClick={pick(onDelete)} className={`${item} text-oxblood`}>
              <Trash2 className="w-4 h-4" /> Delete roster…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// One party: six seats, always. Pips show the makeup at a glance, a missing
// tank or healer is called out (and named in the empty seat it belongs in),
// and a full party turns green.
function PartyCard({ pid, name, onRename, ids, roles, selecting, onPlace, renderMember }) {
  const mk = partyMakeup(ids, roles);
  return (
    <DroppableColumn id={pid} itemIds={ids} onClick={onPlace} selecting={selecting}
      className={`rounded-lg border bg-panel p-2.5 ${mk.full ? 'border-emerald-500/40' : 'border-line'}`}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <input value={name} onChange={(e) => onRename(e.target.value)} onClick={(e) => e.stopPropagation()}
          aria-label={`Rename ${name}`}
          className="bg-transparent font-display text-bone text-sm tracking-[0.06em] focus:outline-none focus:text-brassbright min-w-0 flex-1" />
        <span className={`font-mono text-xs ${mk.full ? GOOD_TEXT : 'text-ash'}`}>{ids.length}/{PARTY_SIZE}</span>
      </div>
      <div className="flex gap-1 mb-2" aria-hidden="true">
        {Array.from({ length: PARTY_SIZE }, (_, i) => (i < mk.pips.length
          ? <span key={i} className={`flex-1 h-1.5 rounded-full ${mk.pips[i] ? ROLE_STYLE[mk.pips[i]].dot : 'bg-ash/40'}`} />
          : <span key={i} className="flex-1 h-1.5 rounded-full border border-dashed border-line" />))}
      </div>
      {mk.missing.length > 0 && (
        <div className={`text-[11px] font-semibold mb-1.5 ${WARN_TEXT}`}>
          No {mk.missing.map((r) => r.toLowerCase()).join(' or ')} yet
        </div>
      )}
      <div className="space-y-1">
        {ids.map(renderMember)}
        {mk.seats.map((need, i) => (
          <div key={`seat-${pid}-${i}`}
            className={`h-[30px] flex items-center px-2 rounded border border-dashed text-[11px] ${need ? `border-amber-500/50 ${WARN_TEXT}` : 'border-line text-ash/60'}`}>
            {need ? `Empty seat · needs a ${need.toLowerCase()}` : 'Empty seat'}
          </div>
        ))}
      </div>
    </DroppableColumn>
  );
}

function BenchBox({ id, ids, selecting, onPlace, tone, dot, title, count, hint, emptyText, renderMember }) {
  return (
    <DroppableColumn id={id} itemIds={ids} strategy={rectSortingStrategy} onClick={onPlace} selecting={selecting}
      className={`rounded-lg border border-dashed p-3 ${tone}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
        {title}
        <span className="font-mono text-xs text-ash">{count}</span>
        <span className="flex-1" />
        <span className="text-[11px] text-ash">{hint}</span>
      </div>
      {ids.length === 0 ? (
        <div className="text-ash/60 text-xs text-center py-3">{emptyText}</div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-1.5 max-h-[320px] overflow-auto pr-1">
          {ids.map(renderMember)}
        </div>
      )}
    </DroppableColumn>
  );
}

// Droppable container that also provides a SortableContext for its items.
// The pool and parties are single columns; the bench lays out as wrapping
// grids and passes rectSortingStrategy so drag previews shift correctly in two
// dimensions. While someone is picked up for click-to-place, every container
// is outlined and a click on it places them there.
function DroppableColumn({ id, itemIds, className, children, strategy = verticalListSortingStrategy, onClick, selecting }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const state = isOver ? 'ring-2 ring-brass/60' : selecting ? 'ring-1 ring-brass/40 cursor-pointer' : '';
  return (
    <SortableContext id={id} items={itemIds} strategy={strategy}>
      <div ref={setNodeRef} onClick={onClick} className={`${className} transition-shadow ${state}`}>
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

// Nested controls (role buttons, the class select) keep their clicks to
// themselves, so using them never picks the card up or sends it to the pool.
const keepClick = {
  onPointerDown: (e) => e.stopPropagation(),
  onClick: (e) => e.stopPropagation(),
  onDoubleClick: (e) => e.stopPropagation(),
};

const MemberCardBase = forwardRef(function MemberCardBase({ member, role, onRole, overlay, style, handle, isDragging, loa, signup, classMode, assignedClass, onClassChange, selected, onSelect, onReturn }, ref) {
  const rs = ROLE_STYLE[role];
  const classes = ((classMode === 'pve' ? member.pve_classes : member.pvp_classes) || []).filter(Boolean);
  const current = assignedClass || classes[0];
  // A definite absence is dimmed and reddened; a partial one stays at full
  // strength in amber, because the member may well still be usable — the
  // difference is the whole point of showing the window.
  const partial = Boolean(loa?.partial);
  const loaTitle = loaSummary(loa);
  const hint = onReturn ? 'Double-click to send back to the pool' : null;
  const title = [loaTitle, hint].filter(Boolean).join(' · ') || undefined;

  return (
    <div
      ref={ref} style={style} {...handle}
      onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(member.id); } : undefined}
      onDoubleClick={onReturn ? (e) => { e.stopPropagation(); onReturn(member.id); } : undefined}
      aria-pressed={onSelect ? Boolean(selected) : undefined}
      title={title}
      className={`group relative flex items-center gap-1 bg-hall border border-line ${rs ? `border-l-2 ${rs.ring}` : ''} rounded px-1.5 py-1 cursor-grab active:cursor-grabbing select-none ${isDragging ? 'opacity-30' : ''} ${overlay ? 'shadow-xl ring-1 ring-brass/40' : ''} ${selected ? 'ring-2 ring-brass' : ''} ${loa && !partial ? 'opacity-50' : ''} ${partial && !selected ? 'ring-1 ring-amber-500/40' : ''}`}
    >
      {member.avatar
        ? <img src={member.avatar} alt="" className="w-5 h-5 rounded-full border border-line shrink-0" />
        : <span className="w-5 h-5 rounded-full bg-panelup border border-line shrink-0 flex items-center justify-center text-[9px] text-brass">{(member.name || '?').slice(0, 1).toUpperCase()}</span>}
      <div className="min-w-0 flex-1">
        <span className={`text-sm leading-tight truncate block ${member.missing ? 'text-ash italic' : loa && !partial ? 'text-oxblood' : partial ? WARN_TEXT : 'text-bone'}`}
          title={loaTitle || (member.missing ? 'No longer in the server' : member.name)}>{member.name}</span>
        {loa?.start_time && (
          <span className={`text-[10px] leading-tight truncate block ${partial ? WARN_TEXT : 'text-oxblood'}`}>
            {loa.end_time ? `out ${shortTime(loa.start_time)}–${shortTime(loa.end_time)}` : `out from ${shortTime(loa.start_time)}`}
          </span>
        )}
        {classes.length === 1 && (
          <span className="text-[10px] leading-tight text-ash truncate block">{classes[0]}</span>
        )}
        {classes.length > 1 && onClassChange && (
          <select
            value={current} onChange={(e) => onClassChange(e.target.value)} {...keepClick}
            aria-label={`${member.name}'s class`}
            className="text-[10px] bg-transparent text-ash hover:text-bone border-none focus:outline-none cursor-pointer truncate w-full -ml-px"
          >
            {classes.map((c, i) => <option key={c} value={c} className="bg-panelup text-bone">{c}{i === 0 ? ' ★' : ''}</option>)}
          </select>
        )}
      </div>
      {/* Signed up. Absence of this badge means nothing at all, so there's no
          counterpart marker for people who haven't answered. */}
      {signup && (
        <span title={signup === 'waitlist' ? 'On the signup waitlist' : 'Signed up for this occasion'}
          className={`text-[9px] font-bold leading-none shrink-0 ${signup === 'waitlist' ? WARN_TEXT : GOOD_TEXT}`}>
          {signup === 'waitlist' ? 'WL' : '✓'}
        </span>
      )}
      {loa && <CalendarOff className={`w-3.5 h-3.5 shrink-0 ${partial ? WARN_TEXT : 'text-oxblood'}`} />}
      {onRole && (
        <div className="flex gap-1 opacity-60 group-hover:opacity-100 transition-opacity" {...keepClick}>
          {ROLES.map((r) => (
            <button key={r} type="button" onClick={() => onRole(member.id, r)} aria-pressed={role === r}
              title={role === r ? `${member.name} is ${r} (click to clear)` : `Set ${member.name} as ${r}`}
              aria-label={role === r ? `Clear ${r}` : `Set as ${r}`}
              className={`w-5 h-5 rounded-full text-[9px] font-bold flex items-center justify-center border transition-colors ${role === r ? `${ROLE_STYLE[r].dot} text-neutral-950 border-transparent` : 'border-line text-ash hover:text-bone'}`}>
              {r[0]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
