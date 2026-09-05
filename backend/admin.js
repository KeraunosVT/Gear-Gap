// backend/admin.js — admin-only match ingest. Mounted behind requireAdmin.
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const Papa = require('papaparse');
const { parseScreenshot, parseCsv, WEAPONS } = require('./ingest');
const { listMembers, listRoles, postEmbed, postImage } = require('./discord');
const perms = require('./permissions');
const createLoa = require('./loa');
const { todayInGuildTz } = createLoa;
const createAttendance = require('./attendance');
const createEventSignups = require('./eventSignups');
const { fetchAll } = require('./pagedRead');
const SHARDS = require('../shared/shards.json');
const guildConfig = require('./guildConfig');
const createGuildSettings = require('./guildSettings');
const createLateAttendance = require('./lateAttendance');
const createEventDetail = require('./eventDetail');

const ROLE_EMOJI = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Levenshtein edit distance — used to suggest the closest known player for an
// unmapped (likely OCR-misread) name.
function lev(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}
const norm = (s) => (s || '').trim().toLowerCase();

// Same shape loa.js and eventSignups.js use, so a validation failure carries
// its own status instead of every caller inventing one. Routes here mostly
// return res.status(...) inline; this is for the handful with real validation
// worth doing in a helper.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Merge parsed rows from one or more screenshots/CSVs into a single reviewed set:
// de-duplicate by player name (fallback rank), sort by rank, and recompute the
// data-quality warnings. Shared by the batch and per-file parse paths.
function mergePlayers(all, fileCount) {
  const warnings = [];
  const seen = new Map();
  let duplicates = 0;
  for (const p of all) {
    const key = p.player_name ? `n:${p.player_name.toLowerCase()}` : `r:${p.rank}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.set(key, p);
  }
  const players = [...seen.values()].sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  if (fileCount > 1) warnings.unshift(`Merged ${fileCount} files into ${players.length} players${duplicates ? `, ${duplicates} duplicate row(s) removed` : ''}.`);
  if (players.length === 0) {
    warnings.push('No player rows were detected — check the files and try again.');
  } else {
    const missingTeam = players.filter((p) => !p.team_color).length;
    if (missingTeam) warnings.push(`${missingTeam} row(s) have no team color set.`);
    const badWeapon = players.filter((p) => !WEAPONS.includes(p.weapon_1) || !WEAPONS.includes(p.weapon_2)).length;
    if (badWeapon) warnings.push(`${badWeapon} row(s) have a class to confirm.`);
  }
  return { players, warnings };
}

// Build a Discord embed from a roster layout.
function rosterEmbed(name, parties) {
  const fields = (parties || [])
    .filter((p) => (p.members || []).length > 0)
    .map((p) => ({
      name: (p.name || 'Party').slice(0, 256),
      value: (p.members.map((m) => `${ROLE_EMOJI[m.role] || '•'} ${m.name}`).join('\n') || '—').slice(0, 1024),
      inline: true,
    }));
  return {
    title: (name || 'Roster').slice(0, 256),
    color: 0xc9973a,
    fields: fields.length ? fields : [{ name: 'Empty', value: 'No members assigned.' }],
    footer: { text: guildConfig.get().house },
    timestamp: new Date().toISOString(),
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v).replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};
const team = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (s.startsWith('r')) return 'Red';
  if (s.startsWith('y')) return 'Yellow';
  return null;
};

module.exports = function createAdminRouter(supabase, gateway, lootCatalog, identities) {
  const router = express.Router();
  const attendance = supabase ? createAttendance(supabase) : null;
  const loa = supabase ? createLoa(supabase, identities) : null;
  const signups = supabase ? createEventSignups(supabase, identities, loa) : null;
  const guildSettings = supabase ? createGuildSettings(supabase) : null;
  const lateAttendance = supabase ? createLateAttendance(supabase, identities) : null;
  // One assembler for a logged night, shared with the member-facing route in
  // server.js. Both must describe the same night; see eventDetail.js's header.
  const eventDetail = supabase
    ? createEventDetail(supabase, { identities, loa, signups, lateAttendance, listMembers })
    : null;

  // ── THE TIME WINDOW, RESOLVED ONCE ──────────────────────────────────────────
  // ?window=7|14|30|all, defaulting to 30. Used by the event list AND the
  // attendance-rate table, from this one helper — two copies of the arithmetic
  // is how the list and the rate come to disagree about which nights count,
  // which shows up as rates that don't match the events on screen.
  //
  // The cutoff is (days - 1) back from today so `window=7` means "this night and
  // the six before it" — seven nights, which is what someone picking "7 days"
  // is counting.
  const WINDOWS = { 7: 7, 14: 14, 30: 30 };
  function attendanceWindow(req) {
    const raw = String(req.query.window || '30');
    if (raw === 'all') return { days: null, since: null };
    const days = WINDOWS[raw] || 30;
    const today = todayInGuildTz();
    const since = new Date(new Date(`${today}T12:00:00Z`).getTime() - (days - 1) * 86_400_000)
      .toISOString().slice(0, 10);
    return { days, since };
  }

  router.get('/whoami', (req, res) => {
    res.json({ admin: true, username: req.user.username });
  });

  // ── GUILD SETTINGS ──────────────────────────────────────────────────────────
  // Everything the form needs in one call: the stored values, plus the live
  // Discord lists the pickers offer.
  //
  // The two channel lists are separate and must stay separate. Every
  // *_channel_id except one is a text channel the bot POSTS into;
  // attendance_voice_channel_id is a voice channel the bot READS a member list
  // out of, and a text-channel dropdown cannot offer it.
  //
  // botOnline is sent explicitly rather than left to be inferred from an empty
  // array, because "the bot is offline" and "the bot is online and can see no
  // channels" need different words on screen — and because the page uses it to
  // decide whether an unrecognised stored id means "deleted" or "can't tell
  // right now".
  router.get('/settings', async (req, res) => {
    if (!guildSettings) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const [settings, roles, members] = await Promise.all([
        guildSettings.load(),
        listRoles().catch((err) => { console.error('settings listRoles failed:', err.message); return []; }),
        // For the LOA-cancellation picker, so nobody has to hunt down a
        // snowflake by hand. Soft-failed like roles: not being able to list
        // members is a reason to type an id, not a reason the page won't load.
        listMembers().catch((err) => { console.error('settings listMembers failed:', err.message); return []; }),
      ]);
      const channels = gateway.listTextChannels();
      const voiceChannels = gateway.listVoiceChannels();
      res.json({
        settings,
        roles,
        members,
        channels,
        voice_channels: voiceChannels,
        bot_online: Boolean(channels.length || voiceChannels.length),
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to load settings.' });
    }
  });

  router.patch('/settings', async (req, res) => {
    if (!guildSettings) return res.status(503).json({ error: 'Database not configured.' });
    try {
      // req.user, never a body field: the self-lockout guard is only a guard if
      // the identity it checks is the one that actually made the request.
      const out = await guildSettings.save(req.body, req.user);
      res.json(out);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to save settings.' });
    }
  });

  // ── Party member pool (Discord members with the member role) ────────────────
  router.get('/members', async (req, res) => {
    try {
      const members = await listMembers();
      if (supabase) {
        const [{ data: roleData, error: roleError }, ids] = await Promise.all([
          supabase.from('member_roles').select('discord_id, pvp_role, pve_role, pvp_classes, pve_classes'),
          identities.load(),
        ]);
        if (roleError) console.error('member_roles load error:', roleError.message);
        const roleMap = {};
        const classMap = {};
        (roleData || []).forEach((r) => {
          roleMap[r.discord_id] = { pvp: r.pvp_role || '', pve: r.pve_role || '' };
          classMap[r.discord_id] = {
            pvp_classes: Array.isArray(r.pvp_classes) ? r.pvp_classes : [],
            pve_classes: Array.isArray(r.pve_classes) ? r.pve_classes : [],
          };
        });

        members.forEach((m) => {
          m.pvp_role = roleMap[m.id]?.pvp || '';
          m.pve_role = roleMap[m.id]?.pve || '';
          m.pvp_classes = classMap[m.id]?.pvp_classes || [];
          m.pve_classes = classMap[m.id]?.pve_classes || [];
          m.name = ids.displayNameFor(m.id, m.name);
        });
      }
      res.json({ members });
    } catch (err) {
      console.error('Member list error:', err.response?.data?.message || err.message);
      res.status(502).json({ error: err.response?.data?.message || err.message });
    }
  });

  // ── Persist a member's role (sticks across rosters) ─────────────────────────
  // Tracked separately per PvP/PvE mode — someone can be a Tank for one and a
  // Healer for the other.
  router.put('/member-roles', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { id, mode, role } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Member id required.' });
    const column = mode === 'pve' ? 'pve_role' : 'pvp_role';
    const { error } = await supabase.from('member_roles')
      .upsert({ discord_id: String(id), [column]: role || null, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: 'Failed to save role.' });
    res.json({ ok: true });
  });

  // ── Gear item levels (admin-only comparison table) ───────────────────────────
  router.get('/gear-ilvl', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    // The third query is deliberately thin: the leaderboard needs to know
    // WHETHER each member has a stored equipment window so it can offer the
    // button, and when it arrived. Selecting the parsed item lists (still on
    // pre-existing rows) would ship a full inventory per member to render one
    // icon.
    const [{ data, error }, ids, { data: shots }] = await Promise.all([
      supabase.from('gear_levels').select('*'),
      identities.load(),
      supabase.from('gear_screenshots').select('discord_id, display_name, excluded_count, submitted_at'),
    ]);
    if (error) return res.status(500).json({ error: 'Failed to load gear levels.' });
    const shotBy = new Map((shots || []).map((s) => [String(s.discord_id), s]));
    const entries = (data || []).map((e) => ({
      ...e,
      display_name: ids.displayNameFor(e.discord_id, e.display_name),
      has_screenshot: shotBy.has(String(e.discord_id)),
      excluded_count: shotBy.get(String(e.discord_id))?.excluded_count ?? 0,
    }));

    // Uploading an equipment window no longer creates a gear level, so a member
    // can have a screenshot on file and no row above. They still belong in this
    // table: it is the only place an officer can open that screenshot, and
    // leaving them out would make an uploaded image unreachable. Levels come
    // through as null, which the page renders as a dash — the honest answer to
    // "what is their gear level" for someone who never sent the popup.
    const levelled = new Set((data || []).map((e) => String(e.discord_id)));
    (shots || []).forEach((s) => {
      const id = String(s.discord_id);
      if (levelled.has(id)) return;
      entries.push({
        discord_id: id,
        display_name: ids.displayNameFor(id, s.display_name),
        weapon: null, armor: null, accessory: null, average: null,
        maxed_at: null, source: null,
        submitted_at: s.submitted_at,
        has_screenshot: true,
        excluded_count: s.excluded_count ?? 0,
      });
    });

    res.json({ entries });
  });

  router.get('/gear-ilvl/:discordId/history', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase.from('gear_level_history')
      .select('*').eq('discord_id', req.params.discordId).order('submitted_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load gear level history.' });
    res.json({ entries: data || [] });
  });

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

  // ── Enemy guild aliases ─────────────────────────────────────────────────────
  // The same job the Names page does for players — reconcile an OCR-misread
  // name to the right thing — applied to enemy guilds, which is why it takes
  // the 'names' capability rather than a new key nobody has been granted.
  //
  // Whitespace is collapsed by the SQL already, so a row here is only ever
  // needed for a genuine misread ("HighIy Regarded") or a rebrand.
  const normaliseGuild = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

  // The two rules that keep the enemy list from corrupting the guild's own
  // record, checked here where the error message can explain them.
  async function assertEnemyAliasSafe(alias, canonical) {
    // 1. Neither side may name US. guild_config.aliases is the list of names
    //    the guild has gone by, and every reader of it treats a match as us —
    //    so an entry here pointing at one of our names would either fold a
    //    rival's matches into our record or push ours out of it. Preventing
    //    exactly that is why the two lists are separate tables.
    const ours = new Set(Object.keys(guildConfig.aliasMap()).map(normaliseGuild));
    if (ours.has(alias)) {
      throw httpError(400, `"${alias}" is one of this guild's own names — enemy aliases can't point at us.`);
    }
    if (ours.has(canonical)) {
      throw httpError(400, `"${canonical}" is one of this guild's own names. To record a name we used to go by, add it to the aliases in Guild Settings instead.`);
    }

    // 2. No chains. If the target is itself an alias, the result would depend
    //    on which join ran first, so A→B→C is refused rather than flattened.
    const { data: chain } = await supabase.from('enemy_guild_aliases')
      .select('canonical').eq('alias', canonical).maybeSingle();
    if (chain) {
      throw httpError(400, `"${canonical}" is already mapped to "${chain.canonical}". Point this one there instead.`);
    }
  }

  router.get('/enemy-guilds', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const p_guild_names = Object.keys(guildConfig.aliasMap());
      const [{ data: aliases, error: aErr }, feuds] = await Promise.all([
        supabase.from('enemy_guild_aliases').select('*').order('canonical').order('alias'),
        supabase.rpc('get_guild_feuds', { p_guild_names }),
      ]);
      if (aErr) throw aErr;
      if (feuds.error) throw feuds.error;

      // Suggestions use the same Levenshtein helper and the same length-scaled
      // threshold as /unmapped-names, so the two merge tools behave alike. It
      // only ever SUGGESTS — auto-merging on edit distance would eventually
      // fold two genuinely different guilds together with nothing saying so.
      const names = (feuds.data || []).map((f) => f.enemy_guild);
      const suggestions = [];
      names.forEach((a, i) => {
        names.slice(i + 1).forEach((b) => {
          const d = lev(norm(a), norm(b));
          const threshold = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.25));
          if (d > 0 && d <= threshold) {
            const [from, to] = (feuds.data.find((f) => f.enemy_guild === a).met
              <= feuds.data.find((f) => f.enemy_guild === b).met) ? [a, b] : [b, a];
            // Merge the rarer spelling INTO the commoner one — the one seen
            // more often is far likelier to be the correct reading.
            suggestions.push({ alias: from, canonical: to, distance: d });
          }
        });
      });

      res.json({ aliases: aliases || [], guilds: feuds.data || [], suggestions });
    } catch (err) {
      console.error('Enemy guilds error:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Failed to load enemy guilds.' });
    }
  });

  router.post('/enemy-guilds', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const alias = normaliseGuild(req.body?.alias);
    const canonical = normaliseGuild(req.body?.canonical);
    try {
      if (!alias || !canonical) throw httpError(400, 'Both names are required.');
      if (alias === canonical) throw httpError(400, 'That maps a name to itself.');
      await assertEnemyAliasSafe(alias, canonical);

      const { error } = await supabase.from('enemy_guild_aliases').upsert({
        alias, canonical, created_by: req.user.username || req.user.id, created_at: new Date().toISOString(),
      }, { onConflict: 'alias' });
      if (error) throw error;

      // Flatten, rather than refuse. A guild that renames twice is the normal
      // case: A→B is recorded, then B renames to C. Left alone that leaves
      // A→B and B→C, and the lookup is a single join — so A would resolve to
      // B, a name nothing else uses, and its matches would split off on their
      // own again.
      //
      // Re-pointing every alias that named B at C keeps the table one level
      // deep by construction, which is what makes the single join correct.
      const { data: repointed, error: rErr } = await supabase.from('enemy_guild_aliases')
        .update({ canonical })
        .eq('canonical', alias)
        .select('alias');
      if (rErr) console.error('Enemy alias re-point failed:', rErr.message);

      res.json({ ok: true, alias, canonical, repointed: (repointed || []).map((r) => r.alias) });
    } catch (err) {
      console.error('Enemy guild merge error:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Failed to save that merge.' });
    }
  });

  router.delete('/enemy-guilds/:alias', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('enemy_guild_aliases')
      .delete().eq('alias', normaliseGuild(decodeURIComponent(req.params.alias)));
    if (error) return res.status(500).json({ error: 'Failed to undo that merge.' });
    res.json({ ok: true });
  });

  // ── Enemy player aliases ────────────────────────────────────────────────────
  // The same job one level down from enemy guilds: OCR turns one person into
  // three rows of a roster, each with a third of their matches — which also
  // puts all three under the standout floor, so the misread hides exactly the
  // player it fragments.
  //
  // Its own table rather than player_identities: that one maps names to OUR
  // members and their Discord ids, and every reader treats a name in it as
  // somebody in this guild. Same call as enemy_guild_aliases in 019.
  async function assertEnemyPlayerSafe(alias, canonical) {
    // CURRENT members only. Someone who left and now plays for a rival is
    // exactly the case this table is for — their old name genuinely belongs to
    // an enemy player now, and refusing it would leave them fragmented on every
    // roster they appear on.
    //
    // "Current" is membership of the Discord guild, not merely having an
    // identity row: those are never deleted (deliberately — they keep old match
    // rows readable), so an identity alone says "we knew this name once", which
    // is not a reason to block anything.
    const ids = await identities.load();
    const hits = [alias, canonical].map((n) => ids.identityForName(n)).filter(Boolean);

    if (hits.length) {
      let current;
      try {
        current = new Set((await listMembers()).map((m) => String(m.id)));
      } catch (err) {
        // Fail closed, and say so. The same call assertAliasesSafe makes when
        // it can't check the war record: refusing a merge that might be wrong
        // beats making one nobody verified, and this is transient.
        console.error('enemy player guard: member list unavailable:', err.message);
        throw httpError(503, "Couldn't check the member list just now, so nothing was merged. Try again in a moment.");
      }

      // No discord_id means nobody is attached to that name — it can't be a
      // current member however it got into the identities table.
      const isCurrent = (it) => Boolean(it?.discord_id) && current.has(String(it.discord_id));

      const aliasHit = ids.identityForName(alias);
      if (isCurrent(aliasHit)) {
        throw httpError(400, `"${alias}" belongs to ${aliasHit.display_name}, who is in the guild. Merge it on the Names page instead.`);
      }
      const canonHit = ids.identityForName(canonical);
      if (isCurrent(canonHit)) {
        throw httpError(400, `"${canonical}" belongs to ${canonHit.display_name}, who is in the guild — enemy aliases can't point at a current member.`);
      }
    }

    // No chains. A→B, B→C would make the result depend on join order, and the
    // lookup is a single join.
    const { data: chain } = await supabase.from('enemy_player_aliases')
      .select('canonical').ilike('alias', canonical).maybeSingle();
    if (chain) {
      throw httpError(400, `"${canonical}" is already mapped to "${chain.canonical}". Point this one there instead.`);
    }
  }

  router.get('/enemy-players', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const enemy = String(req.query.guild || '').trim();
      if (!enemy) throw httpError(400, 'Which guild?');

      const [{ data: aliases, error: aErr }, roster] = await Promise.all([
        supabase.from('enemy_player_aliases').select('*').order('canonical').order('alias'),
        supabase.rpc('get_guild_feud_roster', {
          p_guild_names: Object.keys(guildConfig.aliasMap()),
          p_enemy: enemy,
        }),
      ]);
      if (aErr) throw aErr;
      if (roster.error) throw roster.error;

      // Appearances per already-resolved name, so the commoner spelling is the
      // one a suggestion merges INTO.
      const seen = new Map();
      (roster.data || []).forEach((r) => {
        seen.set(r.player_name, (seen.get(r.player_name) || 0) + (Number(r.appearances) || 0));
      });
      const names = [...seen.keys()];

      // Scoped to ONE guild's roster, deliberately. Across the whole record,
      // two unrelated players in different guilds with similar names would be
      // proposed constantly; within a guild, a near-match is nearly always the
      // same person read twice.
      const suggestions = [];
      names.forEach((a, i) => {
        names.slice(i + 1).forEach((b) => {
          const d = lev(norm(a), norm(b));
          const threshold = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.25));
          if (d > 0 && d <= threshold) {
            const [from, to] = seen.get(a) <= seen.get(b) ? [a, b] : [b, a];
            suggestions.push({ alias: from, canonical: to, distance: d });
          }
        });
      });

      res.json({
        guild: enemy,
        aliases: aliases || [],
        players: names.map((n) => ({ player_name: n, appearances: seen.get(n) })),
        suggestions,
      });
    } catch (err) {
      console.error('Enemy players error:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Failed to load enemy players.' });
    }
  });

  router.post('/enemy-players', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const alias = normaliseGuild(req.body?.alias);
    const canonical = normaliseGuild(req.body?.canonical);
    try {
      if (!alias || !canonical) throw httpError(400, 'Both names are required.');
      if (alias.toLowerCase() === canonical.toLowerCase()) throw httpError(400, 'That maps a name to itself.');
      await assertEnemyPlayerSafe(alias, canonical);

      const { error } = await supabase.from('enemy_player_aliases').upsert({
        alias, canonical, created_by: req.user.username || req.user.id, created_at: new Date().toISOString(),
      }, { onConflict: 'alias' });
      if (error) throw error;

      // Flatten rather than refuse, as with guild renames: if others already
      // pointed at this alias, re-point them at the new target so the table
      // stays one level deep — which is what makes the single join correct.
      const { data: repointed, error: rErr } = await supabase.from('enemy_player_aliases')
        .update({ canonical }).ilike('canonical', alias).select('alias');
      if (rErr) console.error('Enemy player re-point failed:', rErr.message);

      res.json({ ok: true, alias, canonical, repointed: (repointed || []).map((r) => r.alias) });
    } catch (err) {
      console.error('Enemy player merge error:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Failed to save that merge.' });
    }
  });

  router.delete('/enemy-players/:alias', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('enemy_player_aliases')
      .delete().ilike('alias', normaliseGuild(decodeURIComponent(req.params.alias)));
    if (error) return res.status(500).json({ error: 'Failed to undo that merge.' });
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

      let eq = supabase.from('events').select('id');
      if (since) eq = eq.gte('event_date', since);
      const { data: evts, error: eErr } = await eq;
      if (eErr) throw eErr;
      const eventIds = (evts || []).map((e) => e.id);
      const totalEvents = eventIds.length;

      const inWindow = (q) => (since ? q.gte('awarded_at', since) : q);

      const [attRows, awardRows, currencyRows, ids, discordMembers] = await Promise.all([
        eventIds.length === 0 ? [] : fetchAll(
          () => supabase.from('event_attendance').select('discord_id')
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
      ]);

      const rows = new Map();
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
      attRows.forEach((a) => { row(a.discord_id).attended += 1; });
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

      const members = [...rows.values()].map((r) => {
        const out = {
          ...r,
          rate: totalEvents ? Math.round((r.attended / totalEvents) * 100) : null,
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

  // ── Loot catalog management ──────────────────────────────────────────────────
  router.post('/loot/categories', async (req, res) => {
    const { label } = req.body || {};
    if (!label) return res.status(400).json({ error: 'Category label required.' });
    const cat = await lootCatalog.addCategory(label);
    if (!cat) return res.status(409).json({ error: 'Category already exists.' });
    res.json(cat);
  });

  router.put('/loot/categories/:key', async (req, res) => {
    const { label } = req.body || {};
    if (!label) return res.status(400).json({ error: 'Category label required.' });
    if (!(await lootCatalog.renameCategory(req.params.key, label))) return res.status(404).json({ error: 'Category not found.' });
    res.json({ ok: true });
  });

  router.delete('/loot/categories/:key', async (req, res) => {
    if (!(await lootCatalog.deleteCategory(req.params.key))) return res.status(404).json({ error: 'Category not found.' });
    res.json({ ok: true });
  });

  router.post('/loot/items', async (req, res) => {
    const { category, name } = req.body || {};
    if (!category || !name) return res.status(400).json({ error: 'Category and item name required.' });
    const item = await lootCatalog.addItem(category, name);
    if (!item) return res.status(409).json({ error: 'Item already exists or category not found.' });
    res.json(item);
  });

  router.put('/loot/items/:key', async (req, res) => {
    const { name, description, image_url } = req.body || {};
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (image_url !== undefined) updates.image_url = image_url;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update.' });
    if (!(await lootCatalog.editItem(req.params.key, updates))) return res.status(404).json({ error: 'Item not found.' });
    res.json({ ok: true });
  });

  router.post('/loot/items/:key/image', upload.single('image'), async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No image uploaded.' });
    const ext = f.mimetype === 'image/png' ? 'png' : f.mimetype === 'image/webp' ? 'webp' : 'jpg';
    const path = `loot-icons/${req.params.key}.${ext}`;
    const { error: upErr } = await supabase.storage.from('assets').upload(path, f.buffer, {
      contentType: f.mimetype, upsert: true,
    });
    if (upErr) { console.error('Image upload error:', upErr.message); return res.status(500).json({ error: 'Failed to upload image.' }); }
    const { data: urlData } = supabase.storage.from('assets').getPublicUrl(path);
    const image_url = urlData.publicUrl;
    await lootCatalog.editItem(req.params.key, { image_url });
    res.json({ image_url });
  });

  router.delete('/loot/items/:key', async (req, res) => {
    if (!(await lootCatalog.deleteItem(req.params.key))) return res.status(404).json({ error: 'Item not found.' });
    res.json({ ok: true });
  });

  // ── Questlog.gg bulk import ─────────────────────────────────────────────────
  const runImport = require('./questlogImport');

  let importStatus = { running: false, result: null, error: null };

  router.post('/loot/import-questlog', (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    if (importStatus.running) return res.status(409).json({ error: 'Import already running.' });
    importStatus = { running: true, result: null, error: null };
    res.json({ ok: true, message: 'Import started.' });
    runImport(supabase)
      .then((result) => { importStatus = { running: false, result, error: null }; })
      .catch((err) => {
        console.error('Questlog import error:', err.stack || err.message);
        importStatus = { running: false, result: null, error: err.message };
      });
  });

  router.get('/loot/import-status', (req, res) => {
    res.json(importStatus);
  });

  router.get('/loot/questlog-search', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const q = req.query.q || '';
    const cat = req.query.category || '';
    let query = supabase.from('questlog_items').select('*').order('name');
    if (q.trim()) query = query.ilike('name', `%${q.trim()}%`);
    if (cat) query = query.eq('sub_category', cat);
    query = query.limit(50);
    const { data, error } = await query;
    if (error) return res.status(500).json({ error: 'Search failed.' });
    res.json({ items: data || [] });
  });

  router.post('/loot/add-from-questlog', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { questlog_id, category } = req.body || {};
    if (!questlog_id || !category) return res.status(400).json({ error: 'Questlog ID and category required.' });

    const { data: ref } = await supabase.from('questlog_items').select('*').eq('id', questlog_id).single();
    if (!ref) return res.status(404).json({ error: 'Item not found in reference data. Run import first.' });

    const itemKey = `${category}__${questlog_id}`;
    const { data: existing } = await supabase.from('loot_items').select('key').eq('questlog_id', questlog_id).single();
    if (existing) return res.status(409).json({ error: 'Item already in catalog.' });

    const { data: maxRow } = await supabase.from('loot_items').select('sort_order').eq('category_key', category)
      .order('sort_order', { ascending: false }).limit(1).single();
    const sort_order = (maxRow?.sort_order ?? -1) + 1;

    const { error } = await supabase.from('loot_items').insert({
      key: itemKey,
      category_key: category,
      name: ref.name,
      sort_order,
      image_url: ref.icon,
      description: ref.description,
      questlog_id: ref.id,
      grade: ref.grade,
      questlog_data: ref.data,
    });
    if (error) return res.status(500).json({ error: 'Failed to add item.' });
    res.json({ key: itemKey, name: ref.name });
  });

  router.put('/loot/link-questlog/:key', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { questlog_id } = req.body || {};
    if (!questlog_id) return res.status(400).json({ error: 'Questlog ID required.' });

    const { data: ref } = await supabase.from('questlog_items').select('*').eq('id', questlog_id).single();
    if (!ref) return res.status(404).json({ error: 'Item not found in reference data.' });

    const { error } = await supabase.from('loot_items').update({
      image_url: ref.icon,
      description: ref.description,
      questlog_id: ref.id,
      grade: ref.grade,
      questlog_data: ref.data,
    }).eq('key', req.params.key);
    if (error) return res.status(500).json({ error: 'Failed to link item.' });
    res.json({ ok: true });
  });

  router.put('/loot/unlink-questlog/:key', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('loot_items').update({
      image_url: null, description: null, questlog_id: null, grade: null, questlog_data: null,
    }).eq('key', req.params.key);
    if (error) return res.status(500).json({ error: 'Failed to unlink item.' });
    res.json({ ok: true });
  });

  // ── Player identities / name merging ────────────────────────────────────────
  router.get('/identities', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase.from('player_identities')
      .select('id, display_name, ingame_names, discord_id').order('display_name');
    if (error) return res.status(500).json({ error: 'Failed to load identities.' });
    res.json({ identities: data || [] });
  });

  // In-game names from match data that aren't yet mapped to any identity.
  //
  // The alias list is passed in, never assumed by the function — see 023. The
  // zero-argument version this replaced had our guild names hardcoded, so a
  // rename made every player since invisible to the Unmapped list.
  router.get('/unmapped-names', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const [counts, ids] = await Promise.all([
        supabase.rpc('get_guild_player_counts', { p_guild_names: Object.keys(guildConfig.aliasMap()) }),
        identities.load(),
      ]);
      if (counts.error) throw counts.error;
      const identityRows = ids.rows;

      const unmapped = (counts.data || [])
        .filter((c) => !ids.identityForName(c.player_name))
        .map((c) => {
          let best = null;
          identityRows.forEach((it) => {
            [it.display_name, ...(Array.isArray(it.ingame_names) ? it.ingame_names : [])]
              .filter(Boolean)
              .forEach((cand) => {
                const d = lev(norm(c.player_name), norm(cand));
                if (best === null || d < best.distance) best = { id: it.id, display_name: it.display_name, distance: d };
              });
          });
          const threshold = Math.max(2, Math.floor((c.player_name || '').length * 0.34));
          return { name: c.player_name, matches: c.matches, suggestion: best && best.distance <= threshold ? best : null };
        })
        .sort((a, b) => b.matches - a.matches);

      res.json({ unmapped, identities: identityRows });
    } catch (err) {
      console.error('Unmapped names error:', err.message);
      res.status(500).json({ error: 'Failed to load unmapped names.' });
    }
  });

  // Attach an in-game name to an existing identity.
  router.post('/identities/:id/aliases', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name required.' });
    const { data: it, error: gErr } = await supabase
      .from('player_identities').select('ingame_names').eq('id', req.params.id).single();
    if (gErr) return res.status(404).json({ error: 'Identity not found.' });
    const arr = Array.isArray(it.ingame_names) ? it.ingame_names : [];
    if (!arr.some((n) => norm(n) === norm(name))) arr.push(name);
    const { error } = await supabase.from('player_identities')
      .update({ ingame_names: arr, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to add alias.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Remove an in-game name from an identity (un-merge a mistake).
  router.delete('/identities/:id/aliases', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name } = req.body || {};
    const { data: it, error: gErr } = await supabase
      .from('player_identities').select('ingame_names').eq('id', req.params.id).single();
    if (gErr) return res.status(404).json({ error: 'Identity not found.' });
    const arr = (Array.isArray(it.ingame_names) ? it.ingame_names : []).filter((n) => norm(n) !== norm(name));
    const { error } = await supabase.from('player_identities')
      .update({ ingame_names: arr, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to remove alias.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Link a Discord ID to an identity.
  router.put('/identities/:id/discord', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { discord_id } = req.body || {};
    const { error } = await supabase.from('player_identities')
      .update({ discord_id: discord_id || null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to link Discord account.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Rename an identity's display name.
  router.put('/identities/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { display_name } = req.body || {};
    if (!display_name || !display_name.trim()) return res.status(400).json({ error: 'Display name required.' });
    const { error } = await supabase.from('player_identities')
      .update({ display_name: String(display_name).trim().slice(0, 120), updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to rename identity.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Delete an identity entirely (its in-game names fall back to unmapped).
  router.delete('/identities/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('player_identities').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete identity.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Create a new identity (optionally seeded with a first in-game name).
  router.post('/identities', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { display_name, ingame_names } = req.body || {};
    if (!display_name) return res.status(400).json({ error: 'Display name required.' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const aliases = Array.isArray(ingame_names) ? ingame_names : ingame_names ? [ingame_names] : [];
    const { error } = await supabase.from('player_identities')
      .insert({ id, display_name: String(display_name).slice(0, 120), ingame_names: aliases, created_at: now, updated_at: now });
    if (error) return res.status(500).json({ error: 'Failed to create identity.' });
    identities.invalidate();
    res.json({ id });
  });

  // ── Roster CRUD ─────────────────────────────────────────────────────────────
  // A roster is bound to the occasion it was built for (event_date, and
  // optionally one event_schedule_id) so loading it can re-check LOA against
  // that date instead of against today. Both are nullable — rosters saved
  // before the binding existed simply have no occasion to re-check.
  // Returns the columns to write, or null if the date is malformed.
  const rosterOccasion = (body) => {
    const date = body.event_date || null;
    if (date && !DATE_RE.test(date)) return null;
    return { event_date: date, event_schedule_id: body.event_schedule_id || null };
  };

  router.get('/rosters', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase
      .from('rosters').select('id, name, updated_at, event_date, event_schedule_id')
      .order('updated_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load rosters.' });
    res.json({ rosters: data || [] });
  });

  router.get('/rosters/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase
      .from('rosters').select('*').eq('id', req.params.id).single();
    if (error) return res.status(404).json({ error: 'Roster not found.' });
    res.json({ roster: data });
  });

  router.post('/rosters', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, layout } = req.body || {};
    if (!name || !layout) return res.status(400).json({ error: 'Name and layout are required.' });
    const occasion = rosterOccasion(req.body || {});
    if (!occasion) return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format.' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const { error } = await supabase.from('rosters')
      .insert({ id, name: String(name).slice(0, 120), layout, ...occasion, created_at: now, updated_at: now });
    if (error) return res.status(500).json({ error: 'Failed to save roster.' });
    res.json({ id });
  });

  router.put('/rosters/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, layout } = req.body || {};
    const occasion = rosterOccasion(req.body || {});
    if (!occasion) return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format.' });
    const { error } = await supabase.from('rosters')
      .update({ name: String(name || '').slice(0, 120), layout, ...occasion, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update roster.' });
    res.json({ ok: true });
  });

  router.delete('/rosters/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('rosters').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete roster.' });
    res.json({ ok: true });
  });

  // ── Post a roster to Discord ────────────────────────────────────────────────
  router.post('/rosters/post', upload.single('image'), async (req, res) => {
    try {
      if (req.file) {
        const name = req.body?.name || 'Roster';
        await postImage(req.file.buffer, 'roster.png', name);
      } else {
        const { name, parties } = req.body || {};
        if (!Array.isArray(parties)) return res.status(400).json({ error: 'Nothing to post.' });
        await postEmbed(rosterEmbed(name, parties));
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('Discord post error:', err.response?.data?.message || err.message);
      res.status(502).json({ error: err.response?.data?.message || err.message });
    }
  });

  // ── Parse a SINGLE upload (per-file, so the UI can show progress + retry) ────
  router.post('/match/parse-one', upload.single('file'), async (req, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      let players = [];
      if (f.mimetype.startsWith('image/')) {
        players = (await parseScreenshot(f.buffer, f.mimetype)).players;
      } else if (f.mimetype === 'text/csv' || /\.csv$/i.test(f.originalname)) {
        players = parseCsv(f.buffer.toString('utf8')).players;
      } else {
        return res.status(415).json({ error: 'Unsupported file type.' });
      }
      res.json({ players: players || [] });
    } catch (err) {
      const msg = err.message || 'Could not read that file.';
      console.error('Parse-one error:', msg);
      const busy = /overload|rate.?limit|429|503|busy|unavailable|timeout|temporar/i.test(msg);
      res.status(busy ? 503 : 502).json({ error: busy ? `The reader is busy — ${msg}` : msg, retryable: busy });
    }
  });

  // ── Merge already-parsed rows into the reviewed set ─────────────────────────
  router.post('/match/merge', (req, res) => {
    const all = Array.isArray(req.body?.players) ? req.body.players : [];
    const fileCount = Number(req.body?.fileCount) || 0;
    res.json(mergePlayers(all, fileCount));
  });

  // ── Parse one or more uploads into merged draft rows (batch; no DB writes) ──
  router.post('/match/parse', upload.array('files', 20), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });

    const results = await Promise.all(files.map(async (f) => {
      try {
        if (f.mimetype.startsWith('image/')) return { players: (await parseScreenshot(f.buffer, f.mimetype)).players };
        if (f.mimetype === 'text/csv' || /\.csv$/i.test(f.originalname)) return { players: parseCsv(f.buffer.toString('utf8')).players };
        return { players: [], error: `${f.originalname}: unsupported type, skipped.` };
      } catch (err) {
        return { players: [], error: `${f.originalname}: ${err.message}` };
      }
    }));

    const fileWarnings = [];
    const all = [];
    for (const r of results) { if (r.error) fileWarnings.push(r.error); all.push(...r.players); }
    const merged = mergePlayers(all, files.length);
    res.json({ players: merged.players, warnings: [...fileWarnings, ...merged.warnings] });
  });

  // Shape one reviewed player row for the save_match RPC. The SQL function
  // stamps ids/created_at itself, so only the stat fields travel.
  const playerRow = (p) => ({
    rank: toInt(p.rank),
    weapon_1: clean(p.weapon_1),
    weapon_2: clean(p.weapon_2),
    guild_name: clean(p.guild_name),
    player_name: clean(p.player_name),
    team_color: team(p.team_color),
    kills: toInt(p.kills),
    assists: toInt(p.assists),
    damage_dealt: toInt(p.damage_dealt),
    damage_taken: toInt(p.damage_taken),
    healing: toInt(p.healing),
  });

  // Create-or-replace a match and all its player rows in ONE transaction via
  // the save_match Postgres function (see migrations/001_atomic_match_save.sql).
  // A failure anywhere rolls back everything — no orphan matches, no lost rows.
  async function saveMatch(matchId, { title, match_date, result, map, players }) {
    const { data, error } = await supabase.rpc('save_match', {
      p_id: matchId,
      p_title: clean(title) || 'Wargame',
      p_match_date: clean(match_date),
      p_result: clean(result),
      p_map: clean(map),
      p_players: players.map(playerRow),
    });
    if (error) {
      // Most likely cause on first deploy: the migration hasn't been run yet.
      if (/function .*save_match.* does not exist/i.test(error.message)) {
        throw new Error('save_match() is missing — run migrations/001_atomic_match_save.sql in Supabase.');
      }
      throw new Error(error.message);
    }
    return data; // number of player rows written
  }

  // ── Commit reviewed rows: create match + insert players (atomic) ────────────
  router.post('/match/commit', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const { players } = req.body || {};
    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'No players to save.' });
    }

    const matchId = crypto.randomUUID();
    try {
      const inserted = await saveMatch(matchId, req.body);
      res.json({ match_id: matchId, inserted });
    } catch (err) {
      console.error('Match commit error:', err.message);
      res.status(500).json({ error: 'Failed to save the match. ' + err.message });
    }
  });

  // ── Load an existing match for editing ───────────────────────────────────────
  router.get('/match/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data: match, error: mErr } = await supabase
      .from('wargame_matches').select('*').eq('id', req.params.id).single();
    if (mErr) return res.status(404).json({ error: 'Match not found.' });
    const { data: players, error: pErr } = await supabase
      .from('player_match_stats').select('*').eq('match_id', req.params.id)
      .order('rank', { ascending: true });
    if (pErr) return res.status(500).json({ error: 'Failed to load players.' });
    res.json({ match, players: players || [] });
  });

  // ── Update an existing match (metadata + replace all player rows, atomic) ──
  // save_match() is create-or-replace, so a wrong id would silently create a new
  // match — the existence check keeps PUT semantics honest (404 on unknown id).
  router.put('/match/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const { players } = req.body || {};
    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'No players to save.' });
    }

    const matchId = req.params.id;
    const { data: existing, error: chk } = await supabase
      .from('wargame_matches').select('id').eq('id', matchId).single();
    if (chk || !existing) return res.status(404).json({ error: 'Match not found.' });

    try {
      const updated = await saveMatch(matchId, req.body);
      res.json({ match_id: matchId, updated });
    } catch (err) {
      console.error('Match update error:', err.message);
      res.status(500).json({ error: 'Failed to update the match. ' + err.message });
    }
  });

  // ── Delete a match (player_match_stats rows follow via ON DELETE CASCADE) ───
  // The cascade only holds once migration 005 has run: player_match_stats used
  // to carry a second, non-cascading foreign key on match_id, which blocked
  // every delete here with a 23503. Report that case specifically rather than
  // as a bare 500 — it's a schema problem no amount of retrying will fix.
  router.delete('/match/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('wargame_matches').delete().eq('id', req.params.id);
    if (error) {
      console.error('Match delete error:', error.code, error.message, error.details || '');
      if (error.code === '23503') {
        return res.status(409).json({
          error: 'Player records still reference this match, so it can\'t be deleted. '
            + 'Migration 005 (fix match stats FK) needs to be applied.',
        });
      }
      return res.status(500).json({ error: 'Failed to delete match.', detail: error.message });
    }
    res.json({ ok: true });
  });

  // ── Attendance: voice-channel snapshots ──────────────────────────────────────
  // `configured_id` rides along so the Attendance page can name the guild's
  // default channel without calling GET /settings — which 403s for an officer
  // who holds 'attendance' but not 'settings', and that is most of them.
  router.get('/voice-channels', (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'Discord gateway not available.' });
    res.json({
      channels: gateway.listVoiceChannels(),
      configured_id: guildConfig.get().attendance_voice_channel_id || null,
    });
  });

  router.get('/voice-channels/:id/members', async (req, res) => {
    if (!gateway) return res.status(503).json({ error: 'Discord gateway not available.' });
    const members = gateway.getVoiceMembers(req.params.id);
    // Prefer the guild's mapped display name (player_identities) over whatever
    // nickname/username Discord happens to show, same as /api/admin/members.
    if (supabase && members.length > 0) {
      const ids = await identities.load();
      members.forEach((m) => { m.name = ids.displayNameFor(m.id, m.name); });
    }
    res.json({ members });
  });

  router.get('/events', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { days, since } = attendanceWindow(req);

    let q = supabase.from('events').select('id, title, event_date, created_at')
      .order('event_date', { ascending: false });
    if (since) q = q.gte('event_date', since);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: 'Failed to load events.' });

    const eventIds = (data || []).map((e) => e.id);
    const countMap = {};
    const withParty = new Set();
    if (eventIds.length > 0) {
      // Two queries rather than selecting party_layout in the list: the layout
      // is a whole roster of jsonb per row, and the list only needs to know
      // whether there is one. An id-only query costs nothing; shipping thirty
      // party layouts to render thirty badges is not free.
      const [{ data: att }, { data: parties }] = await Promise.all([
        supabase.from('event_attendance').select('event_id').in('event_id', eventIds),
        supabase.from('events').select('id').in('id', eventIds).not('party_layout', 'is', null),
      ]);
      (att || []).forEach((a) => { countMap[a.event_id] = (countMap[a.event_id] || 0) + 1; });
      (parties || []).forEach((p) => withParty.add(String(p.id)));
    }

    res.json({
      window: days,
      events: (data || []).map((e) => ({
        ...e,
        attendees: countMap[e.id] || 0,
        has_party: withParty.has(String(e.id)),
      })),
    });
  });

  // The whole night, assembled by eventDetail — the same call the member-facing
  // GET /api/attendance/events/:id makes, with `officer: true` widening what
  // comes back rather than changing what is computed.
  //
  // This used to be ~120 lines of inline reconciliation right here, joining the
  // attendance snapshot against LOA and signups by hand. It grew a fourth
  // source (late requests) and a second consumer (the member page) at the same
  // time, and two hand-written copies of a four-way join do not stay in
  // agreement.
  router.get('/events/:id', async (req, res) => {
    if (!eventDetail) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const out = await eventDetail.detail(req.params.id, { viewerId: req.user.id, officer: true });
      res.json(out);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to load that event.' });
    }
  });

  // ── Attendance: adding and removing people after the fact ───────────────────
  // Bulk, because the realistic case is "the snapshot missed the four people who
  // were in the overflow channel", and four separate confirmations for one
  // mistake is how officers stop bothering to fix it.
  //
  // Anyone already present is SKIPPED rather than erroring the whole call: a
  // partially-correct selection is the normal case when someone re-checks a
  // list, and refusing all of it teaches people to stop using the feature.
  router.post('/events/:id/attendees', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const members = Array.isArray(req.body?.members) ? req.body.members : [];
    if (!members.length) return res.status(400).json({ error: 'Nobody selected.' });

    const { data: event } = await supabase.from('events').select('id').eq('id', req.params.id).maybeSingle();
    if (!event) return res.status(404).json({ error: 'Event not found.' });

    const { data: existing } = await supabase.from('event_attendance')
      .select('discord_id').eq('event_id', req.params.id);
    const present = new Set((existing || []).map((a) => String(a.discord_id)));

    const ids = await identities.load().catch(() => null);
    const now = new Date().toISOString();
    const rows = members
      .filter((m) => m && m.id && !present.has(String(m.id)))
      .map((m) => ({
        id: crypto.randomUUID(),
        event_id: req.params.id,
        discord_id: String(m.id),
        display_name: String((ids ? ids.displayNameFor(m.id, m.name) : m.name) || '').slice(0, 120),
        joined_at: now,
        // Not a snapshot. Everything added here arrived after the photograph
        // was taken, which is exactly what this column is for.
        source: 'late',
      }));

    if (!rows.length) return res.json({ added: 0, skipped: members.length });
    const { error } = await supabase.from('event_attendance').insert(rows);
    if (error) {
      console.error('Add attendees error:', error.message);
      return res.status(500).json({ error: 'Failed to add those attendees.' });
    }
    res.json({ added: rows.length, skipped: members.length - rows.length });
  });

  router.delete('/events/:id/attendees/:discordId', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    // Scoped by BOTH ids: an event id alone would be enough to delete the same
    // member's attendance from a different night if the params were swapped.
    const { data, error } = await supabase.from('event_attendance')
      .delete().eq('event_id', req.params.id).eq('discord_id', String(req.params.discordId))
      .select('id').maybeSingle();
    if (error) {
      console.error('Remove attendee error:', error.message);
      return res.status(500).json({ error: 'Failed to remove that attendee.' });
    }
    if (!data) return res.status(404).json({ error: 'That member is not on this event.' });
    res.json({ ok: true });
  });

  // ── Late attendance: the officer queue ──────────────────────────────────────
  // Covered by the existing { prefix: '/attendance', permission: 'attendance' }
  // rule. Deliberately NOT a new permission key: a new key starts granted to
  // nobody, which would lock every granular attendance officer out of a feature
  // they already run, while leaving blanket admins untouched.
  router.get('/attendance/late-requests', async (req, res) => {
    if (!lateAttendance) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const requests = await lateAttendance.list({
        status: req.query.status || 'pending',
        eventId: req.query.event || null,
      });
      res.json({ requests, window_hours: lateAttendance.WINDOW_HOURS });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to load late requests.' });
    }
  });

  router.patch('/attendance/late-requests/:id', async (req, res) => {
    if (!lateAttendance) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const decided = await lateAttendance.decide(
        req.params.id,
        req.body?.status,
        { id: req.user.id, name: req.user.username },
      );
      res.json({ request: decided });

      // After responding, unawaited: a DM that is slow or fails must not delay
      // or undo a decision that is already written. A denial is private, so
      // this is a DM rather than a channel post.
      if (gateway) gateway.notifyLateAttendance(decided).catch(() => {});
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to record that decision.' });
    }
  });

  router.post('/events', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { title, event_date, event_schedule_id, attendees, roster_id } = req.body || {};

    let result;
    try {
      result = await attendance.createEvent({
        title, eventDate: event_date, eventScheduleId: event_schedule_id, attendees,
        // Three-way, and `undefined` is the meaningful default: omitting the
        // field auto-matches the roster saved for this night, while an explicit
        // null records "there was no party". `roster_id ?? undefined` would
        // collapse those two — see freezeParty in attendance.js.
        rosterId: Object.prototype.hasOwnProperty.call(req.body || {}, 'roster_id') ? roster_id : undefined,
      });
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Failed to create event.' });
    }

    res.json(result);

    // Best-effort — DMs go out after responding so a slow/failed Discord send
    // can't delay or break the save itself.
    if (gateway) gateway.notifyAttendance(attendees, title, event_date).catch(() => {});
  });

  // One-time (re-runnable) fix for attendance rows saved before snapshots resolved
  // display names against player_identities — updates any that now have a mapping.
  router.post('/attendance/backfill-names', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const ids = await identities.load();

    // Every attendance row ever, unfiltered — one per member per night, so it
    // passes 1,000 within a few dozen events. Truncated, "Fix past names"
    // silently repaired only the newest slice and reported success, which is
    // the worst possible shape for a repair tool.
    let rows;
    try {
      rows = await fetchAll(
        () => supabase.from('event_attendance').select('id, discord_id, display_name').order('id'),
        { label: 'event_attendance' },
      );
    } catch (err) {
      console.error('attendance backfill load error:', err.message);
      return res.status(500).json({ error: 'Failed to load attendance records.' });
    }

    const toFix = (rows || []).filter((r) => {
      const mapped = ids.displayNameFor(r.discord_id);
      return mapped && mapped !== r.display_name;
    });
    const results = await Promise.all(toFix.map((r) =>
      supabase.from('event_attendance').update({ display_name: ids.displayNameFor(r.discord_id) }).eq('id', r.id)
    ));
    const failed = results.filter((r) => r.error).length;
    if (failed > 0) console.error(`Attendance backfill: ${failed} row(s) failed to update.`);

    res.json({ checked: (rows || []).length, updated: toFix.length - failed });
  });

  router.get('/attendance-stats', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const { days, since } = attendanceWindow(req);

      let eq = supabase.from('events').select('id');
      if (since) eq = eq.gte('event_date', since);
      const { data: evts, error: eErr } = await eq;
      if (eErr) throw eErr;
      const totalEvents = (evts || []).length;
      if (totalEvents === 0) return res.json({ window: days, totalEvents: 0, members: [] });

      // The window has to narrow BOTH halves. Filtering only the denominator
      // leaves attendance rows from outside it counting against a smaller total
      // — which produces rates over 100% and, worse, plausible-looking ones
      // like 95% for someone who came twice.
      // Bounded by the window on paper, but the window can be "all" — and even
      // 30 days of a busy guild is events × attendees. This is the numerator of
      // every attendance percentage on the page, so truncating it doesn't
      // produce an obvious blank, it produces plausible rates that are simply
      // too low for whoever sorts last.
      const eventIdsForAtt = (evts || []).map((e) => e.id);
      const att = eventIdsForAtt.length === 0 ? [] : await fetchAll(
        () => supabase.from('event_attendance').select('discord_id, display_name')
          .in('event_id', eventIdsForAtt).order('id'),
        { label: 'event_attendance' },
      );

      const map = {};
      (att || []).forEach((a) => {
        if (!map[a.discord_id]) map[a.discord_id] = { discord_id: a.discord_id, display_name: a.display_name, attended: 0 };
        map[a.discord_id].attended++;
        if (a.display_name) map[a.discord_id].display_name = a.display_name;
      });

      const members = Object.values(map)
        .map((m) => ({ ...m, rate: Math.round((m.attended / totalEvents) * 100) }))
        .sort((a, b) => b.rate - a.rate || a.display_name.localeCompare(b.display_name));

      res.json({ window: days, totalEvents, members });
    } catch (err) {
      console.error('Attendance stats error:', err.message);
      res.status(500).json({ error: 'Failed to compute attendance stats.' });
    }
  });

  router.delete('/events/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    await supabase.from('event_attendance').delete().eq('event_id', req.params.id);
    const { error } = await supabase.from('events').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete event.' });
    res.json({ ok: true });
  });

  // ── Event signups ────────────────────────────────────────────────────────────
  // Officer side: open a signup for a night, cap it, close it, and add or remove
  // people by hand. Members join through /api/signups or the Discord buttons.
  router.get('/signups', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      res.json({ signups: await signups.list({ includeClosed: true, from: req.query.from || null }) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // The party builder's feed. Note this path takes the 'parties' capability
  // rather than 'attendance' (see permissions.js) — a parties officer has to be
  // able to read it to seed a roster.
  router.get('/signups/by-occasion', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      res.json(await signups.signedUpFor({
        eventDate: req.query.date || todayInGuildTz(),
        eventScheduleId: req.query.event || null,
      }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.get('/signups/:id', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      // The roster is what turns "nobody else responded" into a named list, so
      // it's fetched here rather than inside the module. Best-effort: Discord
      // being down shouldn't cost the officer the signup list itself.
      const roster = await listMembers().catch(() => null);
      res.json(await signups.detail(req.params.id, { includeReasons: true, roster }));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/signups', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    const { event_date, event_schedule_id, title, capacity, reminder_minutes, announce } = req.body || {};
    try {
      const { row, created } = await signups.open({
        eventDate: event_date || todayInGuildTz(),
        eventScheduleId: event_schedule_id || null,
        title, capacity, reminderMinutes: reminder_minutes,
        createdBy: req.user?.id || null,
      });
      res.json({ signup: row, created });
      // Posted after responding and never awaited — the signup is already open,
      // and a Discord outage shouldn't make opening it look like it failed.
      // Re-announcing an existing one is the officer's explicit call, below.
      if (created && announce !== false) gateway.announceSignup(row.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.patch('/signups/:id', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    const { capacity, status, reminder_minutes } = req.body || {};
    try {
      let promoted = [];
      if (capacity !== undefined) promoted = await signups.setCapacity(req.params.id, capacity);
      if (reminder_minutes !== undefined) await signups.setReminderMinutes(req.params.id, reminder_minutes);
      if (status !== undefined) await signups.setStatus(req.params.id, status);
      res.json({ ok: true, promoted });
      gateway.refreshSignupMessage(req.params.id);
      // Raising the cap can move several people at once; each gets told.
      promoted.forEach((m) => gateway.notifySignupPromotion(m, req.params.id));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.delete('/signups/:id', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const row = await signups.remove(req.params.id);
      res.json({ ok: true });
      gateway.deleteSignupMessage(row);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // (Re)post the announcement. The recovery path for a message someone deleted
  // by hand — without it the signup would still be live with nowhere to click.
  router.post('/signups/:id/announce', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      await signups.get(req.params.id);
      res.json({ ok: true });
      gateway.announceSignup(req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/signups/:id/remind', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      await signups.get(req.params.id);
      res.json({ ok: true });
      // Goes through the same claim as the timed sweep, so firing this while a
      // scheduled reminder is going out can't double-DM anyone.
      gateway.sendSignupReminder(req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Sign someone up on their behalf — the resolveTarget pattern, website side.
  router.post('/signups/:id/entries', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    const { discord_id, display_name } = req.body || {};
    if (!discord_id) return res.status(400).json({ error: 'Member id required.' });
    try {
      const result = await signups.join({
        id: req.params.id, discordId: discord_id, displayName: display_name,
        addedBy: req.user?.id || null,
      });
      res.json(result);
      gateway.refreshSignupMessage(req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Remove someone — the answer to a member who left the guild still holding a
  // slot, which nothing else can free.
  router.delete('/signups/:id/entries/:discordId', async (req, res) => {
    if (!signups) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const result = await signups.withdraw({ id: req.params.id, discordId: req.params.discordId });
      res.json(result);
      gateway.refreshSignupMessage(req.params.id);
      if (result.promoted) gateway.notifySignupPromotion(result.promoted, req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── Event schedule management ────────────────────────────────────────────────
  router.post('/event-schedule', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, day_of_week, event_time } = req.body || {};
    if (!name || day_of_week === undefined) return res.status(400).json({ error: 'Name and day of week required.' });
    const dow = parseInt(day_of_week, 10);
    if (!Number.isFinite(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'Day must be 0 (Sun) – 6 (Sat).' });
    const id = crypto.randomUUID();
    const row = { id, name: String(name).slice(0, 120), day_of_week: dow };
    if (event_time) row.event_time = String(event_time).slice(0, 5);
    const { error } = await supabase.from('event_schedule').insert(row);
    if (error) return res.status(500).json({ error: 'Failed to create event.' });
    res.json({ id });
  });

  router.put('/event-schedule/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name, day_of_week, event_time } = req.body || {};
    const update = {};
    if (name !== undefined) update.name = String(name).slice(0, 120);
    if (day_of_week !== undefined) {
      const dow = parseInt(day_of_week, 10);
      if (!Number.isFinite(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'Day must be 0 (Sun) – 6 (Sat).' });
      update.day_of_week = dow;
    }
    if (event_time !== undefined) update.event_time = event_time ? String(event_time).slice(0, 5) : null;
    const { error } = await supabase.from('event_schedule').update(update).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to update event.' });
    res.json({ ok: true });
  });

  router.delete('/event-schedule/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('event_schedule').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete event.' });
    res.json({ ok: true });
  });

  // ── Wargame map management ───────────────────────────────────────────────────
  router.post('/maps', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Map name required.' });
    const { data, error } = await supabase.from('wargame_maps')
      .insert({ name: name.trim().slice(0, 60) }).select('id, name').single();
    if (error) return res.status(409).json({ error: 'That map already exists.' });
    res.json(data);
  });

  router.delete('/maps/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('wargame_maps').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete map.' });
    res.json({ ok: true });
  });

  // ── Permissions: capabilities granted to Discord roles and to individuals ───
  // Gated on the 'permissions' capability itself. There's no lockout risk: a role
  // in DISCORD_ADMIN_ROLE_IDS always holds every capability and can't be edited
  // from here, so someone can always get back in even if every grant is deleted.
  router.get('/permissions', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    // Roles and members come from Discord so the grid can show live names, but a
    // grant whose subject has since been deleted or has left still has to be
    // visible to be removable — hence the stored label as a fallback.
    const [grants, roles, members] = await Promise.all([
      supabase.from('permission_grants').select('*').order('granted_at', { ascending: false })
        .then((r) => r.data || []),
      listRoles().catch((err) => { console.error('listRoles failed:', err.message); return []; }),
      listMembers().catch(() => []),
    ]);
    const roleIds = new Set(roles.map((r) => r.id));
    const memberIds = new Set(members.map((m) => m.id));
    res.json({
      catalog: perms.ALL_PERMISSIONS,
      roles,
      grants: grants.map((g) => ({
        ...g,
        stale: g.subject_type === 'role' ? !roleIds.has(g.subject_id) : !memberIds.has(g.subject_id),
      })),
    });
  });

  router.post('/permissions', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { subject_type, subject_id, subject_label, permission } = req.body || {};
    if (subject_type !== 'role' && subject_type !== 'user') return res.status(400).json({ error: 'Subject must be a role or a member.' });
    if (!subject_id) return res.status(400).json({ error: 'Subject is required.' });
    if (!perms.PERMISSION_KEYS.has(permission)) return res.status(400).json({ error: 'Unknown permission.' });

    const { error } = await supabase.from('permission_grants').upsert({
      subject_type, subject_id: String(subject_id),
      subject_label: (subject_label || '').slice(0, 120) || null,
      permission,
      granted_by: req.user.username || req.user.id,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'subject_type,subject_id,permission' });
    if (error) return res.status(500).json({ error: 'Failed to grant permission.' });
    perms.invalidate();
    res.json({ ok: true });
  });

  router.delete('/permissions', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { subject_type, subject_id, permission } = req.body || {};
    if (!subject_type || !subject_id || !permission) return res.status(400).json({ error: 'Subject and permission are required.' });
    const { error } = await supabase.from('permission_grants').delete()
      .eq('subject_type', subject_type).eq('subject_id', String(subject_id)).eq('permission', permission);
    if (error) return res.status(500).json({ error: 'Failed to revoke permission.' });
    perms.invalidate();
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

  // ── LOA: who's out on a given date/event (for the party builder) ────────────
  // The window and reason come back too, not just the fact of the absence — the
  // builder needs them to tell "gone all night" from "out 7-8, back after",
  // which are different planning problems. Safe to include reason because the
  // whole /api/admin router is admin-gated, the same condition under which
  // loa.all() exposes it.
  router.get('/loa/unavailable', async (req, res) => {
    if (!loa) return res.status(503).json({ error: 'Database not configured.' });
    const date = req.query.date || todayInGuildTz();
    try {
      const unavailable = await loa.unavailableOn({ date, eventScheduleId: req.query.event || null });
      res.json({ date, unavailable });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to load LOAs.' });
    }
  });

  return router;
};
