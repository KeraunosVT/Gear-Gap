-- 19_polls.sql — the bot's own polls, where members can't see each other's votes.
--
-- Discord's built-in polls show every voter to everyone. These are posted by
-- the bot with a button per option; the post shows only how many votes each
-- option has, and who voted for what is stored here, readable only through the
-- officers' "Who voted" button.
--
-- polls: one row per poll. `options` is the list of option texts, in order;
-- a vote names an option by its position. `multi` lets a member pick more than
-- one. `closes_at` (optional) is when the bot's minute sweep closes it; an
-- officer can close it sooner. `channel_id`/`message_id` are where it was
-- posted, so the post can be redrawn as votes come in.
--
-- poll_votes: one row per member per option they picked. A single-choice poll
-- has at most one per member; changing a vote replaces it. Deleting a poll
-- deletes its votes.
--
-- Locked down like every other table (migration 12): RLS on with no policies,
-- nothing granted to anon or authenticated.
--
-- Polls can't be created until this has run; nothing else reads these tables.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

create table if not exists polls (
  id uuid primary key,
  question text not null,
  options jsonb not null,
  multi boolean not null default false,
  closes_at timestamptz,
  status text not null default 'open' check (status in ('open', 'closed')),
  channel_id text,
  message_id text,
  created_by text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists poll_votes (
  poll_id uuid not null references polls (id) on delete cascade,
  discord_id text not null,
  display_name text not null default '',
  option_index int not null check (option_index >= 0),
  voted_at timestamptz not null default now(),
  primary key (poll_id, discord_id, option_index)
);

-- The sweep's query: open polls with a close time.
create index if not exists polls_closing_idx on polls (closes_at) where status = 'open' and closes_at is not null;

alter table polls enable row level security;
alter table poll_votes enable row level security;
revoke all on polls from anon, authenticated;
revoke all on poll_votes from anon, authenticated;
