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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = ['open', 'closed', 'cancelled'];
// The PvP roles member_roles stores, in the order every surface displays them.
// Anything else — including no row at all — tallies as Unassigned.
const ROLE_ORDER = ['Tank', 'DPS', 'Healer'];
// Ceiling on the reminder-candidate query below. Nothing to do with how far
// ahead a reminder can be set — just keeps the coarse SQL filter bounded.
const REMINDER_LOOKAHEAD_DAYS = 7;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const dayOfWeek = (dateStr) => new Date(dateStr + 'T12:00:00').getDay();

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
    entries.forEach((e) => { out[ROLE_ORDER.includes(e.pvp_role) ? e.pvp_role : 'Unassigned'] += 1; });
    return out;
  };

  const loadEvent = async (id) => {
    const { data, error } = await supabase.from('signup_events').select('*').eq('id', id).single();
    if (error || !data) throw httpError(404, 'That signup no longer exists.');
    return data;
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
    };
  };

  // Postgres raises a bare string; surface the two we care about as real HTTP
  // statuses so the button handler and the website say the same thing.
  const rpcError = (error) => {
    const msg = error?.message || '';
    if (msg.includes('signup_not_found')) return httpError(404, 'That signup no longer exists.');
    if (msg.includes('signup_closed')) return httpError(409, 'Signups for this event are closed.');
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
    async open({ eventDate, eventScheduleId = null, title = '', capacity = null, reminderMinutes = null, createdBy = null }) {
      if (!isValidDate(eventDate)) throw httpError(400, 'Date must be in YYYY-MM-DD format.');

      let eventTime = null;
      let eventName = (title || '').trim();
      if (eventScheduleId) {
        const { data: ev, error } = await supabase.from('event_schedule')
          .select('id, name, day_of_week, event_time').eq('id', eventScheduleId).single();
        if (error || !ev) throw httpError(400, 'That scheduled event no longer exists.');
        // Same night check as loa.submitEvent, for the same reason: a signup
        // scoped to an event that doesn't run that night is a typo, not a plan.
        if (createLoa.guildDayOfWeek(ev.day_of_week, ev.event_time) !== dayOfWeek(eventDate)) {
          throw httpError(400, `${ev.name} doesn't run on that night.`);
        }
        eventTime = ev.event_time || null;
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
    async list({ from = null, to = null, includeClosed = false, discordId = null } = {}) {
      let q = supabase.from('signup_events').select('*')
        .gte('event_date', from || createLoa.todayInGuildTz())
        .order('event_date').order('event_time', { nullsFirst: true });
      if (to) q = q.lte('event_date', to);
      if (!includeClosed) q = q.eq('status', 'open');
      const { data, error } = await q;
      if (error) { console.error('signups.list error:', error.message); throw httpError(500, 'Failed to load signups.'); }

      const events = data || [];
      if (!events.length) return [];
      const { data: entries } = await supabase.from('signup_entries')
        .select('signup_event_id, discord_id, status')
        .in('signup_event_id', events.map((e) => e.id));

      // One roles lookup for every entry across every listed occurrence, so the
      // composition on the cards costs a single extra round trip rather than
      // one per event.
      const roles = await rolesFor([...new Set((entries || []).map((r) => r.discord_id))]);
      const roleOf = (id) => {
        const r = roles[id]?.pvp || '';
        return ROLE_ORDER.includes(r) ? r : 'Unassigned';
      };

      const tally = {};
      (entries || []).forEach((r) => {
        const t = tally[r.signup_event_id] || (tally[r.signup_event_id] = {
          going: 0, waitlist: 0, mine: null, roles: { Tank: 0, DPS: 0, Healer: 0, Unassigned: 0 },
        });
        if (r.status === 'going') { t.going += 1; t.roles[roleOf(r.discord_id)] += 1; } else t.waitlist += 1;
        if (discordId && r.discord_id === discordId) t.mine = r.status;
      });
      return events.map((e) => ({
        ...e,
        going_count: tally[e.id]?.going || 0,
        waitlist_count: tally[e.id]?.waitlist || 0,
        // Going only — the waitlist breakdown is detail-level, and a card that
        // showed both would need twice the room to say half as much.
        role_counts: tally[e.id]?.roles || { Tank: 0, DPS: 0, Healer: 0, Unassigned: 0 },
        my_status: tally[e.id]?.mine || null,
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
      const { going, waitlist } = await entriesFor(id);

      let onLoa = [];
      let noResponse = [];
      let conflicts = [];
      if (loa) {
        const out = await loa.unavailableOn({ date: event.event_date, eventScheduleId: event.event_schedule_id })
          .catch((err) => { console.error('signups.detail LOA lookup failed:', err.message); return []; });
        const outById = new Map(out.map((e) => [e.discord_id, e]));
        const signedUp = new Set([...going, ...waitlist].map((e) => e.discord_id));

        // Signed up AND on LOA. Surfaced, never resolved automatically — they
        // may have signed up after filing, or filed a range and made an
        // exception for this one night. The officer decides; we only flag it.
        conflicts = [...going, ...waitlist]
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
        counts: { going: going.length, waitlist: waitlist.length, capacity: event.capacity },
        // Composition, split the same way the party builder's pools are. The
        // waitlist gets its own tally because "we're short a healer and there's
        // one waiting" is the case that justifies raising the cap.
        roleCounts: { going: tallyRoles(going), waitlist: tallyRoles(waitlist) },
        onLoa,
        noResponse,
        conflicts,
      };
    },

    async join({ id, discordId, displayName, addedBy = null }) {
      const name = await resolveName(discordId, displayName);
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

    async dueToClose() {
      const { data, error } = await supabase.from('signup_events').select('*')
        .eq('status', 'open')
        .not('starts_at', 'is', null)
        .lte('starts_at', new Date().toISOString());
      if (error) { console.error('signups.dueToClose error:', error.message); return []; }
      return data || [];
    },

    // The party builder's feed: who committed to this occasion.
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
        const absent = await loa.unavailableOn({ date: event.event_date, eventScheduleId: event.event_schedule_id })
          .catch((err) => { console.error('signups.nonResponders LOA lookup failed:', err.message); return []; });
        out = new Set(absent.map((e) => e.discord_id));
      }
      return { event, members: (roster || []).filter((m) => !responded.has(m.id) && !out.has(m.id)) };
    },

    // Signed up vs actually turned up. Both directions are worth seeing: a
    // no-show is someone to talk to, and a walk-in is someone the cap would have
    // turned away for nothing.
    async attendanceComparison({ signupEventId, attendees }) {
      const { going } = await entriesFor(signupEventId);
      const present = new Set((attendees || []).map((a) => a.discord_id || a.id));
      const signedUp = new Set(going.map((e) => e.discord_id));
      return {
        noShows: going.filter((e) => !present.has(e.discord_id)),
        walkIns: (attendees || []).filter((a) => !signedUp.has(a.discord_id || a.id)),
      };
    },
  };
};

// LOA reasons are officer-only everywhere else (loa.all strips them for
// non-admins), so they're stripped here too unless the caller proved the
// capability. The fact of the absence still shows; only the why is withheld.
function scrubReason(entry, includeReasons) {
  if (!entry) return null;
  const { reason, ...rest } = entry;
  return includeReasons ? { ...rest, reason } : rest;
}
