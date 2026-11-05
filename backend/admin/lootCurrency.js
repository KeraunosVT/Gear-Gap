// backend/admin/lootCurrency.js — Loot council: Lucent and shard grants, Lucent requests, and the market prices that price them.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const crypto = require('crypto');
const Papa = require('papaparse');
const perms = require('../permissions');
const SHARDS = require('../../shared/shards.json');
const { listMembers } = require('../discord');
const { fetchAll } = require('../pagedRead');
const { norm, upload, clean } = require('./helpers');

module.exports = function registerLootCurrency(router, ctx) {
  const { supabase, identities } = ctx;

  // ── Loot council: currency (Lucent / archboss shards) given ───────────────────
  // Kept separate from loot_awards — currency grants have no wishlist, build, or
  // catalog item behind them, just a recipient, a type, and an amount, and (unlike
  // gear) the same currency is routinely given to the same person more than once.
  // Shard types come from shared/shards.json — the same list the "Archboss Shards"
  // wishlist page uses — so both features track the same shards under the same
  // keys, and adding a type there makes it grantable here. Note grants are not
  // capped by a type's `max`: that caps what you say you NEED, not what you were
  // given, and a member can be paid more than they asked for.
  const CURRENCIES = new Set(['lucent', ...SHARDS.types.map((t) => t.key)]);

  router.get('/currency-awards', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    // Paged for the same reason as the gear ledger above — and this one is
    // read to compute totals, so a truncated list understates what a member
    // has actually been paid.
    let data;
    let ids;
    try {
      [data, ids] = await Promise.all([
        fetchAll(
          () => supabase.from('currency_awards').select('*').order('awarded_at', { ascending: false }).order('id'),
          { label: 'currency_awards' },
        ),
        identities.load(),
      ]);
    } catch (err) {
      console.error('currency awards load error:', err.message);
      return res.status(500).json({ error: 'Failed to load currency grants.' });
    }
    const awards = (data || []).map((a) => ({
      ...a,
      display_name: ids.displayNameFor(a.discord_id, a.display_name),
    }));
    res.json({ awards });
  });

  // Optional free-text note on a grant — "raid payout", "boonstone reimbursement",
  // "correction for double-pay". Empty collapses to null so the ledger shows a
  // dash rather than a blank that reads like a missing value.
  const cleanReason = (v) => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, 300) : null;
  };

  // Same treatment for short free-text labels (a request's type), just a
  // tighter cap — it's a category, not a sentence.
  const cleanShort = (v) => {
    const s = String(v ?? '').trim();
    return s ? s.slice(0, 60) : null;
  };

  router.post('/currency-awards', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { discord_id, display_name, currency, amount, reason } = req.body || {};
    if (!discord_id) return res.status(400).json({ error: 'Member is required.' });
    if (!CURRENCIES.has(currency)) return res.status(400).json({ error: 'Unknown currency type.' });
    const amt = parseInt(amount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number.' });

    const id = crypto.randomUUID();
    const { error } = await supabase.from('currency_awards').insert({
      id, discord_id: String(discord_id), display_name: display_name || null,
      currency, amount: amt, reason: cleanReason(reason),
      awarded_by: req.user.username || req.user.id,
      awarded_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ error: 'Failed to record grant.' });
    res.json({ id });
  });

  // Correct a grant in place — a typo'd amount, the wrong shard type, a missing
  // note. The recipient deliberately isn't editable: silently repointing a past
  // grant at a different member rewrites the ledger's history, so that case goes
  // through revoke + re-give, which leaves both actions in the audit log.
  router.patch('/currency-awards/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { currency, amount, reason } = req.body || {};
    const update = {};
    if (currency !== undefined) {
      if (!CURRENCIES.has(currency)) return res.status(400).json({ error: 'Unknown currency type.' });
      update.currency = currency;
    }
    if (amount !== undefined) {
      const amt = parseInt(amount, 10);
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number.' });
      update.amount = amt;
    }
    if (reason !== undefined) update.reason = cleanReason(reason);
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    const { error } = await supabase.from('currency_awards').update(update).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update grant.' });
    res.json({ ok: true });
  });

  // Backfill historical Lucent/shard grants from a CSV, mirroring the gear-award
  // importer above — same header aliasing, same "resolve names, report per-row
  // reasons, insert what's valid" contract, so one spreadsheet convention covers
  // both halves of the loot ledger.
  router.post('/currency-awards/import', upload.single('file'), async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'CSV file required.' });

    const HEADER_MAP = {
      member: 'member', player: 'member', name: 'member', recipient: 'member', winner: 'member',
      currency: 'currency', type: 'currency', kind: 'currency', shard: 'currency',
      amount: 'amount', qty: 'amount', quantity: 'amount', value: 'amount', lucent: 'amount',
      date: 'date', awarded_at: 'date', awardedat: 'date', 'awarded at': 'date',
      awarded_by: 'awarded_by', awardedby: 'awarded_by', 'awarded by': 'awarded_by', by: 'awarded_by',
      reason: 'reason', note: 'reason', notes: 'reason', comment: 'reason',
    };
    const parsed = Papa.parse(f.buffer.toString('utf8'), {
      header: true, skipEmptyLines: true,
      transformHeader: (h) => HEADER_MAP[h.trim().toLowerCase()] || h.trim().toLowerCase(),
    });
    if (parsed.errors?.length) return res.status(400).json({ error: 'Could not parse CSV: ' + parsed.errors[0].message });

    const [discordMembers, ids] = await Promise.all([
      listMembers().catch(() => []),
      identities.load(),
    ]);
    const discordByMemberName = new Map();
    discordMembers.forEach((m) => { if (m.name) discordByMemberName.set(norm(m.name), m.id); });

    // Accept either the storage key ("tevent_ashen") or the human label
    // ("Tevent Ashen") — a spreadsheet kept by hand will have the label, and
    // rejecting it would make the importer useless for the data people actually
    // have. Blank defaults to lucent, which is the overwhelming majority.
    const currencyByKey = new Map([['lucent', 'lucent'], ...SHARDS.types.map((t) => [t.key, t.key])]);
    const currencyByLabel = new Map([['lucent', 'lucent'], ...SHARDS.types.map((t) => [norm(t.label), t.key])]);
    const resolveCurrency = (raw) => {
      if (!raw) return 'lucent';
      const n = norm(raw);
      return currencyByKey.get(n) || currencyByLabel.get(n) || null;
    };

    const errors = [];
    const toInsert = [];
    (parsed.data || []).forEach((raw, idx) => {
      const rowNum = idx + 2; // account for the header row
      const memberRaw = clean(raw.member);
      if (!memberRaw) { errors.push({ row: rowNum, reason: 'Missing member.' }); return; }

      const discordId = ids.discordIdFor(memberRaw) || discordByMemberName.get(norm(memberRaw));
      if (!discordId) { errors.push({ row: rowNum, reason: `Unknown member "${memberRaw}".` }); return; }

      const currency = resolveCurrency(clean(raw.currency));
      if (!currency) { errors.push({ row: rowNum, reason: `Unknown currency "${clean(raw.currency)}".` }); return; }

      // Tolerate "12,500" and "12500 lucent" — hand-kept sheets have both.
      const amt = parseInt(String(raw.amount ?? '').replace(/[^0-9-]/g, ''), 10);
      if (!Number.isFinite(amt) || amt <= 0) {
        errors.push({ row: rowNum, reason: `Amount must be a positive number (got "${clean(raw.amount) ?? ''}").` });
        return;
      }

      const dateRaw = clean(raw.date);
      const parsedDate = dateRaw ? new Date(dateRaw) : null;
      const awardedAt = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : new Date().toISOString();

      toInsert.push({
        id: crypto.randomUUID(),
        discord_id: String(discordId),
        display_name: memberRaw,
        currency,
        amount: amt,
        reason: cleanReason(raw.reason),
        awarded_by: clean(raw.awarded_by) || req.user.username || req.user.id,
        awarded_at: awardedAt,
      });
    });

    if (toInsert.length > 0) {
      const { error } = await supabase.from('currency_awards').insert(toInsert);
      if (error) return res.status(500).json({ error: 'Failed to import grants: ' + error.message });
    }

    res.json({ imported: toInsert.length, skipped: errors.length, errors: errors.slice(0, 50) });
  });

  router.delete('/currency-awards/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('currency_awards').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to revoke grant.' });
    res.json({ ok: true });
  });

  // ── Loot council: Lucent requests ───────────────────────────────────────────
  // "Member asked for N Lucent to buy item X." Sits between the wishlist ("I
  // want this if it drops") and currency_awards ("this member was given N
  // Lucent") — a request is the thing that turns one into the other, and
  // marking it paid writes the grant so the ledger isn't entered twice.
  const REQUEST_STATUSES = new Set(['pending', 'approved', 'denied', 'paid']);

  // An item is either a catalog key or free text, but the display name is
  // always stored: Lucent buys from the auction house, so plenty of requests
  // are for things the guild's drop catalog doesn't list, and snapshotting the
  // name keeps old requests readable after the catalog is edited.
  const resolveItem = async (itemKey, itemName) => {
    const typed = String(itemName ?? '').trim();
    if (itemKey) {
      const { data } = await supabase.from('loot_items').select('key, name').eq('key', itemKey).maybeSingle();
      if (!data) return { error: 'Unknown item.' };
      return { item_key: data.key, item_name: data.name };
    }
    if (!typed) return { error: 'Pick an item or type a name.' };
    return { item_key: null, item_name: typed.slice(0, 200) };
  };

  router.get('/lucent-requests', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const [{ data, error }, ids] = await Promise.all([
      supabase.from('lucent_requests').select('*').order('requested_at', { ascending: false }),
      identities.load(),
    ]);
    if (error) return res.status(500).json({ error: 'Failed to load Lucent requests.' });
    res.json({
      requests: (data || []).map((r) => ({
        ...r,
        display_name: ids.displayNameFor(r.discord_id, r.display_name),
      })),
    });
  });

  router.post('/lucent-requests', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { discord_id, display_name, item_key, item_name, amount, note, request_type, potential_id } = req.body || {};
    if (!discord_id) return res.status(400).json({ error: 'Member is required.' });
    const amt = parseInt(amount, 10);
    if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number.' });
    const item = await resolveItem(item_key, item_name);
    if (item.error) return res.status(400).json({ error: item.error });

    const id = crypto.randomUUID();
    const { error } = await supabase.from('lucent_requests').insert({
      id, discord_id: String(discord_id), display_name: display_name || null,
      ...item, amount: amt, note: cleanReason(note),
      request_type: cleanShort(request_type), status: 'pending',
      // Set only when the picked item is a market-priced potential; the label
      // still lands in item_name so the row reads without a join.
      potential_id: Number.isInteger(potential_id) ? potential_id : null,
      requested_by: req.user.username || req.user.id,
      requested_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ error: 'Failed to record request.' });
    res.json({ id });
  });

  // Edits and status changes share a route. Moving to 'paid' also writes the
  // Lucent grant, once: the currency_award_id guard means re-saving a paid
  // request (to fix a note, say) can't double-pay.
  router.patch('/lucent-requests/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data: existing } = await supabase.from('lucent_requests').select('*').eq('id', req.params.id).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Request not found.' });

    const { status, amount, note, item_key, item_name, request_type, potential_id } = req.body || {};
    const update = {};

    if (amount !== undefined) {
      const amt = parseInt(amount, 10);
      if (!Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'Amount must be a positive number.' });
      update.amount = amt;
    }
    if (note !== undefined) update.note = cleanReason(note);
    if (request_type !== undefined) update.request_type = cleanShort(request_type);
    // Explicit null clears the link when an edit swaps a potential for gear.
    if (potential_id !== undefined) update.potential_id = Number.isInteger(potential_id) ? potential_id : null;
    if (item_key !== undefined || item_name !== undefined) {
      const item = await resolveItem(item_key, item_name);
      if (item.error) return res.status(400).json({ error: item.error });
      Object.assign(update, item);
    }
    if (status !== undefined) {
      if (!REQUEST_STATUSES.has(status)) return res.status(400).json({ error: 'Unknown status.' });
      update.status = status;
      update.decided_by = req.user.username || req.user.id;
      update.decided_at = new Date().toISOString();
    }
    if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update.' });

    // Approving or denying needs only loot.requests, but marking paid writes a
    // row into the Lucent ledger — so it needs the capability that governs the
    // ledger too. Without this, loot.requests would be a back door to minting
    // currency for someone deliberately not given loot.currency.
    if (status === 'paid' && !perms.userHas(req.user, 'loot.currency')) {
      return res.status(403).json({
        error: 'Marking a request paid records a Lucent grant, which needs the "loot.currency" permission.',
      });
    }

    if (status === 'paid' && !existing.currency_award_id) {
      const grantId = crypto.randomUUID();
      const amt = update.amount ?? existing.amount;
      const itemLabel = update.item_name ?? existing.item_name;

      // Claim the row BEFORE writing the grant, with the null check in the
      // UPDATE itself so Postgres arbitrates. Reading currency_award_id and
      // then inserting only rules out the sequential case: two officers
      // clicking "mark paid" together both read null and both mint a grant, and
      // the member is paid twice. A conditional update can only succeed once.
      const { data: claimed, error: claimErr } = await supabase
        .from('lucent_requests')
        .update({ currency_award_id: grantId })
        .eq('id', req.params.id)
        .is('currency_award_id', null)
        .select('id');
      if (claimErr) {
        console.error('Lucent request claim error:', claimErr.message);
        return res.status(500).json({ error: 'Could not mark this request paid.' });
      }
      if (!claimed || claimed.length === 0) {
        return res.status(409).json({ error: 'This request was just marked paid by someone else.' });
      }

      const { error: gErr } = await supabase.from('currency_awards').insert({
        id: grantId, discord_id: existing.discord_id, display_name: existing.display_name,
        currency: 'lucent', amount: amt,
        reason: `Request: ${itemLabel}`.slice(0, 300),
        awarded_by: req.user.username || req.user.id,
        awarded_at: new Date().toISOString(),
      });
      // Without the grant the request isn't really paid, so release the claim
      // rather than leaving a row pointing at a grant that was never written.
      if (gErr) {
        console.error('Lucent request grant error:', gErr.message);
        await supabase.from('lucent_requests')
          .update({ currency_award_id: null }).eq('id', req.params.id);
        return res.status(500).json({ error: 'Could not record the Lucent grant, so the request was left unpaid.' });
      }
      // Already written by the claim above; don't rewrite it in the final update.
    }

    const { error } = await supabase.from('lucent_requests').update(update).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update request.' });
    res.json({ ok: true, currency_award_id: update.currency_award_id || existing.currency_award_id || null });
  });

  router.delete('/lucent-requests/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('lucent_requests').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete request.' });
    res.json({ ok: true });
  });

  // ── Market potentials (auction-house floors, from the scraper) ───────────────
  // Published by scrappers/index.js, not by this app — tl-tracker's API is 403
  // without a browser session, so a separate process drives a logged-in
  // Playwright profile and upserts here. We only ever read.
  //
  // Returned whole (192 rows, ~40 KB) rather than per-item: the requests page
  // needs to price every row it lists plus offer the full pick-list, so one
  // request beats one-per-row. fetched_at goes back so the UI can show its age —
  // if the scraper machine is off, the data ages rather than disappearing.
  router.get('/market-potentials', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase.from('market_potentials')
      .select('region, items, item_count, fetched_at')
      .order('fetched_at', { ascending: false }).limit(1).maybeSingle();
    if (error) {
      console.error('market-potentials load error:', error.message);
      return res.status(500).json({ error: 'Failed to load market prices.' });
    }
    if (!data) return res.json({ region: null, items: [], fetched_at: null });
    res.json(data);
  });
};
