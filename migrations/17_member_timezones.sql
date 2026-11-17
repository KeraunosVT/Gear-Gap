-- 17_member_timezones.sql — each member's own timezone, so an LOA can be
-- entered in their local time and stored in the guild's.
--
-- The website knows a member's timezone from their browser and saves it here
-- whenever they visit. The /loa Discord command has no other way to learn it —
-- Discord doesn't tell bots where a user is — so this row is what lets "out
-- from 8pm" typed in Discord by someone in Chicago land as 9pm ET.
--
-- `timezone` is an IANA name ("America/Chicago"), validated by the backend
-- before it's written. A member with no row is read in guild time, as before.
--
-- Its own table rather than a column on member_roles: that table's row count
-- is read as "members with a role set" in places, and every website visit
-- would add a row to it.
--
-- Until this has run, LOAs still work: the website converts in the browser
-- regardless, and /loa falls back to guild time unless the `timezone` option
-- is passed. Safe to re-run. Run this in the Supabase SQL editor, then run
-- verify.sql.

create table if not exists member_timezones (
  discord_id text primary key,
  timezone text not null,
  updated_at timestamptz not null default now()
);

alter table member_timezones enable row level security;

-- The service role is the only client; 12_lock_down_anon.sql's default
-- privileges already keep anon and authenticated off new tables, and RLS with
-- no policies is the second lock.
