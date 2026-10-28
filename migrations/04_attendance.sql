-- 04_attendance.sql — attendance events, late requests, saved rosters, imported
-- history and member tenure.
--
-- Replaces archive/004, 012, 015, 027, 028, 029 and 030. See
-- 01_guild_and_access.sql for how these files work. Safe to re-run.

-- ── WHAT A SAVED ROSTER WAS FOR (was 004) ───────────────────────────────────
-- rosters is base schema. Binding a roster to its night (and optionally one
-- scheduled event) lets loading it re-check LOA against that occasion rather
-- than "today". Null event_schedule_id means the whole night.
alter table rosters add column if not exists event_date date;
alter table rosters add column if not exists event_schedule_id uuid
  references event_schedule (id) on delete set null;

-- ── THE PARTY A NIGHT RAN WITH (was 015) ────────────────────────────────────
-- events is base schema. roster_id is a breadcrumb (set null if the roster is
-- deleted); party_layout is the record — a COPY of rosters.layout taken when
-- attendance was saved, because rosters are living documents and a join would
-- show last month's night with this month's party.
--
-- roster_id is TEXT: rosters.id is text in the base schema even though it holds
-- UUIDs, and a uuid column is refused as an incompatible key type.
alter table events add column if not exists roster_id text references rosters (id) on delete set null;
alter table events add column if not exists party_layout jsonb;

-- The event list and attendance-rate windows filter on event_date.
create index if not exists events_event_date_idx on events (event_date desc);

-- How an attendance row got here: 'snapshot' (read from a voice channel) or
-- 'late' (an officer approved a late request). Stored, not inferred from
-- joined_at, which a re-snap or backfill would scramble.
alter table event_attendance add column if not exists source text not null default 'snapshot';

-- ── SAVING A NIGHT (was 012, 015) ───────────────────────────────────────────
-- The event and its attendance rows in one transaction, so a failure can't
-- leave an event with zero attendees and no trail.
--
-- The old 5-argument version must not exist beside this one: PostgREST can't
-- choose between overloads where one is a subset of the other, and every call
-- fails with PGRST203. verify.sql checks only the 7-argument one exists.
drop function if exists save_event(uuid, text, date, uuid, jsonb);

create or replace function save_event(
  p_id uuid,
  p_title text,
  p_event_date date,
  p_event_schedule_id uuid,
  p_attendees jsonb,
  -- text, matching events.roster_id and rosters.id — see above.
  p_roster_id text default null,
  p_party_layout jsonb default null
) returns int
language plpgsql
as $$
declare
  v_inserted int;
begin
  insert into events (id, title, event_date, event_schedule_id, roster_id, party_layout, created_at)
  values (p_id, p_title, p_event_date, p_event_schedule_id, p_roster_id, p_party_layout, now());

  -- source is left to its default ('snapshot'): everything created here IS a
  -- snapshot. The only writer of 'late' is the late-request approval.
  insert into event_attendance (id, event_id, discord_id, display_name, joined_at)
  select gen_random_uuid(), p_id, a->>'id', left(coalesce(a->>'name', ''), 120), now()
  from jsonb_array_elements(p_attendees) as a;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- ── LATE ATTENDANCE REQUESTS (was 015) ──────────────────────────────────────
-- A member who was there but missed the snapshot asks to be added; an officer
-- decides. Kept after the decision — "who keeps asking" and "who turned them
-- down" are what this table answers. attendance_id points at the row an
-- approval created, deliberately not a foreign key so deleting attendance
-- can't cascade into the decision record.
create table if not exists late_attendance_requests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  discord_id text not null,
  display_name text,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  requested_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  attendance_id uuid
);

create index if not exists late_requests_status_idx
  on late_attendance_requests (status, requested_at desc);
create index if not exists late_requests_discord_idx
  on late_attendance_requests (discord_id, requested_at desc);

-- One LIVE ask per person per event. This index IS the duplicate check — a
-- SELECT first would lose the race between two clicks. The code maps 23505 to
-- a 409. Partial, so a denied request can be asked again.
create unique index if not exists late_requests_one_pending_idx
  on late_attendance_requests (event_id, discord_id) where status = 'pending';

alter table late_attendance_requests enable row level security;

-- ── IMPORTED HISTORY (was 027) ──────────────────────────────────────────────
-- Per-member totals from TLGM, the tracker used before this app. A summary,
-- not a per-night log, so it is added only to the All-Time column. A re-import
-- replaces a source's rows (TLGM's numbers are cumulative). `total` is the
-- member's own denominator — TLGM counts from when each person joined.
create table if not exists attendance_history (
  source text not null default 'tlgm',
  discord_id text not null,
  display_name text,
  source_name text,     -- the name the source knew them by
  attended int not null check (attended >= 0),
  total int not null check (total >= 0 and attended <= total),
  imported_at timestamptz not null default now(),
  imported_by text,
  primary key (source, discord_id)
);

alter table attendance_history enable row level security;

-- ── MEMBER TENURE (was 028, 029, 030) ───────────────────────────────────────
-- When each member got the Guild Member role. Discord stores no grant date, so
-- an hourly sweep records `since` and `left_at`; attendance rates count only
-- nights inside that stretch. See backend/memberTenure.js.
--
-- source says how good `since` is: tlgm (TLGM's Join Date), audit_log (the
-- grant itself, last 45 days), discord_join (server join, a backfill) or sweep
-- (when the sweep first saw them). discord_username is a label for reading the
-- table by hand; nothing joins on it.
create table if not exists member_tenure (
  discord_id text primary key,
  since timestamptz not null,
  source text not null,
  left_at timestamptz,
  discord_username text,
  updated_at timestamptz not null default now()
);

alter table member_tenure drop constraint if exists member_tenure_source_check;
alter table member_tenure add constraint member_tenure_source_check
  check (source in ('tlgm', 'audit_log', 'discord_join', 'sweep'));

alter table member_tenure enable row level security;
