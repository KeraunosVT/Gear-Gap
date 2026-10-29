-- 09_build_key_stats_per_member.sql — key stats belong to each build.
--
-- Key stats were one list per build type for the whole guild
-- (build_key_stats). They're now picked per member per build, by officers
-- with 'builds', and stored on the build itself: key_stats is that build's
-- pinned stat ids in the officers' order. A build starts with none.
--
-- The guild-wide list is DROPPED, not copied — every build starts empty.
-- Re-pin from each member's build page.
--
-- RUN THIS BEFORE DEPLOYING the code that reads it: the build page reads
-- key_stats off the build, and the old /api/builds/key-stats route is gone.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

alter table builds add column if not exists key_stats text[] not null default '{}';

drop table if exists build_key_stats;
