-- 028_member_tenure.sql — when each member got the Guild Member role.
--
-- Discord stores no role-grant date, so the app records its own: an hourly
-- sweep stamps `since` the first time someone appears with a member role, and
-- `left_at` once they lose it. Every attendance rate counts only nights inside
-- that stretch. See backend/memberTenure.js.
--
-- `source` says how good `since` is:
--   audit_log    the grant itself, from the server audit log (last 45 days)
--   discord_join when they joined the server — a backfill for anyone older
--   sweep        the sweep that first saw them
--
-- One row per member. Coming back after leaving overwrites the row with the new
-- stretch; the nights in between were never theirs to attend.
--
-- Until this runs, the app reads every rate the old way (all nights count).
--
-- Run this in the Supabase SQL editor.

create table if not exists member_tenure (
  discord_id text primary key,
  since timestamptz not null,
  source text not null check (source in ('audit_log', 'discord_join', 'sweep')),
  left_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table member_tenure enable row level security;
