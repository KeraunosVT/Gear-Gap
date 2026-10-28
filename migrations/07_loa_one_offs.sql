-- 07_loa_one_offs.sql — an LOA for one one-off event.
--
-- A weekly event's LOA is scoped by its schedule id. A one-off has none, so the
-- calendar used to scope its LOA by a one-minute window at the event's start
-- time. That broke three ways: a one-off with no time couldn't take an LOA at
-- all, editing the one-off's time orphaned the LOA, and two one-offs at the
-- same time on one night couldn't be told apart.
--
-- signup_event_id points the LOA at the occurrence itself instead. Set, it
-- covers that occurrence and nothing else; asked about the whole night with no
-- event picked, it counts like any other event-scoped LOA. See matchUnavailable
-- in backend/loa.js and loaCovers in frontend/src/timeUtils.js.
--
-- Cascade: deleting the one-off deletes the LOA, which was only ever about it.
-- Still valid after the one-off is made weekly — it keeps the same signup row.
--
-- RUN THIS BEFORE DEPLOYING the code that reads it: loa.js selects this column
-- by name, so without it every LOA lookup fails.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

alter table loa_entries add column if not exists signup_event_id uuid
  references signup_events (id) on delete cascade;

create index if not exists loa_entries_signup_event_idx on loa_entries (signup_event_id)
  where signup_event_id is not null;
