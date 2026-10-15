// backend/departedRequests.js — clear out the loot requests and LOAs of members
// who have left the guild.
//
// "Left" means listMembers() no longer returns them, which is the member-role
// check: losing the role is leaving, whether or not they're still in the
// Discord server. Without this, someone who quits keeps their wishlist picks in
// every Loot Tally count, their open Lucent asks on Loot Requests, and their
// LOAs on the board (and in the LOA channel) forever.
//
// What goes:
//   - their loot_wishlists row (every gear pick)
//   - lucent_requests still open — pending, or approved but not yet paid
//   - every loa_entries row, plus its Discord announcement — the same cleanup
//     cancelling it by hand does
// What stays:
//   - paid and denied Lucent requests. Paid ones point at a currency_awards row
//     and are history, the same as loot_awards, which this never touches.
//
// Two ways in:
//   - sweep(), hourly, on its own. Two guards, because the deletes can't be
//     undone:
//       · Grace: someone has to be missing on two sweeps in a row. A role
//         briefly pulled and re-added shouldn't cost a member their wishlist.
//         The first sighting is in memory, so a restart just restarts the clock
//         — the safe direction, but a host that restarts or sleeps more often
//         than the interval never gets past it.
//       · Mass guard: if a sweep would clear more than half the people holding
//         requests or LOAs, it does nothing and logs instead. That's a mis-set
//         member role, not half the guild quitting in an hour — except on the
//         first run against a backlog nobody ever pruned, when it can be both.
//   - preview() and clear(ids), from Guild Settings. An officer looking at the
//     list IS the check both guards stand in for, so clear() skips them — but
//     it re-reads the member list and only removes ids that are still missing,
//     so a stale page can't clear someone who has since come back.
const SWEEP_MS = 60 * 60 * 1000;
const FIRST_SWEEP_MS = 5 * 60 * 1000;
const OPEN_STATUSES = ['pending', 'approved'];
const MASS_FRACTION = 0.5;
const MASS_MIN = 3; // a small guild losing 2 of 3 requesters is not a misconfig

