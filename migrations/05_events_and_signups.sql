-- 05_events_and_signups.sql — the weekly schedule, signups, LOA exceptions, and
-- the Event Calendar's DST toggle and one-off-to-weekly conversion.
--
-- Replaces archive/013, 022, 031, 035, 036 and 037. Needs 01 (guild_config) and
-- 04 (events). See 01_guild_and_access.sql for how these files work. Safe to
-- re-run.
--
-- Dates throughout are GUILD NIGHTS, not calendar days: a 12:30 AM event stored
-- on Sunday belongs to Saturday night (see guild_config.day_start).

-- ── THE WEEKLY SCHEDULE (was 031, 036) ──────────────────────────────────────
-- event_schedule is base schema.
--
-- skip_dates: nights cancelled out of a weekly event without touching the rest
-- of the series. Not pruned, so a cancelled night stays cancelled in history.
--
-- category: the event's type (arch_boss, siege, ...), a key from
-- frontend/src/eventCategories.js. Null means work it out from the name; an
-- unknown key falls back to the name too.
alter table event_schedule add column if not exists skip_dates date[] not null default '{}';
alter table event_schedule add column if not exists category text;

-- ── LOA EXCEPTIONS (was 022) ────────────────────────────────────────────────
-- loa_entries is base schema. Dates lifted out of a recurring LOA ("out every
-- Tuesday, except this one"). On the row rather than a side table because
-- unavailableOn() already reads every row and matches in JS. Not pruned: past
-- nights are asked about too, and a pruned exception would rewrite history.
alter table loa_entries add column if not exists skip_dates date[] not null default '{}';

-- ── SIGNUPS (was 013, 036) ──────────────────────────────────────────────────
-- One row per occurrence that has signups open. Deliberately not the `events`
-- table: those are made after the fact, have no stable key on the occasion, and
-- get deleted with a bad attendance snap. "Signed up" and "showed up" are two
-- records you join, which is what makes the no-show comparison possible.
--
-- A one-off event on the calendar is a row here with no event_schedule_id.
create table if not exists signup_events (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,   -- the guild night
  -- Set null (not cascade) if the schedule row is deleted. title, event_time,
  -- category and starts_at are snapshots, so the occurrence still reads right.
  event_schedule_id uuid references event_schedule (id) on delete set null,
  title text not null,
  event_time text,
  category text,
  -- The resolved UTC instant, stored so the reminder sweep is one indexed
  -- predicate. Null when the occurrence has no time; reminders and auto-close
  -- skip those.
  starts_at timestamptz,
  -- Null = no cap. Applies to new joins only: lowering it never demotes anyone.
  capacity int check (capacity is null or capacity > 0),
  status text not null default 'open'
    check (status in ('open', 'closed', 'cancelled')),
  -- Minutes before starts_at to DM everyone who hasn't responded.
  reminder_minutes int check (reminder_minutes is null or reminder_minutes > 0),
  -- Claimed with a conditional UPDATE, so concurrent senders can't double-DM.
  reminder_sent_at timestamptz,
  -- Where the announcement lives, so the site and the sweep can edit it.
  discord_channel_id text,
  discord_message_id text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One occurrence per (night, scheduled event). Partial, because two different
-- one-offs on the same night are legitimate.
create unique index if not exists signup_events_occasion_idx
  on signup_events (event_date, event_schedule_id)
  where event_schedule_id is not null;

create index if not exists signup_events_due_idx on signup_events (starts_at)
  where status = 'open';

create index if not exists signup_events_date_idx on signup_events (event_date desc);

create table if not exists signup_entries (
  id uuid primary key default gen_random_uuid(),
  signup_event_id uuid not null references signup_events (id) on delete cascade,
  discord_id text not null,
  display_name text,   -- a snapshot; reads resolve it against player_identities
  -- Opt-in only. There is no 'out' — LOA is the only way to declare absence,
  -- and no row means UNKNOWN, not declined.
  status text not null default 'going' check (status in ('going', 'waitlist')),
  -- Waitlist order is signed_up_at, so a withdrawal needs no renumbering.
  signed_up_at timestamptz not null default now(),
  promoted_at timestamptz,
  added_by text,       -- set when an officer added them
  unique (signup_event_id, discord_id)
);

create index if not exists signup_entries_event_idx
  on signup_entries (signup_event_id, status, signed_up_at);
create index if not exists signup_entries_member_idx on signup_entries (discord_id);

-- ── CAP AND WAITLIST (was 013) ──────────────────────────────────────────────
-- Functions so each is one transaction: two people clicking the last slot at
-- once would otherwise both take it. `for update` on the signup_events row
-- serialises joins and withdrawals for that one occurrence only.
--
-- OUT params are named entry_status / promoted_id rather than status /
-- discord_id, because an ambiguous name resolves to the OUT param and silently
-- shadows the table column.

-- Promote from the waitlist until the cap is met. Callers hold the row lock.
-- With no free slots it returns nothing and demotes nobody — which is how
-- "lowering the cap applies to new joins only" falls out of the code.
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

  -- id breaks ties so entries stamped the same microsecond order deterministically.
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
    -- A double-click, or a button on an old message: report, don't error.
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

-- Withdraw, promoting the head of the waitlist if a committed slot opened.
-- Not gated on status = 'open': late cancellations are worth knowing about.
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

-- ── DAYLIGHT SAVING TOGGLE (was 035) ────────────────────────────────────────
-- The game's clock doesn't move for DST and the guild's does, so twice a year
-- every weekly event lands an hour off. guild_config.dst_active (01) is which
-- way the schedule reads; turning it off moves every weekly event an hour
-- EARLIER, turning it on moves them back.
--
-- One transaction for the flag, the schedule, and signups already opened for
-- nights still to come — their event_time and starts_at are snapshots, and
-- starts_at drives reminders. The flag flips compare-and-set, so two officers
-- pressing at once shift the schedule once. One-off signups keep their typed
-- times. An event within an hour of day_start can cross it and change nights.
create or replace function set_schedule_dst(p_active boolean)
returns jsonb
language plpgsql
as $$
declare
  v_mins int := case when p_active then 60 else -60 end;
  v_ids jsonb;
begin
  update guild_config set dst_active = p_active, updated_at = now()
  where id = 1 and dst_active is distinct from p_active;
  if not found then
    return jsonb_build_object('changed', false, 'signup_ids', '[]'::jsonb);
  end if;

  -- Minutes past midnight, shifted, then split back into a day and a time. An
  -- event pushed past midnight either way moves to the neighbouring day.
  update event_schedule s set
    day_of_week = (s.day_of_week + 7 + floor((t.m + v_mins) / 1440.0)::int) % 7,
    event_time  = to_char(make_interval(mins => ((t.m + v_mins) % 1440 + 1440) % 1440), 'HH24:MI')
  from (
    select id, extract(hour from event_time::time)::int * 60 + extract(minute from event_time::time)::int as m
    from event_schedule
    where event_time is not null
  ) t
  where s.id = t.id;

  -- Opened nights still to come. event_date (the night) stays put; the instant
  -- moves by exactly the shift.
  with moved as (
    update signup_events e set
      event_time = left(s.event_time::text, 5),
      starts_at  = e.starts_at + make_interval(mins => v_mins)
    from event_schedule s
    where e.event_schedule_id = s.id
      and s.event_time is not null
      and e.starts_at > now()
    returning e.id
  )
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_ids from moved;

  return jsonb_build_object('changed', true, 'signup_ids', v_ids);
end;
$$;

-- ── ONE-OFF TO WEEKLY (was 037) ─────────────────────────────────────────────
-- Makes a schedule entry from a one-off and attaches the one-off to it, so
-- people signed up stay signed up. Later one-offs with the same name (ignoring
-- case), time and night of the week join it too, one per night (the unique
-- index allows no more), and so does attendance logged for those nights —
-- otherwise each would show twice. One transaction.
--
-- The day of week is passed in: an after-midnight event is stored on the next
-- calendar day, and that rule already lives in backend/loa.js and timeUtils.js.
create or replace function make_signup_weekly(p_signup_id uuid, p_day_of_week int)
returns uuid
language plpgsql
as $$
declare
  v_ev signup_events%rowtype;
  v_id uuid := gen_random_uuid();
begin
  select * into v_ev from signup_events where id = p_signup_id for update;
  if not found then raise exception 'signup_not_found'; end if;
  if v_ev.event_schedule_id is not null then raise exception 'signup_already_weekly'; end if;

  insert into event_schedule (id, name, day_of_week, event_time, category)
  values (v_id, v_ev.title, p_day_of_week, left(v_ev.event_time, 5), v_ev.category);

  with linked as (
    update signup_events e set event_schedule_id = v_id, updated_at = now()
    where e.id in (
      select distinct on (s.event_date) s.id
      from signup_events s
      where s.event_schedule_id is null
        and (s.id = p_signup_id or (
          lower(trim(s.title)) = lower(trim(v_ev.title))
          and left(s.event_time, 5) is not distinct from left(v_ev.event_time, 5)
          and s.event_date > v_ev.event_date
          and extract(dow from s.event_date) = extract(dow from v_ev.event_date)
        ))
      order by s.event_date, (s.id = p_signup_id) desc, s.created_at
    )
    returning e.event_date
  )
  update events a set event_schedule_id = v_id
  where a.event_schedule_id is null
    and lower(trim(a.title)) = lower(trim(v_ev.title))
    and a.event_date in (select event_date from linked);

  return v_id;
end;
$$;
