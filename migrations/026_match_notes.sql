-- 026_match_notes.sql — free-text notes on a war record match.
--
-- For anything the scoreboard can't say: a different rule set, a short-handed
-- night, a match that was a scrim rather than a real fight. Shown on the match
-- page so nobody reads the numbers without the context.
--
-- Written by backend/admin.js with a plain UPDATE after save_match() returns,
-- not through save_match() itself. That function predates tracked migrations
-- (see 001's header) so its body isn't in this repo, and redefining it blind to
-- add one parameter risks breaking every match upload. Notes are context, not
-- stats, so a save that lands the players but not the note is reported to the
-- officer rather than rolled back.
--
-- Nullable, no default: an absent note and an empty note mean the same thing,
-- and the backend stores both as null.
--
-- Run this in the Supabase SQL editor.

alter table public.wargame_matches
  add column if not exists notes text;
