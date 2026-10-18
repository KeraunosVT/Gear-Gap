// backend/memberTenure.js — when each member got the Guild Member role.
//
// An attendance rate measured against nights from before someone joined says
// nothing about them: a member three weeks in looks 30% present on a 30-day
// window and worse on "all". Every rate in the app reads its denominator
// through countsFor() below, so "eligible" means one thing everywhere.
//
// ── WHERE THE DATE COMES FROM ───────────────────────────────────────────────
// Discord keeps no "role granted on" date. So this records one itself: an
// hourly sweep compares the member-role list with member_tenure, and the first
// sweep to see someone stamps them. That is accurate to within one sweep, which
// for nightly events is exact.
//
// For anyone the table doesn't know yet — everyone, on the first run — the
// stamp is backfilled, best source first:
//   1. audit_log    the role grant in the server audit log (kept 45 days, and
//                   only readable with View Audit Log)
//   2. discord_join when they joined the server — earlier than the role for
//                   anyone who sat in Discord before being let in, so it errs
//                   toward counting nights against them, never toward hiding
//                   them
//   3. sweep        now, when Discord has neither
//
// ── LEAVING AND COMING BACK ─────────────────────────────────────────────────
// Losing the role stamps left_at; regaining it starts a new stretch from the
// new grant. Nights between the two don't count — they weren't a member. Two
// guards on left_at, the same pair departedRequests.js uses and for the same
// reason (a mistaken stamp quietly resets someone's record):
//   · Grace: missing on two sweeps in a row. A role pulled and re-added inside
//     the hour changes nothing.
//   · Mass guard: more than half the tracked members missing at once is a
//     mis-set member role in Guild Settings, not an exodus. Nothing is stamped.
const SWEEP_MS = 60 * 60 * 1000;
const FIRST_SWEEP_MS = 2 * 60 * 1000;
const MASS_FRACTION = 0.5;
const MASS_MIN = 3;
const BATCH = 100;

const { guildDateOf } = require('./loa');
const { fetchAll } = require('./pagedRead');

// Whether a night on `date` (YYYY-MM-DD) belongs in this member's denominator.
// No tenure row means no cutoff — the behaviour before this module, and the
// honest one when the date isn't known.
function countsFor(tenure, date) {
  if (!tenure) return true;
  const d = String(date || '');
  if (d < tenure.since) return false;
  return !tenure.until || d <= tenure.until;
}

module.exports = function createMemberTenure(supabase, listMembers = null, { fetchRoleGrants = null } = {}) {
  const missingSince = new Map(); // discord_id -> first sweep it was missing

  const readRows = () => fetchAll(
    () => supabase.from('member_tenure').select('discord_id, since, left_at').order('discord_id'),
    { label: 'member_tenure' },
  );

  // discord_id -> { since, until } as guild-night dates. Empty when the table
  // is missing (migration 028 not run) — every rate then reads as it did
  // before, which is better than taking the attendance pages down with it.
  async function load() {
    try {
      const rows = await readRows();
      return new Map(rows.map((r) => [String(r.discord_id), {
        since: guildDateOf(r.since),
        until: r.left_at ? guildDateOf(r.left_at) : null,
      }]));
    } catch (err) {
      console.error('member tenure load failed:', err.message);
      return new Map();
    }
  }

  async function sweep() {
    const members = await listMembers();
    // An empty list is a Discord or config failure, never a real answer.
    if (!members.length) return { started: [], left: [], skipped: 'empty member list' };

    const rows = await readRows();
    const byId = new Map(rows.map((r) => [String(r.discord_id), r]));
    const current = new Map(members.map((m) => [String(m.id), m]));
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // ── Arrivals: never seen, or back after leaving ──
    const arriving = [...current.values()].filter((m) => {
      const row = byId.get(String(m.id));
      return !row || row.left_at;
    });
    let grants = new Map();
    if (arriving.length && fetchRoleGrants) {
      grants = await fetchRoleGrants().catch((err) => {
        console.error('Role grant lookup failed, using fallbacks:', err.message);
        return new Map();
      });
    }
    const starts = arriving.map((m) => {
      const id = String(m.id);
      const row = byId.get(id);
      const grant = grants.get(id) || null;
      let since; let source;
      if (row) {
        // Back after leaving: only a grant after they left describes this stretch.
        const leftMs = new Date(row.left_at).getTime();
        if (grant && grant > leftMs) { since = grant; source = 'audit_log'; }
        else { since = nowMs; source = 'sweep'; }
      } else if (grant) { since = grant; source = 'audit_log'; }
      else if (m.joinedAt) { since = new Date(m.joinedAt).getTime(); source = 'discord_join'; }
      else { since = nowMs; source = 'sweep'; }
      return { discord_id: id, since: new Date(since).toISOString(), source, left_at: null, updated_at: nowIso };
    });
    for (let i = 0; i < starts.length; i += BATCH) {
      const { error } = await supabase.from('member_tenure')
        .upsert(starts.slice(i, i + BATCH), { onConflict: 'discord_id' });
      if (error) throw new Error(`member_tenure: ${error.message}`);
    }
    starts.forEach((s) => missingSince.delete(s.discord_id));

    // ── Departures ──
    const active = rows.filter((r) => !r.left_at).map((r) => String(r.discord_id));
    const missing = active.filter((id) => !current.has(id));
    for (const id of missingSince.keys()) {
      if (!missing.includes(id)) missingSince.delete(id);
    }
    const due = [];
    for (const id of missing) {
      if (missingSince.has(id)) due.push(id);
      else missingSince.set(id, nowMs);
    }
    if (due.length >= MASS_MIN && due.length > active.length * MASS_FRACTION) {
      console.warn(`Member tenure sweep: ${due.length} of ${active.length} members look like they left, `
        + 'which is more likely a wrong member role in Guild Settings than a real exodus. Nobody was marked as left.');
      return { started: starts.map((s) => s.discord_id), left: [], skipped: 'mass departure' };
    }
    for (const id of due) {
      // Stamped with the first sweep that missed them, not this one — that is
      // the closer of the two to when the role actually went.
      const { error } = await supabase.from('member_tenure')
        .update({ left_at: new Date(missingSince.get(id)).toISOString(), updated_at: nowIso })
        .eq('discord_id', id);
      if (error) throw new Error(`member_tenure: ${error.message}`);
      missingSince.delete(id);
    }

    if (starts.length || due.length) {
      console.log(`Member tenure sweep: ${starts.length} started, ${due.length} left.`);
    }
    return { started: starts.map((s) => s.discord_id), left: due };
  }

  // Never throws into the timer — a failed sweep just means the next one does
  // the work.
  const safeSweep = () => sweep().catch((err) => console.error('Member tenure sweep failed:', err.message));

  function start() {
    setTimeout(() => {
      safeSweep();
      setInterval(safeSweep, SWEEP_MS);
    }, FIRST_SWEEP_MS);
  }

  return { load, sweep, start };
};

module.exports.countsFor = countsFor;
