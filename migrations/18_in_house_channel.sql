-- 18_in_house_channel.sql — where In-House events' signup posts go.
--
-- guild_config.in_house_channel_id: the channel an In-House event's signup
-- post (the one with the I'm in / Withdraw / LOA buttons) is sent to, so it
-- stays out of the channel the War Games schedule posts in. Set it in Guild
-- Settings. Blank = In-House posts go wherever other signups go.
--
-- Run this BEFORE deploying the code that reads it. guildConfig.js selects
-- this column by name; it retries without it if the column is missing, but
-- saving Guild Settings fails until it exists.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

alter table guild_config add column if not exists in_house_channel_id text;
