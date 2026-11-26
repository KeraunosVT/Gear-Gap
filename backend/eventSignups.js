// backend/eventSignups.js — opt-in signups for a dated occurrence of a
// scheduled event, shared between the website's /api/signups routes and the
// Discord announcement buttons so both write through the same validation.
//
// Opt-in only, and that constraint runs all the way through: an entry means
// "I'm coming", there is no "I'm out", and a member with no row is UNKNOWN
// rather than declined. LOA remains the only way to declare absence, and shows
// up here purely as a read-time overlay (see loaOverlay below) — nothing in this
// module ever writes an LOA.
//
// Knows nothing about Discord. Rendering the announcement lives in
// discordGateway.js for the same reason loaAnnouncement() does: the message
// wording is a presentation concern and the two callers must not drift.
const createLoa = require('./loa');
const createEliteTimers = require('./eliteTimers');
const { raids: RAIDS } = require('../shared/raids.json');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['open', 'closed', 'cancelled'];
// The PvP roles member_roles stores, in the order every surface displays them.
// Anything else — including no row at all — tallies as Unassigned.
const ROLE_ORDER = ['Tank', 'DPS', 'Healer'];
// Ceiling on the reminder-candidate query below. Nothing to do with how far
// ahead a reminder can be set — just keeps the coarse SQL filter bounded.
const REMINDER_LOOKAHEAD_DAYS = 7;

// How far ahead a MEMBER may open a night nobody has opened yet. Officers have
// no such ceiling — one opening a night six months out is doing it deliberately.
// The event calendar's paging cap is the same number on purpose, so its arrows
// can't reach a week whose buttons this would refuse.
const MEMBER_OPEN_HORIZON_DAYS = 30;

// Event types whose signups close before the start, in minutes. Everything
// else closes when it starts. War Games close three hours early so the roster
// can be set while there's still time to change it.
const CLOSE_EARLY_MINUTES = { war_games: 180 };
const MAX_CLOSE_EARLY_MINUTES = Math.max(0, ...Object.values(CLOSE_EARLY_MINUTES));
// An event with no type picked is typed by its name, as the calendar does.
// Mirrors the in_house and war_games patterns in frontend/src/eventCategories.js,
// in the same order — "In-House Wargame" is In-House, not War Games; the
// signupCutoff test holds the two in step. Only the types the server acts on
// are here: War Games close early, In-House posts to its own channel.
const TYPE_BY_NAME = [
  ['in_house', /in[\s-]*house/i],
  ['war_games', /war\s*games?|wargame/i],
];

// An occurrence's type: the one it was given, else read off its name. Null
// for a name no server-side type matches.
function eventTypeOf(row) {
  return categoryKey(row?.category) || (TYPE_BY_NAME.find(([, re]) => re.test(String(row?.title || ''))) || [])[0] || null;
}

// How many minutes before its start an occurrence's signups close: its stored
// type, else its name. 0 for most events.
function closeEarlyMinutes(row) {
  return CLOSE_EARLY_MINUTES[eventTypeOf(row)] || 0;
}

// The instant signups close, or null when the occurrence has no start time
// (those are only ever closed by hand).
function closesAt(row) {
  if (!row?.starts_at) return null;
  return new Date(Date.parse(row.starts_at) - closeEarlyMinutes(row) * 60_000);
}

const pastCutoff = (row, now = Date.now()) => {
  const at = closesAt(row);
  return Boolean(at) && at.getTime() <= now;
};

// "3 hours" — said whenever a join is refused for closing early, so the
// member knows it wasn't a fault.
const leadText = (minutes) => (minutes % 60 === 0
  ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
  : `${minutes} minutes`);
const closedEarlyError = (row) => httpError(409,
  `Signups for ${row.title} closed ${leadText(closeEarlyMinutes(row))} before it starts.`);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ── Raids ────────────────────────────────────────────────────────────────────
// A raid run is a signup_events row with raid_key set (migration 22). Members
// pick their role at signup, each role has a fixed number of slots, and anyone
// past that sits on the bench. Everything else (the post, reminders, closing
// at the start, LOA) is the same machinery War signups use.
const RAID_ROLES = ['Tank', 'DPS', 'Healer'];
const raidOf = (key) => RAIDS.find((r) => r.key === key) || null;

// A run's plan, checked against the catalog: [{ mode, gates }] with each mode
// once, gates sorted and in range, in the catalog's mode order (easiest
// first). Empty modes are dropped; a plan with no gates at all is refused.
function raidSegments(raid, input) {
  if (!Array.isArray(input)) throw httpError(400, 'Pick at least one gate.');
  const byMode = new Map();
  input.forEach((seg) => {
    const mode = raid.modes.find((m) => m.key === seg?.mode);
    if (!mode) throw httpError(400, `${raid.name} has no mode called "${seg?.mode}".`);
    const gates = byMode.get(mode.key) || new Set();
    (Array.isArray(seg.gates) ? seg.gates : []).forEach((g) => {
      const n = Number(g);
      if (!Number.isInteger(n) || n < 1 || n > raid.gates) throw httpError(400, `Gates run from 1 to ${raid.gates}.`);
      gates.add(n);
    });
    byMode.set(mode.key, gates);
  });
  const out = raid.modes
    .filter((m) => byMode.get(m.key)?.size)
    .map((m) => ({ mode: m.key, gates: [...byMode.get(m.key)].sort((a, b) => a - b) }));
  if (!out.length) throw httpError(400, 'Pick at least one gate.');
  return out;
}

// The hardest mode in a run, as its catalog entry. The post takes its colour
// from it. Null for a run with no plan.
function hardestMode(event) {
  const raid = raidOf(event?.raid_key);
  if (!raid || !Array.isArray(event.raid_segments)) return null;
  const keys = new Set(event.raid_segments.map((s) => s.mode));
  return [...raid.modes].reverse().find((m) => keys.has(m.key)) || null;
}

