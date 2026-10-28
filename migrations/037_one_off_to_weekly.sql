-- 037_one_off_to_weekly.sql — turn a one-off event into a weekly one.
--
-- A one-off is a signup_events row with no schedule entry. Making it weekly is
-- three writes that are only right together, so they live in one function:
--
--   1. a schedule entry with the one-off's name, time and type;
--   2. the one-off (and any later copies of it, below) attached to that entry,
--      so the people already signed up stay signed up — otherwise the night
--      would show the new weekly event AND the old one-off side by side;
--   3. attendance already logged for those nights attached too, for the same
--      reason: a one-off's attendance is matched to it by name, a weekly
--      event's by schedule id, and without this the night shows twice.
--
-- "Later copies" are one-offs an officer made by hand for the same thing on
-- later weeks — same name (ignoring case), same time, same night of the week.
-- They would be the weekly event's nights too, so they join it rather than
-- sitting beside it. One per night at most: the unique index on
-- (event_date, event_schedule_id) allows no more.
--
-- The day of week is passed in rather than worked out here. An after-midnight
-- event is stored on the next calendar day, and the rule for "after midnight"
-- (guild_config.day_start) already lives in backend/loa.js and timeUtils.js,
-- held in step by a test. A third copy in SQL would be one nothing checks.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

create or replace function make_signup_weekly(p_signup_id uuid, p_day_of_week int)
returns uuid
language plpgsql
as $$
declare
  v_ev signup_events%rowtype;
  v_id uuid := gen_random_uuid();
begin
  select * into v_ev from signup_events where id = p_signup_id for update;
  if not found then raise exception 'signup_not_found'; end if;
  if v_ev.event_schedule_id is not null then raise exception 'signup_already_weekly'; end if;

  insert into event_schedule (id, name, day_of_week, event_time, category)
  values (v_id, v_ev.title, p_day_of_week, left(v_ev.event_time, 5), v_ev.category);

  with linked as (
    update signup_events e set event_schedule_id = v_id, updated_at = now()
    where e.id in (
      select distinct on (s.event_date) s.id
      from signup_events s
      where s.event_schedule_id is null
        and (s.id = p_signup_id or (
          lower(trim(s.title)) = lower(trim(v_ev.title))
          and left(s.event_time, 5) is not distinct from left(v_ev.event_time, 5)
          and s.event_date > v_ev.event_date
          and extract(dow from s.event_date) = extract(dow from v_ev.event_date)
        ))
      order by s.event_date, (s.id = p_signup_id) desc, s.created_at
    )
    returning e.event_date
  )
  update events a set event_schedule_id = v_id
  where a.event_schedule_id is null
    and lower(trim(a.title)) = lower(trim(v_ev.title))
    and a.event_date in (select event_date from linked);

  return v_id;
end;
$$;
