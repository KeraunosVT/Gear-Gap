-- 027_attendance_history.sql — attendance carried over from another tracker.
--
-- The guild tracked attendance in TLGM before this app. TLGM's export is a
-- per-member SUMMARY ("attended 496 of 775 activities"), not a per-night log,
-- so there is nothing to build events or event_attendance rows from. This holds
-- those totals as they came, beside the app's own record rather than inside it.
--
-- Added to the app's own attendance only in the Attendance page's All-Time
-- column, never in the dated windows (TLGM has no dates to filter by). The sum
-- assumes TLGM and this app never logged the same night — true for this guild,
-- since TLGM covers the time before the app.
--
-- One row per member per source. A re-import replaces the source's rows
-- outright, because TLGM's numbers are cumulative — a newer export supersedes
-- the older one rather than adding to it.
--
-- `total` is the member's own denominator. TLGM counts activities from when
-- each person joined, so it differs per member; the rate is attended / total.
--
-- Run this in the Supabase SQL editor.

create table if not exists attendance_history (
  source text not null default 'tlgm',
  discord_id text not null,
  display_name text,
  -- The name the source knew them by, kept for reference: it is how an officer
  -- recognises a row in the original file.
  source_name text,
  attended int not null check (attended >= 0),
  total int not null check (total >= 0 and attended <= total),
  imported_at timestamptz not null default now(),
  imported_by text,
  primary key (source, discord_id)
);

alter table attendance_history enable row level security;
