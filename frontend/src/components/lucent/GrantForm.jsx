import { useState, useMemo } from 'react';
import { X, Coins } from 'lucide-react';
import { CURRENCY_TYPES } from '../../currencies';

// Quick "give lucent/shards to a member" form — kept as its own component so its
// in-progress selection resets after each submit without touching page state.
export default function GrantForm({ members, busy, onGive }) {
  const [memberId, setMemberId] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState('lucent');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

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
    // Give a suggestion's onClick a chance to register before we close/validate.
    setTimeout(() => {
      setOpen(false);
      if (memberId) return;
      const q = query.trim().toLowerCase();
      const exact = q && members.find((m) => (m.name || '').toLowerCase() === q);
      if (exact) { setMemberId(exact.id); setQuery(exact.name); }
      else setQuery(''); // unresolved text can't be sent as a target
    }, 150);
  };

  const onQueryKeyDown = (e) => {
    if (e.key === 'Enter' && suggestions.length > 0) { e.preventDefault(); pick(suggestions[0]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const submit = () => {
    const amt = parseInt(amount, 10);
    if (!memberId || !Number.isFinite(amt) || amt <= 0) return;
    onGive(memberId, currency, amt, reason.trim());
    // Member and currency stay put — grants tend to come in runs for the same
    // person or the same payout, so only the per-grant fields reset.
    setAmount(''); setReason('');
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[160px]">
        <input
          type="text" value={query} onChange={onQueryChange}
          onFocus={() => setOpen(true)} onBlur={onQueryBlur} onKeyDown={onQueryKeyDown}
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
              <button
                key={m.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(m)}
                className="w-full text-left px-3 py-1.5 text-sm text-bone hover:bg-panelup transition-colors"
              >
                {m.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <select value={currency} onChange={(e) => setCurrency(e.target.value)}
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass">
        {CURRENCY_TYPES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
      <input
        type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount"
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass w-28"
      />
      <input
        type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300}
        placeholder="Reason (optional)" title="Why this was given — e.g. raid payout, reimbursement, correction"
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        className="bg-hall border border-line rounded-lg px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass flex-1 min-w-[160px]"
      />
      <button type="button" onClick={submit} disabled={busy || !memberId || !amount}
        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors disabled:opacity-40">
        <Coins className="w-4 h-4" /> Give
      </button>
    </div>
  );
}
