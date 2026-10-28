-- 023_guild_player_counts_aliases.sql — make the Names page follow Guild Settings.
--
-- get_guild_player_counts() is what the admin Names page asks "which in-game
-- names have we seen, and how often" — it is the entire source of the Unmapped
-- list. It predates the migrations folder (see the note at the top of
-- 001_audit_log.sql: it was applied in the Supabase SQL editor and never
-- committed), and it had our guild names baked into its body:
--
--   where guild_name in ('FTP', 'PUSH', 'House Regard', 'Best Regards')
--
-- Every one of those is a former name. The guild is 'Gear Gap' now, so the
-- function matched nothing recent: players who had been on the scoreboard for
-- weeks never appeared in the Unmapped list, and there was no way to map them.
-- Nothing errored — the list simply showed the older names that still carried a
-- historical guild_name and looked like it was working.
--
-- This is precisely the failure 019 called out when it parameterised the feud
-- functions ("a zero-argument version would be one with our names baked into
-- its body, which is the thing that stops get_player_stats() from following
-- Guild Settings"). That pass converted get_guild_match_sides, get_guild_feuds,
-- get_guild_feud_matches and get_guild_feud_coverage; this one was missed
-- because nothing on the feud pages calls it.
--
-- The DROP is load-bearing and must come first. `create or replace` cannot
-- change a signature, so without it BOTH the 0-argument and the 1-argument
-- versions exist, and every Names page load then dies with PGRST203 "could not
-- choose the best candidate function" — the same trap 015's save_event and
-- 020's get_guild_feud_roster document in verify.sql.
--
-- Run this in the Supabase SQL editor.

drop function if exists get_guild_player_counts();
drop function if exists get_guild_player_counts(text[]);

-- SECURITY DEFINER is carried over from the original definition deliberately.
-- The bug being fixed here is the hardcoded name list; whether this function
-- needs to run as its owner is an orthogonal question about RLS on
-- player_match_stats, and answering it in the same migration would mean two
-- changes sharing one blast radius.
create or replace function get_guild_player_counts(p_guild_names text[])
returns table (player_name text, matches bigint)
language sql
security definer
as $$
  -- Normalised on BOTH sides, the same way 019 does it. Guild names arrive from
  -- OCR, so `Gear Gap ` and `Gear  Gap` are ordinary readings — comparing raw
  -- text here would reintroduce the same class of silent miss this migration
  -- exists to fix, just one stray space at a time.
  --
  -- One name per row rather than `= any (array)`: see the note in 019's
  -- get_guild_match_sides for why the subquery form is the unambiguous one.
  with ours_names as (
    select normalise_guild_name(x) as n
    from unnest(p_guild_names) x
    where normalise_guild_name(x) is not null
  )
  select s.player_name::text,
         count(distinct s.match_id)::bigint as matches
  from player_match_stats s
  where normalise_guild_name(s.guild_name) in (select n from ours_names)
    and s.player_name is not null
  group by s.player_name
  order by matches desc;
$$;
