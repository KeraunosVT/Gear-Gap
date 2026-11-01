-- 10_event_schedule_biweekly.sql — scheduled events that run every other week.
--
-- interval_weeks: 1 is weekly (every row before this), 2 is every other week.
-- anchor_date: one guild NIGHT the event runs on, which fixes which weeks are
-- the on weeks. Only read when interval_weeks > 1; a weekly row leaves it null.
-- The night has to fall on the event's own night of the week — checked in
-- backend/admin.js, which already has the after-midnight rule to hand.
--
-- Nothing else moves. The DST toggle (05) can shift an event across day_start
-- onto the neighbouring night; the cadence check rounds to the nearest week, so
-- that doesn't flip which weeks it runs.
--
-- Weekly events still save without it, but adding or editing an every-other-
-- week one fails until this has run.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

alter table event_schedule add column if not exists interval_weeks int not null default 1;
alter table event_schedule add column if not exists anchor_date date;

alter table event_schedule drop constraint if exists event_schedule_interval_weeks_check;
alter table event_schedule add constraint event_schedule_interval_weeks_check
  check (interval_weeks >= 1 and (interval_weeks = 1 or anchor_date is not null));
