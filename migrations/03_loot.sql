-- 03_loot.sql — Lucent requests, currency, market prices, the item reference
-- table, and the shard weapon ranking.
--
-- Replaces archive/006, 007, 009, 010, 011, 017 and 034. See
-- 01_guild_and_access.sql for how these files work. Safe to re-run.

-- ── WHY A GRANT WAS GIVEN (was 006) ─────────────────────────────────────────
-- currency_awards is base schema. Nullable: routine grants needn't justify
-- themselves, and older rows predate the column.
alter table currency_awards add column if not exists reason text;

-- ── LUCENT REQUESTS (was 007, 009, 011) ─────────────────────────────────────
-- "This member asked for N Lucent to buy this item, and here's where that got
-- to" — distinct from the wishlist (wants it if it drops) and currency_awards
-- (was given N). Officers log these; there is no member-facing write path.
--
-- item_name is always filled, even when item_key points at the catalog — a
-- snapshot, so history reads correctly after an item is renamed or removed.
-- item_key, currency_award_id and potential_id are deliberately not foreign
-- keys: deleting a catalog item, revoking a grant or wiping market prices must
-- not fail or cascade into this ledger.
create table if not exists lucent_requests (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  display_name text,
  item_key text,
  item_name text not null,
  amount int not null check (amount > 0),
  note text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'paid')),
  requested_by text,
  requested_at timestamptz not null default now(),
  decided_by text,
  decided_at timestamptz,
  -- The currency_awards row created when the request was marked paid.
  currency_award_id uuid,
  -- Free text, not a fixed list: the categories officers use shift with the
  -- patch cycle. The form suggests values already in use.
  request_type text,
  -- tl-tracker's stable id for a potential, when the request is for one. Prices
  -- live in market_potentials below.
  potential_id int
);

create index if not exists lucent_requests_status_idx on lucent_requests (status, requested_at desc);
create index if not exists lucent_requests_discord_id_idx on lucent_requests (discord_id);
create index if not exists lucent_requests_potential_id_idx on lucent_requests (potential_id)
  where potential_id is not null;

-- ── MARKET PRICES (was 010) ─────────────────────────────────────────────────
-- Auction-house potential prices, written by the standalone scraper
-- (scrappers/index.js) on an officer's machine — it needs a logged-in
-- Playwright browser this app's host can't keep. The site only reads. One row
-- per region holding the whole snapshot, shape-agnostic on purpose; fetched_at
-- makes stale data visible.
create table if not exists market_potentials (
  region text primary key,
  items jsonb not null,
  item_count int not null default 0,
  fetched_at timestamptz not null default now()
);

-- ── ITEM REFERENCE TABLE (was 017) ──────────────────────────────────────────
-- questlog_items is base schema. Potentials live here beside items, told apart
-- by main_category = 'potential', with sub_category holding the gear type they
-- roll on. Potentials have no grade, and stat potentials belong to no single
-- gear type, so both columns accept null.
alter table questlog_items alter column grade drop not null;
alter table questlog_items alter column sub_category drop not null;

create index if not exists questlog_items_main_category_idx
  on questlog_items (main_category);

-- ── SHARD WEAPON RANKING (was 034) ──────────────────────────────────────────
-- The order officers want weapons' shards to go out in, across every boss —
-- beside each member's per-weapon priority in shard_counts, which ranks PEOPLE
-- within one weapon. `weapons` holds "boss|weapon" keys, the wishlist's key.
-- One row, enforced by the check.
create table if not exists shard_weapon_ranking (
  id smallint primary key default 1 check (id = 1),
  weapons text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table shard_weapon_ranking enable row level security;
