-- 06_war_record.sql — matches, enemy guilds and players, feuds, and the
-- Roster / dashboard stats.
--
-- Replaces archive/005, 019, 020, 021, 023, 024, 025 and 026, keeping only the
-- final version of each function. See 01_guild_and_access.sql for how these
-- files work. Safe to re-run.
--
-- ── EVERY FUNCTION THAT MEANS "US" TAKES p_guild_names ──────────────────────
-- No function carries a guild name in its body. The alias list has one home,
-- guild_config, and one way in: this parameter. A zero-argument version would
-- be one with names baked in, which is how the Roster and Names page once
-- stopped following Guild Settings — verify.sql checks the arity of each.
--
-- ── TYPES FROM THE BASE SCHEMA ──────────────────────────────────────────────
-- Confirmed against information_schema: wargame_matches.id / match_id are TEXT,
-- match_date is TEXT (ISO YYYY-MM-DD — sorts correctly as text, and is never
-- cast to date, so one malformed value can't throw a whole function), and
-- kills is bigint, so sum() over it is NUMERIC and is cast back everywhere.

-- ── MATCHES (was 005, 026) ──────────────────────────────────────────────────
-- player_match_stats had a stale duplicate FK on match_id, typo'd as
-- "player_match.stats_match_id_fkey", with no cascade — deleting a match
-- failed, and PostgREST couldn't pick between two relationships. Dropped both
-- and recreated one, so the end state is the same from any starting point.
alter table player_match_stats drop constraint if exists "player_match.stats_match_id_fkey";
alter table player_match_stats drop constraint if exists player_match_stats_match_id_fkey;

alter table player_match_stats
  add constraint player_match_stats_match_id_fkey
  foreign key (match_id) references wargame_matches (id) on delete cascade;

-- Free-text context on a match (a scrim, a short-handed night). Written by a
-- plain UPDATE after save_match(), whose body predates tracked migrations and
-- isn't in this repo to extend.
alter table public.wargame_matches add column if not exists notes text;

-- ── ENEMY ALIASES (was 019, 021) ────────────────────────────────────────────
-- Misread or former names of OTHER guilds and players, kept apart from ours:
-- guild_config.aliases means "names WE have gone by", and player_identities
-- means "our members" — one enemy name in either folds a rival into us.
-- The guards (nothing mapping to or from our names, no chains) are in the
-- write path in backend/admin.js.
create table if not exists enemy_guild_aliases (
  alias text primary key,      -- as scoreboards record it, whitespace collapsed
  canonical text not null,     -- the guild it really is
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists enemy_guild_aliases_canonical_idx
  on enemy_guild_aliases (canonical);

alter table enemy_guild_aliases enable row level security;

create table if not exists enemy_player_aliases (
  alias text primary key,
  canonical text not null,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists enemy_player_aliases_canonical_idx
  on enemy_player_aliases (canonical);

-- Case-insensitive uniqueness: OCR varies case, and the joins match on lower().
create unique index if not exists enemy_player_aliases_alias_lower_idx
  on enemy_player_aliases (lower(alias));

alter table enemy_player_aliases enable row level security;

-- ── OLD SIGNATURES ──────────────────────────────────────────────────────────
-- Each of these was replaced by a version with different arguments. Left
-- beside the new one, PostgREST can't choose between overloads and every call
-- fails with PGRST203.
drop function if exists get_guild_feud_roster(text[], text);
drop function if exists get_guild_player_counts();
drop function if exists get_player_stats();
drop function if exists get_stats_summary();

-- ── NAME NORMALISING (was 019, 021) ─────────────────────────────────────────
-- Names arrive from OCR, so a stray double space is common. Collapsing here
-- means `Iron Vow` and `Iron  Vow` need no alias row.
create or replace function normalise_guild_name(p_name text)
returns text
language sql
immutable
as $$
  select nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
$$;

create or replace function normalise_player_name(p_name text)
returns text
language sql
immutable
as $$
  select nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
$$;

-- ── WHICH SIDE WERE WE, AND DID WE WIN (was 019) ────────────────────────────
-- The base the feud functions build on, so "our side" and "the outcome" are
-- defined once. Our side is inferred: the team colour holding more of our
-- alias-matched players. `having max(ours) > 0` excludes a match with none of
-- ours matched (rather than defaulting it to Red, as the old JS did); the
-- coverage function counts those. Outcome prefers the stored result, else
-- compares kills — the dashboard's rule, so no match reads differently on two
-- pages.
create or replace function get_guild_match_sides(p_guild_names text[])
returns table (
  match_id text,
  our_color text,
  match_date text,
  our_kills bigint,
  their_kills bigint,
  outcome text
)
language sql
stable
as $$
  -- Our names normalised the same way scoreboard names are, one per row: `in
  -- (select …)` avoids the text = text[] ambiguity of `= any (…)`, and the
  -- `is not null` matters because one NULL makes `not in` empty every list.
  with ours_names as (
    select normalise_guild_name(x) as n
    from unnest(p_guild_names) x
    where normalise_guild_name(x) is not null
  ),
  sides as (
    select s.match_id,
           s.team_color,
           count(*) filter (
             where normalise_guild_name(s.guild_name) in (select n from ours_names)
           ) as ours,
           sum(coalesce(s.kills, 0)) as kills
    from player_match_stats s
    where s.team_color in ('Red', 'Yellow')
    group by s.match_id, s.team_color
  ),
  chosen as (
    select sides.match_id,
           -- Ties break on colour name only to be deterministic.
           (array_agg(sides.team_color order by sides.ours desc, sides.team_color))[1] as our_color
    from sides
    group by sides.match_id
    having max(sides.ours) > 0
  )
  select c.match_id::text,
         c.our_color::text,
         m.match_date::text,
         coalesce(us.kills, 0)::bigint   as our_kills,
         coalesce(them.kills, 0)::bigint as their_kills,
         case
           when m.result in ('Win', 'Loss', 'Draw') then m.result
           when coalesce(us.kills, 0) > coalesce(them.kills, 0) then 'Win'
           when coalesce(us.kills, 0) < coalesce(them.kills, 0) then 'Loss'
           else 'Draw'
         end::text as outcome
  from chosen c
  join wargame_matches m on m.id = c.match_id
  left join sides us   on us.match_id = c.match_id and us.team_color = c.our_color
  left join sides them on them.match_id = c.match_id and them.team_color <> c.our_color;
$$;

-- ── WHO WE FOUGHT, ONE GUILD PER MATCH (was 019) ────────────────────────────
-- The enemy side is credited to the single guild that fielded most of it;
-- everyone else on that side subbed FOR them. Crediting every guild name gives
-- a guild that lent three players its own feud row. Aliases resolve before the
-- count, so two spellings of one guild vote together.
create or replace function get_guild_feud_matches(p_guild_names text[])
returns table (match_id text, enemy_guild text)
language sql
stable
as $$
  with ours_names as (
    select normalise_guild_name(x) as n
    from unnest(p_guild_names) x
    where normalise_guild_name(x) is not null
  ),
  scored as (
    select * from get_guild_match_sides(p_guild_names)
  ),
  enemy_counts as (
    select sc.match_id,
           coalesce(a.canonical, normalise_guild_name(s.guild_name)) as enemy_guild,
           count(*) as players
    from scored sc
    join player_match_stats s
      on s.match_id = sc.match_id
     and s.team_color in ('Red', 'Yellow')
     and s.team_color <> sc.our_color
    left join enemy_guild_aliases a
      on a.alias = normalise_guild_name(s.guild_name)
    where normalise_guild_name(s.guild_name) is not null
      -- We are never our own enemy, even with a few of ours on the far side.
      and normalise_guild_name(s.guild_name) not in (select n from ours_names)
    group by sc.match_id, coalesce(a.canonical, normalise_guild_name(s.guild_name))
  )
  select match_id::text,
         -- Ties break alphabetically, only so the answer is stable.
         (array_agg(enemy_guild order by players desc, enemy_guild))[1]::text
  from enemy_counts
  group by match_id;
$$;

-- ── THE FEUD LIST (was 019) ─────────────────────────────────────────────────
-- One row per enemy guild, one match counted per guild. kills_for /
-- kills_against are whole-side totals for those matches.
create or replace function get_guild_feuds(p_guild_names text[])
returns table (
  enemy_guild text,
  met bigint,
  wins bigint,
  losses bigint,
  draws bigint,
  kills_for bigint,
  kills_against bigint,
  last_met text
)
language sql
stable
as $$
  with scored as (
    select * from get_guild_match_sides(p_guild_names)
  ),
  enemies as (
    select * from get_guild_feud_matches(p_guild_names)
  )
  select e.enemy_guild::text,
         count(*)::bigint                                    as met,
         count(*) filter (where sc.outcome = 'Win')::bigint  as wins,
         count(*) filter (where sc.outcome = 'Loss')::bigint as losses,
         count(*) filter (where sc.outcome = 'Draw')::bigint as draws,
         sum(sc.our_kills)::bigint                           as kills_for,
         sum(sc.their_kills)::bigint                         as kills_against,
         max(sc.match_date)::text                            as last_met
  from enemies e
  join scored sc on sc.match_id = e.match_id
  group by e.enemy_guild
  order by met desc, e.enemy_guild;
$$;

-- How much of the record the list covers, so the page can say "12 of 240
-- matches couldn't be attributed" — usually a missing alias in Guild Settings.
create or replace function get_guild_feud_coverage(p_guild_names text[])
returns table (total_matches bigint, scored_matches bigint)
language sql
stable
as $$
  select (select count(*)::bigint from wargame_matches),
         (select count(*)::bigint from get_guild_match_sides(p_guild_names));
$$;

-- ── WHO THEY FIELD (was 019, 020, 021) ──────────────────────────────────────
-- Everyone on that side of those matches, borrowed players included —
-- `own_guild` lets the page mark them. Player names resolve through
-- enemy_player_aliases before grouping, so three OCR spellings of one person
-- are one row. Weapon pairs come back raw; the class vocabulary lives in
-- shared/weaponClasses.json and isn't copied into SQL. recent_appearances
-- counts only the last p_recent matches against this guild (who they field
-- NOW), while every rate still uses the full history.
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
  -- The same attribution the feud list uses, so the roster never describes
  -- matches the row above it doesn't count.
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

-- ── WHERE ELSE HAS THIS NAME PLAYED (was 020, 021) ──────────────────────────
-- One row per guild a player has appeared under, ours included. The searched
-- name resolves too, so any spelling returns the whole history.
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
         -- Decided on the RAW name: the enemy alias table never holds ours.
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

-- ── NAME SEARCH (was 020, 021) ──────────────────────────────────────────────
-- Grouped in SQL because PostgREST's 1,000-row cap would truncate a common
-- substring's matches. Matches the raw spelling or the resolved one, reports
-- the resolved one. An empty query returns nothing.
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
  -- Most-seen first, so a fragment surfaces the regular before the one-off.
  order by matches desc, h.player_name
  limit greatest(coalesce(p_limit, 25), 1);
$$;

-- ── OUR NAMES ON THE SCOREBOARD (was 023) ───────────────────────────────────
-- The whole source of the Names page's Unmapped list. SECURITY DEFINER is
-- carried over from the original hand-made definition.
create or replace function get_guild_player_counts(p_guild_names text[])
returns table (player_name text, matches bigint)
language sql
security definer
as $$
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

-- ── ROSTER: ALL-TIME PER-PLAYER TOTALS (was 024, 025) ───────────────────────
-- In-game names resolve to identities case-insensitively — the same rule as
-- identities.js — so `Shawarmashuffle` and `ShawarmaShuffle` are one row.
-- The case fold MUST happen inside name_map, before DISTINCT ON: that is what
-- guarantees one row per name, and without it an identity holding both `Vex`
-- and `VEX` would match each scoreboard row twice and double every stat.
create or replace function get_player_stats(p_guild_names text[])
returns table (
  player_name text,
  weapon_1 text,
  weapon_2 text,
  matches bigint,
  kills bigint,
  assists bigint,
  damage_dealt bigint,
  damage_taken bigint,
  healing bigint
)
language sql
security definer
as $$
  with name_map as (
    select distinct on (ingame_name) ingame_name, display_name
    from (
      select lower(normalise_player_name(display_name)) as ingame_name, display_name
        from public.player_identities
        where display_name is not null
      union all
      select lower(normalise_player_name(jsonb_array_elements_text(ingame_names))) as ingame_name, display_name
        from public.player_identities
        where ingame_names is not null
          and jsonb_typeof(ingame_names) = 'array'
    ) t
    where ingame_name is not null and ingame_name <> ''
    -- Deterministic winner when two identities collide on one folded name —
    -- still a data problem for the Names page, but the Roster won't reshuffle.
    order by ingame_name, display_name
  ),
  ours_names as (
    select normalise_guild_name(x) as n
    from unnest(p_guild_names) x
    where normalise_guild_name(x) is not null
  ),
  resolved as (
    select
      coalesce(nm.display_name, pms.player_name) as canonical_name,
      pms.*
    from public.player_match_stats pms
    left join name_map nm
      on lower(normalise_player_name(pms.player_name)) = nm.ingame_name
    where normalise_guild_name(pms.guild_name) in (select n from ours_names)
      and pms.player_name is not null
  )
  select
    canonical_name                                  as player_name,
    mode() within group (order by weapon_1)         as weapon_1,
    mode() within group (order by weapon_2)         as weapon_2,
    count(distinct match_id)::bigint                as matches,
    coalesce(sum(kills),        0)::bigint          as kills,
    coalesce(sum(assists),      0)::bigint          as assists,
    coalesce(sum(damage_dealt), 0)::bigint          as damage_dealt,
    coalesce(sum(damage_taken), 0)::bigint          as damage_taken,
    coalesce(sum(healing),      0)::bigint          as healing
  from resolved
  group by canonical_name
  order by sum(kills) desc nulls last;
$$;

-- ── DASHBOARD: ALL-TIME GUILD TOTALS (was 024) ──────────────────────────────
create or replace function get_stats_summary(p_guild_names text[])
returns table (total_kills bigint, total_damage bigint, total_healing bigint)
language sql
security definer
as $$
  with ours_names as (
    select normalise_guild_name(x) as n
    from unnest(p_guild_names) x
    where normalise_guild_name(x) is not null
  )
  select
    coalesce(sum(kills),        0)::bigint,
    coalesce(sum(damage_dealt), 0)::bigint,
    coalesce(sum(healing),      0)::bigint
  from public.player_match_stats
  where normalise_guild_name(guild_name) in (select n from ours_names);
$$;
