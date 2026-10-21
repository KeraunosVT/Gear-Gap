-- 032_calendar_channel.sql — where the Event Calendar's "Post to Discord" goes.
--
-- Null (the default) falls back to the signup channel, then the announce
-- channel — the same channel the post used before this setting existed.
--
-- RUN THIS BEFORE DEPLOYING the code that reads it: guildConfig selects its
-- columns by name, so a missing column fails the whole config load.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

alter table guild_config add column if not exists calendar_channel_id text;
