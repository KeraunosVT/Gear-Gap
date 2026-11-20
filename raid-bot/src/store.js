// Every read and write the bot makes. One database serves every server the bot
// is in, so anything a server owns is looked up by its guild_id.
//
// Signup moves (join, withdraw, move, remove) lock the run's row first, so two
// people taking the last tank slot at the same moment can't both get it, and a
// freed slot goes to exactly one person off the bench. The rules are the ones
// Gear Gap's raid runs use (its migration 22), moved from SQL functions into
// transactions here so the bot runs on any Postgres without extra setup.
const { ROLES } = require('./catalog');

class RaidError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ERRORS = {
  not_found: "This run doesn't exist any more.",
  closed: 'Signups for this run are closed.',
  cancelled: 'This run was cancelled.',
  bad_role: "That role isn't part of this run.",
  not_signed_up: "They aren't signed up for this run.",
  role_full: 'That role is full. Move someone out of it first.',
  started: 'This run has already started. Change its time first.',
};
const fail = (code) => { throw new RaidError(code, ERRORS[code]); };

const SETTINGS_DEFAULTS = Object.freeze({
  raid_channel_id: null,
  poster_role_id: null,
  manager_role_id: null,
  timezone: null,
  reminder_minutes: 15,
});
const SETTINGS_FIELDS = Object.keys(SETTINGS_DEFAULTS);

// Finished runs are kept this long, then deleted with their signups.
const KEEP_DAYS = 30;

