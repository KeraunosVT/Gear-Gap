import { useState, useMemo } from 'react';
import { X, Plus } from 'lucide-react';

// Sentinels for the item <select>: free text, or a market-priced potential.
const OTHER = '__other__';
const POTENTIAL = '__potential__';

// Log a request on a member's behalf. Its own component so the in-progress
// selection resets after each submit without touching page state — same reason
// GrantForm is split out.
export default function RequestForm({ members, catalog, busy, onCreate, potentials, marketAge }) {
  const [memberId, setMemberId] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [itemKey, setItemKey] = useState('');
  const [otherName, setOtherName] = useState('');
  const [potentialName, setPotentialName] = useState('');
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
  const usingPotential = itemKey === POTENTIAL;

  // The datalist lets anything be typed, so a free-text near-miss resolves to
  // nothing rather than silently pricing the wrong potential.
  const pickedPotential = useMemo(() => {
    const q = potentialName.trim().toLowerCase();
    return potentials.find((p) => String(p.label).toLowerCase() === q) || null;
  }, [potentialName, potentials]);

  const hasItem = usingOther ? otherName.trim() !== ''
    : usingPotential ? Boolean(pickedPotential)
      : itemKey !== '';

  const submit = () => {
    const amt = parseInt(amount, 10);
    if (!memberId || !hasItem || !Number.isFinite(amt) || amt <= 0) return;
    onCreate({
      discord_id: memberId,
      display_name: members.find((m) => m.id === memberId)?.name,
      // A potential isn't a catalog row, so it goes in as its label plus the
      // stable id that makes its price an exact lookup later.
      item_key: (usingOther || usingPotential) ? null : itemKey,
      item_name: usingOther ? otherName.trim() : usingPotential ? pickedPotential.label : undefined,
      potential_id: usingPotential ? pickedPotential.potentialId : null,
      amount: amt,
      note: note.trim(),
      request_type: requestType.trim(),
    });
    // Member stays — a member often asks for more than one thing at a time.
    // Type persists with the member — a run of grants is usually all one kind.
    setItemKey(''); setOtherName(''); setPotentialName(''); setAmount(''); setNote('');
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
        {potentials.length > 0 && <option value={POTENTIAL}>— Potential (market priced) —</option>}
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
      {usingPotential && (
        <>
          {/* A datalist rather than a 190-option select: typing narrows it, and
              the exact-match rule above means a half-typed name won't submit. */}
          <input type="text" value={potentialName} onChange={(e) => setPotentialName(e.target.value)}
            placeholder="Potential…" list="market-potentials" autoFocus autoComplete="off"
            className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-56" />
          <datalist id="market-potentials">
            {potentials.map((p) => <option key={p.potentialId} value={p.label} />)}
          </datalist>
        </>
      )}

      <input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Lucent"
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-28" />
      <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300}
        placeholder="Note (optional)" onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass flex-1 min-w-[140px]" />

      {pickedPotential && (
        <span className="inline-flex items-center gap-2 text-xs text-ash shrink-0"
          title={`Cheapest of ${pickedPotential.listings} listing${pickedPotential.listings === 1 ? '' : 's'}`
            + (pickedPotential.sell?.gapHours ? ` · typically clears in ~${pickedPotential.sell.gapHours}h` : '')
            + (marketAge ? ` · updated ${marketAge}` : '')}>
          <span className="font-mono text-brass">{pickedPotential.floor.toLocaleString()}</span>
          <span className="text-ash/60">floor</span>
          <button type="button" onClick={() => setAmount(String(pickedPotential.floor))}
            className="px-2 py-0.5 rounded border border-line hover:border-brass/60 hover:text-bone transition-colors">
            use
          </button>
        </span>
      )}
      <button type="button" onClick={submit} disabled={busy || !memberId || !hasItem || !amount}
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
        <Plus className="w-4 h-4" /> Log request
      </button>
    </div>
  );
}
