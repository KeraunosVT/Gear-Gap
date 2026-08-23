-- 020_feud_roster_and_players.sql — the enemy roster's full stats, and
-- cross-guild player lookup.
--
-- Run this in the Supabase SQL editor. Requires 019.
--
-- Two things:
--
--   1. get_guild_feud_roster carried only `kills`. The scouting question is
--      "who is the actual threat", and that needs damage and healing too —
--      healing especially, because it identifies a healer empirically. Only 11
--      of the 45 classes have a role mapping anywhere in this app, so ranking
--      on the stat is the only approach that works for every enemy.
--
--   2. Two functions for "where else has this name played" — a name under three
--      guilds in a year is a mercenary, and one that moved from a guild you beat
--      to a guild you lose to is worth knowing about.

-- ── DROP BEFORE CREATE ──────────────────────────────────────────────────────
-- Adding columns to a RETURNS TABLE *is* changing the return type, and
-- `create or replace function` cannot. Migration 015 documents this for
-- save_event; 019 hit it twice while being written. Dropping first also makes
-- this file re-runnable from a half-applied state.
-- BOTH signatures: an earlier run of this file may have created the two-arg
-- version. Leaving it behind alongside a three-arg one gives PostgREST two
-- overloads to choose between, and it refuses with PGRST203 rather than
-- picking — the same failure migration 005 documents for the duplicate FK.
drop function if exists get_guild_feud_roster(text[], text);
drop function if exists get_guild_feud_roster(text[], text, int);
drop function if exists get_player_guilds(text[], text);
drop function if exists get_player_search(text, int);

-- ── WHO THEY FIELD, WITH THE NUMBERS THAT MATTER ────────────────────────────
-- EVERYONE on that side of those matches, not only players whose own guild tag
-- matches — a guild that borrows three players fielded fifty-three against you,
-- and a sheet omitting the borrowed ones describes a team you did not fight.
-- `own_guild` rides along so the caller can mark them.
--
-- Grouped by player AND weapon pair, returning the pair RAW rather than a class
-- name. The weapon-to-class vocabulary lives in shared/weaponClasses.json and
-- is applied by getClassNameBackend; a second copy in SQL would give the site
-- two class vocabularies that drift apart.
--
-- `recent_appearances` counts only the last p_recent matches against this
-- guild, so the page can show who they are fielding NOW while every rate and
-- threat mark still comes from the player's full history. Those are two
-- different questions and a single window can't answer both: three matches is
-- the right lens on a current roster and far too few to call anyone dangerous.
create or replace function get_guild_feud_roster(p_guild_names text[], p_enemy text, p_recent int default 3)
returns table (
  player_name text,
  own_guild text,
  weapon_1 text,
  weapon_2 text,
  appearances bigint,
  recent_appearances bigint,
  kills bigint,
  damage_dealt bigint,
  damage_taken bigint,
  healing bigint
)
language sql
stable
as $$
  with scored as (
    select * from get_guild_match_sides(p_guild_names)
  ),
  -- The same attribution the feud list uses, so the roster can never describe
  -- a set of matches the row above it doesn't count.
  enemies as (
    select * from get_guild_feud_matches(p_guild_names)
  ),
  -- The most recent p_recent matches against THIS guild. match_date is ISO
  -- text, which sorts chronologically as text — see the note in 019.
  recent as (
    select e.match_id
    from enemies e
    join scored sc on sc.match_id = e.match_id
    where e.enemy_guild = p_enemy
    order by sc.match_date desc
    limit greatest(coalesce(p_recent, 3), 0)
  )
  select s.player_name::text,
         coalesce(a.canonical, normalise_guild_name(s.guild_name))::text as own_guild,
         s.weapon_1::text,
         s.weapon_2::text,
         count(*)::bigint                          as appearances,
         count(*) filter (
           where s.match_id in (select match_id from recent)
         )::bigint                                 as recent_appearances,
         sum(coalesce(s.kills, 0))::bigint         as kills,
         sum(coalesce(s.damage_dealt, 0))::bigint  as damage_dealt,
         sum(coalesce(s.damage_taken, 0))::bigint  as damage_taken,
         sum(coalesce(s.healing, 0))::bigint       as healing
  from enemies e
  join scored sc on sc.match_id = e.match_id
  join player_match_stats s
    on s.match_id = e.match_id
   and s.team_color in ('Red', 'Yellow')
   and s.team_color <> sc.our_color
  left join enemy_guild_aliases a
    on a.alias = normalise_guild_name(s.guild_name)
  where e.enemy_guild = p_enemy
    and s.player_name is not null
  group by s.player_name, coalesce(a.canonical, normalise_guild_name(s.guild_name)),
           s.weapon_1, s.weapon_2
  order by appearances desc, s.player_name;
