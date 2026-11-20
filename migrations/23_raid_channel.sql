-- 23_raid_channel.sql — where raid run signup posts go.
--
-- guild_config.raid_channel_id: the channel a raid run's signup post (the one
-- with the Tank / DPS / Healer / Bench buttons) is sent to, so raids stay out
-- of the War signup channel. Set it in Guild Settings. Blank = raid posts go
-- wherever other signups go.
--
-- Run this BEFORE deploying the code that reads it. guildConfig.js selects
-- this column by name; it retries without it if the column is missing, but
-- saving Guild Settings fails until it exists.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

alter table guild_config add column if not exists raid_channel_id text;
