-- 15_roster_one_off_events.sql — link a saved roster to a one-off event.
--
-- A roster already records its night (event_date) and, for a weekly event,
-- event_schedule_id (migration 04). One-off events have no schedule row, so a
-- roster built for one only kept its night, and the Parties board couldn't
-- open it again when that event was picked. signup_event_id is that link.
--
-- Set null (not cascade) if the one-off is deleted: the roster still belongs
-- to its night and stays in the saved list.
--
-- Saving and listing rosters fail until this has run, so run it before
-- deploying the code that reads it.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

alter table rosters add column if not exists signup_event_id uuid
  references signup_events (id) on delete set null;
