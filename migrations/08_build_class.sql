-- 08_build_class.sql — which class a build is for.
--
-- One PvE and one PvP build per member, as before; the class is a label on
-- each, picked by the member at upload. Builds saved before this have none
-- until they're next saved, which then requires one. The allowed names are
-- shared/weaponClasses.json plus shared/extraClasses.json, checked in
-- backend/builds.js rather than here so a new class is a JSON edit, not a
-- migration.
--
-- RUN THIS BEFORE DEPLOYING the code that reads it: builds.list() selects this
-- column by name, so without it the Builds page fails to load.
--
-- Safe to re-run. Run this in the Supabase SQL editor.

alter table builds add column if not exists class text;
