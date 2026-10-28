-- 029_member_tenure_tlgm.sql — allow TLGM's Join Date as a tenure source.
--
-- A TLGM import now carries each member's in-game "Join Date" into
-- member_tenure.since, with source 'tlgm'. 028's check constraint only allowed
-- the three Discord-derived sources, so without this every one of those writes
-- is refused (the import itself still succeeds and reports the failure).
--
-- Run this in the Supabase SQL editor.

alter table member_tenure drop constraint if exists member_tenure_source_check;
alter table member_tenure add constraint member_tenure_source_check
  check (source in ('tlgm', 'audit_log', 'discord_join', 'sweep'));
