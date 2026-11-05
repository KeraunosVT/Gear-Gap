-- 11_scouting.sql — scouting reports: who a night is against, and where the
-- report about them goes.
--
-- signup_events.opponent_guild: the enemy guild an occurrence is against, as
-- the Feuds page names it. Free text, not a foreign key — there is no enemy
-- guild table, only names on scoreboards, and a first meeting has no record.
-- Set per occurrence rather than on the schedule: the event is the same every
-- week, the guild on the other side isn't.
--
-- signup_events.scouting_sent_at: claimed with a conditional UPDATE, exactly
-- like reminder_sent_at, so the sweep, a second instance and the Post to
-- Discord button can't post the same report twice. Cleared when the opponent
-- or the start time changes.
--
-- guild_config.scouting_channel_id: where the report posts automatically, an
-- hour before. Null = never automatically (the buttons still work). There is
-- deliberately no fallback channel — see scoutingChannelId() in guildConfig.js.
--
-- RUN THIS BEFORE DEPLOYING the code that reads it. guildConfig.js selects
-- scouting_channel_id by name; without the column that read fails, and the app
-- falls back to defaults in which nobody holds an officer role.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

alter table signup_events add column if not exists opponent_guild text;
alter table signup_events add column if not exists scouting_sent_at timestamptz;

alter table guild_config add column if not exists scouting_channel_id text;

-- The sweep's query: not cancelled, has an opponent, not yet posted, starting
-- within the hour. Partial, so it only ever holds the handful of nights with an
-- opponent still to post.
create index if not exists signup_events_scouting_due_idx on signup_events (starts_at)
  where opponent_guild is not null and scouting_sent_at is null;
