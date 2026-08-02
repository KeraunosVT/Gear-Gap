import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import { X, Check, Ban, Coins, Plus, Pencil, Trash2, RotateCcw, ChevronDown } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';
import { fmtDatetime } from '../timeUtils';
import CurrencyIcon from '../components/ui/CurrencyIcon';

// Requests move pending -> approved -> paid, with denied as a dead end that can
// be reopened. Only 'paid' has a side effect (it writes the Lucent grant), which
// is why it's reachable from 'approved' rather than straight from 'pending'.
const STATUS_META = {
  pending: { label: 'Pending', cls: 'text-brass border-brass/40' },
  approved: { label: 'Approved', cls: 'text-sky-400 border-sky-400/40' },
  paid: { label: 'Paid', cls: 'text-emerald-400 border-emerald-400/40' },
  denied: { label: 'Denied', cls: 'text-ash border-line' },
};
const FILTERS = ['open', 'pending', 'approved', 'paid', 'denied', 'all'];
const FILTER_LABEL = { open: 'Open', all: 'All', ...Object.fromEntries(Object.entries(STATUS_META).map(([k, v]) => [k, v.label])) };

const OTHER = '__other__';

export default function LootRequests() {
  const { user, can } = useAuth();
  const [members, setMembers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('open');
  const [msg, flash] = useFlash(3500);

  const [editingId, setEditingId] = useState(null);
  const [edit, setEdit] = useState({ amount: '', note: '', request_type: '' });

  const load = () => {
    Promise.all([
      axios.get('/api/admin/members'),
      axios.get('/api/loot/catalog'),
      axios.get('/api/admin/lucent-requests'),
    ])
      .then(([mem, cat, reqs]) => {
        setMembers(mem.data.members || []);
        setCatalog(cat.data.categories || []);
        setRequests(reqs.data.requests || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load Lucent requests.'));
  };
  useEffect(() => { load(); }, []);

  // Status sorts by where it sits in the workflow, not alphabetically —
  // "approved, denied, paid, pending" tells you nothing, whereas grouping the
  // ones still needing action ahead of the settled ones is the point of sorting
  // by it at all.
  const STATUS_ORDER = { pending: 0, approved: 1, paid: 2, denied: 3 };
  const COMPARE = {
    member: (a, b) => (a.display_name || '').localeCompare(b.display_name || ''),
    item: (a, b) => (a.item_name || '').localeCompare(b.item_name || ''),
    // Untyped rows sort last either way rather than clumping under '' at the top.
    type: (a, b) => (a.request_type || '￿').localeCompare(b.request_type || '￿'),
    amount: (a, b) => a.amount - b.amount,
    status: (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9),
    date: (a, b) => String(a.requested_at).localeCompare(String(b.requested_at)),
  };

  const [sort, setSort] = useState({ key: 'date', dir: 'desc' });

  // First click on a column picks the direction that's useful for its type:
  // newest and largest first for dates and amounts, A–Z for names. Clicking the
  // same column again flips it.
  const toggleSort = (key) => setSort((s) => (
    s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'date' || key === 'amount' ? 'desc' : 'asc' }
  ));

  const shown = useMemo(() => {
    const base = filter === 'all' ? requests
      : filter === 'open' ? requests.filter((r) => r.status === 'pending' || r.status === 'approved')
        : requests.filter((r) => r.status === filter);
    const cmp = COMPARE[sort.key] || COMPARE.date;
    // Ties fall back to newest-first so the order is stable and predictable
    // rather than however the rows happened to arrive.
    return [...base].sort((a, b) => {
      const primary = cmp(a, b) * (sort.dir === 'asc' ? 1 : -1);
      return primary || -COMPARE.date(a, b);
    });
  }, [requests, filter, sort]);

  // Lucent already committed but not yet handed over — the number an officer
  // needs before promising anything else.
  const owed = useMemo(
    () => requests.filter((r) => r.status === 'approved').reduce((sum, r) => sum + r.amount, 0),
    [requests],
  );
  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  // Types already in use, offered as suggestions. The field stays free text —
  // this only keeps 'Enchant' and 'enchant' from fragmenting one category.
  const knownTypes = useMemo(
    () => [...new Set(requests.map((r) => r.request_type).filter(Boolean))].sort(),
    [requests],
  );

  const create = (body) => {
    setBusy(true);
    axios.post('/api/admin/lucent-requests', body)
      .then(() => { load(); flash('Request logged.'); })
      .catch((err) => flash(err.response?.data?.error || 'Failed to log request.', false))
      .finally(() => setBusy(false));
  };

  const patch = (id, body, okMsg) => {
    axios.patch(`/api/admin/lucent-requests/${id}`, body)
      .then(() => { setEditingId(null); load(); if (okMsg) flash(okMsg); })
      .catch((err) => flash(err.response?.data?.error || 'Update failed.', false));
  };

  const setStatus = (r, status) => {
    if (status === 'paid' && !window.confirm(
      `Mark paid and record a grant of ${r.amount.toLocaleString()} Lucent to ${r.display_name || r.discord_id}?\n\n`
      + 'This adds a row to the Lucent & Shards ledger.',
    )) return;
    patch(r.id, { status }, status === 'paid' ? 'Marked paid — Lucent grant recorded.' : `Marked ${status}.`);
  };

  const remove = (r) => {
    if (!window.confirm(`Delete this request for ${r.item_name}?${r.currency_award_id ? '\n\nThe Lucent grant it created stays in the ledger.' : ''}`)) return;
    axios.delete(`/api/admin/lucent-requests/${r.id}`)
      .then(() => { load(); flash('Request deleted.'); })
      .catch((err) => flash(err.response?.data?.error || 'Delete failed.', false));
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setEdit({ amount: String(r.amount), note: r.note || '', request_type: r.request_type || '' });
  };

  if (!can('loot.requests')) return <RestrictedGate />;

  return (
    <PageShell>
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}
      <Toast msg={msg} />

      <p className="text-sm text-ash mb-5">
        Log what members have asked for so requests don&apos;t live only in Discord. Marking one paid records the
        Lucent grant on the <span className="text-bone">Lucent &amp; Shards</span> ledger, so it&apos;s only entered once.
      </p>

      <datalist id="lucent-request-types">
        {knownTypes.map((t) => <option key={t} value={t} />)}
      </datalist>

      <div className="panel rounded-lg p-6 space-y-6">
        <RequestForm members={members} catalog={catalog} busy={busy} onCreate={create} />

        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1">
            {FILTERS.map((f) => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded-full text-xs font-semibold tracking-wide transition-colors ${
                  filter === f ? 'bg-brass text-ink' : 'text-ash hover:text-bone border border-line'}`}>
                {FILTER_LABEL[f]}
                {f === 'pending' && pendingCount > 0 ? ` (${pendingCount})` : ''}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {owed > 0 && (
            <span className="text-xs text-ash">
              Approved, not yet paid: <span className="font-mono text-brassbright">{owed.toLocaleString()}</span> Lucent
            </span>
          )}
        </div>

        {shown.length === 0 ? (
          <p className="text-ash text-sm">{requests.length === 0 ? 'No requests logged yet.' : 'Nothing in this view.'}</p>
        ) : (
          <div className="space-y-1.5">
            {/* Widths mirror the row below exactly — the rows are flex divs
                rather than a table, so nothing keeps these in step automatically. */}
            <div className="flex items-center gap-3 px-3 pb-0.5 text-ash">
              <SortHeader col="member" sort={sort} onSort={toggleSort} className="w-32 shrink-0">Member</SortHeader>
              <SortHeader col="type" sort={sort} onSort={toggleSort} className="w-28 shrink-0">Type</SortHeader>
              <SortHeader col="item" sort={sort} onSort={toggleSort} className="w-40 shrink-0">Item</SortHeader>
              <SortHeader col="amount" sort={sort} onSort={toggleSort} className="w-32 shrink-0 justify-end">Lucent</SortHeader>
              <span className="eyebrow text-[10px] flex-1">Note</span>
              <SortHeader col="status" sort={sort} onSort={toggleSort} className="w-20 shrink-0 justify-center">Status</SortHeader>
              <SortHeader col="date" sort={sort} onSort={toggleSort} className="w-28 shrink-0 justify-end">Requested</SortHeader>
              <span className="w-24 shrink-0" />
            </div>
            {shown.map((r) => {
              const meta = STATUS_META[r.status] || STATUS_META.pending;
              return editingId === r.id ? (
                <div key={r.id} className="flex flex-wrap items-center gap-2 bg-hall border border-brass/50 rounded-lg px-3 py-2 text-sm">
                  <span className="text-bone w-32 shrink-0 truncate">{r.display_name || r.discord_id}</span>
                  <input type="text" value={edit.request_type} maxLength={60} placeholder="Type" list="lucent-request-types"
                    onChange={(e) => setEdit((p) => ({ ...p, request_type: e.target.value }))}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass w-28" />
                  <span className="text-ash w-40 shrink-0 truncate" title={r.item_name}>{r.item_name}</span>
                  <input type="number" min={1} value={edit.amount} autoFocus
                    onChange={(e) => setEdit((p) => ({ ...p, amount: e.target.value }))}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass w-28" />
                  <input type="text" value={edit.note} maxLength={300} placeholder="Note (optional)"
                    onChange={(e) => setEdit((p) => ({ ...p, note: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') patch(r.id, edit, 'Request updated.'); if (e.key === 'Escape') setEditingId(null); }}
                    className="bg-panel border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass flex-1 min-w-[140px]" />
                  <button onClick={() => patch(r.id, edit, 'Request updated.')} className="text-brass hover:text-brassbright shrink-0" title="Save">
                    <Check className="w-4 h-4" />
                  </button>
                  <button onClick={() => setEditingId(null)} className="text-ash hover:text-bone shrink-0" title="Cancel">
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div key={r.id} className="flex items-center gap-3 bg-hall border border-line rounded-lg px-3 py-2 text-sm">
                  <span className="text-bone w-32 shrink-0 truncate">{r.display_name || r.discord_id}</span>
                  <span className={`w-28 shrink-0 truncate text-xs ${r.request_type ? 'text-brass' : 'text-ash/30'}`} title={r.request_type || ''}>
                    {r.request_type || '—'}
                  </span>
                  <span className="text-bone w-40 shrink-0 truncate" title={r.item_name}>
                    {r.item_name}
                    {!r.item_key && <span className="text-ash/40 text-[10px] ml-1" title="Not in the loot catalog">*</span>}
                  </span>
                  <span className="shrink-0 w-32 inline-flex items-center justify-end gap-2">
                    <CurrencyIcon currency="lucent" />
                    <span className="font-mono text-brassbright">{r.amount.toLocaleString()}</span>
                  </span>
                  <span className={`text-xs flex-1 truncate ${r.note ? 'text-ash/80 italic' : 'text-ash/30'}`} title={r.note || ''}>
                    {r.note || '—'}
                  </span>
                  {/* Fixed-width wrapper: the labels differ in length, so a
                      content-sized pill shifts the date column row to row. */}
                  <span className="w-20 shrink-0 flex justify-center">
                    <span className={`text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border ${meta.cls}`}>
                      {meta.label}
                    </span>
                  </span>
                  <span className="text-ash/60 text-[10px] w-28 text-right shrink-0">{fmtDatetime(r.requested_at)}</span>

                  {/* Also fixed: the button count varies by status, which would
                      otherwise leave every row a different length. */}
                  <div className="flex items-center justify-end gap-1 shrink-0 w-24">
                    {r.status === 'pending' && (
                      <button onClick={() => setStatus(r, 'approved')} className="text-ash hover:text-sky-400" title="Approve">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {r.status === 'approved' && (
                      <button onClick={() => setStatus(r, 'paid')} className="text-ash hover:text-emerald-400" title="Mark paid — records the Lucent grant">
                        <Coins className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {(r.status === 'pending' || r.status === 'approved') && (
                      <button onClick={() => setStatus(r, 'denied')} className="text-ash hover:text-oxblood" title="Deny">
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {r.status === 'denied' && (
                      <button onClick={() => setStatus(r, 'pending')} className="text-ash hover:text-brass" title="Reopen">
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {r.status !== 'paid' && (
                      <button onClick={() => startEdit(r)} className="text-ash hover:text-brass" title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={() => remove(r)} className="text-ash hover:text-oxblood" title="Delete">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </PageShell>
  );
}

// A clickable column label. The arrow only renders on the active column, so the
// header doesn't read as though everything is sorted at once.
function SortHeader({ col, sort, onSort, className = '', children }) {
  const active = sort.key === col;
  return (
    <button
      type="button" onClick={() => onSort(col)}
      title={`Sort by ${String(children).toLowerCase()}`}
      className={`eyebrow text-[10px] inline-flex items-center gap-1 transition-colors ${
        active ? 'text-brass' : 'text-ash hover:text-bone'} ${className}`}
    >
      {children}
      {active && <ChevronDown className={`w-3 h-3 shrink-0 ${sort.dir === 'asc' ? 'rotate-180' : ''}`} />}
    </button>
  );
}

// Log a request on a member's behalf. Its own component so the in-progress
// selection resets after each submit without touching page state — same reason
// LootCurrency's give form is split out.
function RequestForm({ members, catalog, busy, onCreate }) {
  const [memberId, setMemberId] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [itemKey, setItemKey] = useState('');
  const [otherName, setOtherName] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [requestType, setRequestType] = useState('');

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || memberId) return [];
    return members.filter((m) => (m.name || '').toLowerCase().includes(q)).slice(0, 8);
  }, [query, memberId, members]);

  const pick = (m) => { setMemberId(m.id); setQuery(m.name); setOpen(false); };
  const clear = () => { setMemberId(''); setQuery(''); setOpen(false); };

  const onQueryChange = (e) => {
    setQuery(e.target.value);
    setOpen(true);
    if (memberId) setMemberId(''); // typing again invalidates the previous pick
  };

  const onQueryBlur = () => {
    // Let a suggestion's onClick register before closing/validating.
    setTimeout(() => {
      setOpen(false);
      if (memberId) return;
      const q = query.trim().toLowerCase();
      const exact = q && members.find((m) => (m.name || '').toLowerCase() === q);
      if (exact) { setMemberId(exact.id); setQuery(exact.name); }
      else setQuery(''); // unresolved text can't be sent as a target
    }, 150);
  };

  const usingOther = itemKey === OTHER;
  const hasItem = usingOther ? otherName.trim() !== '' : itemKey !== '';

  const submit = () => {
    const amt = parseInt(amount, 10);
    if (!memberId || !hasItem || !Number.isFinite(amt) || amt <= 0) return;
    onCreate({
      discord_id: memberId,
      display_name: members.find((m) => m.id === memberId)?.name,
      item_key: usingOther ? null : itemKey,
      item_name: usingOther ? otherName.trim() : undefined,
      amount: amt,
      note: note.trim(),
      request_type: requestType.trim(),
    });
    // Member stays — a member often asks for more than one thing at a time.
    // Type persists with the member — a run of grants is usually all one kind.
    setItemKey(''); setOtherName(''); setAmount(''); setNote('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[160px]">
        <input
          type="text" value={query} onChange={onQueryChange}
          onFocus={() => setOpen(true)} onBlur={onQueryBlur}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && suggestions.length > 0) { e.preventDefault(); pick(suggestions[0]); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Member…" autoComplete="off"
          className="w-full bg-hall border border-line rounded-lg pl-3 pr-8 py-2 text-sm text-bone focus:outline-none focus:border-brass"
        />
        {memberId && (
          <button type="button" onClick={clear} title="Clear"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ash hover:text-oxblood">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
        {open && suggestions.length > 0 && (
          <div className="absolute z-10 mt-1 w-full bg-hall border border-line rounded-lg shadow-lg max-h-56 overflow-auto">
            {suggestions.map((m) => (
              <button key={m.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)}
                className="w-full text-left px-3 py-1.5 text-sm text-bone hover:bg-panelup transition-colors">
                {m.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Catalog first, free text as the fallback — Lucent buys from the auction
          house, so plenty of requests are for gear the guild's drop table
          doesn't cover. */}
      <input type="text" value={requestType} onChange={(e) => setRequestType(e.target.value)} maxLength={60}
        placeholder="Type" list="lucent-request-types"
        title="What kind of request this is — e.g. Enchant, Trait, Archboss. Free text; past entries are suggested."
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-32" />
      <select value={itemKey} onChange={(e) => setItemKey(e.target.value)}
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass max-w-[220px]">
        <option value="">Item…</option>
        <option value={OTHER}>— Other (type a name) —</option>
        {catalog.map((c) => (
          <optgroup key={c.key} label={c.label}>
            {c.items.map((i) => <option key={i.key} value={i.key}>{i.name}</option>)}
          </optgroup>
        ))}
      </select>
      {usingOther && (
        <input type="text" value={otherName} onChange={(e) => setOtherName(e.target.value)} maxLength={200}
          placeholder="Item name" autoFocus
          className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-48" />
      )}

      <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Lucent"
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-28" />
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
        placeholder="Note (optional)" onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass flex-1 min-w-[140px]" />

      <button type="button" onClick={submit} disabled={busy || !memberId || !hasItem || !amount}
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
        <Plus className="w-4 h-4" /> Log request
      </button>
    </div>
  );
}
