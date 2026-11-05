// backend/admin/loot.js — Loot council: item awards, the fairness table, and award CSV import.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const crypto = require('crypto');
const Papa = require('papaparse');
const perms = require('../permissions');
const { listMembers } = require('../discord');
const { fetchAll } = require('../pagedRead');
const { eligibleCount, norm, upload, clean } = require('./helpers');

module.exports = function registerLoot(router, ctx) {
  const { supabase, lootCatalog, identities, loadTenure, attendanceWindow } = ctx;

  // ── Loot council: awards ────────────────────────────────────────────────────
  router.get('/loot/awards', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    // Paged: the award ledger only grows, and past the 1,000-row cap the loot
    // tally stops recognising older awards — so members reappear as still
    // wanting gear they were given, which reads as a wishlist bug rather than a
    // truncated read. `id` tiebreaks awarded_at for stable range paging.
    let data;
    let ids;
    try {
      [data, ids] = await Promise.all([
        fetchAll(
          () => supabase.from('loot_awards').select('*').order('awarded_at', { ascending: false }).order('id'),
          { label: 'loot_awards' },
        ),
        identities.load(),
      ]);
    } catch (err) {
      console.error('loot awards load error:', err.message);
      return res.status(500).json({ error: 'Failed to load awards.' });
    }
    const awards = (data || []).map((a) => ({
      ...a,
      display_name: ids.displayNameFor(a.discord_id, a.display_name),
    }));
    res.json({ awards });
  });

  router.post('/loot/awards', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { item_key, discord_id, display_name, priority } = req.body || {};
    if (!item_key || !discord_id) return res.status(400).json({ error: 'Item and player are required.' });
    const validKeys = await lootCatalog.getKeys();
    if (!validKeys.has(item_key)) return res.status(400).json({ error: 'Unknown item.' });
    const id = crypto.randomUUID();
    const { error } = await supabase.from('loot_awards').insert({
      id, item_key, discord_id: String(discord_id),
      display_name: display_name || null,
      priority: lootCatalog.priorities.has(priority) ? priority : null,
      awarded_by: req.user.username || req.user.id,
      awarded_at: new Date().toISOString(),
    });
    if (error) return res.status(500).json({ error: 'Failed to record award.' });
    res.json({ id });
  });

  // Backfill/correct which build an older award (pre-dating the priority
  // column) was actually for.
  router.patch('/loot/awards/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { priority } = req.body || {};
    if (priority !== null && !lootCatalog.priorities.has(priority)) return res.status(400).json({ error: 'Unknown build.' });
    const { error } = await supabase.from('loot_awards').update({ priority }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update award.' });
    res.json({ ok: true });
  });

  router.delete('/loot/awards/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('loot_awards').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to revoke award.' });
    res.json({ ok: true });
  });

  // ── Loot council: fairness ──────────────────────────────────────────────────
  // "Who has shown up the most and received the least" is the question a loot
  // council actually argues about, and until now it could only be answered from
  // memory across three pages. All three inputs were already stored; nothing
  // joined them.
  //
  // THE WINDOW GOVERNS BOTH HALVES. A 30-day attendance rate next to an all-time
  // loot count is not a comparison, it is a way to make a long-standing member
  // look greedy — the same trap the attendance-stats route documents about its
  // own numerator, one step further out.
  //
  // Everyone on the roster appears, including members with nothing on either
  // side. Zero-and-zero is noise, but high-attendance-and-zero is the entire
  // point of the page and it only exists as a row if people with no awards are
  // listed at all.
  router.get('/loot/fairness', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    // Currency is the more sensitive half — same split as playerLoot() on the
    // profile: an officer who runs gear awards doesn't automatically get to see
    // what everyone has been paid. Omitted rather than zeroed, so the page can
    // hide the columns instead of showing a wrong number.
    const canSeeCurrency = perms.userHas(req.user, 'loot.currency');

    try {
      const { days, since } = attendanceWindow(req);

      let eq = supabase.from('events').select('id, event_date');
      if (since) eq = eq.gte('event_date', since);
      const { data: evts, error: eErr } = await eq;
      if (eErr) throw eErr;
      const eventIds = (evts || []).map((e) => e.id);
      const totalEvents = eventIds.length;

      const inWindow = (q) => (since ? q.gte('awarded_at', since) : q);

      const [attRows, awardRows, currencyRows, ids, discordMembers, tenures] = await Promise.all([
        eventIds.length === 0 ? [] : fetchAll(
          () => supabase.from('event_attendance').select('discord_id, event_id')
            .in('event_id', eventIds).order('id'),
          { label: 'event_attendance' },
        ),
        fetchAll(
          () => inWindow(supabase.from('loot_awards').select('discord_id, priority, awarded_at')).order('id'),
          { label: 'loot_awards' },
        ),
        canSeeCurrency
          ? fetchAll(
            () => inWindow(supabase.from('currency_awards').select('discord_id, currency, amount, awarded_at')).order('id'),
            { label: 'currency_awards' },
          )
          : Promise.resolve([]),
        identities.load(),
        // Soft-failed: without Discord the table still works, it just falls back
        // to whoever appears in the data rather than the full roster.
        listMembers().catch(() => []),
        loadTenure(),
      ]);

      const rows = new Map();
      const attendedBy = new Map(); // discord_id -> Set of event ids
      const row = (discordId) => {
        const id = String(discordId);
        if (!rows.has(id)) {
          rows.set(id, {
            discord_id: id,
            display_name: ids.displayNameFor(id, null) || id,
            attended: 0,
            items: 0,
            items_by_build: {},
            lucent: 0,
            shards: 0,
          });
        }
        return rows.get(id);
      };

      discordMembers.forEach((m) => {
        const r = row(m.id);
        // The Discord nickname is only a fallback — an identity alias wins, the
        // same precedence every other surface uses.
        r.display_name = ids.displayNameFor(m.id, m.name) || m.name;
      });
      attRows.forEach((a) => {
        row(a.discord_id).attended += 1;
        const id = String(a.discord_id);
        if (!attendedBy.has(id)) attendedBy.set(id, new Set());
        attendedBy.get(id).add(String(a.event_id));
      });
      awardRows.forEach((a) => {
        const r = row(a.discord_id);
        r.items += 1;
        // 'Untagged' is a real bucket, not a rounding error: awards predating
        // the priority column have no build, and hiding them would make the
        // per-build columns disagree with the total beside them.
        const key = a.priority || 'Untagged';
        r.items_by_build[key] = (r.items_by_build[key] || 0) + 1;
      });
      currencyRows.forEach((c) => {
        const r = row(c.discord_id);
        if (c.currency === 'lucent') r.lucent += c.amount || 0;
        else r.shards += c.amount || 0;
      });

      // Each member's own denominator: the nights since they joined. A member
      // two weeks in is measured on two weeks, not on the whole window.
      const members = [...rows.values()].map((r) => {
        const eligible = eligibleCount(evts || [], tenures.get(r.discord_id), attendedBy.get(r.discord_id));
        const out = {
          ...r,
          eligible,
          rate: eligible ? Math.round((r.attended / eligible) * 100) : null,
        };
        if (!canSeeCurrency) { delete out.lucent; delete out.shards; }
        return out;
      });

      res.json({
        window: days,
        total_events: totalEvents,
        can_see_currency: canSeeCurrency,
        priorities: [...lootCatalog.priorities],
        members,
      });
    } catch (err) {
      console.error('Loot fairness error:', err.message);
      res.status(500).json({ error: 'Failed to build the fairness table.' });
    }
  });

  // Recognized spellings for the optional CSV "build" column, keyed by
  // lowercased input. Falls through to an exact (case-insensitive) match
  // against the live priority list below for anything not listed here.
  const PRIORITY_ALIASES = {
    pvp: 'PvP',
    pve: 'PvE',
    'second build': 'Second Build',
    second: 'Second Build',
    '2nd': 'Second Build',
    '2nd build': 'Second Build',
  };

  // Bulk-backfill older loot awards from a CSV (columns: item, member, date, awarded_by, build).
  router.post('/loot/awards/import', upload.single('file'), async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'CSV file required.' });

    const HEADER_MAP = {
      item: 'item', item_name: 'item', itemname: 'item', 'item name': 'item',
      item_key: 'item_key', itemkey: 'item_key',
      member: 'member', player: 'member', name: 'member', winner: 'member',
      date: 'date', awarded_at: 'date', awardedat: 'date', 'awarded at': 'date',
      awarded_by: 'awarded_by', awardedby: 'awarded_by', 'awarded by': 'awarded_by', by: 'awarded_by',
      build: 'priority', priority: 'priority', class: 'priority',
    };
    const parsed = Papa.parse(f.buffer.toString('utf8'), {
      header: true, skipEmptyLines: true,
      transformHeader: (h) => HEADER_MAP[h.trim().toLowerCase()] || h.trim().toLowerCase(),
    });
    if (parsed.errors?.length) return res.status(400).json({ error: 'Could not parse CSV: ' + parsed.errors[0].message });

    const [catalog, discordMembers, ids] = await Promise.all([
      lootCatalog.getCatalog(),
      listMembers().catch(() => []),
      identities.load(),
    ]);

    const itemByKey = new Map();
    const itemByName = new Map();
    catalog.categories.forEach((c) => c.items.forEach((it) => {
      itemByKey.set(it.key, it);
      itemByName.set(norm(it.name), it);
    }));

    // Identities take precedence; Discord server names are the fallback for
    // members who have no identity row yet.
    const discordByMemberName = new Map();
    discordMembers.forEach((m) => { if (m.name) discordByMemberName.set(norm(m.name), m.id); });

    const errors = [];
    const toInsert = [];
    (parsed.data || []).forEach((raw, idx) => {
      const rowNum = idx + 2; // account for the header row
      const itemRaw = clean(raw.item_key) || clean(raw.item);
      const memberRaw = clean(raw.member);
      if (!itemRaw || !memberRaw) { errors.push({ row: rowNum, reason: 'Missing item or member.' }); return; }

      const item = itemByKey.get(itemRaw) || itemByName.get(norm(itemRaw));
      if (!item) { errors.push({ row: rowNum, reason: `Unknown item "${itemRaw}".` }); return; }

      const discordId = ids.discordIdFor(memberRaw) || discordByMemberName.get(norm(memberRaw));
      if (!discordId) { errors.push({ row: rowNum, reason: `Unknown member "${memberRaw}".` }); return; }

      const dateRaw = clean(raw.date);
      const parsedDate = dateRaw ? new Date(dateRaw) : null;
      const awardedAt = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : new Date().toISOString();

      const priorityRaw = clean(raw.priority);
      const priorityMatch = priorityRaw && (PRIORITY_ALIASES[norm(priorityRaw)]
        || [...lootCatalog.priorities].find((p) => norm(p) === norm(priorityRaw)));

      toInsert.push({
        id: crypto.randomUUID(),
        item_key: item.key,
        discord_id: String(discordId),
        display_name: memberRaw,
        priority: priorityMatch || null,
        awarded_by: clean(raw.awarded_by) || req.user.username || req.user.id,
        awarded_at: awardedAt,
      });
    });

    if (toInsert.length > 0) {
      const { error } = await supabase.from('loot_awards').insert(toInsert);
      if (error) return res.status(500).json({ error: 'Failed to import awards: ' + error.message });
    }

    res.json({ imported: toInsert.length, skipped: errors.length, errors: errors.slice(0, 50) });
  });
};
