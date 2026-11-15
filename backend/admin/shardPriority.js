// backend/admin/shardPriority.js — the Shards page's Priority tab: one combined
// list of who gets shards next, the layout of the request tables beside it,
// officers' need confirmations, and posting the list to Discord.
// Registered onto the one admin router by ../admin.js; '/shard-priority' is
// gated on loot.awards in ../permissions.js, the same capability that sets
// per-member shard priorities and the weapon ranking.
//
// The rules (what a request key is, when a confirmation still holds, what the
// post says) live in ../shardPriority.js; this file only reads and writes.
const SHARDS = require('../../shared/shards.json');
const shardWishlist = require('../shardWishlist');
const {
  keyOf, parseKey, cleanList, cleanWeaponOrder, cleanBossOrder, liveRequests, liveList, buildPost,
} = require('../shardPriority');
const { postToChannel } = require('../discord');
const { fetchAll } = require('../pagedRead');
const { eligibleCount } = require('./helpers');

// How far back the page looks for attendance and for loot already received.
const ATTENDANCE_DAYS = 14;
const LOOT_DAYS = 90;

const CURRENCY_LABEL = new Map([['lucent', 'Lucent'], ...SHARDS.types.map((t) => [t.key, t.label])]);
const SHARD_KEYS = new Set(SHARDS.types.map((t) => t.key));

