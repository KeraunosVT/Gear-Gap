-- 030_member_tenure_username.sql — a readable name on each member_tenure row.
--
-- member_tenure is keyed by Discord id, which is unreadable when checking or
-- hand-fixing a join date in the SQL editor. This adds the account handle
-- (the same "Discord Username" TLGM's export uses). The hourly sweep fills it
-- in for every current member and updates it when someone renames; a member
-- who has left keeps the last name they had.
--
-- A label only: nothing joins or matches on it — the id is the key. Until this
-- runs, the sweep records dates without names and every rate works the same.
--
-- Run this in the Supabase SQL editor.

alter table member_tenure add column if not exists discord_username text;
