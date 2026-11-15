-- 16_shard_priority.sql — the Shards page's Priority tab: one combined list of
-- who gets shards next, the officers' order for the request tables beside it,
-- and their "still needs this many" confirmations.
--
-- ── shard_priority ──────────────────────────────────────────────────────────
-- One row, like shard_weapon_ranking (03_loot.sql). `requests` holds
-- "discordId|boss|weapon" keys — one member wanting one weapon — first gets the
-- next shard. Separate from shard_weapon_ranking, which orders WEAPONS across
-- every boss for the By Weapon tab; this orders PEOPLE across every shard.
--
-- weapon_order ({ boss: [weapon, ...] }) and boss_order are only how the
-- request tables are laid out. They decide nothing about who is paid.
--
-- posted_* is a copy of the list as it stood when it was last posted to
-- Discord, so the page can say "changed since" without guessing.
--
-- ── shard_need_confirmations ────────────────────────────────────────────────
-- An officer has checked with the member that they still need `need` shards
-- for that weapon. `need` is the figure confirmed, kept so a later change to
-- the wishlist shows the confirmation as stale rather than vouching for a
-- number nobody checked. A row per request, not a column on shard_counts:
-- members save their own wishlist rows, and an officer's tick must survive
-- that save untouched.
--
-- Not foreign keys: a member leaving or unlinking a weapon should leave the
-- page to drop the entry, not fail a delete somewhere else.
--
-- The Priority tab fails to load until this has run, so run it before
-- deploying the code that reads it.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

create table if not exists shard_priority (
  id smallint primary key default 1 check (id = 1),
  requests text[] not null default '{}',
  weapon_order jsonb not null default '{}'::jsonb,
  boss_order text[] not null default '{}',
  posted_requests text[],
  posted_at timestamptz,
  posted_by text,
  posted_by_name text,
  posted_channel_id text,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table shard_priority enable row level security;

create table if not exists shard_need_confirmations (
  discord_id text not null,
  boss text not null,
  weapon text not null,
  need int not null check (need >= 0),
  confirmed_by text not null,
  confirmed_by_name text,
  confirmed_at timestamptz not null default now(),
  primary key (discord_id, boss, weapon)
);

alter table shard_need_confirmations enable row level security;

-- The service role is the only client; 12_lock_down_anon.sql's default
-- privileges already keep anon and authenticated off new tables, and RLS with
-- no policies is the second lock.