$$;

-- ── WHERE ELSE HAS THIS NAME PLAYED ─────────────────────────────────────────
-- One row per guild the name has appeared under, ours included.
--
-- Guild names resolve exactly as the feud list resolves them — whitespace
-- collapsed, then the alias join — or a player's history splits across the very
-- misreads the Feuds page already merges.
--
-- Matched case-insensitively. These names never pass through player_identities
-- (which only knows our own members), so the raw scoreboard text is all there
-- is, and OCR varies the case.
create or replace function get_player_guilds(p_guild_names text[], p_player text)
returns table (
  guild text,
  is_ours boolean,
  matches bigint,
  first_seen text,
  last_seen text,
  kills bigint,
  damage_dealt bigint,
  healing bigint
)
language sql
stable
as $$
  with ours_names as (
    select normalise_guild_name(x) as n
    from unnest(p_guild_names) x
    where normalise_guild_name(x) is not null
  ),
  rows as (
    select coalesce(a.canonical, normalise_guild_name(s.guild_name)) as guild,
           normalise_guild_name(s.guild_name) as raw_guild,
           m.match_date,
           s.kills, s.damage_dealt, s.healing
    from player_match_stats s
    join wargame_matches m on m.id = s.match_id
    left join enemy_guild_aliases a
      on a.alias = normalise_guild_name(s.guild_name)
    where lower(s.player_name) = lower(btrim(coalesce(p_player, '')))
      and normalise_guild_name(s.guild_name) is not null
  )
  select r.guild::text,
         -- Ours is decided on the RAW name, before the enemy alias join: that
         -- table never contains our names (the write path refuses it), so
         -- checking after would be checking a value it can't have changed.
         bool_or(r.raw_guild in (select n from ours_names))     as is_ours,
         count(*)::bigint                                       as matches,
         min(r.match_date)::text                                as first_seen,
         max(r.match_date)::text                                as last_seen,
         sum(coalesce(r.kills, 0))::bigint                      as kills,
         sum(coalesce(r.damage_dealt, 0))::bigint               as damage_dealt,
         sum(coalesce(r.healing, 0))::bigint                    as healing
  from rows r
  group by r.guild
  order by max(r.match_date) desc, matches desc;
$$;

-- ── NAME SEARCH ─────────────────────────────────────────────────────────────
-- Grouped in SQL rather than JS: a common substring matches thousands of rows
-- but only a few dozen distinct names, and PostgREST's 1,000-row cap would
-- silently truncate the middle of that.
--
-- A leading-wildcard ilike can't use player_match_stats_player_name_idx, so
-- this is a sequential scan. On a table of this size that is milliseconds —
-- but measure it on real data before assuming so.
--
-- An empty query returns nothing rather than every player on record: a search
-- box that dumps the whole table on first keystroke is worse than one that
-- waits.
create or replace function get_player_search(p_query text, p_limit int default 25)
returns table (
  player_name text,
  guilds text[],
  matches bigint,
  last_seen text
)
language sql
stable
as $$
  with q as (
    select nullif(btrim(coalesce(p_query, '')), '') as term
  ),
  hits as (
    select s.player_name,
           coalesce(a.canonical, normalise_guild_name(s.guild_name)) as guild,
           m.match_date
    from player_match_stats s
    join wargame_matches m on m.id = s.match_id
    left join enemy_guild_aliases a
      on a.alias = normalise_guild_name(s.guild_name)
    where (select term from q) is not null
      and s.player_name ilike '%' || (select term from q) || '%'
  )
  select h.player_name::text,
         array_agg(distinct h.guild)                   as guilds,
         count(*)::bigint                              as matches,
         max(h.match_date)::text                       as last_seen
  from hits h
  where h.player_name is not null
  group by h.player_name
  -- Most-seen first: searching a fragment should surface the regular before
  -- the one-off who happens to sort earlier.
  order by matches desc, h.player_name
  limit greatest(coalesce(p_limit, 25), 1);
$$;
