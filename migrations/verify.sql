-- verify.sql — "is this database where the repo thinks it is?"
--
-- Paste into the Supabase SQL editor and run. Every row should say `ok`.
-- Anything reading false means that file didn't take, in whole or part. Each
-- row is labelled with the migration file that creates the thing it checks.
--
-- Safe to run any number of times: it only reads catalog tables and changes
-- nothing. Not a migration — it has no number and never needs applying.
--
-- Add a row here whenever a migration adds a table, column, function or bucket,
-- so this stays the single answer to "did that one land?".

-- ── 01_guild_and_access ─────────────────────────────────────────────────────
select '01 · guild_config.loa_notify_discord_id' as item,
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'guild_config' and column_name = 'loa_notify_discord_id') = 1 as ok
union all
select '01 · guild_config.calendar_channel_id',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'guild_config' and column_name = 'calendar_channel_id') = 1
union all
select '01 · guild_config.dst_active',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'guild_config' and column_name = 'dst_active') = 1
union all

-- ── 02_gear_and_builds ──────────────────────────────────────────────────────
select '02 · gear_levels.source',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'gear_levels' and column_name = 'source') = 1
union all
select '02 · gear_level_history.source',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'gear_level_history' and column_name = 'source') = 1
union all
select '02 · gear_screenshots table',
       to_regclass('public.gear_screenshots') is not null
union all
-- Private is the whole access-control story for gear screenshots: the app
-- serves them through short-lived signed URLs from a gated route. A public
-- bucket makes every member's screenshot readable by anyone who can guess a
-- Discord id, and the route gating becomes decoration.
select '02 · gear bucket exists AND is private',
       (select count(*) from storage.buckets where id = 'gear' and public = false) = 1
union all
select '02 · builds, build_history tables',
       to_regclass('public.builds') is not null
       and to_regclass('public.build_history') is not null
union all

-- ── 03_loot ─────────────────────────────────────────────────────────────────
-- Potentials carry no grade and no sub-category. Without these two, every
-- potential upsert in the Questlog sync fails one row at a time.
select '03 · questlog_items.grade is nullable',
       (select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'questlog_items' and column_name = 'grade') = 'YES'
union all
select '03 · questlog_items.sub_category is nullable',
       (select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'questlog_items' and column_name = 'sub_category') = 'YES'
union all
select '03 · questlog_items.main_category index',
       (select count(*) from pg_indexes
        where schemaname = 'public' and indexname = 'questlog_items_main_category_idx') = 1
union all
select '03 · shard_weapon_ranking table',
       to_regclass('public.shard_weapon_ranking') is not null
union all

-- ── 04_attendance ───────────────────────────────────────────────────────────
select '04 · events.roster_id',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'events' and column_name = 'roster_id') = 1
union all
select '04 · events.party_layout',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'events' and column_name = 'party_layout') = 1
union all
select '04 · event_attendance.source',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'event_attendance' and column_name = 'source') = 1
union all
select '04 · late_attendance_requests table',
       to_regclass('public.late_attendance_requests') is not null
union all
-- Fails at RUNTIME rather than at migration time if wrong. The 5-argument
-- save_event must be gone before the 7-argument one exists: `create or replace`
-- cannot change a signature, so a skipped drop leaves BOTH defined, and every
-- attendance save then dies with PGRST203 "could not choose the best candidate
-- function". Exactly one, taking seven arguments, is the pass.
select '04 · save_event is the 7-arg version only',
       (select count(*) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'save_event') = 1
       and coalesce((select p.pronargs from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'save_event' limit 1), 0) = 7
union all
select '04 · attendance_history table',
       to_regclass('public.attendance_history') is not null
union all
select '04 · member_tenure table',
       to_regclass('public.member_tenure') is not null
union all
select '04 · member_tenure.discord_username',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'member_tenure' and column_name = 'discord_username') = 1
union all
-- Reads the constraint's text: the only catalog trace of which sources are
-- allowed. Without 'tlgm' every TLGM join date is refused at write time.
select '04 · member_tenure.source allows tlgm',
       coalesce((select pg_get_constraintdef(c.oid) ~ 'tlgm'
                 from pg_constraint c
                 where c.conrelid = to_regclass('public.member_tenure')
                   and c.conname = 'member_tenure_source_check'), false)
union all

-- ── 05_events_and_signups ───────────────────────────────────────────────────
-- Without this column every read of loa_entries in unavailableOn() fails, since
-- the select names it explicitly — so a missing column takes down the party
-- builder, the event page and the signup reminder sweep. `date[]`, not
-- `text[]`: a text column would accept "next tuesday" without complaint.
select '05 · loa_entries.skip_dates is date[]',
       (select data_type = 'ARRAY' and udt_name = '_date'
        from information_schema.columns
        where table_schema = 'public' and table_name = 'loa_entries'
          and column_name = 'skip_dates')
