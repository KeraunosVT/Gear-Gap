-- 20_poll_write_ins.sql — members can write in their own answer to a poll.
--
-- polls.write_in: whether the poll's post has a "Write my own" button. Off for
-- every poll made before this.
--
-- poll_write_ins: one row per member per poll — the answer they typed. Writing
-- again replaces it; saving it empty removes it. In a single-choice poll a
-- write-in is the member's one vote, so it and a button vote replace each
-- other; in a multiple-choice poll they sit side by side. Like poll_votes, who
-- wrote what is shown only to officers, through the "Who voted" button.
-- Deleting a poll deletes its write-ins.
--
-- Locked down like every other table (migration 12): RLS on with no policies,
-- nothing granted to anon or authenticated.
--
-- Needs 19_polls.sql first. Until this has run, polls without write-ins still
-- work; a poll with write-ins can't be created.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

alter table polls add column if not exists write_in boolean not null default false;

create table if not exists poll_write_ins (
  poll_id uuid not null references polls (id) on delete cascade,
  discord_id text not null,
  display_name text not null default '',
  answer text not null check (length(answer) between 1 and 100),
  written_at timestamptz not null default now(),
  primary key (poll_id, discord_id)
);

alter table poll_write_ins enable row level security;
revoke all on poll_write_ins from anon, authenticated;
