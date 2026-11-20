-- 22_raids.sql — raid signups: fixed slots per role, and a bench.
--
-- A raid run is a signup_events row with raid_key set (shared/raids.json names
-- the raids). raid_segments is the run's plan, in order of difficulty:
-- [{ "mode": "normal", "gates": [1,2,3] }, { "mode": "nightmare", "gates": [1] }].
-- role_caps is the slot count per role, copied from the catalog when the run
-- is opened, so changing the catalog later doesn't reshuffle a run already
-- filling. Any member can open a run; created_by (05) is its raid lead's
-- Discord id and raid_lead_name a snapshot of their name (reads prefer the
-- site alias, as they do for signup_entries.display_name).
--
-- signup_entries gains the role picked at signup (raids only; War signups
-- read the role from member_roles and leave this null) and a third status,
-- 'bench'. bench_kind says how someone got there:
--   overflow — joined a role that was full. Moved up automatically, in
--              signup order, when a slot in that role opens.
--   opt_in   — chose the bench ("available if needed"), or was benched by the
--              raid lead. Only moved up by the lead.
--
-- The functions lock the run's signup_events row, the same way signup_join
-- does (05), so two people taking the last tank slot at once can't both get it.
--
-- Raid runs can't be posted until this has run; War signups don't need it.
--
-- Safe to re-run. Run this in the Supabase SQL editor, then run verify.sql.

alter table signup_events add column if not exists raid_key text;
alter table signup_events add column if not exists raid_segments jsonb;
alter table signup_events add column if not exists role_caps jsonb;
alter table signup_events add column if not exists raid_lead_name text;

alter table signup_entries add column if not exists role text;
alter table signup_entries add column if not exists bench_kind text;

alter table signup_entries drop constraint if exists signup_entries_role_check;
alter table signup_entries add constraint signup_entries_role_check
  check (role is null or role in ('Tank', 'DPS', 'Healer'));
alter table signup_entries drop constraint if exists signup_entries_bench_kind_check;
alter table signup_entries add constraint signup_entries_bench_kind_check
  check (bench_kind is null or bench_kind in ('overflow', 'opt_in'));
-- Widened from ('going', 'waitlist').
alter table signup_entries drop constraint if exists signup_entries_status_check;
alter table signup_entries add constraint signup_entries_status_check
  check (status in ('going', 'waitlist', 'bench'));

-- Moves the first overflow bench entry in a role into the roster, if the role
-- has room. Callers hold the row lock. Returns nothing when the role is full
-- or nobody is waiting for it.
create or replace function raid_fill_role(p_event_id uuid, p_role text)
returns table (promoted_id text, promoted_name text, promoted_role text)
language plpgsql
as $$
declare
  v_cap int;
  v_going int;
begin
  select coalesce((role_caps ->> p_role)::int, 0) into v_cap from signup_events where id = p_event_id;
  select count(*) into v_going from signup_entries e
    where e.signup_event_id = p_event_id and e.status = 'going' and e.role = p_role;
  if v_going >= v_cap then return; end if;

  return query
    update signup_entries set status = 'going', bench_kind = null, promoted_at = now()
    where id = (
      select e.id from signup_entries e
      where e.signup_event_id = p_event_id and e.status = 'bench'
        and e.bench_kind = 'overflow' and e.role = p_role
      order by e.signed_up_at, e.id
      limit 1
    )
    returning signup_entries.discord_id, signup_entries.display_name, signup_entries.role;
end;
$$;

-- Join a raid in a role, or on the bench. Joining again in another role (or
-- moving between roster and bench) replaces the old entry: the old slot is
-- freed, and the first overflow bench entry in that role moves up.
--
-- p_bench = false: into the role if it has room, else the bench (overflow).
-- p_bench = true:  the bench (opt_in), whatever the role's room.
--
-- position is where the caller stands on the bench for their role (1 = next
-- up), or null when they're in.
create or replace function raid_join(
  p_event_id uuid,
  p_discord_id text,
  p_display_name text,
  p_role text,
  p_bench boolean default false,
  p_added_by text default null
) returns table (
  entry_status text, entry_role text, entry_bench_kind text, bench_position int,
  changed boolean, promoted_id text, promoted_name text, promoted_role text
)
language plpgsql
as $$
declare
  v_event signup_events%rowtype;
  v_existing signup_entries%rowtype;
  v_had boolean := false;
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
  if v_event.status <> 'open' then raise exception 'signup_closed'; end if;
  if v_event.raid_key is null then raise exception 'not_a_raid'; end if;
  if v_event.role_caps is null or not (v_event.role_caps ? p_role) then raise exception 'raid_bad_role'; end if;

  select * into v_existing from signup_entries
    where signup_event_id = p_event_id and signup_entries.discord_id = p_discord_id;
  v_had := found;

  -- Already where they asked to be: report, don't reshuffle. A second click on
  -- an old post shouldn't send someone to the back of the bench.
  if v_had and v_existing.role = p_role and (
       (not p_bench and v_existing.status = 'going')
    or (not p_bench and v_existing.status = 'bench' and v_existing.bench_kind = 'overflow')
    or (p_bench and v_existing.status = 'bench' and v_existing.bench_kind = 'opt_in')) then
    v_status := v_existing.status;
    v_kind := v_existing.bench_kind;
  else
    if v_had then
      delete from signup_entries where id = v_existing.id;
    end if;

    v_cap := (v_event.role_caps ->> p_role)::int;
    select count(*) into v_going from signup_entries e
      where e.signup_event_id = p_event_id and e.status = 'going' and e.role = p_role;

    if p_bench then
      v_status := 'bench'; v_kind := 'opt_in';
    elsif v_going < v_cap then
      v_status := 'going'; v_kind := null;
    else
      v_status := 'bench'; v_kind := 'overflow';
    end if;

    insert into signup_entries (signup_event_id, discord_id, display_name, status, role, bench_kind, added_by)
      values (p_event_id, p_discord_id, left(coalesce(p_display_name, ''), 120), v_status, p_role, v_kind, p_added_by);

    -- Their old slot, if they gave one up.
    if v_had and v_existing.status = 'going' and not (v_status = 'going' and v_existing.role = p_role) then
      select f.promoted_id, f.promoted_name, f.promoted_role into v_pid, v_pname, v_prole
        from raid_fill_role(p_event_id, v_existing.role) f limit 1;
    end if;
  end if;

  if v_status = 'bench' and v_kind = 'overflow' then
    select count(*)::int into v_position from signup_entries e
      where e.signup_event_id = p_event_id and e.status = 'bench' and e.bench_kind = 'overflow' and e.role = p_role
        and (e.signed_up_at, e.id) <= (select x.signed_up_at, x.id from signup_entries x
                                        where x.signup_event_id = p_event_id and x.discord_id = p_discord_id);
  end if;

  return query select v_status, p_role, v_kind, v_position,
    not (v_had and v_existing.role = p_role and v_existing.status = v_status
         and v_existing.bench_kind is not distinct from v_kind),
    v_pid, v_pname, v_prole;
