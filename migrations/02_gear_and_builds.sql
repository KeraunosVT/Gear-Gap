-- 02_gear_and_builds.sql — gear levels, equipment screenshots, and stat builds.
--
-- Replaces archive/002, 003, 016 and 033. See 01_guild_and_access.sql for how
-- these files work. Safe to re-run.

-- ── CURRENT GEAR LEVEL (was 002, 016) ───────────────────────────────────────
-- gear_levels is base schema: one current row per member.
--
-- maxed_at: when the member FIRST reached 80/80/80, so members tied at the cap
-- rank by who got there first instead of reshuffling.
--
-- source: which upload produced the row. 'popup' is the Equipment Level popup,
-- the only thing that sets a gear level now. 'window' is historical — the full
-- equipment window used to be parsed with Heroic items excluded; nothing writes
-- it any more, but rows that have it were measured by that rule.
alter table gear_levels add column if not exists maxed_at timestamptz;
alter table gear_levels add column if not exists source text not null default 'popup';

-- ── EVERY SUBMISSION (was 003, 016) ─────────────────────────────────────────
-- Append-only, beside gear_levels' latest-only snapshot.
create table if not exists gear_level_history (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  display_name text,
  weapon int not null,
  armor int not null,
  accessory int not null,
  average int not null,
  source text not null default 'popup',
  submitted_at timestamptz not null default now()
);

create index if not exists gear_level_history_discord_id_idx on gear_level_history (discord_id, submitted_at desc);

-- ── EQUIPMENT WINDOW SCREENSHOT (was 016) ───────────────────────────────────
-- One row per member, replaced on re-upload. Filed as evidence and no longer
-- parsed: items / weapon / armor / accessory / average / excluded_count are
-- written empty on every upload, and kept only because rows from before that
-- change still carry a parse worth looking at.
create table if not exists gear_screenshots (
  discord_id text primary key,
  display_name text,
  -- Path in the private 'gear' bucket, never a URL: a public URL would be
  -- wrong, and a signed one is a link that expires while looking like data.
  storage_path text not null,
  items jsonb not null default '[]',   -- [{ slot, name, category, tier, level, excluded }]
  weapon int,
  armor int,
  accessory int,
  average int,
  excluded_count int not null default 0,
  submitted_at timestamptz not null default now()
);

alter table gear_screenshots enable row level security;

-- PRIVATE is the whole access-control story: the app serves these through
-- short-lived signed URLs from a route that checks the viewer is the member or
-- an officer. (The opposite of the 'assets' bucket, which is public on purpose.)
-- No storage policies — the server's service-role key bypasses RLS.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gear', 'gear', false, 15728640, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- ── STAT BUILDS (was 033) ───────────────────────────────────────────────────
-- A member's PvE and PvP builds, read from seven character-window screenshots.
-- Which build it is comes from the member's choice at upload, never the image.
-- See backend/builds.js.
--
-- One row per member per kind, latest wins. `stats` is { stat_id: number } as
-- the game shows it (96.5 for "+96.5%"), not shared/stats.json's fixed-point;
-- units live in shared/buildStats.json. PvP stats are the bonus the PvP tab
-- shows. `flags` is { stat_id: note } for values the reader wasn't sure of,
-- cleared once someone corrects or confirms them.
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

-- One row per save that changed something. upload = first build of this kind,
-- scan = new screenshots replaced it, edit = someone typed a value in.
-- `changes` is [{ id, from, to }]; a first upload stores none.
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

-- Key stats were a guild-wide build_key_stats table here; they're per build
-- now, in builds.key_stats (09_build_key_stats_per_member.sql).

alter table builds enable row level security;
alter table build_history enable row level security;
