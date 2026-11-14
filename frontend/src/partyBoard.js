// Pure pieces of the Parties board, kept apart from the page so they can be
// tested: what a party is made of, what the pool shows, and the signature that
// says whether the board differs from what was last saved.

// The order roles are read in everywhere on the board: pips, buttons, counts.
export const ROLES = ['Tank', 'Healer', 'DPS'];
export const PARTY_SIZE = 6;

const roleRank = (role) => {
  const i = ROLES.indexOf(role);
  return i === -1 ? ROLES.length : i;
};

// What one party is made of.
//   pips     one entry per member, tanks first, then healers, DPS, no role (null)
//   missing  'Tank' / 'Healer' the party has nobody for. Empty parties miss
//            nothing: an unstarted party isn't a problem worth flagging.
//   seats    one entry per free seat, naming the role it should go to (the
//            missing ones first) or null, so "needs a healer" sits where the
//            healer would go
//   full     every seat taken
export function partyMakeup(ids, roles, size = PARTY_SIZE) {
  const pips = ids
    .map((id) => (ROLES.includes(roles[id]) ? roles[id] : null))
    .sort((a, b) => roleRank(a) - roleRank(b))
    .slice(0, size);
  const missing = ids.length === 0 ? [] : ['Tank', 'Healer'].filter((r) => !ids.some((id) => roles[id] === r));
  const free = Math.max(0, size - ids.length);
  const seats = Array.from({ length: free }, (_, i) => missing[i] || null);
  return { pips, missing, seats, full: ids.length >= size };
}

// Whether a member passes the pool's role chip. 'none' is the "No role" chip.
export const roleMatches = (role, filter) => (filter === 'all'
  ? true
  : filter === 'none' ? !ROLES.includes(role) : role === filter);

// The pool as shown: search and the Signed up only switch first, then the
// role chip. `counts` is per chip after search and the switch, so each chip
// says how many it would show. Signed up first (going, then waitlist), then
// by name, so the people expected tonight are at the top.
//   ids        pool member ids
//   nameOf     id -> display name
//   roleOf     id -> role in the current mode, or falsy
//   signupOf   id -> 'going' | 'waitlist' | undefined
export function poolView(ids, { nameOf, roleOf, signupOf, query = '', signedOnly = false, role = 'all' }) {
  const q = query.trim().toLowerCase();
  const base = ids.filter((id) => (!signedOnly || signupOf(id))
    && (!q || (nameOf(id) || '').toLowerCase().includes(q)));
  const counts = { all: base.length, none: 0 };
  ROLES.forEach((r) => { counts[r] = 0; });
  base.forEach((id) => {
    const r = roleOf(id);
    if (ROLES.includes(r)) counts[r] += 1; else counts.none += 1;
  });
  const signRank = (id) => ({ going: 0, waitlist: 1 }[signupOf(id)] ?? 2);
  const list = base
    .filter((id) => roleMatches(roleOf(id), role))
    .sort((a, b) => (signRank(a) - signRank(b)) || (nameOf(a) || '').localeCompare(nameOf(b) || ''));
  return { list, counts };
}

// Everything a saved roster records, as one comparable string. The pool is
// left out on purpose: it's whoever isn't placed, and its order means nothing.
// Roles are left out too, because they're saved per member the moment they
// change, not with the roster.
// Class picks are sorted by member so the order they were made in doesn't count.
export function boardSignature({ items, partyIds, partyNames, classAssignments, rosterName, date, event }) {
  const classes = ['pvp', 'pve'].map((mode) => Object.entries(classAssignments?.[mode] || {})
    .filter(([, cls]) => cls)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify([
    partyIds.map((pid) => [partyNames[pid] || '', items[pid] || []]),
    items.absent || [],
    classes,
    (rosterName || '').trim(),
    date || '',
    event || '',
  ]);
}
