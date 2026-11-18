// Pure pieces of the Parties board, kept apart from the page so they can be
// tested: what a party is made of, what the pool shows, and the signature that
// says whether the board differs from what was last saved.

// The order roles are read in everywhere on the board: pips, buttons, counts.
export const ROLES = ['Tank', 'Healer', 'DPS'];
export const PARTY_SIZE = 6;

// The colour pips above a party read Tank, DPS, Healer, like the pool's boxes.
const PIP_ORDER = ['Tank', 'DPS', 'Healer'];
const pipRank = (role) => {
  const i = PIP_ORDER.indexOf(role);
  return i === -1 ? PIP_ORDER.length : i;
};

// What one party is made of.
//   pips     one entry per member, tanks first, then DPS, healers, no role (null)
//   missing  'Tank' / 'Healer' the party has nobody for. Empty parties miss
//            nothing: an unstarted party isn't a problem worth flagging.
//   seats    one entry per free seat, naming the role it should go to (the
//            missing ones first) or null, so "needs a healer" sits where the
//            healer would go
//   full     every seat taken
export function partyMakeup(ids, roles, size = PARTY_SIZE) {
  const pips = ids
    .map((id) => (ROLES.includes(roles[id]) ? roles[id] : null))
    .sort((a, b) => pipRank(a) - pipRank(b))
    .slice(0, size);
  const missing = ids.length === 0 ? [] : ['Tank', 'Healer'].filter((r) => !ids.some((id) => roles[id] === r));
  const free = Math.max(0, size - ids.length);
  const seats = Array.from({ length: free }, (_, i) => missing[i] || null);
  return { pips, missing, seats, full: ids.length >= size };
}

// The pool as shown: one box per role, plus `none` for members with no role
// in the current mode. Search and the Signed up only switch narrow every box.
// Within a box, signed up first (going, then waitlist), then by name, so the
// people expected tonight are at the top.
//   ids        pool member ids
//   nameOf     id -> display name
//   roleOf     id -> role in the current mode, or falsy
//   signupOf   id -> 'going' | 'waitlist' | undefined
export function poolView(ids, { nameOf, roleOf, signupOf, query = '', signedOnly = false }) {
  const q = query.trim().toLowerCase();
  const signRank = (id) => ({ going: 0, waitlist: 1 }[signupOf(id)] ?? 2);
  const groups = { none: [] };
  ROLES.forEach((r) => { groups[r] = []; });
  ids
    .filter((id) => (!signedOnly || signupOf(id)) && (!q || (nameOf(id) || '').toLowerCase().includes(q)))
    .sort((a, b) => (signRank(a) - signRank(b)) || (nameOf(a) || '').localeCompare(nameOf(b) || ''))
    .forEach((id) => {
      const r = roleOf(id);
      groups[ROLES.includes(r) ? r : 'none'].push(id);
    });
  return groups;
}

// The event picker's value for the occasion a saved roster is linked to: a
// one-off as `signup:<id>`, a weekly event by its schedule id, '' for the
// whole night.
export const rosterOccasionKey = (r) => (r.signup_event_id
  ? `signup:${r.signup_event_id}`
  : r.event_schedule_id || '');

// The saved roster linked to a night and event, or null. `saved` is newest
// first, so a duplicated roster beats its original. With "All events" picked
// and nothing saved for the whole night, a night with exactly one roster still
// opens it; with several there's no telling which was meant.
export function rosterForOccasion(saved, date, event) {
  if (!date) return null;
  const night = (saved || []).filter((r) => r.event_date === date);
  const exact = night.find((r) => rosterOccasionKey(r) === (event || ''));
  if (exact) return exact;
  return !event && night.length === 1 ? night[0] : null;
}

// Does loading roster `r` copy it into the picked occasion rather than open it?
// With a specific event picked, a roster saved for anything else — another
// event, another night, no occasion at all — is brought in as a new, unsaved
// roster for that event, so building from it can never overwrite it. Its own
// roster, or anything with "All events" picked, opens as itself.
export function loadsAsCopy(r, date, event) {
  if (!event || !r) return false;
  return !(r.event_date === date && rosterOccasionKey(r) === event);
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
