-- verify.sql — "is this database where the repo thinks it is?"
--
-- Paste into the Supabase SQL editor and run. Every row should say `ok`.
-- Anything reading MISSING means that migration didn't take, in whole or part.
--
-- Safe to run any number of times: it only reads catalog tables and changes
-- nothing. Not a migration — it has no number and never needs applying.
--
-- Add a row here whenever a migration adds a table, column, function or bucket,
-- so this stays the single answer to "did that one land?".

select '015 · events.roster_id' as item,
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'events' and column_name = 'roster_id') = 1 as ok
union all
select '015 · events.party_layout',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'events' and column_name = 'party_layout') = 1
union all
select '015 · event_attendance.source',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'event_attendance' and column_name = 'source') = 1
union all
select '015 · late_attendance_requests table',
       to_regclass('public.late_attendance_requests') is not null
union all
-- The one most likely to be half-applied, and the only one that fails at
-- RUNTIME rather than at migration time. 015 must DROP the 5-argument
-- save_event before creating the 7-argument one: `create or replace` cannot
-- change a signature, so a skipped drop leaves BOTH defined, and every
-- attendance save then dies with PGRST203 "could not choose the best
-- candidate function". Exactly one, taking seven arguments, is the pass.
select '015 · save_event is the 7-arg version only',
       (select count(*) from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'save_event') = 1
       and coalesce((select p.pronargs from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'save_event' limit 1), 0) = 7
union all
select '016 · gear_levels.source',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'gear_levels' and column_name = 'source') = 1
union all
select '016 · gear_level_history.source',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'gear_level_history' and column_name = 'source') = 1
union all
select '016 · gear_screenshots table',
       to_regclass('public.gear_screenshots') is not null
union all
-- Private is the whole access-control story for gear screenshots: the app
-- serves them through short-lived signed URLs from a gated route. A public
-- bucket makes every member's screenshot readable by anyone who can guess a
-- Discord id, and the route gating becomes decoration.
select '016 · gear bucket exists AND is private',
       (select count(*) from storage.buckets where id = 'gear' and public = false) = 1
union all
-- Potentials carry no grade and no sub-category. Without these two, every
-- potential upsert in the Questlog sync fails one row at a time.
select '017 · questlog_items.grade is nullable',
       (select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'questlog_items' and column_name = 'grade') = 'YES'
union all
select '017 · questlog_items.sub_category is nullable',
       (select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'questlog_items' and column_name = 'sub_category') = 'YES'
union all
select '017 · questlog_items.main_category index',
       (select count(*) from pg_indexes
        where schemaname = 'public' and indexname = 'questlog_items_main_category_idx') = 1
union all
select '018 · guild_config.loa_notify_discord_id',
       (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'guild_config' and column_name = 'loa_notify_discord_id') = 1
union all
select '019 · enemy_guild_aliases table',
       to_regclass('public.enemy_guild_aliases') is not null
union all
-- Argument counts are checked, not just existence. Every one of these takes the
-- guild alias list as a parameter on purpose — a zero-argument version would be
-- one with our names baked into its body, which is the thing that stops
-- get_player_stats() from following Guild Settings.
select '019 · get_guild_match_sides(text[])',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_match_sides' and p.pronargs = 1) = 1
union all
select '019 · get_guild_feuds(text[])',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_feuds' and p.pronargs = 1) = 1
union all
select '019 · get_guild_feud_matches(text[])',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_feud_matches' and p.pronargs = 1) = 1
union all
select '019 · get_guild_feud_coverage(text[])',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_feud_coverage' and p.pronargs = 1) = 1
union all
select '019 · get_guild_feud_roster(text[], text)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_guild_feud_roster' and p.pronargs = 2) = 1
union all
-- 020 widens get_guild_feud_roster's RETURNS TABLE, which verify.sql cannot
-- inspect — the manual check in the plan covers the column list. What it can
-- hold is that the two new lookup functions exist with the right arity.
select '020 · get_player_guilds(text[], text)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_player_guilds' and p.pronargs = 2) = 1
union all
select '020 · get_player_search(text, int)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'get_player_search') = 1
union all
select '021 · enemy_player_aliases table',
       to_regclass('public.enemy_player_aliases') is not null
union all
-- Case-insensitive uniqueness on the alias. Without it `Vex` and `vex` can be
-- two rows pointing different ways, and the joins (which match on lower())
-- would resolve one of them arbitrarily.
select '021 · enemy_player_aliases unique on lower(alias)',
       (select count(*) from pg_indexes
        where schemaname = 'public' and indexname = 'enemy_player_aliases_alias_lower_idx') = 1
union all
select '021 · normalise_player_name(text)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'normalise_player_name') = 1
union all
select '019 · normalise_guild_name(text)',
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'normalise_guild_name') = 1
order by item;