union all
select '05 · event_schedule.skip_dates is date[]',
       coalesce((select data_type = 'ARRAY' and udt_name = '_date'
        from information_schema.columns
        where table_schema = 'public' and table_name = 'event_schedule'
          and column_name = 'skip_dates'), false)
union all
select '05 · event_schedule.category, signup_events.category',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and column_name = 'category'
          and table_name in ('event_schedule', 'signup_events')) = 2
union all
select '05 · set_schedule_dst(boolean)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'set_schedule_dst' and p.pronargs = 1) = 1
union all
select '05 · make_signup_weekly(uuid, int)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'make_signup_weekly' and p.pronargs = 2) = 1
union all

-- ── 06_war_record ───────────────────────────────────────────────────────────
select '06 · wargame_matches.notes',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'wargame_matches' and column_name = 'notes') = 1
union all
select '06 · enemy_guild_aliases table',
       to_regclass('public.enemy_guild_aliases') is not null
union all
select '06 · enemy_player_aliases table',
       to_regclass('public.enemy_player_aliases') is not null
union all
-- Case-insensitive uniqueness on the alias. Without it `Vex` and `vex` can be
-- two rows pointing different ways, and the joins (which match on lower())
-- would resolve one of them arbitrarily.
select '06 · enemy_player_aliases unique on lower(alias)',
       (select count(*) from pg_indexes
        where schemaname = 'public' and indexname = 'enemy_player_aliases_alias_lower_idx') = 1
union all
select '06 · normalise_guild_name(text)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'normalise_guild_name') = 1
union all
select '06 · normalise_player_name(text)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'normalise_player_name') = 1
union all
-- Argument counts are checked, not just existence. Every function that means
-- "us" takes the guild alias list as a parameter on purpose — a zero-argument
-- version would be one with our names baked into its body, which is what stops
-- a page from following Guild Settings.
select '06 · get_guild_match_sides(text[])',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_match_sides' and p.pronargs = 1) = 1
union all
select '06 · get_guild_feuds(text[])',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_feuds' and p.pronargs = 1) = 1
union all
select '06 · get_guild_feud_matches(text[])',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_feud_matches' and p.pronargs = 1) = 1
union all
select '06 · get_guild_feud_coverage(text[])',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_feud_coverage' and p.pronargs = 1) = 1
union all
-- The rest are checked as "exactly one, with this many arguments", for the
-- PGRST203 trap described at save_event above: each replaced an earlier version
-- with a different argument list, and both left defined means every call fails.
select '06 · get_guild_feud_roster is the 3-arg version only',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_feud_roster') = 1
       and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_feud_roster' and p.pronargs = 3) = 1
union all
select '06 · get_player_guilds(text[], text)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_player_guilds' and p.pronargs = 2) = 1
union all
select '06 · get_player_search(text, int)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_player_search') = 1
union all
select '06 · get_guild_player_counts is the 1-arg version only',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_player_counts') = 1
       and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_player_counts' and p.pronargs = 1) = 1
union all
select '06 · get_player_stats is the 1-arg version only',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_player_stats') = 1
       and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_player_stats' and p.pronargs = 1) = 1
union all
select '06 · get_stats_summary is the 1-arg version only',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_stats_summary') = 1
       and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_stats_summary' and p.pronargs = 1) = 1
union all
-- A body-only check, so weaker than the rest: it asserts the case-insensitive
-- name resolution is spelled that way, not that it works. Silently keeping a
-- case-SENSITIVE join is what forks one player into two Roster rows.
select '06 · get_player_stats folds case when resolving names',
       coalesce((select p.prosrc ~ 'lower\(normalise_player_name'
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'get_player_stats'
                 limit 1), false)
union all

-- ── 07_loa_one_offs ─────────────────────────────────────────────────────────
select '07 · loa_entries.signup_event_id',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'loa_entries' and column_name = 'signup_event_id') = 1
union all

-- ── 08_build_class ──────────────────────────────────────────────────────────
select '08 · builds.class',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'builds' and column_name = 'class') = 1
union all

-- ── 09_build_key_stats_per_member ───────────────────────────────────────────
select '09 · builds.key_stats is text[]',
       coalesce((select data_type = 'ARRAY' and udt_name = '_text'
        from information_schema.columns
        where table_schema = 'public' and table_name = 'builds'
          and column_name = 'key_stats'), false)
union all
select '09 · guild-wide build_key_stats table is gone',
       to_regclass('public.build_key_stats') is null
union all

-- ── BASE SCHEMA ─────────────────────────────────────────────────────────────
-- Predates tracked migrations, so no file of its own. The whole shard wishlist
-- (weapons, need, priority, Last Updated) lives in this one column; anything
-- but json/jsonb would refuse or flatten it on save.
select 'base · shard_counts.shards is json',
       coalesce((select data_type in ('json', 'jsonb')
        from information_schema.columns
        where table_schema = 'public' and table_name = 'shard_counts'
          and column_name = 'shards'), false)
order by item;
