-- 017_questlog_potentials.sql — make room for gear potentials in the questlog
-- reference table.
--
-- `questlog_items` predates the tracked migrations, so this is the first file
-- that touches it. It gains no new columns: a potential is a named, described,
-- iconed thing that members request exactly like an item, and everything
-- downstream — the officer search, "add from questlog", the item tooltip —
-- already reads this table. Giving potentials a table of their own would mean
-- reimplementing all four for a second row shape.
--
-- They are told apart by `main_category = 'potential'`, and their `sub_category`
-- holds the gear type they roll on (weapon / armor / accessory / universal)
-- rather than a weapon class; the weapon class lives in `data.weaponClass`.
--
-- Two things needed loosening, both no-ops if they were already true — the table
-- was created by hand and nobody wrote down which columns were nullable:
--
--   * `grade` — items are Epic (41) or Legendary (51). Potentials have no grade
--     at all, so the column has to accept null or every potential row is
--     rejected on insert.
--   * `sub_category` — the 12 stat potentials ("Hit Chance", "Max Health") roll
--     on both armor and accessories and belong to no single gear type.
--
-- Safe to re-run.
--
-- Run this in the Supabase SQL editor BEFORE the next "Sync Item Database".
-- Running the sync first isn't destructive — the potential upserts just fail
-- one by one and the errors come back in the sync result — but nothing is
-- imported until this has run.

alter table questlog_items alter column grade drop not null;
alter table questlog_items alter column sub_category drop not null;

-- The import reads back only the potential rows to decide which ones still need
-- their effect text, and the officer search filters on this column. 192
-- potentials against a few thousand items is exactly the selectivity an index
-- is for.
create index if not exists questlog_items_main_category_idx
  on questlog_items (main_category);
