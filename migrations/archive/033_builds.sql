-- 033_builds.sql — members' PvE and PvP stat builds, read from screenshots.
--
-- A member uploads the character stats window (seven screenshots: the combat
-- panel scrolled twice, the weapon panel, and the Basic, Status, Boss and PvP
-- tabs) once as their PvE build and once as their PvP build. The screenshots
-- look the same either way, so which build it is comes from the member's
-- choice at upload, never from the image. See backend/builds.js.
--
-- Run this in the Supabase SQL editor.

-- ── THE CURRENT BUILDS ──────────────────────────────────────────────────────
-- One row per member per kind, replaced on every save: "latest wins", the same
-- shape as gear_levels. The history below is what keeps the older numbers.
--
-- `stats` is { stat_id: number } with the numbers exactly as the game shows
-- them — 96.5 for "+96.5%", 0.392 for "0.392s" — NOT the internal fixed-point
-- values in shared/stats.json. The units live in shared/buildStats.json.
-- PvP stats are stored as the bonus the PvP tab shows; the page adds the base
-- stat to show the total against players.
--
-- `flags` is { stat_id: note } for values the reader wasn't sure of (a clipped
-- row, an impossible negative, two screenshots disagreeing). Cleared per stat
-- once someone corrects or confirms it.
create table if not exists builds (
  discord_id text not null,
  kind text not null check (kind in ('pve', 'pvp')),
  display_name text,
  stats jsonb not null default '{}'::jsonb,
  flags jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (discord_id, kind)
);

-- ── EVERY CHANGE TO A BUILD ─────────────────────────────────────────────────
-- Backs "Last updated" and the history list on the build page. A row per save
-- that changed something; a save that changed nothing writes nothing.
--
--   upload  the member's first build of this kind
--   scan    a new set of screenshots replaced it
--   edit    someone typed a value in — usually an officer fixing a misread
--
-- `changes` is [{ id, from, to }], with null for a stat that was added or
-- dropped. A first upload stores none: every stat is new, and listing 112 of
-- them says nothing the build itself doesn't.
create table if not exists build_history (
  id bigserial primary key,
  discord_id text not null,
  kind text not null check (kind in ('pve', 'pvp')),
  how text not null check (how in ('upload', 'scan', 'edit')),
  changes jsonb not null default '[]'::jsonb,
  changed_count integer not null default 0,
  changed_by text,
  changed_by_name text,
  changed_at timestamptz not null default now()
);
create index if not exists build_history_member_idx on build_history (discord_id, kind, changed_at desc);

-- ── THE GUILD'S KEY STATS ───────────────────────────────────────────────────
-- What officers pin to the top of every member's build, separately for PvE and
-- PvP, in the order they dragged them into. One row per kind.
create table if not exists build_key_stats (
  kind text primary key check (kind in ('pve', 'pvp')),
  stat_ids text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table builds enable row level security;
alter table build_history enable row level security;
alter table build_key_stats enable row level security;
