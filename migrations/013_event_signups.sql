-- 013_event_signups.sql — opt-in signups for a dated occurrence of a scheduled
-- event, with a headcount cap and an auto-promoting waitlist.
--
-- This is the first materialised "event occurrence" in the schema. LOA gets away
-- without one by keying on (event_date, event_schedule_id) and deriving
-- everything else, but a signup post has per-occurrence STATE — a cap, the
-- Discord message it lives on, whether it's still open, whether the reminder has
-- gone out — and state has to live somewhere.
--
-- It is deliberately NOT the `events` table. Those rows are created after the
-- fact by save_event(), which always inserts a fresh id with no unique key on
-- the occasion, so there'd be nothing stable to hang a signup off. They also get
-- deleted when an officer removes a bad attendance snap, which must not take the
-- signup ledger with it. Keeping them apart is what makes the no-show comparison
-- possible at all: "signed up" and "showed up" are two records you join, not one
-- record you overwrite.
--
-- event_date is a GUILD NIGHT (see loa.js GUILD_DAY_START), not a calendar day,
-- so it joins directly against loa.unavailableOn() and events.event_date. The
-- 12:30am field boss belongs to the night before, on both sides.
--
-- Run this in the Supabase SQL editor.

create table signup_events (
  id uuid primary key default gen_random_uuid(),
  -- The guild night, not the calendar day the event lands on.
  event_date date not null,
  -- Null for an ad-hoc event with no schedule row, and set null (not cascade) if
  -- the schedule row is later deleted — matching rosters (migration 004).
  -- title/event_time/starts_at are snapshots, so the post still reads correctly.
  event_schedule_id uuid references event_schedule (id) on delete set null,
  title text not null,
  event_time text,
  -- The resolved UTC instant, stored rather than derived. It makes the reminder
  -- sweep one indexed predicate instead of per-row timezone math, and it freezes
  -- the time people actually committed to — editing the schedule row afterwards
  -- shouldn't move an event that's already been announced. Same snapshot
  -- reasoning as lucent_requests.item_name (migration 007). Null when the
  -- occurrence has no time at all (event_schedule.event_time is nullable);
  -- reminders and auto-close both skip those.
  starts_at timestamptz,
  -- Null = no cap. Applies to NEW joins only: lowering it never demotes someone
  -- who already committed (see signup_fill_from_waitlist).
  capacity int check (capacity is null or capacity > 0),
  status text not null default 'open'
    check (status in ('open', 'closed', 'cancelled')),
  -- Minutes before starts_at to DM everyone who hasn't responded. Null = none.
  reminder_minutes int check (reminder_minutes is null or reminder_minutes > 0),
  -- The idempotency flag for the sweep — elite_timers.pinged, but a timestamp,
  -- because "when did we remind" costs the same to store and is worth knowing.
  -- Claimed with a conditional UPDATE, never a read-then-write, so it is atomic
  -- against any number of concurrent senders (the minute timer and the manual
  -- "remind now" button can and will race).
  reminder_sent_at timestamptz,
  -- Where the announcement lives, so the website and the sweep can edit it with
  -- no interaction in hand. Same reason loa_entries.discord_message_id exists —
  -- except this one is edited on every signup, not just deleted at the end.
  discord_channel_id text,
  discord_message_id text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One signup post per (night, scheduled event). Partial, because NULLs compare
-- as distinct in a unique index — which is exactly right here: two different
-- ad-hoc events on the same night are legitimate, two posts for the same
-- Saturday siege are not.
create unique index signup_events_occasion_idx
  on signup_events (event_date, event_schedule_id)
  where event_schedule_id is not null;

-- Drives the sweep's "what's due" query. Partial on status so it stays small as
-- closed occurrences accumulate.
create index signup_events_due_idx on signup_events (starts_at)
  where status = 'open';

create index signup_events_date_idx on signup_events (event_date desc);

create table signup_entries (
  id uuid primary key default gen_random_uuid(),
  signup_event_id uuid not null references signup_events (id) on delete cascade,
  discord_id text not null,
  -- A snapshot like event_attendance.display_name; reads resolve it against
  -- player_identities anyway, so an alias set later still shows up.
  display_name text,
  -- Opt-in only. There is no 'out' — LOA is the only way to declare absence, and
  -- someone with no row here is UNKNOWN, not declined. This check constraint is
  -- the enforcement: a 'declined' or 'maybe' can't be added by accident, only by
  -- a migration that has to argue for it.
  status text not null default 'going' check (status in ('going', 'waitlist')),
  -- Waitlist order. No position column: order is signed_up_at ascending, which
  -- needs no renumbering when someone in the middle withdraws.
  signed_up_at timestamptz not null default now(),
  promoted_at timestamptz,
  -- Set when an officer added them on someone's behalf (the resolveTarget
  -- pattern), null when they clicked the button themselves.
  added_by text,
  unique (signup_event_id, discord_id)
);

create index signup_entries_event_idx
  on signup_entries (signup_event_id, status, signed_up_at);
create index signup_entries_member_idx on signup_entries (discord_id);

