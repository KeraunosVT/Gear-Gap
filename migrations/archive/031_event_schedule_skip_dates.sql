-- 031_event_schedule_skip_dates.sql — per-night exceptions for a weekly event.
--
-- The same shape as 022 (loa_entries.skip_dates), for the same reason: a
-- schedule entry is a standing rule ("Siege every Saturday"), and the only
-- thing you could do to it was delete it. Cancelling one Saturday shouldn't
-- cost every Saturday.
--
-- Dates are guild NIGHTS, the same key signup_events.event_date uses — a
-- 12:30 AM event stored on Sunday is skipped by naming Saturday.
--
-- Not pruned of past dates, so a cancelled night stays cancelled in history.
--
-- Run this in the Supabase SQL editor.

alter table event_schedule
  add column if not exists skip_dates date[] not null default '{}';
