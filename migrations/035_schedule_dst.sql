-- 035_schedule_dst.sql — the Event Calendar's daylight-saving toggle.
--
-- The game's clock doesn't move for DST, the guild's does, so twice a year
-- every weekly event lands an hour off in guild time. This moves them all at
-- once instead of editing each row by hand.
--
-- dst_active is which way the schedule currently reads. It defaults to true
-- because the times on file were entered in summer time; turning it off moves
-- every event an hour EARLIER (a server on standard time reads an hour earlier
-- in EST than in EDT), and turning it back on moves them back.
--
-- ── WHY A FUNCTION ──────────────────────────────────────────────────────────
-- The shift is three writes that are only right together: the flag, the
-- schedule, and the signups already opened for nights still to come. Those
-- carry their own snapshot of event_time and starts_at (013), and starts_at
-- drives reminders and auto-close, so leaving them behind would ping people an
-- hour off. A function body is one transaction, so a failure part way can't
-- leave half the week moved.
--
-- The flag is flipped compare-and-set: two officers pressing the toggle at the
-- same moment shift the schedule once, not twice.
--
-- One-off signups (no event_schedule_id) are left alone. Their time was typed
-- for that one date by whoever made them, so it is already right.
--
-- An event within an hour of the guild-night rollover (day_start) can cross it
-- and change which night it belongs to. With the default 01:00 rollover that is
-- only an event between 00:00 and 01:59, and only one entered while the toggle
-- was in the other position.
--
-- RUN THIS BEFORE DEPLOYING the code that reads it: guildConfig selects its
-- columns by name, so a missing column fails the whole config load.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

alter table guild_config add column if not exists dst_active boolean not null default true;

create or replace function set_schedule_dst(p_active boolean)
returns jsonb
language plpgsql
as $$
declare
  v_mins int := case when p_active then 60 else -60 end;
  v_ids jsonb;
begin
  update guild_config set dst_active = p_active, updated_at = now()
  where id = 1 and dst_active is distinct from p_active;
  if not found then
    return jsonb_build_object('changed', false, 'signup_ids', '[]'::jsonb);
  end if;

  -- Minutes past midnight, shifted, then split back into a day and a time. An
  -- event pushed past midnight either way moves to the neighbouring calendar
  -- day, the same as the schedule stores after-midnight events already.
  update event_schedule s set
    day_of_week = (s.day_of_week + 7 + floor((t.m + v_mins) / 1440.0)::int) % 7,
    event_time  = to_char(make_interval(mins => ((t.m + v_mins) % 1440 + 1440) % 1440), 'HH24:MI')
  from (
    select id, extract(hour from event_time::time)::int * 60 + extract(minute from event_time::time)::int as m
    from event_schedule
    where event_time is not null
  ) t
  where s.id = t.id;

  -- Nights still to come that signups were already opened for. event_date is
  -- the guild night and stays put; the instant moves by exactly the shift.
  with moved as (
    update signup_events e set
      event_time = left(s.event_time::text, 5),
      starts_at  = e.starts_at + make_interval(mins => v_mins)
    from event_schedule s
    where e.event_schedule_id = s.id
      and s.event_time is not null
      and e.starts_at > now()
    returning e.id
  )
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_ids from moved;

  return jsonb_build_object('changed', true, 'signup_ids', v_ids);
end;
$$;
