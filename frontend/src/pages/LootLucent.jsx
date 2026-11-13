import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import { Plus, Coins, Search, Check, X, Pencil, Trash2, RotateCcw } from 'lucide-react';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';
import ErrorBanner from '../components/ui/ErrorBanner';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import CurrencyIcon from '../components/ui/CurrencyIcon';
import LootNav from '../components/LootNav';
import RequestForm from '../components/lucent/RequestForm';
import GrantForm from '../components/lucent/GrantForm';
import { fmtDatetime, guildDateOf, fmtGuildDay } from '../timeUtils';
import { CURRENCY_TYPES, CURRENCY_LABEL } from '../currencies';

// ── LUCENT & SHARDS ─────────────────────────────────────────────────────────
// Requests and the currency ledger used to be two tabs for one job: a request
// goes pending -> approved -> paid, and paying it writes the grant the other
// tab listed. They're one page now. Requests sit on a board by status; grants
// sit in the ledger below, with each member's running total beside it.
//
// The two halves keep their own permissions. loot.requests shows the board;
// loot.currency shows the ledger and direct grants. Paying needs both, because
// it writes a ledger row (the PATCH route enforces that too).

// The two request types the guild actually runs. request_type stays free text
// in the database; anything else lands under Other.
const TYPES = ['Partial Refund', 'Partial Fund'];
const normType = (t) => TYPES.find((k) => k.toLowerCase() === String(t || '').trim().toLowerCase()) || null;
const TYPE_FILTERS = [{ key: 'all', label: 'All types' }, ...TYPES.map((t) => ({ key: t, label: t })), { key: 'other', label: 'Other' }];
const TYPE_TONE = {
  'Partial Refund': 'text-sky-700 dark:text-sky-300 border-sky-500/40',
  'Partial Fund': 'text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-500/40',
};
const typeTone = (t) => TYPE_TONE[normType(t)] || 'text-ash border-line';

// Paid requests leave the board after this long. Their grants stay in the
// ledger, which is the record.
const PAID_DAYS = 14;
const WEEK_MS = 7 * 86_400_000;

const COLUMNS = [
  { key: 'pending', label: 'Pending', dot: 'bg-ash', empty: 'Nothing waiting for approval.' },
  { key: 'approved', label: 'Approved · to pay', dot: 'bg-amber-500', empty: 'Nothing approved and unpaid.' },
  { key: 'paid', label: `Paid · last ${PAID_DAYS} days`, dot: 'bg-emerald-500', empty: 'Nothing paid recently.' },
  { key: 'denied', label: 'Denied', dot: 'bg-line', empty: 'Nothing denied.' },
];

const LUCENT_TEXT = 'text-amber-700 dark:text-amber-400';
const fmt = (n) => (n || 0).toLocaleString();
const shortDay = (iso) => (iso ? fmtGuildDay(guildDateOf(iso), { weekday: false }) : '');

