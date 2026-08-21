// backend/pagedRead.js — read every row a query matches, not the first 1,000.
//
// PostgREST caps an unbounded select at `max-rows` (1,000 by default) and
// returns the truncated set with no error and no flag. Any read of a table that
// grows without bound therefore starts silently wrong on the day it crosses
// that line — and the tables it bit here are the ones whose wrongness is least
// visible: absences that stop counting, awards that stop being recognised,
// attendance rates computed from a partial numerator.
//
// ── WHY NOT `data.length < pageSize` ────────────────────────────────────────
// The obvious loop stops when a page comes back short. That is correct only
// while `pageSize` is not greater than the server's own cap. Ask for 1,000 from
// a project configured with max-rows 500 and the first page returns 500, the
// loop reads it as "the end", and the fix truncates exactly like the bug it
// replaced — with the extra charm of looking paginated.
//
// So this advances by however many rows actually came back and stops only on an
// EMPTY page. That costs one extra round trip at the end and is right for any
// server cap, including one changed later by someone who never reads this file.
//
// ── THE QUERY MUST HAVE A UNIQUE TIEBREAKER ─────────────────────────────────
// Range pagination over an ordering with ties is not stable: rows with equal
// sort keys may land on either side of a page boundary between two requests, so
// a row can be skipped or read twice. Order by something unique, or add `id` as
// a final tiebreaker — the shape `entriesFor` in eventSignups.js already uses.
// Ordering only in JS afterwards does NOT fix this; the damage happens between
// the requests.

const DEFAULT_PAGE_SIZE = 1000;

// A read that has paged this far is not a read any more, it is an accident —
// a missing filter, or a table nothing is pruning. Failing loudly beats
// spending the request's memory and the user's patience finding out.
const MAX_ROWS = 200_000;

/**
 * @param {() => object} buildQuery  Returns a FRESH PostgREST builder each call.
 *   It must be a factory: builders are single-use, so reusing one would apply
 *   `.range()` to an already-executed query.
 * @param {{ pageSize?: number, label?: string }} [opts]  `label` names the read
 *   in the runaway error, so the message says which one to go and look at.
 */
async function fetchAll(buildQuery, { pageSize = DEFAULT_PAGE_SIZE, label = 'rows' } = {}) {
  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;

    const batch = data || [];
    out.push(...batch);
    if (batch.length === 0) return out;

    from += batch.length;
    if (out.length > MAX_ROWS) {
      throw new Error(
        `Refusing to page past ${MAX_ROWS.toLocaleString()} ${label} — this read is almost certainly missing a filter.`,
      );
    }
  }
}

module.exports = { fetchAll, DEFAULT_PAGE_SIZE, MAX_ROWS };
