-- 001_init.sql — everything the raid bot stores.
--
-- Every row that belongs to a Discord server carries its guild_id, and every
-- read the bot makes is filtered by it: this one database serves every server
-- the bot is in. Removing the bot from a server deletes that server's rows
-- (store.deleteGuild), so nothing outlives the bot's welcome.
--
-- Applied by src/migrate.js, which the bot runs on start.

-- Per-server settings, edited with /raid-setup. A server that has never run it
-- has no row and reads the defaults in store.js.
create table if not exists guild_settings (
  guild_id         text primary key,
  raid_channel_id  text,              -- where /raid post sends runs; null = the channel it was run in
  poster_role_id   text,              -- who may post runs; null = anyone
  manager_role_id  text,              -- may manage anyone's run, besides Manage Server / Manage Events
  timezone         text,              -- how typed times are read when the poster has none of their own
  reminder_minutes int not null default 15 check (reminder_minutes between 0 and 240),
  updated_at       timestamptz not null default now()
);

-- One person's own timezone, set with /raid timezone. Not per server: it's
-- where they live, wherever they raid.
create table if not exists user_settings (
  user_id    text primary key,
  timezone   text not null,
  updated_at timestamptz not null default now()
);

create table if not exists raid_runs (
  id          bigserial primary key,     -- short on purpose: it rides in every button's customId
  guild_id    text not null,
  channel_id  text,
  message_id  text,
  raid_key    text not null,             -- raids.json
  segments    jsonb not null,            -- [{ "mode": "normal", "gates": [1,2,3] }, ...]
  role_caps   jsonb not null,            -- { "Tank": 1, "DPS": 9, "Healer": 2 }, copied at post time
  title       text not null,
  notes       text,
  starts_at   timestamptz not null,
  lead_id     text not null,
  status      text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  reminded_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists raid_runs_guild_starts on raid_runs (guild_id, starts_at);
create index if not exists raid_runs_status_starts on raid_runs (status, starts_at);

-- One row per person per run.
--   status 'going' — in a slot.
--   status 'bench' — bench_kind says how they got there:
--     overflow — picked a role that was full. Moved up automatically, in
--                signup order, when a slot in that role opens.
--     opt_in   — chose the bench, or was benched by the lead. Only the lead
--                moves them up.
create table if not exists raid_entries (
  id           bigserial primary key,
  run_id       bigint not null references raid_runs (id) on delete cascade,
  user_id      text not null,
  display_name text not null,
  role         text not null check (role in ('Tank', 'DPS', 'Healer')),
  status       text not null check (status in ('going', 'bench')),
  bench_kind   text check (bench_kind in ('overflow', 'opt_in')),
  signed_up_at timestamptz not null default clock_timestamp(),
  added_by     text,
  unique (run_id, user_id),
  check ((status = 'bench') = (bench_kind is not null))
);
