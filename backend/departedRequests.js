// backend/departedRequests.js — clear out the loot requests of members who
// have left the guild.
//
// "Left" means listMembers() no longer returns them, which is the member-role
// check: losing the role is leaving, whether or not they're still in the
// Discord server. Without this, someone who quits keeps their wishlist picks in
// every Loot Tally count and their open Lucent asks on Loot Requests forever.
//
// What goes:
//   - their loot_wishlists row (every gear pick)
//   - lucent_requests still open — pending, or approved but not yet paid
// What stays:
//   - paid and denied Lucent requests. Paid ones point at a currency_awards row
//     and are history, the same as loot_awards, which this never touches.
//
// Two guards, because the deletes can't be undone:
//   - Grace: someone has to be missing on two sweeps in a row. A role briefly
//     pulled and re-added (or swapped during a reshuffle) shouldn't cost a
//     member their wishlist. The first sighting is in memory, so a restart just
//     restarts the clock — the safe direction.
//   - Mass guard: if a sweep would clear more than half the people holding
//     requests, it does nothing and logs instead. That's a mis-set member role
//     in Guild Settings, not half the guild quitting in an hour.
const SWEEP_MS = 60 * 60 * 1000;
const FIRST_SWEEP_MS = 5 * 60 * 1000;
const OPEN_STATUSES = ['pending', 'approved'];
const MASS_FRACTION = 0.5;
const MASS_MIN = 3; // a small guild losing 2 of 3 requesters is not a misconfig

module.exports = function createDepartedRequests(supabase, listMembers) {
  const missingSince = new Map(); // discord_id -> first sweep it was missing

  async function requestHolders() {
    const [wl, lr] = await Promise.all([
      supabase.from('loot_wishlists').select('discord_id'),
      supabase.from('lucent_requests').select('discord_id').in('status', OPEN_STATUSES),
    ]);
    if (wl.error) throw new Error(`loot_wishlists: ${wl.error.message}`);
    if (lr.error) throw new Error(`lucent_requests: ${lr.error.message}`);
    return new Set([...(wl.data || []), ...(lr.data || [])].map((r) => r.discord_id));
  }

  async function sweep() {
    const members = await listMembers();
    // An empty list is a Discord or config failure, never a real answer.
    if (!members.length) return { removed: [], skipped: 'empty member list' };
    const current = new Set(members.map((m) => m.id));

    const holders = await requestHolders();
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
        + 'look departed, which is more likely a wrong member role in Guild Settings than a real exodus.');
      return { removed: [], skipped: 'mass removal' };
    }

    const [wl, lr] = await Promise.all([
      supabase.from('loot_wishlists').delete().in('discord_id', due),
      supabase.from('lucent_requests').delete().in('discord_id', due).in('status', OPEN_STATUSES),
    ]);
    if (wl.error) throw new Error(`loot_wishlists: ${wl.error.message}`);
    if (lr.error) throw new Error(`lucent_requests: ${lr.error.message}`);

    due.forEach((id) => missingSince.delete(id));
    console.log(`Departed-request sweep: cleared loot requests for ${due.length} former member(s): ${due.join(', ')}`);
    return { removed: due };
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

  return { sweep, start };
};
