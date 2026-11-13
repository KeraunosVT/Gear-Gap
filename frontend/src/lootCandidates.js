import { buildIndex } from './lootBuilds.js';

// The people who want one item, in the order the council reads them, with
// what it weighs when choosing: attendance and items received over the
// fairness window (the same numbers as Who's Owed), and their last award.
//
// Grouped by build first, PvP → Second Build → PvE, as the tally always has
// been. Within a build: best attendance, then fewest items, then whoever
// wished for it first. Members with no stats (the fairness read failed, or
// they've no tenure yet) sort after those with stats rather than in front.
//
// `mostOwed` marks the top row only when it's an actual comparison: stats are
// there and at least two people want the item for that same build. It's a
// hint for the officer. Nothing is hidden or blocked by it.
//
//   watchers    [{ discord_id, name, priority, added_at }]
//   statsById   Map discord_id -> { rate, attended, eligible, items }, or null
//   lastAwardById  Map discord_id -> ISO timestamp of their latest award
export function rankCandidates(watchers, statsById, lastAwardById = new Map()) {
  const rows = watchers.map((w) => {
    const st = statsById ? statsById.get(w.discord_id) : null;
    return {
      ...w,
      rate: st?.rate ?? null,
      attended: st?.attended ?? null,
      eligible: st?.eligible ?? null,
      items: st ? st.items || 0 : null,
      lastAward: lastAwardById.get(w.discord_id) || null,
      mostOwed: false,
    };
  });

  const known = (v, missing) => (v == null ? missing : v);
  rows.sort((a, b) => (buildIndex(a.priority) - buildIndex(b.priority))
    || (known(b.rate, -1) - known(a.rate, -1))
    || (known(a.items, Number.MAX_SAFE_INTEGER) - known(b.items, Number.MAX_SAFE_INTEGER))
    // ISO strings sort by time; a missing date goes last.
    || String(a.added_at || '~').localeCompare(String(b.added_at || '~'))
    || String(a.name || '').localeCompare(String(b.name || '')));

  const top = rows[0];
  if (top && top.rate != null && rows.filter((r) => r.priority === top.priority).length >= 2) {
    top.mostOwed = true;
  }
  return rows;
}

// Each member's most recent award, from the awards list (any order).
export function lastAwardMap(awards) {
  const m = new Map();
  awards.forEach((a) => {
    const prev = m.get(a.discord_id);
    if (!prev || String(a.awarded_at) > String(prev)) m.set(a.discord_id, a.awarded_at);
  });
  return m;
}
