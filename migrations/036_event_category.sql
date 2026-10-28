-- 036_event_category.sql — an event's type, picked when it is made.
--
-- The calendar coloured events by guessing from the name ("Arch Boss —
-- Morokai" is an Arch Boss), which can't place a name that doesn't say what it
-- is. Now the type can be picked when the event is added.
--
-- Null means "work it out from the name", which is what every existing row
-- keeps doing. The value is a key from frontend/src/eventCategories.js
-- (arch_boss, siege, ...); a key the frontend doesn't know falls back to the
-- name too, so retiring a category later never breaks a row that has it.
--
-- signup_events gets its own copy for the same reason it has title and
-- event_time (013): an occurrence outlives a deleted schedule row, and should
-- keep its colour when it does.
--
-- RUN THIS BEFORE DEPLOYING the code that writes it: opening a signup inserts
-- this column by name, so without it every signup open fails.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

alter table event_schedule add column if not exists category text;
alter table signup_events add column if not exists category text;