function createStore(pool) {
  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async function getSettings(guildId) {
    const { rows } = await pool.query('select * from guild_settings where guild_id = $1', [guildId]);
    return { ...SETTINGS_DEFAULTS, ...(rows[0] || {}), guild_id: guildId };
  }

  // Only the fields given are touched; null clears one back to its default.
  async function updateSettings(guildId, patch) {
    const fields = SETTINGS_FIELDS.filter((f) => f in patch);
    if (!fields.length) return getSettings(guildId);
    const values = fields.map((f) => (patch[f] === null ? SETTINGS_DEFAULTS[f] : patch[f]));
    const cols = fields.join(', ');
    const params = fields.map((_, i) => `$${i + 2}`).join(', ');
    const sets = fields.map((f) => `${f} = excluded.${f}`).join(', ');
    await pool.query(
      `insert into guild_settings (guild_id, ${cols}) values ($1, ${params})
       on conflict (guild_id) do update set ${sets}, updated_at = now()`,
      [guildId, ...values],
    );
    return getSettings(guildId);
  }

  async function getUserTimezone(userId) {
    const { rows } = await pool.query('select timezone from user_settings where user_id = $1', [userId]);
    return rows[0]?.timezone || null;
  }

  async function setUserTimezone(userId, timezone) {
    if (!timezone) {
      await pool.query('delete from user_settings where user_id = $1', [userId]);
      return;
    }
    await pool.query(
      `insert into user_settings (user_id, timezone) values ($1, $2)
       on conflict (user_id) do update set timezone = excluded.timezone, updated_at = now()`,
      [userId, timezone],
    );
  }

  // Whose clock a typed time is read on: theirs if they've set one, else the
  // server's, else UTC. `source` says which, so replies can mention it.
  async function timezoneFor(userId, guildId) {
    const mine = await getUserTimezone(userId);
    if (mine) return { timezone: mine, source: 'user' };
    const { timezone } = await getSettings(guildId);
    return timezone ? { timezone, source: 'server' } : { timezone: 'UTC', source: 'default' };
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  async function createRun({ guildId, channelId, raidKey, segments, roleCaps, title, notes, startsAt, leadId }) {
    const { rows } = await pool.query(
      `insert into raid_runs (guild_id, channel_id, raid_key, segments, role_caps, title, notes, starts_at, lead_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [guildId, channelId, raidKey, JSON.stringify(segments), JSON.stringify(roleCaps), title, notes || null, startsAt, leadId],
    );
    return rows[0];
  }

  async function setMessage(runId, channelId, messageId) {
    await pool.query('update raid_runs set channel_id = $2, message_id = $3 where id = $1', [runId, channelId, messageId]);
  }

  async function deleteRun(runId) {
    await pool.query('delete from raid_runs where id = $1', [runId]);
  }

  // A run, but only if it belongs to `guildId` when one is given: a button's
  // customId names a run, and it must never reach another server's.
  async function getRun(runId, guildId = null) {
    if (!/^\d+$/.test(String(runId))) return null;
    const { rows } = await pool.query('select * from raid_runs where id = $1', [runId]);
    const run = rows[0];
    if (!run || (guildId && run.guild_id !== guildId)) return null;
    return run;
  }

  // The run and everyone on it: the roster in signup order, and the bench in
  // the order people move up.
  async function detail(runId, guildId = null) {
    const run = await getRun(runId, guildId);
    if (!run) fail('not_found');
    const { rows } = await pool.query(
      'select * from raid_entries where run_id = $1 order by signed_up_at, id',
      [runId],
    );
    return {
      run,
      going: rows.filter((e) => e.status === 'going'),
      bench: rows.filter((e) => e.status === 'bench'),
    };
  }

  // Upcoming and just-started runs in a server, soonest first.
  async function listUpcoming(guildId, { now = new Date(), limit = 10 } = {}) {
    const { rows } = await pool.query(
      `select r.*,
         (select count(*)::int from raid_entries e where e.run_id = r.id and e.status = 'going') as going_count,
         (select count(*)::int from raid_entries e where e.run_id = r.id and e.status = 'bench') as bench_count
       from raid_runs r
       where r.guild_id = $1 and r.status <> 'cancelled' and r.starts_at > $2::timestamptz - interval '3 hours'
       order by r.starts_at
       limit $3`,
      [guildId, now, limit],
    );
    return rows;
  }

  // Title, notes, start time and plan. A new start time re-arms the reminder.
  async function updateRun(runId, patch) {
    const run = await getRun(runId);
    if (!run) fail('not_found');
    const next = {
      title: patch.title ?? run.title,
      notes: patch.notes === undefined ? run.notes : (patch.notes || null),
      starts_at: patch.startsAt ?? run.starts_at,
      segments: patch.segments ?? run.segments,
    };
    const moved = new Date(next.starts_at).getTime() !== new Date(run.starts_at).getTime();
    const { rows } = await pool.query(
      `update raid_runs set title = $2, notes = $3, starts_at = $4, segments = $5,
         reminded_at = case when $6 then null else reminded_at end
       where id = $1 returning *`,
      [runId, next.title, next.notes, next.starts_at, JSON.stringify(next.segments), moved],
    );
    return rows[0];
  }

  // open ⇄ closed, or either → cancelled. Reopening a run that has started is
  // refused: the sweep would close it again within the minute.
  async function setStatus(runId, status, { now = new Date() } = {}) {
    return tx(async (c) => {
      const run = await lockRun(c, runId);
      if (run.status === 'cancelled') fail('cancelled');
      if (status === 'open' && new Date(run.starts_at) <= now) fail('started');
      const { rows } = await c.query('update raid_runs set status = $2 where id = $1 returning *', [runId, status]);
      return rows[0];
    });
  }

  // ── Signups ───────────────────────────────────────────────────────────────

  async function lockRun(c, runId, guildId = null) {
    if (!/^\d+$/.test(String(runId))) fail('not_found');
    const { rows } = await c.query('select * from raid_runs where id = $1 for update', [runId]);
    const run = rows[0];
    if (!run || (guildId && run.guild_id !== guildId)) fail('not_found');
    return run;
  }

  const countGoing = async (c, runId, role) => (await c.query(
    "select count(*)::int as n from raid_entries where run_id = $1 and status = 'going' and role = $2",
    [runId, role],
  )).rows[0].n;

  // Moves the first overflow bench entry in `role` into the roster, if the
  // role has room. Caller holds the run's lock.
  async function fillRole(c, run, role) {
    const cap = Number(run.role_caps?.[role] || 0);
    if (await countGoing(c, run.id, role) >= cap) return null;
    const { rows } = await c.query(
      `update raid_entries set status = 'going', bench_kind = null
       where id = (
         select id from raid_entries
         where run_id = $1 and status = 'bench' and bench_kind = 'overflow' and role = $2
         order by signed_up_at, id limit 1
       ) returning *`,
      [run.id, role],
    );
    return rows[0] || null;
  }

  // Join in a role, or on the bench. Joining again in another role (or moving
  // between roster and bench) replaces the old entry: the old slot is freed,
  // and the first overflow bench entry in that role moves up.
  //
  //   bench = false: into the role if it has room, else the bench (overflow).
  //   bench = true:  the bench (opt_in), whatever the role's room.
  //
  // `addedBy` is the lead's id when a lead adds someone, which may happen on a
  // closed run (but not a cancelled one).
  async function join({ runId, guildId = null, userId, displayName, role, bench = false, addedBy = null }) {
    return tx(async (c) => {
      const run = await lockRun(c, runId, guildId);
      if (run.status === 'cancelled') fail('cancelled');
      if (run.status !== 'open' && !addedBy) fail('closed');
      if (!ROLES.includes(role) || !(role in (run.role_caps || {}))) fail('bad_role');

      const { rows: had } = await c.query('select * from raid_entries where run_id = $1 and user_id = $2', [run.id, userId]);
      const existing = had[0] || null;

      // Already where they asked to be: report it, don't reshuffle. A second
      // click shouldn't send someone to the back of the bench.
      if (existing && existing.role === role && (
        (!bench && existing.status === 'going')
        || (!bench && existing.status === 'bench' && existing.bench_kind === 'overflow')
        || (bench && existing.status === 'bench' && existing.bench_kind === 'opt_in'))) {
        return {
          run, status: existing.status, role, benchKind: existing.bench_kind,
          position: await benchPosition(c, run.id, userId, existing), changed: false, promoted: null,
        };
      }

      if (existing) await c.query('delete from raid_entries where id = $1', [existing.id]);

      const cap = Number(run.role_caps[role] || 0);
      let status = 'bench';
      let benchKind = 'opt_in';
      if (!bench) {
        if (await countGoing(c, run.id, role) < cap) { status = 'going'; benchKind = null; } else benchKind = 'overflow';
      }

      const { rows: inserted } = await c.query(
        `insert into raid_entries (run_id, user_id, display_name, role, status, bench_kind, added_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning *`,
        [run.id, userId, String(displayName || 'Unknown').slice(0, 80), role, status, benchKind, addedBy],
      );

      // Their old slot, if they gave one up.
      let promoted = null;
      if (existing?.status === 'going' && !(status === 'going' && existing.role === role)) {
        promoted = await fillRole(c, run, existing.role);
      }

      return {
        run, status, role, benchKind,
        position: await benchPosition(c, run.id, userId, inserted[0]), changed: true, promoted,
      };
    });
  }

  // Where someone stands in line for their role (1 = next up), or null when
  // they aren't waiting for a slot. Compared in SQL: signed_up_at has
  // microseconds, and a round trip through a JS Date would drop them and
  // leave the entry behind itself.
  async function benchPosition(c, runId, userId, entry) {
    if (entry.status !== 'bench' || entry.bench_kind !== 'overflow') return null;
    const { rows } = await c.query(
      `select count(*)::int as n from raid_entries e, raid_entries me
       where me.id = $2 and e.run_id = $1 and e.status = 'bench' and e.bench_kind = 'overflow' and e.role = me.role
         and (e.signed_up_at, e.id) <= (me.signed_up_at, me.id)`,
      [runId, entry.id],
    );
    return rows[0].n;
  }

  // Leave a run, freeing the slot for the first overflow bench entry in that
  // role. Allowed on a closed run: dropping out after signups close is exactly
  // what the lead needs to hear about.
  async function withdraw({ runId, guildId = null, userId }) {
    return tx(async (c) => {
      const run = await lockRun(c, runId, guildId);
      const { rows } = await c.query('delete from raid_entries where run_id = $1 and user_id = $2 returning *', [run.id, userId]);
      const removed = rows[0];
      if (!removed) return { run, removed: false, wasGoing: false, promoted: null };
      const promoted = removed.status === 'going' && run.status !== 'cancelled' ? await fillRole(c, run, removed.role) : null;
      return { run, removed: true, wasGoing: removed.status === 'going', promoted };
    });
  }

  // The lead moving someone. Into the roster refuses a full role. Onto the
  // bench is opt_in, at the back, so they aren't moved straight back up, and
  // the freed slot is left for the lead to fill — moving someone out is
  // usually to make room for someone else. Removing frees the slot like a
  // withdraw does.
  async function move({ runId, guildId = null, userId, to }) {
    if (to === 'remove') return withdraw({ runId, guildId, userId });
    return tx(async (c) => {
      const run = await lockRun(c, runId, guildId);
      if (run.status === 'cancelled') fail('cancelled');
      const { rows } = await c.query('select * from raid_entries where run_id = $1 and user_id = $2', [run.id, userId]);
      const entry = rows[0];
      if (!entry) fail('not_signed_up');

      if (to === 'going') {
        if (entry.status === 'going') return { run, entry, changed: false };
        if (await countGoing(c, run.id, entry.role) >= Number(run.role_caps[entry.role] || 0)) fail('role_full');
        const { rows: up } = await c.query(
          "update raid_entries set status = 'going', bench_kind = null where id = $1 returning *", [entry.id],
        );
        return { run, entry: up[0], changed: true };
      }
      if (to === 'bench') {
        const { rows: down } = await c.query(
          "update raid_entries set status = 'bench', bench_kind = 'opt_in', signed_up_at = clock_timestamp() where id = $1 returning *",
          [entry.id],
        );
        return { run, entry: down[0], changed: true };
      }
      throw new RaidError('bad_move', 'Unknown move.');
    });
  }

  // ── Sweeps ────────────────────────────────────────────────────────────────

  // Runs whose reminder is due, each claimed so it's sent once even with two
  // instances running. A run posted inside its own reminder window is skipped:
  // a ping seconds after the post is noise. Moving the start time re-arms it.
  async function claimReminders(now = new Date()) {
    const { rows } = await pool.query(
      `with due as (
         select r.id, coalesce(s.reminder_minutes, $2::int) as mins
         from raid_runs r left join guild_settings s on s.guild_id = r.guild_id
         where r.status in ('open', 'closed') and r.reminded_at is null and r.message_id is not null
           and r.starts_at > $1::timestamptz
       )
       update raid_runs r set reminded_at = $1::timestamptz
       from due
       where r.id = due.id and due.mins > 0
         and r.starts_at <= $1::timestamptz + make_interval(mins => due.mins)
         and r.created_at < r.starts_at - make_interval(mins => due.mins)
         and r.reminded_at is null
       returning r.*`,
      [now, SETTINGS_DEFAULTS.reminder_minutes],
    );
    return rows;
  }

  // Closes signups on runs that have started. Returns them, to re-render.
  async function closeStarted(now = new Date()) {
    const { rows } = await pool.query(
      "update raid_runs set status = 'closed' where status = 'open' and starts_at <= $1 returning *",
      [now],
    );
    return rows;
  }

  async function purgeOld(now = new Date()) {
    const { rowCount } = await pool.query(
      `delete from raid_runs where starts_at < $1::timestamptz - make_interval(days => $2::int)`,
      [now, KEEP_DAYS],
    );
    return rowCount;
  }

  // The bot was removed from a server: forget it. Signups go with their runs.
  async function deleteGuild(guildId) {
    await tx(async (c) => {
      await c.query('delete from raid_runs where guild_id = $1', [guildId]);
      await c.query('delete from guild_settings where guild_id = $1', [guildId]);
    });
  }

  return {
    getSettings, updateSettings, getUserTimezone, setUserTimezone, timezoneFor,
    createRun, setMessage, deleteRun, getRun, detail, listUpcoming, updateRun, setStatus,
    join, withdraw, move,
    claimReminders, closeStarted, purgeOld, deleteGuild,
  };
}

module.exports = { createStore, RaidError, SETTINGS_DEFAULTS, KEEP_DAYS };
