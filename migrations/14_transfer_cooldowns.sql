-- 14_transfer_cooldowns.sql — each member's server transfer cooldown.
--
-- One row per member, replaced whenever they update it. Members enter the time
-- the game shows as left (days and hours, 30 days at most); the backend turns
-- that into ends_at, so the site can count down without anyone re-entering it.
-- A finished cooldown stays listed as "Ready" for a week, then drops off the
-- page (the row itself is simply overwritten the next time they enter one).
--
-- Locked down like every other table (migration 12): RLS on with no policies,
-- nothing granted to anon or authenticated. Only the backend's service key
-- reads or writes it.
--
-- The page shows an error until this has run; nothing else reads the table.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

create table if not exists transfer_cooldowns (
  discord_id text primary key,
  display_name text not null default '',
  ends_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table transfer_cooldowns enable row level security;
revoke all on transfer_cooldowns from anon, authenticated;
