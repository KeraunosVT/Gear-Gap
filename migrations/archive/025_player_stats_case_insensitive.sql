-- 025_player_stats_case_insensitive.sql — one player, one Roster row, whatever
-- the scoreboard capitalised.
--
-- get_player_stats() resolved in-game names to identities with a case-SENSITIVE
-- join (`btrim(pms.player_name) = nm.ingame_name`), while identities.js resolves
-- the same names with `lower(trim(…))`. 024 left that alone deliberately and
-- said so in a comment; this is the bill arriving.
--
-- A scoreboard read as `Shawarmashuffle` against an identity holding
-- `ShawarmaShuffle` produced TWO Roster rows for one person — 92 matches under
-- one spelling, 1 under the other. And the split could not be repaired from the
-- Names page, because the two layers disagree in OPPOSITE directions:
--
--   * SQL, case-sensitive: the name doesn't resolve, so it becomes its own
--     canonical_name and gets its own row.
--   * JS, case-insensitive: identityForName() DOES resolve it, so the Unmapped
--     list treats it as already mapped and never offers it.
--
-- So the name was simultaneously unmapped enough to split the Roster and mapped
-- enough to be invisible on the page that exists to fix exactly this. Adding the
-- variant spelling as an alias by hand would have cleared this one instance and
-- left the trap set — OCR produces a fresh capitalisation whenever a screenshot
-- is a little dark, and each one would quietly fork another player.
--
-- Matching is now `lower(normalise_player_name(…))` on both sides: the same
-- expression 021 already uses to join enemy player aliases, and the closest SQL
-- equivalent of identities.js's norm(). It also collapses internal double
-- spaces, which the old btrim did not and which OCR emits regularly.
--
-- THE LOWERING MUST HAPPEN INSIDE name_map's SUBQUERY, not just at the join.
-- `distinct on (ingame_name)` is what guarantees one row per name, and that
-- guarantee is what keeps the LEFT JOIN from multiplying match rows. Fold case
-- only at the join and an identity carrying both `Vex` and `VEX` yields two
-- name_map rows that now match the same scoreboard row — every stat for that
-- player silently doubles. Lowering first means the DISTINCT ON dedupes on the
-- folded key, which is the whole point.
--
-- Signature unchanged, so this needs no code deploy and can be run on its own.
-- It does assume 024 has been applied (that migration introduces the
-- p_guild_names parameter and get_stats_summary alongside it).
--
-- Run this in the Supabase SQL editor.

drop function if exists get_player_stats(text[]);

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
  -- Map every known in-game name (and the display name itself) to one identity,
  -- keyed on the case-folded name. See the header on why the fold is here and
  -- not at the join.
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
    -- Explicit and deterministic. DISTINCT ON without an ORDER BY picks an
    -- arbitrary winner, which barely mattered while keys were exact strings but
    -- becomes reachable once case is folded: two identities holding `Vex` and
    -- `VEX` now collide on one key. They still collide — that is a real data
    -- problem for a human to resolve on the Names page — but the Roster must at
    -- least not reshuffle which of them wins between two identical reads.
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
