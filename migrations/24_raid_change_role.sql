-- 24_raid_change_role.sql — the raid lead changing a signed-up member's role.
--
-- raid_change_role(run, member, role) moves someone already on a raid run to
-- another role, keeping their place as far as the new role allows:
--
--   in the roster   → into the new role if it has room. A full role is
--                     refused (raid_role_full) rather than bumping someone:
--                     who comes out is the lead's call, made first. Their old
--                     slot goes to the first overflow bench entry in the old
--                     role, via raid_fill_role (22).
--   overflow bench  → straight into the new role if it has room. Otherwise
--                     they wait for the new role instead, in their original
--                     place in line: signed_up_at is kept.
--   opt-in bench    → still "available if needed", under the new role.
--
-- Locks the run's signup_events row like raid_join and raid_move, so it can't
-- interleave with a join taking the same slot. Not gated on status = 'open',
-- the same as raid_move: the lead can still rearrange a closed run.
--
-- Run this BEFORE deploying the code that calls it. Until then, the Raids
-- page's role buttons answer "needs migration 24" and nothing else changes.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

create or replace function raid_change_role(p_event_id uuid, p_discord_id text, p_role text)
returns table (
  entry_status text, entry_role text, entry_bench_kind text, bench_position int,
  changed boolean, from_role text, promoted_id text, promoted_name text, promoted_role text
)
language plpgsql
as $$
declare
  v_event signup_events%rowtype;
  v_entry signup_entries%rowtype;
  v_cap int;
  v_going int;
  v_status text;
  v_kind text;
  v_pid text;
  v_pname text;
  v_prole text;
  v_position int;
begin
  select * into v_event from signup_events where id = p_event_id for update;
  if not found then raise exception 'signup_not_found'; end if;
  if v_event.raid_key is null then raise exception 'not_a_raid'; end if;
  if v_event.role_caps is null or not (v_event.role_caps ? p_role) then raise exception 'raid_bad_role'; end if;

  select * into v_entry from signup_entries e
    where e.signup_event_id = p_event_id and e.discord_id = p_discord_id;
  if not found then raise exception 'raid_not_signed_up'; end if;

  -- Already that role: report it, change nothing.
  if v_entry.role = p_role then
    return query select v_entry.status, v_entry.role, v_entry.bench_kind, null::int,
      false, v_entry.role, null::text, null::text, null::text;
    return;
  end if;

  v_cap := coalesce((v_event.role_caps ->> p_role)::int, 0);
  select count(*) into v_going from signup_entries e
    where e.signup_event_id = p_event_id and e.status = 'going' and e.role = p_role;

  v_status := v_entry.status;
  v_kind := v_entry.bench_kind;
  if v_entry.status = 'going' and v_going >= v_cap then raise exception 'raid_role_full'; end if;
  if v_entry.status = 'bench' and v_entry.bench_kind = 'overflow' and v_going < v_cap then
    v_status := 'going';
    v_kind := null;
  end if;

  update signup_entries set
    role = p_role,
    status = v_status,
    bench_kind = v_kind,
    promoted_at = case when v_status = 'going' and v_entry.status <> 'going' then now() else promoted_at end
  where id = v_entry.id;

  -- Their old slot, if they had one.
  if v_entry.status = 'going' then
    select f.promoted_id, f.promoted_name, f.promoted_role into v_pid, v_pname, v_prole
      from raid_fill_role(p_event_id, v_entry.role) f limit 1;
  end if;

  if v_status = 'bench' and v_kind = 'overflow' then
    select count(*)::int into v_position from signup_entries e
      where e.signup_event_id = p_event_id and e.status = 'bench' and e.bench_kind = 'overflow' and e.role = p_role
        and (e.signed_up_at, e.id) <= (v_entry.signed_up_at, v_entry.id);
  end if;

  return query select v_status, p_role, v_kind, v_position, true, v_entry.role, v_pid, v_pname, v_prole;
end;
$$;

-- Same treatment as every other function (migration 12): the server's
-- service role only.
revoke execute on function raid_change_role(uuid, text, text) from public, anon, authenticated;
grant execute on function raid_change_role(uuid, text, text) to service_role;