end;
$$;

-- Leave a raid. Frees the slot and moves up the first overflow bench entry in
-- that role. Not gated on status = 'open', same as signup_withdraw (05).
create or replace function raid_withdraw(p_event_id uuid, p_discord_id text)
returns table (removed boolean, was_going boolean, promoted_id text, promoted_name text, promoted_role text)
language plpgsql
as $$
declare
  v_status text;
  v_role text;
  v_promoted record;
begin
  perform 1 from signup_events where id = p_event_id for update;
  if not found then raise exception 'signup_not_found'; end if;

  delete from signup_entries
    where signup_event_id = p_event_id and signup_entries.discord_id = p_discord_id
    returning signup_entries.status, signup_entries.role into v_status, v_role;

  if v_status is null then
    return query select false, false, null::text, null::text, null::text;
    return;
  end if;
  if v_status <> 'going' or v_role is null then
    return query select true, false, null::text, null::text, null::text;
    return;
  end if;

  select * into v_promoted from raid_fill_role(p_event_id, v_role) limit 1;
  return query select true, true, v_promoted.promoted_id, v_promoted.promoted_name, v_promoted.promoted_role;
end;
$$;

-- The raid lead (or an officer) moving someone between the roster and the
-- bench. Into the roster refuses a full role. Onto the bench is opt_in, so
-- they aren't moved straight back up, and the freed slot is left open for the
-- lead to fill: moving someone out is usually to make room for someone else.
create or replace function raid_move(p_event_id uuid, p_discord_id text, p_to text)
returns table (entry_status text, entry_role text)
language plpgsql
as $$
declare
  v_event signup_events%rowtype;
  v_entry signup_entries%rowtype;
  v_going int;
begin
  select * into v_event from signup_events where id = p_event_id for update;
  if not found then raise exception 'signup_not_found'; end if;
  if v_event.raid_key is null then raise exception 'not_a_raid'; end if;

  select * into v_entry from signup_entries
    where signup_event_id = p_event_id and signup_entries.discord_id = p_discord_id;
  if not found then raise exception 'raid_not_signed_up'; end if;

  if p_to = 'going' then
    if v_entry.status = 'going' then
      return query select v_entry.status, v_entry.role; return;
    end if;
    select count(*) into v_going from signup_entries e
      where e.signup_event_id = p_event_id and e.status = 'going' and e.role = v_entry.role;
    if v_going >= coalesce((v_event.role_caps ->> v_entry.role)::int, 0) then raise exception 'raid_role_full'; end if;
    update signup_entries set status = 'going', bench_kind = null, promoted_at = now() where id = v_entry.id;
    return query select 'going'::text, v_entry.role;
  elsif p_to = 'bench' then
    -- To the back of the bench.
    update signup_entries set status = 'bench', bench_kind = 'opt_in', signed_up_at = now() where id = v_entry.id;
    return query select 'bench'::text, v_entry.role;
  else
    raise exception 'raid_bad_move';
  end if;
end;
$$;

-- Same treatment as every other function (migration 12): the server's
-- service role only.
revoke execute on function raid_fill_role(uuid, text) from public, anon, authenticated;
revoke execute on function raid_join(uuid, text, text, text, boolean, text) from public, anon, authenticated;
revoke execute on function raid_withdraw(uuid, text) from public, anon, authenticated;
revoke execute on function raid_move(uuid, text, text) from public, anon, authenticated;
grant execute on function raid_fill_role(uuid, text) to service_role;
grant execute on function raid_join(uuid, text, text, text, boolean, text) to service_role;
grant execute on function raid_withdraw(uuid, text) to service_role;
grant execute on function raid_move(uuid, text, text) to service_role;
