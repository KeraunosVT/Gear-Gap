-- 034_shard_weapon_ranking.sql — the guild's order of weapons for shards.
--
-- Officers drag weapons into the order the guild wants their shards to go
-- out: first in the list, first served. It sits beside each member's per-weapon
-- priority (shard_counts.shards → weapons[].priority), which ranks PEOPLE
-- within one weapon; this ranks the WEAPONS themselves, across every boss.
--
-- `weapons` holds "boss|weapon" keys, the same key the wishlist uses, e.g.
-- 'Tevent|Warblade of Incineration'. Officers-only to read, like the priorities.
--
-- One row, enforced by the check, so there is never a question of which
-- ranking is current.
--
-- Run this in the Supabase SQL editor.

create table if not exists shard_weapon_ranking (
  id smallint primary key default 1 check (id = 1),
  weapons text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table shard_weapon_ranking enable row level security;
