-- 021_enemy_player_aliases.sql — one enemy player, one row.
--
-- Run this in the Supabase SQL editor. Requires 019 and 020.
--
-- Enemy player names come off a scoreboard through OCR, and the failure modes
-- are the obvious ones: l for I, 0 for O, rn for m. The result is one person
-- occupying three rows of a roster, each with a third of their matches — which
-- also puts all three under the appearance floor and stops any of them being
-- marked, so the misread hides exactly the player it fragments.
--
-- ── WHY NOT player_identities ───────────────────────────────────────────────
-- That table maps in-game names to OUR members and their Discord ids. Every
-- reader of it — identityForName, discordIdFor, displayNameFor, the Names page
-- — treats a name in it as somebody in this guild. Adding enemies would put
-- rivals in the member roster.
--
-- Same reasoning that keeps enemy_guild_aliases apart from guild_config.aliases
-- in 019, and the same shape, so there is one pattern here rather than two.

create table if not exists enemy_player_aliases (
  -- The name exactly as the scoreboard recorded it, after whitespace collapsing.
  alias text primary key,
  -- The player it really is.
  canonical text not null,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists enemy_player_aliases_canonical_idx
  on enemy_player_aliases (canonical);

-- Case-insensitive uniqueness. OCR varies case as readily as it varies letters,
-- and without this `Vex` and `vex` could be two aliases pointing different ways
-- — which the joins below, matching on lower(), would then resolve arbitrarily.
create unique index if not exists enemy_player_aliases_alias_lower_idx
  on enemy_player_aliases (lower(alias));

alter table enemy_player_aliases enable row level security;

-- Same treatment guild names get. Kept as its own function so the rule lives in
-- one place rather than being spelled out at each join.
create or replace function normalise_player_name(p_name text)
returns text
language sql
immutable
as $$
  select nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
$$;

-- ── DROP BEFORE CREATE ──────────────────────────────────────────────────────
-- Bodies change, signatures don't — but `create or replace` still refuses if a
-- previous run left a different return type, and dropping keeps this file
-- re-runnable from a half-applied state. See the note in 019.
drop function if exists get_guild_feud_roster(text[], text, int);
drop function if exists get_player_guilds(text[], text);
drop function if exists get_player_search(text, int);

-- ── WHO THEY FIELD ──────────────────────────────────────────────────────────
-- As 020, with player names resolved through the alias table before grouping —
-- so three spellings of one person fold into one row carrying all their
-- matches, which is what puts them back above the appearance floor.
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
  enemies as (
    select * from get_guild_feud_matches(p_guild_names)
  ),
  recent as (
    select e.match_id
    from enemies e
    join scored sc on sc.match_id = e.match_id
    where e.enemy_guild = p_enemy
    order by sc.match_date desc
    limit greatest(coalesce(p_recent, 3), 0)
  )
  select coalesce(pa.canonical, normalise_player_name(s.player_name))::text as player_name,
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
  left join enemy_player_aliases pa
    on lower(pa.alias) = lower(normalise_player_name(s.player_name))
  where e.enemy_guild = p_enemy
    and normalise_player_name(s.player_name) is not null
  group by coalesce(pa.canonical, normalise_player_name(s.player_name)),
           coalesce(a.canonical, normalise_guild_name(s.guild_name)),
           s.weapon_1, s.weapon_2
  order by appearances desc, player_name;
$$;

-- ── WHERE ELSE HAS THIS NAME PLAYED ─────────────────────────────────────────
-- The lookup resolves the SEARCHED name too, so asking about any spelling
-- returns the whole history rather than the third of it under that spelling.
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
  -- What the caller asked about, after resolution. Looking up an alias and
  -- looking up the canonical name must give the same answer.
  target as (
    select coalesce(
             (select pa.canonical from enemy_player_aliases pa
              where lower(pa.alias) = lower(normalise_player_name(p_player))),
             normalise_player_name(p_player)
           ) as name
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
    left join enemy_player_aliases pa
      on lower(pa.alias) = lower(normalise_player_name(s.player_name))
    where lower(coalesce(pa.canonical, normalise_player_name(s.player_name)))
        = lower((select name from target))
      and normalise_guild_name(s.guild_name) is not null
  )
  select r.guild::text,
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
-- Matches against the RAW spelling but reports the resolved one, so searching a
-- misread still finds the person and returns them under the name the rest of
-- the app uses. One result per person, not one per OCR variant.
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
    select coalesce(pa.canonical, normalise_player_name(s.player_name)) as player_name,
           coalesce(a.canonical, normalise_guild_name(s.guild_name)) as guild,
           m.match_date
    from player_match_stats s
    join wargame_matches m on m.id = s.match_id
    left join enemy_guild_aliases a
      on a.alias = normalise_guild_name(s.guild_name)
    left join enemy_player_aliases pa
      on lower(pa.alias) = lower(normalise_player_name(s.player_name))
    where (select term from q) is not null
      -- Either spelling finds them: the raw text as recorded, or the name it
      -- resolves to. Searching "Vex" must return someone whose rows all say
      -- "\/ex".
      and (s.player_name ilike '%' || (select term from q) || '%'
           or coalesce(pa.canonical, '') ilike '%' || (select term from q) || '%')
  )
  select h.player_name::text,
         array_agg(distinct h.guild)                   as guilds,
         count(*)::bigint                              as matches,
         max(h.match_date)::text                       as last_seen
  from hits h
  where h.player_name is not null
  group by h.player_name
  order by matches desc, h.player_name
  limit greatest(coalesce(p_limit, 25), 1);
$$;
