-- 015_attendance_revamp.sql — time windows, late requests, and frozen parties.
--
-- Run this in the Supabase SQL editor, AFTER 014_guild_config.sql (the
-- attendance voice channel is a column there, not here).
--
-- Idempotent apart from the function replacement at the bottom, which is
-- written to be safely re-runnable too.

-- ── THE PARTY THE NIGHT ACTUALLY RAN WITH ───────────────────────────────────
-- Two columns, because they answer two different questions.
--
-- roster_id is a breadcrumb: which saved roster was this built from. It is
-- nullable and ON DELETE SET NULL, because deleting a roster must not delete
-- the history of nights that used it.
--
-- party_layout is the record. It is a COPY of rosters.layout taken when
-- attendance was saved, not a join. Rosters are living documents — officers
-- reshuffle them week to week and the party builder saves over them — so a
-- join would make last month's event silently start displaying this month's
-- party, and there would be no way to notice. A record of what happened is not
-- a live view of configuration.
--
-- TEXT, not uuid. `rosters` predates the tracked migrations (see the header of
-- 001) and its primary key is text, even though admin.js fills it with
-- crypto.randomUUID(). Declaring this uuid is refused outright — "Key columns
-- roster_id and id are of incompatible types" — so the reference matches the
-- type that is actually there rather than the one the values look like.
alter table events add column if not exists roster_id text references rosters (id) on delete set null;
alter table events add column if not exists party_layout jsonb;

-- ── HOW AN ATTENDANCE ROW GOT HERE ──────────────────────────────────────────
-- 'snapshot' — read out of a voice channel when attendance was taken.
-- 'late'     — added afterwards by an officer approving a late request.
--
-- Stored explicitly rather than inferred from joined_at. A snapshot stamps one
-- identical timestamp on every row, so "later than its siblings" LOOKS like a
-- reliable tell — until someone re-snaps a channel, or a backfill rewrites the
-- column, and every past late approval quietly becomes indistinguishable.
--
-- NOT NULL with a default, so existing rows are correct without a backfill:
-- everything written before this migration came from a voice snapshot.
alter table event_attendance add column if not exists source text not null default 'snapshot';

-- ── LATE ATTENDANCE REQUESTS ────────────────────────────────────────────────
-- A member who was there but isn't in the snapshot asks to be added; an officer
-- decides. The request is KEPT after the decision rather than deleted — "who
-- has been asking every week" and "who turned them down" are the questions this
-- table exists to answer, and both are gone if a denial deletes the row.
--
-- attendance_id points at the event_attendance row an approval created, so an
-- approval can be traced to its cause (and a re-run can tell it already did the
-- work). Deliberately NOT a foreign key: an officer deleting an attendance row
-- must not cascade into the decision record that explains it.
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

-- The officer queue's query: pending requests, newest first.
create index if not exists late_requests_status_idx
  on late_attendance_requests (status, requested_at desc);

-- The member's own history, for "have I already asked about this one".
create index if not exists late_requests_discord_idx
  on late_attendance_requests (discord_id, requested_at desc);

-- One LIVE ask per person per event — a partial index, so a decided request
-- doesn't block a re-ask (a denial that was a misunderstanding should be
-- appealable). This index IS the duplicate check: doing it with a SELECT first
-- would lose the race between two clicks on a slow connection, which is exactly
-- how double-submits happen. The code maps 23505 to a 409.
create unique index if not exists late_requests_one_pending_idx
  on late_attendance_requests (event_id, discord_id) where status = 'pending';

alter table late_attendance_requests enable row level security;

-- ── save_event GAINS THE FROZEN PARTY ───────────────────────────────────────
-- The two new events columns above have to be written inside the same
-- transaction as the event and its attendance rows, which means they have to be
-- parameters of this function. createEvent() calls the RPC — there is no insert
-- to add them to.
--
-- WHY THE DROP. `create or replace function` cannot change a function's
-- argument list; adding parameters creates a second OVERLOAD alongside the old
-- one. PostgREST resolves overloads by the set of named arguments in the body,
-- and with one signature a strict subset of the other it cannot choose — every
-- call would fail with PGRST203 "Could not choose the best candidate function".
-- So the 5-argument version has to go before the 7-argument one arrives.
--
-- The two new parameters DEFAULT NULL, so any caller still passing five
-- arguments keeps working and means "no party recorded".
drop function if exists save_event(uuid, text, date, uuid, jsonb);

create or replace function save_event(
  p_id uuid,
  p_title text,
  p_event_date date,
  p_event_schedule_id uuid,
  p_attendees jsonb,
  -- text, matching events.roster_id and rosters.id — see the note above.
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

  -- gen_random_uuid() per row and now() for joined_at, so the caller doesn't
  -- have to mint ids client-side the way the two-insert version did.
  --
  -- source is left to its column default ('snapshot'). Everything created
  -- through this path IS a snapshot; the only writer of 'late' is the late
  -- request approval, which inserts one row directly.
  insert into event_attendance (id, event_id, discord_id, display_name, joined_at)
  select gen_random_uuid(), p_id, a->>'id', left(coalesce(a->>'name', ''), 120), now()
  from jsonb_array_elements(p_attendees) as a;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- ── WINDOWED QUERIES ────────────────────────────────────────────────────────
-- Both the event list and the attendance-rate table filter on event_date now
-- (?window=7|14|30|all). Without this the 30-day default scans every event the
-- guild has ever run to return the last dozen.
create index if not exists events_event_date_idx on events (event_date desc);
