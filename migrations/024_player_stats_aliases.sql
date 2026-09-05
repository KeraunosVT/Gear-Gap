-- 024_player_stats_aliases.sql — the Roster and the dashboard tiles follow
-- Guild Settings too.
--
-- The last two functions carrying our guild names in their bodies. 023 fixed
-- get_guild_player_counts() (the Names page); these two are the pair README.md
-- has been warning about:
--
--   "The Roster's all-time table and the dashboard tiles come from
--    get_player_stats() / get_stats_summary(), both called with no arguments,
--    so their guild list is baked into the SQL and does not [follow Guild
--    Settings]. If the two ever disagree about a member's match count, that
--    mismatch is the first place to look."
--
-- Both held the same dead list — 'FTP', 'PUSH', 'House Regard', 'Best Regards'
-- — so every player since the rename to 'Gear Gap' was missing from the
-- Roster's All Time table under BOTH the Members and All toggles, and every
-- kill, point of damage and point of healing since the rename was missing from
-- the dashboard totals. The Roster's "Last 10" toggle was unaffected, because
-- that path filters in JS against guildAliases() instead of calling the RPC —
-- which is exactly the disagreement README predicted.
--
-- With this applied, no function in the database has a guild name in it. The
-- alias list has one home, guild_config, and one way in: a parameter.
--
-- The DROPs are load-bearing and must come first — `create or replace` cannot
-- change a signature, so skipping them leaves both arities defined and every
-- caller dies with PGRST203 "could not choose the best candidate function".
--
-- Run this in the Supabase SQL editor.

drop function if exists get_player_stats();
drop function if exists get_player_stats(text[]);
drop function if exists get_stats_summary();
drop function if exists get_stats_summary(text[]);

-- ── Roster: all-time per-player totals ──────────────────────────────────────
-- SECURITY DEFINER is carried over from the original definition, as in 023.
-- Whether these need to run as their owner is an orthogonal RLS question, and
-- answering it here would put two unrelated changes in one blast radius.
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
  -- Map every known in-game name (and the display name itself) to one identity.
  --
  -- NOTE: this join is case-SENSITIVE (btrim only), while identities.js matches
  -- on lower(btrim(…)). A name whose casing differs between the scoreboard and
  -- the identity record therefore resolves in the JS layer but not here. That
  -- predates this migration and is left alone on purpose — collapsing case here
  -- would silently merge rows, which is a bigger change than the one this file
  -- is making and deserves its own.
  with name_map as (
    select distinct on (ingame_name) ingame_name, display_name
    from (
      select btrim(display_name) as ingame_name, display_name
        from public.player_identities
        where display_name is not null
      union all
      select btrim(jsonb_array_elements_text(ingame_names)) as ingame_name, display_name
        from public.player_identities
        where ingame_names is not null
          and jsonb_typeof(ingame_names) = 'array'
    ) t
    where ingame_name is not null and ingame_name <> ''
  ),
  -- One name per row, normalised the same way 019 and 023 do it. See the note
  -- in 019's get_guild_match_sides for why this is a subquery and not an array.
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
    left join name_map nm on btrim(pms.player_name) = nm.ingame_name
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

-- ── Dashboard: all-time guild totals ────────────────────────────────────────
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