module.exports = function registerShardPriority(router, ctx) {
  const { supabase, gateway, identities, lootCatalog, loadTenure, attendanceWindow } = ctx;

  // Everything the list is read against: the saved row, every live request,
  // the confirmations keyed like requests, and names.
  async function loadState() {
    const [rowRes, wishRows, confRows, ids] = await Promise.all([
      supabase.from('shard_priority').select('*').eq('id', 1).maybeSingle(),
      fetchAll(() => supabase.from('shard_counts').select('discord_id, display_name, shards').order('discord_id'), { label: 'shard_counts' }),
      fetchAll(() => supabase.from('shard_need_confirmations').select('*').order('discord_id'), { label: 'shard_need_confirmations' }),
      identities.load(),
    ]);
    if (rowRes.error) throw rowRes.error;
    const row = rowRes.data || {};
    const fallbackName = new Map((wishRows || []).map((r) => [String(r.discord_id), r.display_name]));
    const live = liveRequests((wishRows || []).map((r) => ({ discordId: String(r.discord_id), shards: shardWishlist.read(r.shards) })));
    const confirmations = new Map((confRows || []).map((c) => [keyOf(c.discord_id, c.boss, c.weapon), c]));
    const nameFor = (id) => ids.displayNameFor(id, fallbackName.get(String(id)) || 'Member');
    return { row, live, confirmations, nameFor, ids };
  }

  // Each member's rate over the last ATTENDANCE_DAYS nights, measured the way
  // the Attendance page measures it: the same window helper, and only nights
  // since they joined in the denominator (eligibleCount).
  async function attendanceFor(discordIds) {
    const { since } = attendanceWindow({ query: { window: String(ATTENDANCE_DAYS) } });
    const { data: evts, error } = await supabase.from('events').select('id, event_date').gte('event_date', since);
    if (error) throw error;
    const eventIds = (evts || []).map((e) => e.id);
    const [att, tenures] = await Promise.all([
      eventIds.length === 0 ? [] : fetchAll(
        () => supabase.from('event_attendance').select('discord_id, event_id').in('event_id', eventIds).order('id'),
        { label: 'event_attendance' },
      ),
      loadTenure(),
    ]);
    const attended = new Map();
    (att || []).forEach((a) => {
      const id = String(a.discord_id);
      if (!attended.has(id)) attended.set(id, new Set());
      attended.get(id).add(String(a.event_id));
    });
    const out = {};
    discordIds.forEach((id) => {
      const set = attended.get(id);
      const eligible = eligibleCount(evts || [], tenures.get(id), set);
      const n = set ? set.size : 0;
      // null rather than 0 for someone with no nights yet, as on the Attendance page.
      out[id] = { attended: n, eligible, rate: eligible ? Math.round((n / eligible) * 100) : null };
    });
    return out;
  }

  // Gear and currency each member received in the last LOOT_DAYS, newest first.
  async function lootFor(discordIds) {
    const since = new Date(Date.now() - LOOT_DAYS * 86_400_000).toISOString();
    const wanted = new Set(discordIds);
    const [items, currency, catalog] = await Promise.all([
      fetchAll(
        () => supabase.from('loot_awards').select('id, discord_id, item_key, awarded_at').gte('awarded_at', since)
          .order('awarded_at', { ascending: false }).order('id'),
        { label: 'loot_awards' },
      ),
      fetchAll(
        () => supabase.from('currency_awards').select('id, discord_id, currency, amount, awarded_at').gte('awarded_at', since)
          .order('awarded_at', { ascending: false }).order('id'),
        { label: 'currency_awards' },
      ),
      lootCatalog ? lootCatalog.getCatalog() : null,
    ]);
    const itemName = new Map();
    (catalog?.categories || []).forEach((c) => (c.items || []).forEach((i) => itemName.set(i.key, i.name)));
    const out = {};
    const add = (id, entry) => {
      if (!wanted.has(id)) return;
      (out[id] = out[id] || []).push(entry);
    };
    (items || []).forEach((a) => add(String(a.discord_id), {
      at: a.awarded_at, kind: 'gear', label: itemName.get(a.item_key) || a.item_key, amount: null,
    }));
    (currency || []).forEach((a) => add(String(a.discord_id), {
      at: a.awarded_at, kind: SHARD_KEYS.has(a.currency) ? 'shard' : 'lucent',
      label: CURRENCY_LABEL.get(a.currency) || a.currency, amount: a.amount,
    }));
    Object.values(out).forEach((list) => list.sort((x, y) => (x.at < y.at ? 1 : -1)));
    return out;
  }

  // Attendance and loot are side panels: if either can't be read, the list
  // still loads and the page says what's missing, rather than the whole tab
  // failing over a hover card.
  const settle = (label, p) => p.catch((err) => {
    console.error(`shard priority ${label} error:`, err.message);
    return null;
  });

  router.get('/shard-priority', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const { row, live, confirmations } = await loadState();
      const memberIds = [...new Set([...live.values()].map((r) => r.discordId))];
      const [attendance, loot] = await Promise.all([
        settle('attendance', attendanceFor(memberIds)),
        settle('loot', lootFor(memberIds)),
      ]);
      const confirmed = {};
      confirmations.forEach((c, k) => {
        if (live.has(k)) confirmed[k] = { need: c.need, by_name: c.confirmed_by_name || null, at: c.confirmed_at };
      });
      res.json({
        requests: liveList(row.requests, live),
        weapon_order: cleanWeaponOrder(row.weapon_order),
        boss_order: cleanBossOrder(row.boss_order),
        posted: row.posted_at ? {
          requests: cleanList(row.posted_requests),
          at: row.posted_at,
          by_name: row.posted_by_name || null,
          channel_id: row.posted_channel_id || null,
        } : null,
        confirmations: confirmed,
        attendance, attendance_days: ATTENDANCE_DAYS,
        loot, loot_days: LOOT_DAYS,
      });
    } catch (err) {
      console.error('shard priority load error:', err.message);
      // Postgres's "no such table", or PostgREST's word for the same thing.
      if (err.code === '42P01' || err.code === 'PGRST205') {
        return res.status(503).json({ error: 'The priority tables are missing — run migrations/16_shard_priority.sql, then verify.sql.' });
      }
      res.status(500).json({ error: 'Failed to load shard priority.' });
    }
  });

  // The whole list each time — adding, removing and dragging all send it, so
  // what's stored is always the order the officer last saw.
  router.put('/shard-priority/list', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const requests = cleanList(req.body?.requests);
    const { error } = await supabase.from('shard_priority')
      .upsert({ id: 1, requests, updated_at: new Date().toISOString(), updated_by: req.user.id });
    if (error) { console.error('shard priority save error:', error.message); return res.status(500).json({ error: 'Failed to save the priority list.' }); }
    res.json({ requests });
  });

  // How the request tables are laid out: weapons within each boss, and the
  // bosses themselves. Either half may be sent alone.
  router.put('/shard-priority/order', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const patch = { id: 1, updated_at: new Date().toISOString(), updated_by: req.user.id };
    if (req.body?.weapon_order !== undefined) patch.weapon_order = cleanWeaponOrder(req.body.weapon_order);
    if (req.body?.boss_order !== undefined) patch.boss_order = cleanBossOrder(req.body.boss_order);
    const { error } = await supabase.from('shard_priority').upsert(patch);
    if (error) { console.error('shard priority order error:', error.message); return res.status(500).json({ error: 'Failed to save the table order.' }); }
    res.json({ weapon_order: patch.weapon_order, boss_order: patch.boss_order });
  });

  // "Checked with them: they still need what the wishlist says." The need is
  // read here from the wishlist rather than taken from the request, so what's
  // confirmed is the number actually on file at that moment.
  router.put('/shard-priority/confirmations', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const parsed = parseKey(req.body?.key);
    if (!parsed) return res.status(400).json({ error: 'Unknown request.' });
    const { data, error } = await supabase.from('shard_counts').select('shards').eq('discord_id', parsed.discordId).maybeSingle();
    if (error) { console.error('confirmation read error:', error.message); return res.status(500).json({ error: 'Failed to confirm.' }); }
    const weapon = shardWishlist.read(data?.shards).weapons.find((w) => w.boss === parsed.boss && w.weapon === parsed.weapon);
    if (!weapon) return res.status(404).json({ error: 'That member no longer has this weapon on their wishlist.' });
    if (weapon.need === null) return res.status(400).json({ error: "This member hasn't set how many they need yet." });
    const ids = await identities.load();
    const confirmation = {
      discord_id: parsed.discordId, boss: parsed.boss, weapon: parsed.weapon, need: weapon.need,
      confirmed_by: String(req.user.id),
      confirmed_by_name: ids.displayNameFor(req.user.id, req.user.username || null),
      confirmed_at: new Date().toISOString(),
    };
    const { error: saveError } = await supabase.from('shard_need_confirmations').upsert(confirmation);
    if (saveError) { console.error('confirmation save error:', saveError.message); return res.status(500).json({ error: 'Failed to confirm.' }); }
    res.json({ key: req.body.key, need: confirmation.need, by_name: confirmation.confirmed_by_name, at: confirmation.confirmed_at });
  });

  router.delete('/shard-priority/confirmations', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const parsed = parseKey(req.query.key);
    if (!parsed) return res.status(400).json({ error: 'Unknown request.' });
    const { error } = await supabase.from('shard_need_confirmations').delete()
      .eq('discord_id', parsed.discordId).eq('boss', parsed.boss).eq('weapon', parsed.weapon);
    if (error) { console.error('confirmation delete error:', error.message); return res.status(500).json({ error: 'Failed to clear the confirmation.' }); }
    res.json({ ok: true });
  });

  // The channel picker. Starts on wherever the list was posted last time.
  router.get('/shard-priority/channels', async (req, res) => {
    let last = null;
    if (supabase) {
      const { data } = await supabase.from('shard_priority').select('posted_channel_id').eq('id', 1).maybeSingle();
      last = data?.posted_channel_id || null;
    }
    res.json({ channels: gateway.listTextChannels(), default_channel_id: last });
  });

  // Exactly what Post would send, built by the same function from the saved
  // list, so the preview can't drift from the post.
  router.get('/shard-priority/preview', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const { row, live, confirmations, nameFor } = await loadState();
      // Previewed with names even when mentioning: <@id> means nothing outside Discord.
      const { lines, count } = buildPost({ list: row.requests, live, nameFor, confirmations, mention: false });
      res.json({ lines, count });
    } catch (err) {
      console.error('shard priority preview error:', err.message);
      res.status(500).json({ error: 'Failed to build the preview.' });
    }
  });

  // { channel_id, mention } — posts the saved list, then records it as posted.
  // Recorded only after every message went out, so a refused post doesn't
  // clear "changed since".
  router.post('/shard-priority/post', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const channelId = String(req.body?.channel_id || '');
    if (!channelId) return res.status(400).json({ error: 'Pick a channel to post to.' });
    try {
      const { row, live, confirmations, nameFor, ids } = await loadState();
      const { messages, count } = buildPost({ list: row.requests, live, nameFor, confirmations, mention: Boolean(req.body?.mention) });
      if (!count) return res.status(400).json({ error: 'Nothing is ranked yet.' });
      for (const message of messages) await postToChannel(channelId, message);
      const posted = {
        posted_requests: liveList(row.requests, live),
        posted_at: new Date().toISOString(),
        posted_by: String(req.user.id),
        posted_by_name: ids.displayNameFor(req.user.id, req.user.username || null),
        posted_channel_id: channelId,
      };
      const { error } = await supabase.from('shard_priority').upsert({ id: 1, ...posted });
      if (error) console.error('shard priority posted-stamp error:', error.message);
      res.json({
        count,
        posted: { requests: posted.posted_requests, at: posted.posted_at, by_name: posted.posted_by_name, channel_id: channelId },
      });
    } catch (err) {
      const discordMsg = err.response?.data?.message;
      console.error('shard priority post error:', discordMsg || err.message);
      res.status(discordMsg ? 502 : 500).json({
        error: discordMsg ? `Discord refused the post: ${discordMsg}` : err.message || 'Failed to post.',
      });
    }
  });
};