export default function LootLucent() {
  const { can } = useAuth();
  const canReq = can('loot.requests');
  const canCur = can('loot.currency');

  const [members, setMembers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [requests, setRequests] = useState([]);
  // Auction-house floors for potentials, refreshed by the standalone scraper.
  const [market, setMarket] = useState({ items: [], fetched_at: null });
  const [grants, setGrants] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [msg, flash] = useFlash(3500);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState(null); // 'request' | 'grant' | null
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [showDenied, setShowDenied] = useState(false);
  const [paying, setPaying] = useState(null);

  const load = useCallback(() => {
    setError('');
    Promise.all([
      axios.get('/api/admin/members'),
      axios.get('/api/loot/catalog'),
      canReq ? axios.get('/api/admin/lucent-requests') : null,
      // Prices are a nice-to-have: a scraper that's off or mid-refresh must not
      // stop requests being logged, so this resolves to empty rather than failing.
      canReq ? axios.get('/api/admin/market-potentials').catch(() => ({ data: { items: [], fetched_at: null } })) : null,
      canCur ? axios.get('/api/admin/currency-awards') : null,
    ])
      .then(([mem, cat, reqs, mkt, cur]) => {
        setMembers(mem.data.members || []);
        setCatalog(cat.data.categories || []);
        if (reqs) setRequests(reqs.data.requests || []);
        if (mkt) setMarket({ items: mkt.data.items || [], fetched_at: mkt.data.fetched_at || null });
        if (cur) setGrants(cur.data.awards || []);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load Lucent & Shards.'))
      .finally(() => setLoaded(true));
  }, [canReq, canCur]);
  useEffect(() => { load(); }, [load]);

  // ── Market prices ─────────────────────────────────────────────────────────
  // Priced by potentialId, the stable integer tl-tracker keys off, so a
  // retitled potential still resolves. The label map is a fallback for requests
  // logged as free text before potentials could be picked.
  const priceById = useMemo(
    () => new Map(market.items.filter((i) => i.floor != null).map((i) => [i.potentialId, i])),
    [market],
  );
  const priceByLabel = useMemo(
    () => new Map(market.items.filter((i) => i.floor != null).map((i) => [String(i.label).trim().toLowerCase(), i])),
    [market],
  );
  const priceFor = (r) => priceById.get(r.potential_id)
    || priceByLabel.get(String(r.item_name || '').trim().toLowerCase()) || null;
  // Only potentials actually on the market are offerable: one with no floor
  // would promise a price the board can't show.
  const pickablePotentials = useMemo(
    () => market.items.filter((i) => i.floor != null).sort((a, b) => String(a.label).localeCompare(String(b.label))),
    [market],
  );
  const marketAge = useMemo(() => {
    if (!market.fetched_at) return null;
    const mins = Math.round((Date.now() - Date.parse(market.fetched_at)) / 60000);
    return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  }, [market]);

  // Name -> catalog row and name -> potential, for editing a card's item by
  // name: a typed name has to find its way back to the key or potential id.
  const catalogByName = useMemo(() => new Map(
    catalog.flatMap((c) => c.items).map((i) => [i.name.trim().toLowerCase(), i]),
  ), [catalog]);
  const potentialByLabel = useMemo(() => new Map(
    pickablePotentials.map((p) => [String(p.label).trim().toLowerCase(), p]),
  ), [pickablePotentials]);
  const itemNameOptions = useMemo(() => [...new Set([
    ...catalog.flatMap((c) => c.items).map((i) => i.name),
    ...pickablePotentials.map((p) => p.label),
  ])].sort((a, b) => a.localeCompare(b)), [catalog, pickablePotentials]);
  // The named types first, then anything else already in use.
  const knownTypes = useMemo(() => {
    const extra = [...new Set(requests.map((r) => r.request_type).filter((t) => t && !normType(t)))].sort();
    return [...TYPES, ...extra];
  }, [requests]);

  // ── Filtering ─────────────────────────────────────────────────────────────
  const needle = q.trim().toLowerCase();
  const nameOf = (row) => row.display_name || row.discord_id || '';
  const matchesMember = (row) => !needle || nameOf(row).toLowerCase().includes(needle);
  const ofType = (r, t) => (t === 'all' ? true : t === 'other' ? !normType(r.request_type) : normType(r.request_type) === t);

  const byMember = useMemo(() => requests.filter(matchesMember), [requests, needle]);

  const columns = useMemo(() => {
    const paidCutoff = Date.now() - PAID_DAYS * 86_400_000;
    const shown = byMember.filter((r) => ofType(r, typeFilter));
    const newest = (a, b) => String(b.requested_at).localeCompare(String(a.requested_at));
    return COLUMNS.filter((c) => c.key !== 'denied' || showDenied).map((c) => {
      let list = shown.filter((r) => r.status === c.key);
      let older = 0;
      if (c.key === 'paid') {
        const recent = list.filter((r) => new Date(r.decided_at || r.requested_at).getTime() >= paidCutoff);
        older = list.length - recent.length;
        list = recent.sort((a, b) => String(b.decided_at || '').localeCompare(String(a.decided_at || '')));
      } else {
        list = list.sort(newest);
      }
      return { ...c, list, older, sum: list.reduce((n, r) => n + r.amount, 0) };
    });
  }, [byMember, typeFilter, showDenied]);

  const deniedCount = byMember.filter((r) => r.status === 'denied' && ofType(r, typeFilter)).length;

  const summary = useMemo(() => {
    const since = Date.now() - WEEK_MS;
    const pending = requests.filter((r) => r.status === 'pending');
    const recent = grants.filter((g) => new Date(g.awarded_at).getTime() >= since);
    return {
      pendingCount: pending.length,
      pendingSum: pending.reduce((n, r) => n + r.amount, 0),
      // Committed but not yet handed over: the number to check before
      // promising anyone anything else.
      owed: requests.filter((r) => r.status === 'approved').reduce((n, r) => n + r.amount, 0),
      lucent7d: recent.filter((g) => g.currency === 'lucent').reduce((n, g) => n + g.amount, 0),
      shards7d: recent.filter((g) => g.currency !== 'lucent').reduce((n, g) => n + g.amount, 0),
    };
  }, [requests, grants]);

  // All-time totals per member, from the ledger.
  const balances = useMemo(() => {
    const m = new Map();
    grants.forEach((g) => {
      if (!m.has(g.discord_id)) m.set(g.discord_id, { discord_id: g.discord_id, display_name: g.display_name, byType: {} });
      const b = m.get(g.discord_id);
      b.byType[g.currency] = (b.byType[g.currency] || 0) + g.amount;
      if (g.display_name) b.display_name = g.display_name;
    });
    return [...m.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  }, [grants]);
  const lucentReceived = (discordId) => balances.find((b) => b.discord_id === discordId)?.byType.lucent || 0;

  // Which ledger rows a paid request wrote, so the ledger can say so.
  const requestByGrant = useMemo(
    () => new Map(requests.filter((r) => r.currency_award_id).map((r) => [r.currency_award_id, r])),
    [requests],
  );
  const ledger = useMemo(
    () => grants.filter(matchesMember).sort((a, b) => String(b.awarded_at).localeCompare(String(a.awarded_at))),
    [grants, needle],
  );

  // ── Request actions ───────────────────────────────────────────────────────
  const createRequest = (body) => {
    setBusy(true);
    axios.post('/api/admin/lucent-requests', body)
      .then(() => { load(); flash('Request logged.'); })
      .catch((err) => flash(err.response?.data?.error || 'Failed to log request.', false))
      .finally(() => setBusy(false));
  };

  const patch = (id, body, okMsg) => axios.patch(`/api/admin/lucent-requests/${id}`, body)
    .then(() => { load(); if (okMsg) flash(okMsg); return true; })
    .catch((err) => { flash(err.response?.data?.error || 'Update failed.', false); return false; });

  const setStatus = (r, status) => {
    const okMsg = status === 'pending' && r.status === 'approved' ? 'Approval undone. Back to pending.'
      : status === 'pending' ? 'Reopened.'
        : `Marked ${status}.`;
    patch(r.id, { status }, okMsg);
  };

  const confirmPay = () => {
    if (!paying) return;
    setBusy(true);
    patch(paying.id, { status: 'paid' }, `Paid ${fmt(paying.amount)} Lucent to ${nameOf(paying)}. Grant recorded.`)
      .then((ok) => { if (ok) setPaying(null); })
      .finally(() => setBusy(false));
  };

  const removeRequest = (r) => {
    if (!window.confirm(`Delete this request for ${r.item_name}?${r.currency_award_id ? '\n\nThe Lucent grant it created stays in the ledger.' : ''}`)) return;
    axios.delete(`/api/admin/lucent-requests/${r.id}`)
      .then(() => { load(); flash('Request deleted.'); })
      .catch((err) => flash(err.response?.data?.error || 'Delete failed.', false));
  };

  // Item fields ride along only when the name actually changed. Sending it on
  // every save would re-resolve it against the live catalog, so a catalog item
  // renamed since the request was logged would quietly lose its item_key on an
  // unrelated note fix.
  const saveRequestEdit = (r, edit) => {
    const body = { amount: edit.amount, note: edit.note, request_type: edit.request_type };
    const typed = edit.item_name.trim();
    if (typed !== (r.item_name || '')) {
      if (!typed) { flash('An item name is required.', false); return Promise.resolve(false); }
      const hit = catalogByName.get(typed.toLowerCase());
      const pot = potentialByLabel.get(typed.toLowerCase());
      if (hit) Object.assign(body, { item_key: hit.key, potential_id: null });
      else if (pot) Object.assign(body, { item_key: null, item_name: pot.label, potential_id: pot.potentialId });
      else Object.assign(body, { item_key: null, item_name: typed, potential_id: null });
    }
    return patch(r.id, body, 'Request updated.');
  };

  // ── Grant actions ─────────────────────────────────────────────────────────
  const giveGrant = (discordId, currency, amount, reason) => {
    const member = members.find((m) => m.id === discordId);
    setBusy(true);
    axios.post('/api/admin/currency-awards', { discord_id: discordId, display_name: member?.name, currency, amount, reason })
      .then(() => { load(); flash(`Gave ${fmt(amount)} ${CURRENCY_LABEL[currency] || currency} to ${member?.name || 'member'}.`); })
      .catch((err) => flash(err.response?.data?.error || 'Failed to record grant.', false))
      .finally(() => setBusy(false));
  };

  const saveGrantEdit = (g, edit) => {
    const amt = parseInt(edit.amount, 10);
    if (!Number.isFinite(amt) || amt <= 0) { flash('Amount must be a positive number.', false); return Promise.resolve(false); }
    return axios.patch(`/api/admin/currency-awards/${g.id}`, { currency: edit.currency, amount: amt, reason: edit.reason })
      .then(() => { load(); flash('Grant updated.'); return true; })
      .catch((err) => { flash(err.response?.data?.error || 'Update failed.', false); return false; });
  };

  const revokeGrant = (g) => {
    const fromRequest = requestByGrant.get(g.id);
    if (!window.confirm(`Revoke ${fmt(g.amount)} ${CURRENCY_LABEL[g.currency] || g.currency} from ${nameOf(g)}?`
      + (fromRequest ? '\n\nIt was paid for a request, which will still read as paid.' : ''))) return;
    axios.delete(`/api/admin/currency-awards/${g.id}`)
      .then(() => { load(); flash('Grant revoked.'); })
      .catch((err) => flash(err.response?.data?.error || 'Revoke failed.', false));
  };

  if (!canReq && !canCur) return <RestrictedGate />;

  return (
    <PageShell width="full">
      <LootNav />
      <ErrorBanner>{error}</ErrorBanner>
      <Toast msg={msg} />

      <datalist id="lucent-request-types">
        {knownTypes.map((t) => <option key={t} value={t} />)}
      </datalist>
      <datalist id="lucent-item-names">
        {itemNameOptions.map((n) => <option key={n} value={n} />)}
      </datalist>

      <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
        <p className="text-sm text-ash max-w-2xl">
          {canReq && canCur
            ? 'Requests and grants in one place. Paying a request records its grant, so nothing is entered twice.'
            : canReq
              ? 'Log and decide what members ask for. Paying a request records a Lucent grant, which needs the Lucent & Shards permission.'
              : 'Every Lucent and shard grant, and what each member has received.'}
        </p>
        <div className="flex gap-2 flex-wrap">
          {canReq && (
            <button type="button" onClick={() => setForm(form === 'request' ? null : 'request')} aria-expanded={form === 'request'}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors">
              <Plus className="w-4 h-4" /> Log a request
            </button>
          )}
          {canCur && (
            <button type="button" onClick={() => setForm(form === 'grant' ? null : 'grant')} aria-expanded={form === 'grant'}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm border border-brass/60 text-brassbright hover:bg-panelup font-semibold rounded-lg transition-colors">
              <Coins className="w-4 h-4" /> Give directly
            </button>
          )}
        </div>
      </div>

      {form === 'request' && canReq && (
        <div className="panel rounded-lg p-4 mb-5 border-brass/50">
          <div className="eyebrow text-[10px] text-ash mb-3">New request · starts as pending</div>
          <RequestForm members={members} catalog={catalog} busy={busy} onCreate={createRequest}
            potentials={pickablePotentials} marketAge={marketAge} />
        </div>
      )}
      {form === 'grant' && canCur && (
        <div className="panel rounded-lg p-4 mb-5 border-brass/50">
          <div className="eyebrow text-[10px] text-ash mb-3">Direct grant · payouts, shard splits, corrections</div>
          <GrantForm members={members} busy={busy} onGive={giveGrant} />
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {canReq && (
          <>
            <div className="panel rounded-lg px-4 py-3">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-2xl text-bone">{loaded ? summary.pendingCount : '—'}</span>
                {loaded && summary.pendingSum > 0 && <span className="font-mono text-xs text-ash">{fmt(summary.pendingSum)} Lucent</span>}
              </div>
              <div className="eyebrow text-[10px] text-ash mt-1">Waiting for approval</div>
            </div>
            <div className="panel rounded-lg px-4 py-3 border-amber-500/50">
              <div className={`font-mono text-2xl ${LUCENT_TEXT}`}>{loaded ? fmt(summary.owed) : '—'}</div>
              <div className="eyebrow text-[10px] text-ash mt-1">Approved, not yet paid</div>
            </div>
          </>
        )}
        {canCur && (
          <>
            <div className="panel rounded-lg px-4 py-3">
              <div className="font-mono text-2xl text-bone">{loaded ? fmt(summary.lucent7d) : '—'}</div>
              <div className="eyebrow text-[10px] text-ash mt-1">Lucent given · 7 days</div>
            </div>
            <div className="panel rounded-lg px-4 py-3">
              <div className="font-mono text-2xl text-purple-700 dark:text-purple-300">{loaded ? fmt(summary.shards7d) : '—'}</div>
              <div className="eyebrow text-[10px] text-ash mt-1">Shards given · 7 days</div>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <label className="relative w-full sm:w-64">
          <span className="sr-only">Filter by member</span>
          <Search className="w-4 h-4 text-ash absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by member…"
            className="w-full bg-panel border border-line rounded-lg pl-9 pr-8 py-2.5 text-sm text-bone focus:outline-none focus:border-brass" />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label="Clear member filter"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-ash hover:text-bone">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </label>
        {canReq && TYPE_FILTERS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTypeFilter(t.key)} aria-pressed={typeFilter === t.key}
            className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
              typeFilter === t.key ? 'bg-brass text-ink border-transparent' : 'border-line text-ash hover:text-bone'}`}>
            {t.label}
            {t.key !== 'all' && <span className="font-mono opacity-75"> {byMember.filter((r) => ofType(r, t.key)).length}</span>}
          </button>
        ))}
        <div className="flex-1" />
        {canReq && (
          <button type="button" onClick={() => setShowDenied((v) => !v)} aria-pressed={showDenied}
            className="text-sm text-ash hover:text-bone underline underline-offset-4">
            {showDenied ? 'Hide denied' : `Show denied (${deniedCount})`}
          </button>
        )}
      </div>

      {canReq && (
        <div className={`grid grid-cols-1 md:grid-cols-2 ${showDenied ? 'xl:grid-cols-4' : 'xl:grid-cols-3'} gap-4 items-start mb-8`}>
          {columns.map((c) => (
            <section key={c.key} aria-label={c.label} className="bg-panel/60 border border-line rounded-xl p-3">
              <div className="flex items-center gap-2 px-1 pb-3">
                <span className={`w-2 h-2 rounded-full ${c.dot}`} />
                <h2 className="font-display text-sm text-bone tracking-[0.06em]">{c.label}</h2>
                <span className="font-mono text-xs text-ash">{c.list.length}</span>
                <span className="flex-1" />
                {c.sum > 0 && (
                  <span className={`font-mono text-xs ${c.key === 'approved' ? LUCENT_TEXT : 'text-ash'}`}>{fmt(c.sum)}</span>
                )}
              </div>
              <div className="space-y-2">
                {!loaded ? (
                  <div className="text-ash text-sm text-center py-6">Loading…</div>
                ) : c.list.length === 0 ? (
                  <div className="border border-dashed border-line rounded-lg py-6 px-3 text-center text-ash/70 text-sm">{c.empty}</div>
                ) : c.list.map((r) => (
                  <RequestCard
                    key={r.id} r={r} price={priceFor(r)} canPay={canCur}
                    onStatus={(status) => setStatus(r, status)} onPay={() => setPaying(r)}
                    onDelete={() => removeRequest(r)} onSave={(edit) => saveRequestEdit(r, edit)}
                  />
                ))}
                {c.older > 0 && (
                  <p className="text-xs text-ash/70 px-1 pt-1">
                    {c.older} older paid request{c.older === 1 ? '' : 's'} not shown.{canCur ? ' Their grants are in the ledger below.' : ''}
                  </p>
                )}
              </div>
            </section>
          ))}
        </div>
      )}

      {canCur && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 items-start">
          <section aria-label="Received, by member" className="panel rounded-xl p-4">
            <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
              <h2 className="font-display text-sm text-bone tracking-[0.06em]">Received, by member</h2>
              <span className="text-xs text-ash">All time{canReq ? ' · click a name to filter the board' : ''}</span>
            </div>
            {balances.length === 0 ? (
              <p className="text-ash text-sm py-2">{loaded ? 'Nothing given yet.' : 'Loading…'}</p>
            ) : (
              <div className="divide-y divide-line/60 max-h-[420px] overflow-auto pr-1">
                {balances.map((b) => {
                  const active = needle && nameOf(b).toLowerCase() === needle;
                  return (
                    <div key={b.discord_id} className="flex items-center gap-3 py-2 flex-wrap">
                      <button type="button" onClick={() => setQ(active ? '' : nameOf(b))} aria-pressed={Boolean(active)}
                        className={`text-sm font-semibold text-left w-36 truncate ${active ? 'text-brassbright' : 'text-bone hover:text-brassbright'}`}>
                        {nameOf(b)}
                      </button>
                      <div className="flex flex-wrap gap-1.5">
                        {CURRENCY_TYPES.filter((c) => b.byType[c.key]).map((c) => (
                          <span key={c.key} className="inline-flex items-center gap-1.5 text-xs bg-hall border border-line rounded-full pl-1 pr-2.5 py-0.5 text-ash">
                            <CurrencyIcon currency={c.key} size={20} />
                            {c.shard ? c.label : null}
                            <span className={`font-mono ${c.shard ? 'text-bone' : LUCENT_TEXT}`}>{fmt(b.byType[c.key])}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section aria-label="Ledger" className="panel rounded-xl p-4">
            <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
              <h2 className="font-display text-sm text-bone tracking-[0.06em]">Ledger</h2>
              <span className="text-xs text-ash">
                {needle ? `${ledger.length} of ${grants.length} grants` : `${grants.length} grant${grants.length === 1 ? '' : 's'}`}
                {' · '}CSV import is on <Link to="/admin/loot/history" className="text-brassbright hover:text-brass">Loot History</Link>
              </span>
            </div>
            {ledger.length === 0 ? (
              <p className="text-ash text-sm py-2">{!loaded ? 'Loading…' : needle ? 'Nothing for this member.' : 'Nothing given yet.'}</p>
            ) : (
              <div className="divide-y divide-line/60 max-h-[420px] overflow-auto pr-1">
                {ledger.map((g) => (
                  <LedgerRow key={g.id} g={g} fromRequest={requestByGrant.get(g.id)}
                    onSave={(edit) => saveGrantEdit(g, edit)} onRevoke={() => revokeGrant(g)} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {paying && (
        <Modal onClose={() => !busy && setPaying(null)}>
          <div className={`eyebrow text-[11px] mb-3 ${LUCENT_TEXT}`}>Pay request</div>
          <h2 className="font-display text-xl text-bone tracking-[0.04em] mb-4">
            Pay {fmt(paying.amount)} Lucent to {nameOf(paying)}?
          </h2>
          <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-2 text-sm bg-ink border border-line rounded-lg p-4 mb-4">
            <dt className="text-ash">Type</dt><dd className="text-bone">{paying.request_type || '—'}</dd>
            <dt className="text-ash">For</dt><dd className="text-bone">{paying.item_name}</dd>
            {priceFor(paying) && (
              <><dt className="text-ash">AH floor</dt><dd className="text-bone font-mono">{fmt(priceFor(paying).floor)}</dd></>
            )}
            <dt className="text-ash">Received</dt><dd className="text-bone">{fmt(lucentReceived(paying.discord_id))} Lucent so far</dd>
          </dl>
          <p className="text-ash text-sm mb-6">This records the grant in the ledger. To take it back later, revoke the grant there.</p>
          <div className="flex justify-end gap-3">
            <Button variant="neutral" size="none" className="px-4 py-2" disabled={busy} onClick={() => setPaying(null)}>Cancel</Button>
            <Button size="none" className="px-5 py-2" disabled={busy} onClick={confirmPay}>
              <Coins className="w-4 h-4" /> {busy ? 'Paying…' : 'Pay and record grant'}
            </Button>
          </div>
        </Modal>
      )}
    </PageShell>
  );
}

// One request on the board. Edits happen in place on the card.
function RequestCard({ r, price, canPay, onStatus, onPay, onDelete, onSave }) {
  const [edit, setEdit] = useState(null);
  const name = r.display_name || r.discord_id;
  const startEdit = () => setEdit({ amount: String(r.amount), note: r.note || '', request_type: r.request_type || '', item_name: r.item_name || '' });
  const save = () => onSave(edit).then((ok) => { if (ok) setEdit(null); });
  const field = 'bg-hall border border-line rounded-lg px-2 py-1.5 text-sm text-bone focus:outline-none focus:border-brass w-full';
  const keys = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(null); };

  if (edit) {
    return (
      <article className="bg-panel border border-brass/50 rounded-lg p-3 space-y-2">
        <div className="text-sm font-semibold text-bone">{name}</div>
        <div className="grid grid-cols-2 gap-2">
          <input value={edit.request_type} maxLength={60} placeholder="Type" list="lucent-request-types" aria-label="Type"
            onChange={(e) => setEdit((p) => ({ ...p, request_type: e.target.value }))} onKeyDown={keys} className={field} />
          <input type="number" min={1} value={edit.amount} aria-label="Lucent" autoFocus
            onChange={(e) => setEdit((p) => ({ ...p, amount: e.target.value }))} onKeyDown={keys} className={field} />
        </div>
        <input value={edit.item_name} maxLength={200} placeholder="Item name" list="lucent-item-names" autoComplete="off" aria-label="Item"
          title="Typing a catalog item or a market-priced potential re-links it; anything else is kept as free text."
          onChange={(e) => setEdit((p) => ({ ...p, item_name: e.target.value }))} onKeyDown={keys} className={field} />
        <input value={edit.note} maxLength={300} placeholder="Note (optional)" aria-label="Note"
          onChange={(e) => setEdit((p) => ({ ...p, note: e.target.value }))} onKeyDown={keys} className={field} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => setEdit(null)} className="px-3 py-1 text-xs text-ash hover:text-bone">Cancel</button>
          <button type="button" onClick={save} className="px-3 py-1 text-xs bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg">Save</button>
        </div>
      </article>
    );
  }

  const isApproved = r.status === 'approved';
  return (
    <article className={`bg-panel border rounded-lg p-3 space-y-2 ${isApproved ? 'border-amber-500/50' : 'border-line'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-semibold text-bone truncate max-w-[60%]">{name}</span>
        {r.request_type && (
          <span className={`text-[11px] border rounded-full px-2 py-0.5 truncate max-w-[45%] ${typeTone(r.request_type)}`} title={r.request_type}>
            {r.request_type}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-ash" title={fmtDatetime(r.requested_at)}>{shortDay(r.requested_at)}</span>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1.5">
          <CurrencyIcon currency="lucent" size={22} />
          <span className={`font-mono text-lg ${LUCENT_TEXT}`}>{fmt(r.amount)}</span>
        </span>
        <span className="text-sm text-bone min-w-0 truncate" title={r.item_name}>
          {r.item_name}
          {!r.item_key && !r.potential_id && <span className="text-ash/40 text-[10px] ml-1" title="Not in the loot catalog">*</span>}
        </span>
        {r.potential_id != null && (
          <span className="text-[10px] text-sky-700 dark:text-sky-300 border border-sky-500/40 rounded-full px-1.5">potential</span>
        )}
      </div>
      {/* Floor, not a valuation: the cheapest listing right now, which is what
          the requester would actually pay. */}
      {price && (
        <div className="text-xs text-ash"
          title={`Cheapest of ${price.listings} listing${price.listings === 1 ? '' : 's'}${price.sell?.gapHours ? ` · typically clears in ~${price.sell.gapHours}h` : ''}`}>
          AH floor <span className="font-mono text-bone">{fmt(price.floor)}</span> · {price.listings} listing{price.listings === 1 ? '' : 's'}
        </div>
      )}
      {r.note && <div className="text-xs text-ash/90 italic break-words">{r.note}</div>}

      <div className="flex items-center gap-1.5 flex-wrap pt-1">
        {r.status === 'pending' && (
          <>
            <button type="button" onClick={() => onStatus('approved')} aria-label={`Approve ${name}'s request`}
              className="px-3 py-1 rounded-lg border border-sky-500/60 text-sky-700 dark:text-sky-300 text-xs font-semibold hover:bg-panelup">
              Approve
            </button>
            <button type="button" onClick={() => onStatus('denied')} aria-label={`Deny ${name}'s request`}
              className="px-3 py-1 rounded-lg border border-line text-ash text-xs font-semibold hover:text-bone">
              Deny
            </button>
          </>
        )}
        {isApproved && (
          <>
            {canPay ? (
              <button type="button" onClick={onPay} aria-label={`Pay ${fmt(r.amount)} Lucent to ${name}`}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-amber-400 hover:bg-amber-300 text-neutral-950 text-xs font-bold">
                <Coins className="w-3.5 h-3.5" /> Pay {fmt(r.amount)}
              </button>
            ) : (
              <span className="text-[11px] text-ash" title="Paying records a grant, which needs the Lucent & Shards permission">
                Waiting for an officer who can pay
              </span>
            )}
            <button type="button" onClick={() => onStatus('pending')} title="Undo approval: back to pending"
              className="inline-flex items-center gap-1 px-2 py-1 text-xs text-ash hover:text-bone">
              <RotateCcw className="w-3 h-3" /> Undo
            </button>
            <button type="button" onClick={() => onStatus('denied')} className="px-2 py-1 text-xs text-ash hover:text-oxblood">Deny</button>
          </>
        )}
        {r.status === 'paid' && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
            <Check className="w-3.5 h-3.5" /> Grant recorded{r.decided_at ? ` ${shortDay(r.decided_at)}` : ''}
          </span>
        )}
        {r.status === 'denied' && (
          <button type="button" onClick={() => onStatus('pending')}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-lg border border-line text-xs text-bone hover:border-brass/50">
            <RotateCcw className="w-3 h-3" /> Reopen
          </button>
        )}
        <span className="flex-1" />
        {r.status !== 'paid' && (
          <button type="button" onClick={startEdit} className="p-1 text-ash hover:text-brass" title="Edit" aria-label={`Edit ${name}'s request`}>
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        <button type="button" onClick={onDelete} className="p-1 text-ash hover:text-oxblood" title="Delete" aria-label={`Delete ${name}'s request`}>
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </article>
  );
}

// One grant in the ledger, editable in place. The recipient isn't editable:
// revoke and re-give instead (the PATCH route refuses it too).
function LedgerRow({ g, fromRequest, onSave, onRevoke }) {
  const [edit, setEdit] = useState(null);
  const name = g.display_name || g.discord_id;
  const save = () => onSave(edit).then((ok) => { if (ok) setEdit(null); });
  const keys = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(null); };
  const field = 'bg-hall border border-line rounded-lg px-2 py-1 text-sm text-bone focus:outline-none focus:border-brass';

  if (edit) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-2">
        <span className="text-sm text-bone w-28 truncate" title="Recipient can't be changed. Revoke and re-give instead.">{name}</span>
        <input type="number" min={1} value={edit.amount} autoFocus aria-label="Amount"
          onChange={(e) => setEdit((p) => ({ ...p, amount: e.target.value }))} onKeyDown={keys} className={`${field} w-24`} />
        <select value={edit.currency} aria-label="Currency" onChange={(e) => setEdit((p) => ({ ...p, currency: e.target.value }))} className={field}>
          {CURRENCY_TYPES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <input value={edit.reason} maxLength={300} placeholder="Reason (optional)" aria-label="Reason"
          onChange={(e) => setEdit((p) => ({ ...p, reason: e.target.value }))} onKeyDown={keys} className={`${field} flex-1 min-w-[140px]`} />
        <button type="button" onClick={save} className="p-1 text-brass hover:text-brassbright" aria-label="Save"><Check className="w-4 h-4" /></button>
        <button type="button" onClick={() => setEdit(null)} className="p-1 text-ash hover:text-bone" aria-label="Cancel"><X className="w-4 h-4" /></button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-2 flex-wrap">
      <span className="text-[11px] text-ash w-14 shrink-0" title={fmtDatetime(g.awarded_at)}>{shortDay(g.awarded_at)}</span>
      <span className="text-sm text-bone font-semibold w-28 truncate">{name}</span>
      <span className="inline-flex items-center gap-1.5 w-44 shrink-0">
        <CurrencyIcon currency={g.currency} size={22} />
        <span className={`font-mono ${g.currency === 'lucent' ? LUCENT_TEXT : 'text-bone'}`}>{fmt(g.amount)}</span>
        <span className="text-xs text-ash truncate">{CURRENCY_LABEL[g.currency] || g.currency}</span>
      </span>
      {fromRequest ? (
        <span className="text-[11px] text-sky-700 dark:text-sky-300 border border-sky-500/40 rounded-full px-2 py-0.5 shrink-0"
          title={`${fromRequest.request_type || 'Request'} · ${fromRequest.item_name}`}>From request</span>
      ) : (
        <span className="text-[11px] text-ash border border-line rounded-full px-2 py-0.5 shrink-0">Direct</span>
      )}
      <span className={`text-xs flex-1 min-w-[100px] truncate ${g.reason ? 'text-ash/90 italic' : 'text-ash/30'}`} title={g.reason || ''}>
        {g.reason || '—'}
      </span>
      <button type="button" onClick={() => setEdit({ currency: g.currency, amount: String(g.amount), reason: g.reason || '' })}
        className="p-1 text-ash hover:text-brass" title="Edit" aria-label={`Edit grant to ${name}`}>
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <button type="button" onClick={onRevoke} className="p-1 text-ash hover:text-oxblood" title="Revoke" aria-label={`Revoke grant to ${name}`}>
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
