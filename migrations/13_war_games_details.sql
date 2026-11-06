-- 13_war_games_details.sql — what a War Games night is played on, and under
-- which rules.
--
-- signup_events.war_maps: the map or maps for that night. Free text: officers
-- tick maps from War Record's wargame_maps list or type their own, and the
-- result is stored as the comma-separated text they see. Not a foreign key —
-- a map deleted from War Record later shouldn't blank a night already run.
--
-- signup_events.war_rules: the rules and limits for that night (gear limits,
-- class caps, anything else), shown as written.
--
-- Set per occurrence, like opponent_guild: each night has its own. The site
-- only offers them on War Games signups.
--
-- Saving maps or rules fails until this has run; nothing else reads them by
-- name, so the rest of the app is unaffected if it hasn't.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

alter table signup_events add column if not exists war_maps text;
alter table signup_events add column if not exists war_rules text;
