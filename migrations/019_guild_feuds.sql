-- 019_guild_feuds.sql — head-to-head record against every enemy guild.
--
-- Run this in the Supabase SQL editor.
--
-- Every scoreboard already stores BOTH teams: player_match_stats carries
-- guild_name and team_color for each player, ours and theirs. Nothing read the
-- enemy half. This aggregates it.
--
-- ── WHY SQL AND NOT JS ──────────────────────────────────────────────────────
-- Answering "who do we fight" means reading every player row of every match —
-- tens of thousands. PostgREST caps an unbounded select at 1,000 rows and
-- returns the truncated set with no error, so the JS version would have to page
-- the whole table on every page load. Aggregating here is one round trip.
--
-- ── EVERY FUNCTION TAKES p_guild_names ──────────────────────────────────────
-- Deliberately, and unlike get_player_stats() / get_stats_summary(), which are
-- called with no arguments and have our guild names baked into their bodies.
-- Those two do NOT follow the aliases on Guild Settings — edit the alias list
-- and the profile changes while the Roster's all-time table does not. Do not
-- add a third of those. Everything below is passed the list at call time.

-- ── ENEMY ALIASES, KEPT APART FROM OURS ─────────────────────────────────────
-- guild_config.aliases means "names WE have gone by", and every reader of it —
-- canonicalGuild, the war-record collapsing, the player profile's guild split,
-- guildSettings.assertAliasesSafe — treats a name in that list as US. One enemy
-- name in there silently folds a rival's matches into our own record.
--
-- So theirs lives here instead. The two lists answer different questions and
-- must never share storage.
--
-- `alias` is the primary key: one spelling can only ever resolve one way. The
-- two guards that keep this sane — no mapping to or from our own names, and no
-- chains (a canonical that is itself an alias) — are enforced in the write path
-- in backend/admin.js, next to the error messages that explain them.
create table if not exists enemy_guild_aliases (
  -- The name exactly as scoreboards record it, after whitespace collapsing.
  alias text primary key,
  -- The guild it really is.
  canonical text not null,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists enemy_guild_aliases_canonical_idx
  on enemy_guild_aliases (canonical);

-- RLS on with no policies, like every other table here: the server holds the
-- service-role key and all access control lives in Express middleware.
alter table enemy_guild_aliases enable row level security;

-- ── DROP BEFORE CREATE ──────────────────────────────────────────────────────
-- `create or replace function` cannot change a function's return type. Change
-- one and Postgres refuses with:
--
--   42P13: cannot change return type of existing function
--   DETAIL: Row type defined by OUT parameters is different.
--
-- Migration 015 hit exactly this with save_event and documents the same fix.
-- It matters here because a failed earlier attempt at this file can leave a
-- function behind with the old signature, and then every later run fails on a
-- statement that looks correct. Dropping first makes the file re-runnable from
-- any state, including a half-applied one.
--
-- Dependents first, then the base they call. `language sql` bodies given as a
-- quoted string aren't dependency-tracked, so the order is for clarity rather
-- than necessity — but it is the order that stays correct if these ever become
-- BEGIN ATOMIC bodies, which are tracked.
drop function if exists get_guild_feud_roster(text[], text);
drop function if exists get_guild_feud_coverage(text[]);
drop function if exists get_guild_feuds(text[]);
drop function if exists get_guild_feud_matches(text[]);
drop function if exists get_guild_match_sides(text[]);
drop function if exists normalise_guild_name(text);

-- Guild names arrive from OCR, so a stray double space is common. Collapsing
-- here means `Iron Vow` and `Iron  Vow` need no alias row at all.
create or replace function normalise_guild_name(p_name text)
returns text
language sql
immutable
as $$
  select nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');
$$;

-- ── WHICH SIDE WERE WE, AND DID WE WIN ──────────────────────────────────────
-- The base every other function builds on, so the rule for "our side" and the
-- rule for "the outcome" exist once.
--
-- Our side is not stored. It is inferred: the team colour holding more of our
-- alias-matched players.
--
-- `having max(ours) > 0` is load-bearing. The equivalent JS in server.js reads
-- `myRedCount >= myYellowCount ? 'Red' : 'Yellow'`, which assigns RED when both
-- are zero — so a match with none of our players matched (an all-sub roster, or
-- an alias missing from Guild Settings) silently gets a side and an outcome.
-- Here such a match is excluded instead, and counted by the coverage function
-- below so the page can say how many were dropped.
--
-- The outcome prefers the stored result and falls back to comparing kills,
-- which is the same rule the dashboard's EngagementRow already applies — a
-- match must not read as a Win on one page and a Loss on another.
create or replace function get_guild_match_sides(p_guild_names text[])
returns table (
  -- Types confirmed against information_schema, NOT taken from
  -- 000_baseline.sql — that file is a reconstruction and disagrees with the
  -- live database on at least two of these.
  --
  --   match_id    text  (baseline says uuid)
  --   match_date  text  (baseline says date)
  --   kills       bigint, so sum() over it yields NUMERIC — see the casts below
  --
  -- match_date stays text and is never cast to date. The values are ISO
  -- YYYY-MM-DD, which sorts and compares correctly as text — max() gives the
  -- real latest — whereas ::date would throw the whole function on a single
  -- empty or malformed value somewhere in the record.
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
  -- Normalised the SAME way enemy names are. This used to compare the raw
  -- guild_name against the raw alias list while the enemy side collapsed
  -- whitespace — so a scoreboard reading `FTP ` failed to match `FTP`, those
  -- players counted as nobody, and the guild's own name then turned up in the
  -- feud table as a rival. Both sides normalise or neither can.
  with ours_names as (
    -- One name PER ROW, not an array. `= any (…)` reads a parenthesised
    -- subquery as the subquery form, which wants a set of scalars — handing it
    -- an array gives "operator does not exist: text = text[]". `in (select …)`
    -- has no such ambiguity.
    --
    -- The `is not null` is load-bearing for the NOT IN below: a single NULL in
    -- the list makes `x not in (…)` evaluate to NULL for every row, which
    -- silently empties the enemy list rather than erroring.
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
           -- Ties break on colour name only to be deterministic; a tie means
           -- equal numbers of our players on both sides, which is a scoreboard
           -- problem rather than something to guess cleverly about.
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


-- ── WHO WE ACTUALLY FOUGHT, ONE GUILD PER MATCH ─────────────────────────────
-- The enemy side is credited to the single guild that fielded the most of it.
-- Everyone else on that side is treated as having subbed FOR them.
--
-- Attributing every distinct guild name on the far side — the obvious reading —
-- gives a guild that lent three players its own feud row, showing a match it
-- never chose to fight, sitting next to guilds that brought fifty. Those rows
-- are noise, and they are indistinguishable from real ones once they are in a
-- table sorted by "met".
--
-- The consequence to know: `met` summed across all guilds now equals the number
-- of attributed matches exactly, and a genuine two-guild alliance is recorded
-- as the larger guild's match. That is the trade — one clean row per match
-- rather than a faithful but unusable list.
--
-- Aliases resolve BEFORE the count, so two spellings of one guild combine into
-- one total and can win the comparison together rather than splitting the vote.
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
      -- We are never our own enemy. Side detection picks the colour holding
      -- MORE of our players, so a few of ours on the other team — subs lent
      -- out, or a scrim against our own second roster — would otherwise be
      -- counted here. Excluded by name, which is the only test that holds.
      and normalise_guild_name(s.guild_name) not in (select n from ours_names)
    group by sc.match_id, coalesce(a.canonical, normalise_guild_name(s.guild_name))
  )
  select match_id::text,
         -- Ties break alphabetically, only so the answer is stable between runs.
         (array_agg(enemy_guild order by players desc, enemy_guild))[1]::text
  from enemy_counts
  group by match_id;
$$;

-- ── THE FEUD LIST ───────────────────────────────────────────────────────────
-- One row per enemy guild.
--
-- A match with several enemy guilds on the other side (allied teams are normal)
-- counts once FOR EACH of them, so summed `met` exceeds the match count. That
-- One row per enemy guild, and one match counted per guild — see
-- get_guild_feud_matches above for why the far side is credited to whoever
-- fielded most of it. kills_for / kills_against are the whole side's totals for
-- those matches, not a per-guild share-out.
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
  -- Every aggregate is cast to the type the signature declares. count() is
  -- already bigint, but player_match_stats.kills is bigint and sum() over a
  -- bigint returns NUMERIC — and a function whose body disagrees with its
  -- RETURNS TABLE fails at creation time with "return type mismatch", not at
  -- call time, so this is worth being explicit about everywhere.
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

-- ── HOW MUCH OF THE RECORD THIS COVERS ──────────────────────────────────────
-- Returned separately so the page can show "12 of 240 matches couldn't be
-- attributed" rather than silently dropping them. A rising excluded count
-- usually means an alias is missing from Guild Settings, which is actionable.
create or replace function get_guild_feud_coverage(p_guild_names text[])
returns table (total_matches bigint, scored_matches bigint)
language sql
stable
as $$
  select (select count(*)::bigint from wargame_matches),
         (select count(*)::bigint from get_guild_match_sides(p_guild_names));
$$;

-- ── WHO THEY FIELD ──────────────────────────────────────────────────────────
-- The drill-down, fetched only when a row is expanded.
--
-- EVERYONE on that side of those matches, not only players whose own guild tag
-- matches. A guild that borrows three players fielded five-and-fifty against
-- you, and a scouting sheet that omits the borrowed ones describes a team you
-- did not fight. `own_guild` comes back alongside so the page can mark them:
-- knowing a name is a sub is the difference between "they always run this" and
-- "they borrowed a healer once".
--
-- Grouped by player AND weapon pair, and returns the pair RAW rather than a
-- class name. The weapon-to-class vocabulary lives in shared/weaponClasses.json
-- and is applied by getClassNameBackend; a second copy in SQL would give the
-- site two class vocabularies that drift apart. The caller sums the pairs into
-- both a per-player total and a class mix.
create or replace function get_guild_feud_roster(p_guild_names text[], p_enemy text)
returns table (
  player_name text,
  own_guild text,
  weapon_1 text,
  weapon_2 text,
  appearances bigint,
  kills bigint
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
  )
  select s.player_name::text,
         coalesce(a.canonical, normalise_guild_name(s.guild_name))::text as own_guild,
         s.weapon_1::text,
         s.weapon_2::text,
         count(*)::bigint                    as appearances,
         sum(coalesce(s.kills, 0))::bigint   as kills
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