// "Gate 2", "Gates 1 & 3", "Gates 1–3".
function gatesText(gates) {
  const g = [...gates].sort((a, b) => a - b);
  if (g.length === 1) return `Gate ${g[0]}`;
  const run = g.every((n, i) => i === 0 || n === g[i - 1] + 1);
  return run && g.length > 2 ? `Gates ${g[0]}–${g[g.length - 1]}` : `Gates ${g.join(' & ')}`;
}

// The role a signup counts under: the one picked at signup for a raid, else
// the PvP role on file (War signups).
const entryRole = (e) => e.role || e.pvp_role || '';

const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const dayOfWeek = (dateStr) => new Date(dateStr + 'T12:00:00').getDay();

// An event type key (migration 036), or null for "work it out from the name".
// Only the shape is checked: the list of types lives in the frontend, which
// treats a key it doesn't know as null anyway.
const categoryKey = (v) => {
  const s = String(v || '').trim();
  return /^[a-z_]{1,40}$/.test(s) ? s : null;
};

// The UTC instant an occurrence actually starts. `nightDate` is the guild night;
// an after-midnight event occurs on the *following* calendar day, which is the
// same shift the schedule itself stores and Home.jsx's nextOccurrences() applies.
// Null when the occurrence has no time — reminders and auto-close both skip it.
function resolveStartsAt(nightDate, eventTime) {
  if (!eventTime) return null;
  const calendarDay = createLoa.isAfterMidnight(eventTime) ? addDays(nightDate, 1) : nightDate;
  const [hour, minute] = eventTime.split(':').map(Number);
  return createEliteTimers.guildTimeOn(calendarDay, hour, minute);
}

