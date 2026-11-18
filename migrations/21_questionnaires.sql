-- 21_questionnaires.sql — the bot's questionnaires: several questions, each
-- picked from a list or typed.
--
-- questionnaires: one row each. `questions` is the list, in order:
-- { type: 'choice' | 'text', text, required, options?, multi? }. An answer
-- names a choice by its position. `closes_at` (optional) is when the bot's
-- minute sweep closes it; an officer can close it sooner. `channel_id` and
-- `message_id` are where it was posted, so the post can be redrawn.
--
-- questionnaire_responses: one row per member per questionnaire. `answers`
-- lines up with the questions: a list of picked choice positions for a choice
-- question, the text for a typed one. Answering again replaces it. Who
-- answered what is shown only to officers, through the post's "Responses"
-- button. Deleting a questionnaire deletes its responses.
--
-- Locked down like every other table (migration 12): RLS on with no policies,
-- nothing granted to anon or authenticated.
--
-- Questionnaires can't be created until this has run; polls don't need it.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

create table if not exists questionnaires (
  id uuid primary key,
  title text not null,
  intro text not null default '',
  questions jsonb not null,
  closes_at timestamptz,
  status text not null default 'open' check (status in ('open', 'closed')),
  channel_id text,
  message_id text,
  created_by text,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists questionnaire_responses (
  questionnaire_id uuid not null references questionnaires (id) on delete cascade,
  discord_id text not null,
  display_name text not null default '',
  answers jsonb not null,
  responded_at timestamptz not null default now(),
  primary key (questionnaire_id, discord_id)
);

-- The sweep's query: open questionnaires with a close time.
create index if not exists questionnaires_closing_idx on questionnaires (closes_at) where status = 'open' and closes_at is not null;

alter table questionnaires enable row level security;
alter table questionnaire_responses enable row level security;
revoke all on questionnaires from anon, authenticated;
revoke all on questionnaire_responses from anon, authenticated;
