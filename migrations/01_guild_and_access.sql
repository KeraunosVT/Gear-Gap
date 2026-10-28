-- 01_guild_and_access.sql — guild settings, capabilities, and the admin audit log.
--
-- Replaces archive/001, 008, 014, 018, 032 and the guild_config column from 035.
-- The originals in migrations/archive/ keep the full reasoning; code comments
-- that say "migration 014" mean archive/014_guild_config.sql.
--
-- ── HOW THESE FILES WORK ────────────────────────────────────────────────────
-- 01–06 are the schema this repo adds, consolidated to its final state. They
-- sit on top of a base schema that was built by hand in Supabase before
-- migrations were tracked and was never committed (gear_levels, rosters,
-- event_schedule, events, event_attendance, wargame_matches, player_match_stats,
-- loa_entries, questlog_items, currency_awards, player_identities, shard_counts,
-- and the save_match() function).
--
-- Run them in order, in the Supabase SQL editor. Every statement is safe to
-- re-run, so a database that already ran the old archive/001–037 sequence needs
-- nothing from here — running them anyway changes nothing. Then run verify.sql.
--
-- New schema changes go in 07_, 08_, ...

-- ── AUDIT LOG (was 001) ─────────────────────────────────────────────────────
-- Every admin-area write. display_name is the actor's name AS OF the action,
-- frozen rather than re-resolved like loot_awards / loa_entries are.
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null,
  display_name text,
  method text not null,
  path text not null,       -- relative to /api/admin, e.g. "/loot/awards/abc-123"
  feature text,             -- human-readable label derived from the path prefix
  body jsonb,               -- sanitised req.body; empty for DELETEs, which identify
                            -- their target via req.params
  status_code int not null,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created_at_idx on audit_log (created_at desc);
create index if not exists audit_log_discord_id_idx on audit_log (discord_id);

-- ── CAPABILITIES (was 008) ──────────────────────────────────────────────────
-- Named capabilities granted to a Discord role (everyone holding it inherits)
-- or to one person. Roles are the main mechanism because they self-maintain;
-- per-person grants don't, so the UI flags grants whose subject has left.
-- subject_label is a display snapshot, not a key — it keeps a grant readable
-- after the role is deleted or the member leaves. Officer roles in guild_config
-- still grant everything, so an empty table changes nothing.
create table if not exists permission_grants (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('role', 'user')),
  subject_id text not null,
  subject_label text,
  permission text not null,
  granted_by text,
  granted_at timestamptz not null default now(),
  unique (subject_type, subject_id, permission)
);

create index if not exists permission_grants_subject_idx on permission_grants (subject_type, subject_id);

-- ── GUILD SETTINGS (was 014, 018, 032, 035) ─────────────────────────────────
-- Identity and Discord wiring, edited from Guild Settings instead of env vars
-- and bundled JSON — both need a redeploy to change. What stays in the
-- environment: DISCORD_BOT_TOKEN (a secret), DISCORD_CLIENT_ID (half of the
-- OAuth identity) and DISCORD_GUILD_ID (which server this hall IS).
--
-- New deployment: run this, then `node backend/scripts/seedConfigFromEnv.js`
-- in the deployment's own environment, check row 1, THEN deploy. Deploying
-- first leaves the bot with no channels and — because admin_role_ids gates the
-- admin area and allowed_role_ids gates login — nobody able to sign in.
--
-- One row, forever: `check (id = 1)` makes a second row an error at insert
-- time. Every read is `.eq('id', 1)`. guildConfig.js selects columns by name,
-- so a missing column fails the whole config load.
create table if not exists guild_config (
  id int primary key default 1 check (id = 1),

  -- `house` is the ceremonial name shown large, `tag` the in-game guild tag.
  house text not null default 'Gear Gap',
  tag text not null default 'Gear Gap',

  -- Every name this guild has played under, current tag included. server.js
  -- collapses them all onto `tag` so a rename doesn't split the war record.
  -- Removing one that history uses re-reads those matches as an enemy's, so
  -- guildSettings.js refuses that — in practice this list is append-only.
  aliases text[] not null default '{}',

  motto text,
  creed text,

  -- The guild-night model, mirrored in backend/loa.js and frontend/timeUtils.js.
  -- A night runs past midnight; day_start is where it rolls over.
  timezone text not null default 'America/New_York',
  day_start text not null default '01:00'
    check (day_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),

  -- admin_role_ids  — officer; every capability, present and future. Empty
  --                   fails closed (nobody is an officer), so saves refuse it.
  -- allowed_role_ids— may sign in at all. Empty means any server member.
  -- member_role_ids — counts as roster: parties, attendance, reminder fan-outs.
  admin_role_ids text[] not null default '{}',
  allowed_role_ids text[] not null default '{}',
  member_role_ids text[] not null default '{}',

  -- Text channels the bot posts into. Null disables that announcement.
  roster_channel_id text,
  loa_channel_id text,
  announce_channel_id text,
  -- Falls back to the announce channel when null (discordGateway.js).
  signup_channel_id text,
  -- The Event Calendar's "Post to Discord"; falls back to the signup channel.
  calendar_channel_id text,

  -- The one channel the bot READS: the voice channel /attendance snaps when
  -- nobody names another. A voice channel, so the settings page feeds it from
  -- listVoiceChannels(). Null means ask every time.
  attendance_voice_channel_id text,

  -- One member DMed whenever an LOA is cancelled (cancelling deletes the LOA
  -- post, so otherwise nothing records it). Null means nobody.
  loa_notify_discord_id text,

  -- Which way the weekly schedule currently reads for daylight saving. Only
  -- ever changed by set_schedule_dst (05_events_and_signups.sql), never by the
  -- settings form. True because the schedule was entered in summer time.
  dst_active boolean not null default true,

  updated_at timestamptz not null default now()
);

-- `do nothing` keeps a re-run from erroring, and from touching values the seed
-- script or the settings page already wrote.
insert into guild_config (id) values (1) on conflict (id) do nothing;

-- RLS on with no policies: only the server's service-role key reads this, which
-- matters here — the row holds role and channel ids the browser never sees.
alter table guild_config enable row level security;