-- ── Cap and waitlist ────────────────────────────────────────────────────────
-- These are functions for the same reason save_event() is (migration 012): a
-- function body is a single transaction. Two people clicking the last slot at
-- the same instant would both read going_count = capacity - 1 and both take it.
-- The `for update` on the parent signup_events row serialises every join and
-- withdraw for that one occurrence — and nothing else, so a different night's
-- signups are unaffected.
--
-- plpgsql gotcha throughout: OUT params are named entry_status/promoted_id
-- rather than status/discord_id, because an ambiguous name resolves to the OUT
-- param and would silently shadow the table column in every query in the body.

-- Promote from the waitlist until the cap is met. Shared by withdraw and
-- capacity changes so "who moves up" has exactly one implementation.
--
-- Callers already hold the row lock. When there are no free slots this returns
-- nothing and demotes nobody — which is how "lowering the cap applies to new
-- joins only" falls out of the code instead of needing a special case. Bumping
-- someone who already committed is worse than being one over for a night.
create or replace function signup_fill_from_waitlist(p_event_id uuid)
returns table (promoted_id text, promoted_name text)
language plpgsql
as $$
declare
  v_capacity int;
  v_going int;
  v_slots int;
begin
  select capacity into v_capacity from signup_events where id = p_event_id;

  -- Cap removed entirely: nobody should still be waiting.
  if v_capacity is null then
    return query
      update signup_entries set status = 'going', promoted_at = now()
      where signup_event_id = p_event_id and signup_entries.status = 'waitlist'
      returning signup_entries.discord_id, signup_entries.display_name;
    return;
  end if;

  select count(*) into v_going from signup_entries
    where signup_event_id = p_event_id and signup_entries.status = 'going';
  v_slots := v_capacity - v_going;
  if v_slots <= 0 then return; end if;

  -- id breaks ties so two entries stamped the same microsecond still order
  -- deterministically rather than by whatever the planner feels like.
  return query
    update signup_entries set status = 'going', promoted_at = now()
    where id in (
      select e.id from signup_entries e
      where e.signup_event_id = p_event_id and e.status = 'waitlist'
      order by e.signed_up_at, e.id
      limit v_slots
    )
    returning signup_entries.discord_id, signup_entries.display_name;
end;
$$;

-- Join, or report where the caller already stands.
create or replace function signup_join(
  p_event_id uuid,
  p_discord_id text,
  p_display_name text,
  p_added_by text default null
) returns table (entry_status text, going_count int, waitlist_count int, was_new boolean)
language plpgsql
as $$
declare
  v_event signup_events%rowtype;
  v_existing signup_entries%rowtype;
  v_going int;
  v_status text;
  v_new boolean := false;
begin
  select * into v_event from signup_events where id = p_event_id for update;
  if not found then raise exception 'signup_not_found'; end if;
  if v_event.status <> 'open' then raise exception 'signup_closed'; end if;

  select * into v_existing from signup_entries
    where signup_event_id = p_event_id and signup_entries.discord_id = p_discord_id;

  if found then
    -- A double-click, or a button on a message someone scrolled back to.
    -- Reporting where they already stand beats erroring at them.
    v_status := v_existing.status;
  else
    select count(*) into v_going from signup_entries
      where signup_event_id = p_event_id and signup_entries.status = 'going';
    v_status := case
      when v_event.capacity is null or v_going < v_event.capacity then 'going'
      else 'waitlist' end;
    insert into signup_entries (signup_event_id, discord_id, display_name, status, added_by)
      values (p_event_id, p_discord_id, left(coalesce(p_display_name, ''), 120), v_status, p_added_by);
    v_new := true;
  end if;

  return query select v_status,
    (select count(*)::int from signup_entries e
       where e.signup_event_id = p_event_id and e.status = 'going'),
    (select count(*)::int from signup_entries e
       where e.signup_event_id = p_event_id and e.status = 'waitlist'),
    v_new;
end;
$$;

-- Withdraw, promoting the head of the waitlist if a committed slot opened up.
--
-- Deliberately NOT gated on status = 'open', unlike join: people cancel late,
-- and an officer would rather know at T-10 than find out in voice comms.
create or replace function signup_withdraw(p_event_id uuid, p_discord_id text)
returns table (removed boolean, was_going boolean, promoted_id text, promoted_name text)
language plpgsql
as $$
declare
  v_status text;
  v_promoted record;
begin
  perform 1 from signup_events where id = p_event_id for update;
  if not found then raise exception 'signup_not_found'; end if;

  delete from signup_entries
    where signup_event_id = p_event_id and signup_entries.discord_id = p_discord_id
    returning signup_entries.status into v_status;

  if v_status is null then
    return query select false, false, null::text, null::text;
    return;
  end if;
  if v_status <> 'going' then
    return query select true, false, null::text, null::text;
    return;
  end if;

  select * into v_promoted from signup_fill_from_waitlist(p_event_id) limit 1;
  return query select true, true, v_promoted.promoted_id, v_promoted.promoted_name;
end;
$$;

create or replace function signup_set_capacity(p_event_id uuid, p_capacity int)
returns table (promoted_id text, promoted_name text)
language plpgsql
as $$
begin
  perform 1 from signup_events where id = p_event_id for update;
  if not found then raise exception 'signup_not_found'; end if;
  update signup_events set capacity = p_capacity, updated_at = now() where id = p_event_id;
  return query select f.promoted_id, f.promoted_name from signup_fill_from_waitlist(p_event_id) f;
end;
$$;
