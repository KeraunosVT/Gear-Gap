-- 12_lock_down_anon.sql — nothing in the database is reachable with the
-- public anon key. Only the service key (the app, its scripts and the market
-- scraper) can read, write or call anything.
--
-- WHY. Supabase exposes every table and function in `public` over its REST
-- API. Which requests succeed depends on the key: the service key bypasses
-- row-level security; the anon key is meant to be public and is limited by it.
-- This app never uses the anon key — every query goes through the backend with
-- the service key — but until now several tables had RLS off, and every
-- function was callable by anyone. Anyone holding the anon key (it shows in the
-- dashboard to every project member, and is the key most often pasted into a
-- tool or a client by mistake) could have:
--   - inserted a row into permission_grants and handed themselves officer
--     capabilities,
--   - rewritten or emptied audit_log,
--   - read and written signups, Lucent requests and gear history,
--   - called the SECURITY DEFINER stats functions, which ignore RLS entirely.
-- The anon key is not in this repo or its history, so this closes a door
-- nobody is known to have opened. It costs the app nothing.
--
-- WHAT IT DOES, all of it idempotent:
--   1. Turns RLS on for every table in `public` that doesn't have it, including
--      the base tables that predate tracked migrations. No policies are added,
--      so anon and authenticated get nothing; the service role bypasses RLS.
--   2. Revokes every table, sequence and function privilege in `public` from
--      anon and authenticated, now and for objects created later. With RLS on
--      this is belt and braces: a policy added carelessly later still grants
--      nothing without the underlying privilege.
--   3. Re-grants function EXECUTE to service_role explicitly, since revoking
--      from PUBLIC would otherwise take it from every role that relied on it.
--   4. Pins search_path on SECURITY DEFINER functions, so one can't be pointed
--      at a same-named object in another schema.
--
-- Objects that belong to an installed extension are skipped: they aren't this
-- app's, and their owner may not be the role running this.
--
-- IF THE BROWSER EVER TALKS TO SUPABASE DIRECTLY (it doesn't today), whatever
-- it needs must be granted back to anon/authenticated deliberately, with a
-- policy — this migration makes that an explicit decision rather than a default.
--
-- Safe to re-run. Run in the Supabase SQL editor, then run verify.sql.

-- ── 1. RLS on every app table ───────────────────────────────────────────────
do $$
declare t record;
begin
  for t in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')          -- tables and partitioned tables
      and not c.relrowsecurity
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
  loop
    begin
      execute format('alter table public.%I enable row level security', t.relname);
      raise notice 'RLS enabled on %', t.relname;
    exception when insufficient_privilege then
      raise warning 'Could not enable RLS on % (not its owner) — check it by hand', t.relname;
    end;
  end loop;
end $$;

-- ── 2. No privileges for anon or authenticated ──────────────────────────────
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- ...including on anything created later by the role running migrations.
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
-- Postgres gives EXECUTE on every new function to PUBLIC as a GLOBAL default,
-- and a per-schema default can only add to the global one, never take away —
-- so this one has to be global to stick.
alter default privileges revoke execute on functions from public;

-- ── 3. The app keeps everything ─────────────────────────────────────────────
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- ── 4. Fixed search_path on SECURITY DEFINER functions ──────────────────────
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('alter function %s set search_path = public, pg_temp', f.sig);
    raise notice 'search_path pinned on %', f.sig;
  end loop;
end $$;
