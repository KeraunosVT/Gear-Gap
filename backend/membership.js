// backend/membership.js — who holds the Guild Member role now, who has left,
// and who held it on a given night.
//
// Everything here is read from member_tenure, the table memberTenure.js's
// hourly sweep keeps, plus the live Discord list for the current roster. It
// writes nothing.
//
// ── WHAT THE TABLE CAN AND CAN'T ANSWER ─────────────────────────────────────
// One row per person: their latest stretch with the role. Someone who left and
// came back has only the stretch since they returned, so "who was in on <date>"
// misses them for any night in an earlier stretch. And nobody is known from
// before the sweep first ran. The page says both; this file just reads the rows
// the way countsFor() does, so a member counted on a night here is the same
// member attendance counts that night.
const { guildDateOf } = require('./loa');
const { fetchAll } = require('./pagedRead');
const { countsFor } = require('./memberTenure');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A tenure row as the page reads it: guild-night dates, not instants, and a
// name. The alias set on the Names page wins; the Discord username the sweep
// last saw is the fallback, since a former member isn't in the live list to
// read a display name from.
function entryOf(row, nameFor) {
  const id = String(row.discord_id);
  return {
    discord_id: id,
    name: nameFor(id, row.discord_username) || row.discord_username || 'Unknown member',
    username: row.discord_username || null,
    since: guildDateOf(row.since),
    until: row.left_at ? guildDateOf(row.left_at) : null,
    source: row.source || null,
  };
}

const byName = (a, b) => a.name.localeCompare(b.name);

// `members` is the live Discord list, or null when Discord couldn't be read.
// `rows` are member_tenure rows. `nameFor(id, fallback)` is identities'
// displayNameFor.
function assemble(members, rows, nameFor) {
  const entries = rows.map((r) => entryOf(r, nameFor));
  const byId = new Map(entries.map((e) => [e.discord_id, e]));

  let active;
  if (members) {
    // The live list is the roster. A tenure row only supplies the join date,
    // and only while it describes a stretch that's still open — a row that
    // says they left, for someone back in the list, is a return the sweep
    // hasn't stamped yet, so there's no honest start date for it.
    active = members.map((m) => {
      const id = String(m.id);
      const e = byId.get(id);
      const open = e && !e.until;
      return {
        discord_id: id,
        name: nameFor(id, m.name) || m.name,
        username: m.username || e?.username || null,
        since: open ? e.since : null,
        until: null,
        source: open ? e.source : null,
      };
    });
  } else {
    active = entries.filter((e) => !e.until);
  }

  const current = new Set(active.map((m) => m.discord_id));
  // Someone back in the live list isn't a former member, whatever their row
  // still says.
  const past = entries
    .filter((e) => e.until && !current.has(e.discord_id))
    .sort((a, b) => b.until.localeCompare(a.until) || byName(a, b));

  return { active: active.sort(byName), past, entries };
}

// Who held the role on `date` (a guild night, YYYY-MM-DD), by the same rule
// attendance uses for its denominators.
function membersOn(entries, date) {
  return entries
    .filter((e) => countsFor({ since: e.since, until: e.until }, date))
    .sort(byName);
}

module.exports = function createMembership(supabase, listMembers, identities) {
  async function read({ on = null } = {}) {
    const [rows, ids, members] = await Promise.all([
      fetchAll(
        () => supabase.from('member_tenure')
          .select('discord_id, since, source, left_at, discord_username').order('discord_id'),
        { label: 'member_tenure' },
      ),
      identities.load(),
      // Past members and the date view don't need Discord, so a Discord outage
      // shouldn't take them down. The roster falls back to the open rows.
      listMembers().catch((err) => {
        console.error('Membership: member list unavailable:', err.response?.data?.message || err.message);
        return null;
      }),
    ]);
    const { active, past, entries } = assemble(members, rows, ids.displayNameFor);
    return {
      active,
      past,
      on: on ? { date: on, members: membersOn(entries, on) } : null,
      discordUnavailable: !members,
    };
  }

  return { read };
};

module.exports.assemble = assemble;
module.exports.membersOn = membersOn;
module.exports.DATE_RE = DATE_RE;