// `deleteLoaMessage` is optional: without it the LOA rows still go, only their
// channel announcements are left behind.
module.exports = function createDepartedRequests(supabase, listMembers, { deleteLoaMessage = null } = {}) {
  const missingSince = new Map(); // discord_id -> first sweep it was missing

  // Everything this module can clear, row by row, with the names on the rows —
  // the preview needs to say who someone was after Discord has forgotten them.
  async function holdings() {
    const [wl, lr, loa] = await Promise.all([
      supabase.from('loot_wishlists').select('discord_id, display_name'),
      supabase.from('lucent_requests').select('discord_id, display_name').in('status', OPEN_STATUSES),
      supabase.from('loa_entries').select('discord_id, display_name'),
    ]);
    if (wl.error) throw new Error(`loot_wishlists: ${wl.error.message}`);
    if (lr.error) throw new Error(`lucent_requests: ${lr.error.message}`);
    if (loa.error) throw new Error(`loa_entries: ${loa.error.message}`);
    return { wishlists: wl.data || [], lucent: lr.data || [], loas: loa.data || [] };
  }

  const holderIds = (h) => new Set([...h.wishlists, ...h.lucent, ...h.loas].map((r) => String(r.discord_id)));

  // An empty list is a Discord or config failure, never a real answer.
  async function currentIds() {
    const members = await listMembers();
    return members.length ? new Set(members.map((m) => String(m.id))) : null;
  }

  // Batched because every id goes into the request URL as an in-list; a long
  // backlog in one go can outgrow what PostgREST will accept.
  const BATCH = 100;

  // Deletes the rows, then the LOA channel posts. `waitForPosts` is false for
  // the officer-run clear: a backlog can mean dozens of posts, deleted one at a
  // time and rate-limited by Discord, which can outlast the host's request
  // timeout — the officer then gets a bare gateway error for a clear that
  // actually worked. The posts are best-effort either way, so there they finish
  // in the background after the reply.
  async function remove(ids, { waitForPosts = true } = {}) {
    const messageIds = [];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      // The announcement ids have to be read before the rows that hold them go.
      const loaRows = await supabase.from('loa_entries').select('discord_message_id').in('discord_id', batch);
      if (loaRows.error) throw new Error(`loa_entries: ${loaRows.error.message}`);
      (loaRows.data || []).forEach((r) => { if (r.discord_message_id) messageIds.push(r.discord_message_id); });

      const [wl, lr, loa] = await Promise.all([
        supabase.from('loot_wishlists').delete().in('discord_id', batch),
        supabase.from('lucent_requests').delete().in('discord_id', batch).in('status', OPEN_STATUSES),
        supabase.from('loa_entries').delete().in('discord_id', batch),
      ]);
      if (wl.error) throw new Error(`loot_wishlists: ${wl.error.message}`);
      if (lr.error) throw new Error(`lucent_requests: ${lr.error.message}`);
      if (loa.error) throw new Error(`loa_entries: ${loa.error.message}`);
    }
    ids.forEach((id) => missingSince.delete(id));

    // After the delete — the same order cancel uses. A message that won't
    // delete is logged by deleteLoaMessage and costs nothing else.
    if (deleteLoaMessage && messageIds.length) {
      const posts = (async () => {
        for (const messageId of messageIds) await deleteLoaMessage(messageId);
      })().catch((err) => console.error('Former-member LOA post cleanup failed:', err.message));
      if (waitForPosts) await posts;
    }
    return { posts: messageIds.length };
  }

  async function sweep() {
    const current = await currentIds();
    if (!current) return { removed: [], skipped: 'empty member list' };

    const holders = holderIds(await holdings());
    const missing = [...holders].filter((id) => !current.has(id));

    // Anyone back in the guild (or with nothing left to clear) starts over.
    for (const id of missingSince.keys()) {
      if (!missing.includes(id)) missingSince.delete(id);
    }
    const now = Date.now();
    const due = [];
    for (const id of missing) {
      if (missingSince.has(id)) due.push(id);
      else missingSince.set(id, now);
    }
    if (!due.length) return { removed: [] };

    if (due.length >= MASS_MIN && due.length > holders.size * MASS_FRACTION) {
      console.warn(`Departed-request sweep skipped: ${due.length} of ${holders.size} requesters `
        + 'look departed, which is more likely a wrong member role in Guild Settings than a real exodus. '
        + 'If they really have left, review and clear them under Guild Settings → Former members.');
      return { removed: [], skipped: 'mass removal' };
    }

    await remove(due);
    console.log(`Departed-request sweep: cleared loot requests and LOAs for ${due.length} former member(s): ${due.join(', ')}`);
    return { removed: due };
  }

  // Who would be cleared right now, and what of theirs. No grace, no mass
  // guard — this only reads; the officer decides.
  async function preview() {
    const current = await currentIds();
    if (!current) throw Object.assign(new Error('The Discord member list came back empty, so nobody can be judged departed right now.'), { status: 503 });
    const h = await holdings();
    const byId = new Map();
    const touch = (r) => {
      const id = String(r.discord_id);
      if (current.has(id)) return null;
      if (!byId.has(id)) byId.set(id, { discord_id: id, display_name: null, wishlist: false, lucent: 0, loas: 0 });
      const p = byId.get(id);
      if (!p.display_name && r.display_name) p.display_name = r.display_name;
      return p;
    };
    h.wishlists.forEach((r) => { const p = touch(r); if (p) p.wishlist = true; });
    h.lucent.forEach((r) => { const p = touch(r); if (p) p.lucent += 1; });
    h.loas.forEach((r) => { const p = touch(r); if (p) p.loas += 1; });
    const people = [...byId.values()].sort((a, b) => String(a.display_name || a.discord_id).localeCompare(String(b.display_name || b.discord_id)));
    return { people, holders: holderIds(h).size };
  }

  async function clear(ids) {
    const wanted = new Set((ids || []).map(String));
    if (!wanted.size) return { removed: [] };
    const current = await currentIds();
    if (!current) throw Object.assign(new Error('The Discord member list came back empty — nothing was cleared.'), { status: 503 });
    const due = [...wanted].filter((id) => !current.has(id));
    if (!due.length) return { removed: [], kept: [...wanted] };
    const { posts } = await remove(due, { waitForPosts: false });
    console.log(`Former-member cleanup (manual): cleared loot requests and LOAs for ${due.length}: ${due.join(', ')}`);
    return { removed: due, kept: [...wanted].filter((id) => current.has(id)), posts };
  }

  // Never throws into the timer — this app has no unhandledRejection handler,
  // and a failed sweep just means the next one does the work.
  const safeSweep = () => sweep().catch((err) => console.error('Departed-request sweep failed:', err.message));

  function start() {
    setTimeout(() => {
      safeSweep();
      setInterval(safeSweep, SWEEP_MS);
    }, FIRST_SWEEP_MS);
  }

  return { sweep, preview, clear, start };
};