// `identities` and `loa` are both optional so a caller without them still works.
// Without identities, names pass through as stored; without loa, the overlay is
// simply empty. Everywhere both are supplied — which is everywhere in the app —
// signups read the same aliases and the same absence answer as everything else.
module.exports = function createEventSignups(supabase, identities = null, loa = null) {
  const isValidDate = (dateStr) => DATE_RE.test(dateStr || '');

  // Resolved at write time so the row carries the site alias rather than a
  // Discord username, matching loa.js.
  const resolveName = async (discordId, fallback) => {
    if (!identities) return (fallback || '').slice(0, 120);
    const ids = await identities.load();
    return (ids.displayNameFor(discordId, fallback) || '').slice(0, 120);
  };

  // Resolved again on read, because display_name is only a snapshot: an alias
  // set after someone signed up wouldn't otherwise show up.
  const withNames = async (rows) => {
    if (!identities) return rows;
    const ids = await identities.load();
    return rows.map((e) => ({ ...e, display_name: ids.displayNameFor(e.discord_id, e.display_name) }));
  };

  // Role is READ from member_roles, never asked for at signup — one less step in
  // the Discord flow, and it stays consistent with the party builder's pools.
  const rolesFor = async (discordIds) => {
    const out = {};
    if (!discordIds.length) return out;
    const { data, error } = await supabase.from('member_roles')
      .select('discord_id, pvp_role, pve_role').in('discord_id', discordIds);
    if (error) { console.error('signups.rolesFor error:', error.message); return out; }
    (data || []).forEach((r) => { out[r.discord_id] = { pvp: r.pvp_role || '', pve: r.pve_role || '' }; });
    return out;
  };

  // Headcount per stored role, for the composition line on the post and the
  // site card. 'Unassigned' is deliberately counted rather than dropped: a
  // signup with no role on file is exactly the person an officer has to chase
  // before they can build parties, and a silent omission would hide them.
  const tallyRoles = (entries) => {
    const out = { Tank: 0, DPS: 0, Healer: 0, Unassigned: 0 };
    entries.forEach((e) => { out[ROLE_ORDER.includes(entryRole(e)) ? entryRole(e) : 'Unassigned'] += 1; });
    return out;
  };

  // A raid's lead, by their site alias when they have one. raid_lead_name is
  // only the name they had when they posted the run.
  const withLeadNames = async (events) => {
    if (!identities || !events.some((e) => e.raid_key)) return events;
    const ids = await identities.load();
    return events.map((e) => (e.raid_key && e.created_by
      ? { ...e, raid_lead_name: ids.displayNameFor(e.created_by, e.raid_lead_name) }
      : e));
  };

  const loadEvent = async (id) => {
    const { data, error } = await supabase.from('signup_events').select('*').eq('id', id).single();
    if (error || !data) throw httpError(404, 'That signup no longer exists.');
    return (await withLeadNames([data]))[0];
  };

  // Entries for one occurrence, name-resolved and role-decorated, going first
  // and each list in signup order — which for the waitlist is also its position.
  const entriesFor = async (signupEventId) => {
    const { data, error } = await supabase.from('signup_entries').select('*')
      .eq('signup_event_id', signupEventId).order('signed_up_at').order('id');
    if (error) { console.error('signups.entriesFor error:', error.message); throw httpError(500, 'Failed to load signups.'); }
    const rows = await withNames(data || []);
    const roles = await rolesFor(rows.map((r) => r.discord_id));
    const decorated = rows.map((r) => ({ ...r, pvp_role: roles[r.discord_id]?.pvp || '', pve_role: roles[r.discord_id]?.pve || '' }));
    return {
      going: decorated.filter((r) => r.status === 'going'),
      waitlist: decorated.filter((r) => r.status === 'waitlist'),
      // Raids only. Signup order, which within a role and bench kind is the
      // order people move up in.
      bench: decorated.filter((r) => r.status === 'bench'),
    };
  };

  // Postgres raises a bare string; surface the two we care about as real HTTP
  // statuses so the button handler and the website say the same thing.
  const rpcError = (error) => {
    const msg = error?.message || '';
    if (msg.includes('signup_not_found')) return httpError(404, 'That signup no longer exists.');
    if (msg.includes('signup_closed')) return httpError(409, 'Signups for this event are closed.');
    if (msg.includes('not_a_raid')) return httpError(400, "That signup isn't a raid run.");
    if (msg.includes('raid_bad_role')) return httpError(400, 'Pick a role: Tank, DPS or Healer.');
    if (msg.includes('raid_role_full')) return httpError(409, 'That role is full. Move someone to the bench first.');
    if (msg.includes('raid_not_signed_up')) return httpError(404, "They aren't signed up for this run.");
    if (msg.includes('raid_bad_move')) return httpError(400, 'Move them to the roster or the bench.');
    // The functions are missing: a migration hasn't run.
    if (/raid_change_role/.test(msg) && /function|schema cache/i.test(msg)) {
      return httpError(503, 'Changing roles needs migration 24 to be run first.');
    }
    if (/raid_(join|withdraw|move)/.test(msg) && /function|schema cache/i.test(msg)) {
      return httpError(503, 'Raid signups need migration 22 to be run first.');
    }
    console.error('signups rpc error:', msg);
    return httpError(500, 'Failed to update that signup.');
  };

  return {
    isValidDate,
    resolveStartsAt,

    // Opens a signup for one night. `eventScheduleId` is optional — an ad-hoc
    // event just needs a title — but when given, the schedule row supplies the
    // title and time, and the night is validated against it.
    //
    // A second open for the same occasion returns the existing row rather than
    // erroring: an officer double-submitting wants the post they already made,
    // not a duplicate or a stack trace.
    async open({ eventDate, eventScheduleId = null, title = '', eventTime: rawTime = null, category = null, capacity = null, reminderMinutes = null, createdBy = null }) {
      if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');

      // A one-off event's own time. Ignored when a schedule entry is given —
      // the schedule's time is the event's time, and two sources for one fact
      // is how they come to disagree.
      let eventTime = null;
      if (!eventScheduleId && rawTime) {
        eventTime = createLoa.parseTimeOfDay(rawTime);
        if (!eventTime) throw httpError(400, 'Time must be a valid time, e.g. 9:00 PM.');
      }
      let eventName = (title || '').trim();
      // Same rule as the time: a scheduled event's type comes from the schedule.
      let eventCategory = eventScheduleId ? null : categoryKey(category);
      if (eventScheduleId) {
        // '*' rather than naming skip_dates, so a database without 031 still
        // opens signups instead of failing every one.
        const { data: ev, error } = await supabase.from('event_schedule')
          .select('*').eq('id', eventScheduleId).single();
        if (error || !ev) throw httpError(400, 'That scheduled event no longer exists.');
        if (Array.isArray(ev.skip_dates) && ev.skip_dates.map(String).includes(eventDate)) {
          throw httpError(409, `${ev.name} is cancelled that night.`);
        }
        // Same night check as loa.submitEvent, for the same reason: a signup
        // scoped to an event that doesn't run that night is a typo, not a plan.
        if (createLoa.guildDayOfWeek(ev.day_of_week, ev.event_time) !== dayOfWeek(eventDate)) {
          throw httpError(400, `${ev.name} doesn't run on that night.`);
        }
        if (!createLoa.eventRunsThatWeek(ev, eventDate)) {
          throw httpError(400, `${ev.name} runs every other week, and that night is an off week.`);
        }
        eventTime = ev.event_time || null;
        eventCategory = categoryKey(ev.category);
        if (!eventName) eventName = ev.name;
      }
      if (!eventName) throw httpError(400, 'A title is required for an event with no schedule entry.');

      const cap = capacity == null || capacity === '' ? null : parseInt(capacity, 10);
      if (cap != null && (!Number.isFinite(cap) || cap < 1)) throw httpError(400, 'Capacity must be a positive number.');
      const remind = reminderMinutes == null || reminderMinutes === '' ? null : parseInt(reminderMinutes, 10);
      if (remind != null && (!Number.isFinite(remind) || remind < 1)) throw httpError(400, 'Reminder must be a positive number of minutes.');

      const startsAt = resolveStartsAt(eventDate, eventTime);
      const { data, error } = await supabase.from('signup_events').insert({
        event_date: eventDate,
        event_schedule_id: eventScheduleId || null,
        title: eventName.slice(0, 120),
        event_time: eventTime,
        category: eventCategory,
        starts_at: startsAt ? startsAt.toISOString() : null,
        capacity: cap,
        reminder_minutes: remind,
        created_by: createdBy || null,
      }).select('*').single();

      if (error) {
        // 23505 = the partial unique index on (event_date, event_schedule_id).
        if (error.code === '23505' && eventScheduleId) {
          const existing = await this.getByOccasion({ eventDate, eventScheduleId });
          if (existing) return { row: existing, created: false };
        }
        console.error('signups.open error:', error.message);
        throw httpError(500, 'Failed to open signups.');
      }
      return { row: data, created: true };
    },

    // A member signing up for a scheduled night nobody has opened yet — the
    // thing that makes the event calendar answerable, since most of the week
    // has no signup_events row until someone commits to it.
    //
    // open() does the real work: it already validates the night against the
    // schedule, and it already returns the EXISTING occurrence on a 23505
    // rather than erroring. That second property is what keeps two members
    // tapping the same row a second apart from producing two attendee lists.
    //
    // The guards added here are only the ones an officer doesn't need. An
    // officer opening a night that has already started, or one six months out,
    // is doing it on purpose; a member tapping a row on a calendar is not.
    async openForSchedule({ eventScheduleId, eventDate, openedBy = null }) {
      if (!eventScheduleId) throw httpError(400, 'Pick an event.');
      if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');

      const { data: ev } = await supabase.from('event_schedule')
        .select('id, name, event_time, category').eq('id', eventScheduleId).single();
      if (!ev) throw httpError(400, 'That scheduled event no longer exists.');
      // No time means resolveStartsAt can't place it, so neither guard below
      // can be evaluated — refuse rather than open something unbounded.
      if (!ev.event_time) throw httpError(400, `${ev.name} has no start time on the schedule.`);

      const startsAt = resolveStartsAt(eventDate, ev.event_time);
      if (!startsAt) throw httpError(400, 'Could not resolve that date and time.');
      if (startsAt.getTime() <= Date.now()) throw httpError(409, 'That event has already started.');
      // The same cutoff the sweep closes by, checked before opening so a late
      // tap doesn't leave an empty occurrence behind.
      const early = { title: ev.name, category: ev.category, starts_at: startsAt.toISOString() };
      if (pastCutoff(early)) throw closedEarlyError(early);
      if (startsAt.getTime() - Date.now() > MEMBER_OPEN_HORIZON_DAYS * 86_400_000) {
        throw httpError(400, `Signups can only be opened up to ${MEMBER_OPEN_HORIZON_DAYS} days ahead.`);
      }

      // Deliberately no capacity and no reminder: a member opening a night is
      // answering for themselves, not setting up the raid. An officer adds
      // those from the Signups page, along with the Discord post.
      const { row, created } = await this.open({ eventDate, eventScheduleId, createdBy: openedBy });
      return { id: row.id, opened: created };
    },

    // Posts a raid run. Any member may: whoever opens it is its raid lead
    // (created_by). A start time is required, since it's what the reminder,
    // the close at the start and the Discord countdown all run from.
    async openRaid({ raidKey, eventDate, eventTime: rawTime, segments, reminderMinutes = null, createdBy = null, createdByName = '' }) {
      const raid = raidOf(raidKey);
      if (!raid) throw httpError(400, 'Pick a raid.');
      if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
      const eventTime = rawTime ? createLoa.parseTimeOfDay(rawTime) : null;
      if (!eventTime) throw httpError(400, 'A raid run needs a start time, e.g. 9:00 PM.');
      const plan = raidSegments(raid, segments);
      const remind = reminderMinutes == null || reminderMinutes === '' ? null : parseInt(reminderMinutes, 10);
      if (remind != null && (!Number.isFinite(remind) || remind < 1)) throw httpError(400, 'Reminder must be a positive number of minutes.');

      const startsAt = resolveStartsAt(eventDate, eventTime);
      if (startsAt.getTime() <= Date.now()) throw httpError(409, 'That time has already passed.');
      if (startsAt.getTime() - Date.now() > MEMBER_OPEN_HORIZON_DAYS * 86_400_000) {
        throw httpError(400, `Raid runs can be posted up to ${MEMBER_OPEN_HORIZON_DAYS} days ahead.`);
      }

      const { data, error } = await supabase.from('signup_events').insert({
        event_date: eventDate,
        title: raid.name,
        event_time: eventTime,
        category: 'raid',
        starts_at: startsAt.toISOString(),
        reminder_minutes: remind,
        raid_key: raid.key,
        raid_segments: plan,
        role_caps: raid.roles,
        created_by: createdBy || null,
        raid_lead_name: createdBy ? await resolveName(createdBy, createdByName) : null,
      }).select('*').single();
      if (error) {
        console.error('signups.openRaid error:', error.message);
        // 42703 = undefined column.
        throw httpError(error.code === '42703' ? 503 : 500, error.code === '42703'
          ? 'Raid signups need migration 22 to be run first.'
          : 'Failed to post that raid run.');
      }
      return data;
    },

    // A run's gates, changed after posting. Who's signed up stays as they are.
    async setRaidSegments(id, segments) {
      const event = await loadEvent(id);
      const raid = raidOf(event.raid_key);
      if (!raid) throw httpError(400, "That signup isn't a raid run.");
      const plan = raidSegments(raid, segments);
      const { data, error } = await supabase.from('signup_events')
        .update({ raid_segments: plan, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
      if (error || !data) {
        console.error('signups.setRaidSegments error:', error?.message);
        throw httpError(500, 'Failed to save the gates.');
      }
      return data;
    },

    // Whether this member leads the run (posted it). Officers are checked by
    // the caller, which knows the session's permissions.
    isRaidLead(event, discordId) {
      return Boolean(event?.raid_key && event.created_by && String(event.created_by) === String(discordId));
    },

    // The raid lead moving someone between the roster and the bench.
    async raidMove({ id, discordId, to }) {
      const { data, error } = await supabase.rpc('raid_move', {
        p_event_id: id, p_discord_id: String(discordId), p_to: to,
      });
      if (error) throw rpcError(error);
      const row = (data || [])[0] || {};
      return { status: row.entry_status || to, role: row.entry_role || null };
    },

    // The raid lead changing someone's role (migration 24). They keep their
    // place as far as the new role allows; see the migration for the rules.
    async raidChangeRole({ id, discordId, role }) {
      if (!RAID_ROLES.includes(role)) throw httpError(400, 'Pick a role: Tank, DPS or Healer.');
      const { data, error } = await supabase.rpc('raid_change_role', {
        p_event_id: id, p_discord_id: String(discordId), p_role: role,
      });
      if (error) throw rpcError(error);
      const row = (data || [])[0] || {};
      return {
        status: row.entry_status || null,
        role: row.entry_role || role,
        benchKind: row.entry_bench_kind || null,
        position: row.bench_position || null,
        changed: Boolean(row.changed),
        fromRole: row.from_role || null,
        promoted: row.promoted_id
          ? { discord_id: row.promoted_id, display_name: row.promoted_name, role: row.promoted_role }
          : null,
      };
    },

    get: loadEvent,

    // The (night, event) lookup shared by the party builder and the attendance
    // breakdown — the same key LOA uses, so all three line up on the 00:30 event.
    async getByOccasion({ eventDate, eventScheduleId = null }) {
      if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
      let q = supabase.from('signup_events').select('*').eq('event_date', eventDate);
      q = eventScheduleId ? q.eq('event_schedule_id', eventScheduleId) : q.is('event_schedule_id', null);
      const { data, error } = await q.limit(1);
      if (error) { console.error('signups.getByOccasion error:', error.message); return null; }
      return (data || [])[0] || null;
    },

    // getByOccasion + detail in the one shape eventDetail.js wants: "the signup
    // for this night, with its headcount and composition, or null".
    //
    // The composition here is FLAT and covers `going` only — { Tank, DPS,
    // Healer, unknown, total } — deliberately different from detail()'s nested
    // roleCounts. The event page shows one line summarising who is coming; the
    // signups page shows going and waitlist side by side because "we're short a
    // healer and there's one waiting" is the case that justifies raising the
    // cap. Flattening at the boundary keeps each consumer reading the shape it
    // actually needs rather than reaching into a nested object for one half.
    //
    // `unknown` rather than `Unassigned`: this is the summary vocabulary, where
    // the question is "how many can't be placed", not "which bucket is empty".
    async forOccasion({ date, eventScheduleId = null }) {
      const event = await this.getByOccasion({ eventDate: date, eventScheduleId });
      if (!event) return null;
      const d = await this.detail(event.id);
      const going = d.roleCounts.going;
      return {
        id: event.id,
        title: event.title,
        capacity: event.capacity,
        status: event.status,
        counts: d.counts,
        composition: {
          Tank: going.Tank,
          DPS: going.DPS,
          Healer: going.Healer,
          unknown: going.Unassigned,
          total: d.going.length,
        },
        going: d.going,
        waitlist: d.waitlist,
      };
    },

    // Occurrences with their headcounts. Counts are tallied in JS off one extra
    // query rather than a per-row aggregate — the list is a handful of rows and
    // this keeps it to two round trips.
    // `raids`: raid runs instead of everything else. The two are listed apart
    // because every surface that reads this list (the calendar, the Signups
    // page, LOA) joins with one "I'm in" and a raid needs a role. Filtered in
    // JS rather than on raid_key so this keeps working before migration 22.
    async list({ from = null, to = null, includeClosed = false, discordId = null, raids = false } = {}) {
      let q = supabase.from('signup_events').select('*')
        .gte('event_date', from || createLoa.todayInGuildTz())
        .order('event_date').order('event_time', { nullsFirst: true });
      if (to) q = q.lte('event_date', to);
      if (!includeClosed) q = q.eq('status', 'open');
      const { data, error } = await q;
      if (error) { console.error('signups.list error:', error.message); throw httpError(500, 'Failed to load signups.'); }

      const events = await withLeadNames((data || []).filter((e) => Boolean(e.raid_key) === raids));
      if (!events.length) return [];
      // '*' so the raid columns come back when they exist, without naming
      // columns a database before migration 22 doesn't have.
      const { data: entries } = await supabase.from('signup_entries')
        .select('*')
        .in('signup_event_id', events.map((e) => e.id));

      // One roles lookup for every entry across every listed occurrence, so the
      // composition on the cards costs a single extra round trip rather than
      // one per event.
      const roles = await rolesFor([...new Set((entries || []).map((r) => r.discord_id))]);
      const roleOf = (entry) => {
        const r = entry.role || roles[entry.discord_id]?.pvp || '';
        return ROLE_ORDER.includes(r) ? r : 'Unassigned';
      };

      const tally = {};
      (entries || []).forEach((r) => {
        const t = tally[r.signup_event_id] || (tally[r.signup_event_id] = {
          going: 0, waitlist: 0, bench: 0, mine: null, mineRole: null, roles: { Tank: 0, DPS: 0, Healer: 0, Unassigned: 0 },
        });
        if (r.status === 'going') { t.going += 1; t.roles[roleOf(r)] += 1; } else if (r.status === 'bench') t.bench += 1; else t.waitlist += 1;
        if (discordId && r.discord_id === discordId) { t.mine = r.status; t.mineRole = r.role || null; }
        (t.ids || (t.ids = [])).push(String(r.discord_id));
      });
      return events.map((e) => ({
        ...e,
        going_count: tally[e.id]?.going || 0,
        waitlist_count: tally[e.id]?.waitlist || 0,
        // Going and waitlist both. A signup beats an LOA, so the calendar
        // leaves these members out of its "away" list for the event. Who's
        // signed up is no secret — "Who's coming?" shows it in Discord.
        signed_up_ids: tally[e.id]?.ids || [],
        // Going only — the waitlist breakdown is detail-level, and a card that
        // showed both would need twice the room to say half as much.
        role_counts: tally[e.id]?.roles || { Tank: 0, DPS: 0, Healer: 0, Unassigned: 0 },
        my_status: tally[e.id]?.mine || null,
        // Raids only: the bench, and the role the caller signed up as.
        bench_count: tally[e.id]?.bench || 0,
        my_role: tally[e.id]?.mineRole || null,
      }));
    },

    // One occurrence in full. `roster` is passed in rather than fetched so this
    // module stays free of Discord — admin.js already owns listMembers().
    //
    // The unknown bucket is split, and that split is the entire officer-facing
    // payoff of opt-in-only: without LOA there'd be no way to tell someone who
    // declined from someone who hasn't opened Discord yet.
    async detail(id, { includeReasons = false, roster = null } = {}) {
      const event = await loadEvent(id);
      const { going, waitlist, bench } = await entriesFor(id);

      let onLoa = [];
      let noResponse = [];
      let conflicts = [];
      if (loa) {
        // As filed, signups ignored: this view lists both, side by side.
        const out = await loa.unavailableOn({
          date: event.event_date, eventScheduleId: event.event_schedule_id, signupEventId: event.id, ignoreSignups: true,
        }).catch((err) => { console.error('signups.detail LOA lookup failed:', err.message); return []; });
        const outById = new Map(out.map((e) => [e.discord_id, e]));
        const signedUp = new Set([...going, ...waitlist, ...bench].map((e) => e.discord_id));

        // Signed up AND on LOA. The signup wins — they count as coming
        // everywhere (see signedUpAcross in loa.js) — so this is a note, not a
        // problem: they may have signed up after filing, or filed a range and
        // made an exception for this one night.
        conflicts = [...going, ...waitlist, ...bench]
          .filter((e) => outById.has(e.discord_id))
          .map((e) => ({ ...e, loa: scrubReason(outById.get(e.discord_id), includeReasons) }));

        if (roster) {
          const unknown = roster.filter((m) => !signedUp.has(m.id));
          onLoa = unknown.filter((m) => outById.has(m.id))
            .map((m) => ({ discord_id: m.id, display_name: m.name, loa: scrubReason(outById.get(m.id), includeReasons) }));
          noResponse = unknown.filter((m) => !outById.has(m.id))
            .map((m) => ({ discord_id: m.id, display_name: m.name }));
        }
      }

      return {
        event,
        going,
        waitlist,
        bench,
        counts: { going: going.length, waitlist: waitlist.length, bench: bench.length, capacity: event.capacity },
        // Composition, split the same way the party builder's pools are. The
        // waitlist gets its own tally because "we're short a healer and there's
        // one waiting" is the case that justifies raising the cap.
        roleCounts: { going: tallyRoles(going), waitlist: tallyRoles(waitlist) },
        onLoa,
        noResponse,
        conflicts,
      };
    },

    // `role` and `bench` are for raid runs, and a raid needs a role. They're
    // ignored for everything else, where the role comes from member_roles.
    async join({ id, discordId, displayName, addedBy = null, role = null, bench = false }) {
      // Signups that close early are refused from the cutoff on, not from
      // whenever the sweep next runs — it ticks once a minute. A missing row is
      // left to the RPC, which already says so. '*' so raid_key is there when
      // the column is, without breaking before migration 22.
      const { data: ev } = await supabase.from('signup_events')
        .select('*').eq('id', id).maybeSingle();
      if (ev && ev.status === 'open' && closeEarlyMinutes(ev) && pastCutoff(ev)) throw closedEarlyError(ev);

      const name = await resolveName(discordId, displayName);
      if (ev?.raid_key) {
        if (!RAID_ROLES.includes(role)) throw httpError(400, 'Pick a role: Tank, DPS or Healer.');
        const { data, error } = await supabase.rpc('raid_join', {
          p_event_id: id, p_discord_id: String(discordId), p_display_name: name,
          p_role: role, p_bench: Boolean(bench), p_added_by: addedBy || null,
        });
        if (error) throw rpcError(error);
        const row = (data || [])[0] || {};
        return {
          raid: true,
          status: row.entry_status || 'going',
          role: row.entry_role || role,
          benchKind: row.entry_bench_kind || null,
          position: row.bench_position || null,
          wasNew: Boolean(row.changed),
          promoted: row.promoted_id
            ? { discord_id: row.promoted_id, display_name: row.promoted_name, role: row.promoted_role }
            : null,
          displayName: name,
        };
      }

      const { data, error } = await supabase.rpc('signup_join', {
        p_event_id: id, p_discord_id: String(discordId), p_display_name: name, p_added_by: addedBy || null,
      });
      if (error) throw rpcError(error);
      const row = (data || [])[0] || {};
      return {
        status: row.entry_status || 'going',
        going: row.going_count || 0,
        waitlist: row.waitlist_count || 0,
        wasNew: Boolean(row.was_new),
        displayName: name,
      };
    },

    async withdraw({ id, discordId }) {
      // A raid frees a slot in one role, so it promotes by role.
      const { data: ev } = await supabase.from('signup_events').select('*').eq('id', id).maybeSingle();
      if (ev?.raid_key) {
        const { data, error } = await supabase.rpc('raid_withdraw', { p_event_id: id, p_discord_id: String(discordId) });
        if (error) throw rpcError(error);
        const row = (data || [])[0] || {};
        return {
          removed: Boolean(row.removed),
          wasGoing: Boolean(row.was_going),
          promoted: row.promoted_id
            ? { discord_id: row.promoted_id, display_name: row.promoted_name, role: row.promoted_role }
            : null,
        };
      }
      const { data, error } = await supabase.rpc('signup_withdraw', {
        p_event_id: id, p_discord_id: String(discordId),
      });
      if (error) throw rpcError(error);
      const row = (data || [])[0] || {};
      return {
        removed: Boolean(row.removed),
        wasGoing: Boolean(row.was_going),
        // Non-null only when a slot actually opened up, so the caller knows to
        // DM them without having to diff the lists itself.
        promoted: row.promoted_id ? { discord_id: row.promoted_id, display_name: row.promoted_name } : null,
      };
    },

    // Returns everyone the change promoted, so the caller can tell them.
    async setCapacity(id, capacity) {
      const cap = capacity == null || capacity === '' ? null : parseInt(capacity, 10);
      if (cap != null && (!Number.isFinite(cap) || cap < 1)) throw httpError(400, 'Capacity must be a positive number.');
      const { data, error } = await supabase.rpc('signup_set_capacity', { p_event_id: id, p_capacity: cap });
      if (error) throw rpcError(error);
      return (data || []).map((r) => ({ discord_id: r.promoted_id, display_name: r.promoted_name }));
    },

    async setStatus(id, status) {
      if (!STATUSES.includes(status)) throw httpError(400, 'Unknown signup status.');
      const { data, error } = await supabase.from('signup_events')
        .update({ status, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
      if (error || !data) throw httpError(404, 'That signup no longer exists.');
      return data;
    },

    // A one-off's own facts: name, night, time, type. A scheduled occurrence
    // takes all four from its schedule entry, so it is refused here rather than
    // allowed to drift from it — that edit belongs on the schedule.
    async setDetails(id, { title, eventDate, eventTime, category } = {}) {
      const event = await loadEvent(id);
      if (event.event_schedule_id) throw httpError(400, 'A weekly event is edited on the schedule, not one night at a time.');

      const update = {};
      if (title !== undefined) {
        const name = String(title || '').trim();
        if (!name) throw httpError(400, 'A title is required.');
        update.title = name.slice(0, 120);
      }
      if (eventDate !== undefined) {
        if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
        update.event_date = eventDate;
      }
      if (eventTime !== undefined) {
        const time = eventTime ? createLoa.parseTimeOfDay(eventTime) : null;
        if (eventTime && !time) throw httpError(400, 'Time must be a valid time, e.g. 9:00 PM.');
        update.event_time = time;
      }
      if (category !== undefined) update.category = categoryKey(category);
      if (!Object.keys(update).length) return event;

      // starts_at drives reminders and auto-close, so it follows the night and
      // time. A move re-arms the reminder: one already sent was for the old time.
      if ('event_date' in update || 'event_time' in update) {
        const startsAt = resolveStartsAt(update.event_date ?? event.event_date,
          'event_time' in update ? update.event_time : event.event_time);
        const before = event.starts_at ? new Date(event.starts_at).getTime() : null;
        const after = startsAt ? startsAt.getTime() : null;
        update.starts_at = startsAt ? startsAt.toISOString() : null;
        if (before !== after) update.reminder_sent_at = null;
      }

      const { data, error } = await supabase.from('signup_events')
        .update({ ...update, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
      if (error || !data) {
        console.error('signups.setDetails error:', error?.message);
        throw httpError(500, 'Failed to update that event.');
      }
      return data;
    },

    async setReminderMinutes(id, minutes) {
      const remind = minutes == null || minutes === '' ? null : parseInt(minutes, 10);
      if (remind != null && (!Number.isFinite(remind) || remind < 1)) throw httpError(400, 'Reminder must be a positive number of minutes.');
      // Clearing reminder_sent_at alongside so re-arming a reminder actually
      // re-arms it — otherwise a spent flag silently suppresses the new setting.
      const { data, error } = await supabase.from('signup_events')
        .update({ reminder_minutes: remind, reminder_sent_at: null, updated_at: new Date().toISOString() })
        .eq('id', id).select('*').single();
      if (error || !data) throw httpError(404, 'That signup no longer exists.');
      return data;
    },

    async remove(id) {
      const event = await loadEvent(id);
      const { error } = await supabase.from('signup_events').delete().eq('id', id);
      if (error) { console.error('signups.remove error:', error.message); throw httpError(500, 'Failed to delete that signup.'); }
      // Entries go with it via the cascade; the row is returned so the caller
      // can clean up the Discord message it points at.
      return event;
    },

    // Best-effort — called after the announcement posts, to remember where it
    // went so the site and the sweep can edit it later. Same contract as
    // loa.setMessageId: a failure here must not undo a signup that already saved.
    async setMessageId(id, channelId, messageId) {
      const { error } = await supabase.from('signup_events')
        .update({ discord_channel_id: channelId || null, discord_message_id: messageId || null, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) console.error('signups.setMessageId error:', error.message);
    },

    // Claims the right to send this occurrence's reminder, atomically. The
    // conditional `.is(null)` is the whole duplicate-DM defence: an empty result
    // means somebody else — another sweep tick, a second instance, or the manual
    // "remind now" button — got there first, and this caller must not send.
    async claimReminder(id) {
      const { data, error } = await supabase.from('signup_events')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('id', id).is('reminder_sent_at', null).select('id');
      if (error) { console.error('signups.claimReminder error:', error.message); return false; }
      return Boolean((data || []).length);
    },

    // The manual "Remind" button's version: no compare-and-set, since an
    // officer repeating a reminder is the point. Recording it still stops a
    // scheduled reminder that hasn't fired yet from following straight after.
    async markReminderSent(id) {
      const { error } = await supabase.from('signup_events')
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq('id', id);
      if (error) {
        console.error('signups.markReminderSent error:', error.message);
        throw httpError(500, 'Failed to record the reminder.');
      }
    },

    // Who this night is against — an enemy guild's name as the Feuds page
    // shows it, or null. Free text rather than a key: there is no enemy guild
    // table, only names on scoreboards, and a first meeting has no record yet.
    async setOpponent(id, name) {
      const opponent = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) || null;
      const { data, error } = await supabase.from('signup_events')
        .update({ opponent_guild: opponent, updated_at: new Date().toISOString() })
        .eq('id', id).select('*').single();
      if (error || !data) {
        console.error('signups.setOpponent error:', error?.message);
        throw httpError(error ? 500 : 404, error ? 'Failed to save the opponent.' : 'That signup no longer exists.');
      }
      return data;
    },

    // A War Games night's maps and rules, either or both. Free text, trimmed,
    // and blank clears. Maps are one line (the site fills them from War
    // Record's list, comma-separated); rules keep their line breaks.
    async setWarDetails(id, { maps, rules } = {}) {
      const update = { updated_at: new Date().toISOString() };
      if (maps !== undefined) update.war_maps = String(maps ?? '').trim().replace(/\s+/g, ' ').slice(0, 300) || null;
      if (rules !== undefined) {
        update.war_rules = String(rules ?? '').replace(/\r\n?/g, '\n').trim().replace(/\n{3,}/g, '\n\n').slice(0, 1000) || null;
      }
      const { data, error } = await supabase.from('signup_events').update(update).eq('id', id).select('*').single();
      if (error || !data) {
        console.error('signups.setWarDetails error:', error?.message);
        // A missing column is the likeliest error, and its fix is the migration.
        throw httpError(error ? 500 : 404, error
          ? 'Failed to save the maps and rules — has migration 13 been run?'
          : 'That signup no longer exists.');
      }
      return data;
    },

    // Occurrences whose reminder is due now.
    //
    // The final "is it within reminder_minutes" test is done in JS because the
    // interval is per-row (`starts_at <= now() + reminder_minutes`) and PostgREST
    // can't express a filter against another column. The SQL filter narrows to a
    // handful of open future rows first, so the JS pass is over almost nothing.
    //
    // `starts_at > now()` is load-bearing: it stops a process that was down for
    // six hours from waking up and blasting reminders for events that already ran.
    async dueForReminder() {
      const now = Date.now();
      const { data, error } = await supabase.from('signup_events').select('*')
        .eq('status', 'open')
        .not('reminder_minutes', 'is', null)
        .is('reminder_sent_at', null)
        .not('starts_at', 'is', null)
        .gt('starts_at', new Date(now).toISOString())
        .lte('starts_at', new Date(now + REMINDER_LOOKAHEAD_DAYS * 86_400_000).toISOString());
      if (error) { console.error('signups.dueForReminder error:', error.message); return []; }
      return (data || []).filter((e) => Date.parse(e.starts_at) - now <= e.reminder_minutes * 60_000);
    },

    // Open occurrences whose signups should now be closed: at the start, or
    // earlier for a type in CLOSE_EARLY_MINUTES. The SQL takes everything
    // starting within the longest early close; the per-row cutoff is JS.
    async dueToClose() {
      const now = Date.now();
      const { data, error } = await supabase.from('signup_events').select('*')
        .eq('status', 'open')
        .not('starts_at', 'is', null)
        .lte('starts_at', new Date(now + MAX_CLOSE_EARLY_MINUTES * 60_000).toISOString());
      if (error) { console.error('signups.dueToClose error:', error.message); return []; }
      return (data || []).filter((row) => pastCutoff(row, now));
    },

    // The party builder's feed: who committed to this occasion.
    // The one-off events opened for a night — signups with no schedule entry —
    // for the party builder's event picker, which otherwise only knows the
    // weekly schedule. Cancelled ones are left out.
    async oneOffsOn(eventDate) {
      if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
      const { data, error } = await supabase.from('signup_events')
        .select('id, title, event_date, event_time, status')
        .eq('event_date', eventDate).is('event_schedule_id', null).neq('status', 'cancelled')
        .order('event_time', { ascending: true, nullsFirst: true });
      if (error) { console.error('signups.oneOffsOn error:', error.message); throw httpError(500, 'Failed to load events.'); }
      return data || [];
    },

    // signedUpFor, by signup id — how the party builder asks about a one-off,
    // which (date, schedule id) can't single out when a night has several.
    async signedUpForId(id) {
      const event = await loadEvent(id);
      const { going, waitlist, bench } = await entriesFor(event.id);
      // A raid's bench reads as its waitlist here: the party builder only
      // knows the two.
      return { event, going, waitlist: [...waitlist, ...bench] };
    },

    async signedUpFor({ eventDate, eventScheduleId = null }) {
      const event = await this.getByOccasion({ eventDate, eventScheduleId });
      if (!event) return { event: null, going: [], waitlist: [] };
      const { going, waitlist } = await entriesFor(event.id);
      return { event, going, waitlist };
    },

    // Who to DM: everyone on the roster with no entry at all and no LOA on file.
    // Excluding the LOA'd is the point — with only "going" recorded, LOA is the
    // one signal that separates a decline from someone who hasn't looked yet, and
    // pinging people who already told you they're out is how a reminder becomes
    // noise people mute.
    async nonResponders(id, roster) {
      const event = await loadEvent(id);
      const { data } = await supabase.from('signup_entries').select('discord_id').eq('signup_event_id', id);
      const responded = new Set((data || []).map((r) => r.discord_id));

      let out = new Set();
      if (loa) {
        const absent = await loa.unavailableOn({ date: event.event_date, eventScheduleId: event.event_schedule_id, signupEventId: event.id })
          .catch((err) => { console.error('signups.nonResponders LOA lookup failed:', err.message); return []; });
        out = new Set(absent.map((e) => e.discord_id));
      }
      return { event, members: (roster || []).filter((m) => !responded.has(m.id) && !out.has(m.id)) };
    },

    // `attendanceComparison` used to live here: signed-up vs turned-up, for the
    // admin event route. It is gone because eventDetail.js now derives both from
    // the same pass that resolves LOA and late requests, and it must — a
    // no-show is only a no-show once you know they didn't file leave and didn't
    // ask to be added afterwards. Two implementations of that join would answer
    // the same question differently within a month, which is the whole reason
    // eventDetail exists. See `walk_in` and the `noshow_signed` status there.
  };
};

// For the schedule routes in admin/schedule.js, which take the same field.
module.exports.categoryKey = categoryKey;
module.exports.eventTypeOf = eventTypeOf;
module.exports.closeEarlyMinutes = closeEarlyMinutes;
module.exports.closesAt = closesAt;
module.exports.RAIDS = RAIDS;
module.exports.RAID_ROLES = RAID_ROLES;
module.exports.raidOf = raidOf;
module.exports.raidSegments = raidSegments;
module.exports.hardestMode = hardestMode;
module.exports.gatesText = gatesText;

// LOA reasons are officer-only everywhere else (loa.all strips them for
// non-admins), so they're stripped here too unless the caller proved the
// capability. The fact of the absence still shows; only the why is withheld.
function scrubReason(entry, includeReasons) {
  if (!entry) return null;
  const { reason, ...rest } = entry;
  return includeReasons ? { ...rest, reason } : rest;
}
