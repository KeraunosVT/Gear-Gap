-- 016_gear_screenshots.sql — store the full equipment window.
--
-- Run this in the Supabase SQL editor.
--
-- ── SUPERSEDED IN PART, AND STILL REQUIRED ──────────────────────────────────
-- This migration originally also read gear levels out of the stored window with
-- Heroic-tier items excluded. That reading has since been removed: the
-- equipment window is filed as evidence and parsed no more, and the Equipment
-- Level popup is the only thing that sets a gear level.
--
-- Everything below still needs to run — the table and the private bucket are
-- what hold the screenshot. What changed is only which columns get filled:
-- items/weapon/armor/accessory/average/excluded_count are written NULL/empty on
-- every new upload (and explicitly cleared on re-upload, so a row can't keep an
-- old parse beside a new image). They are kept, not dropped, because rows
-- written before the change still carry a real parse worth being able to look
-- at. The 'window' value on gear_levels.source is likewise historical: nothing
-- writes it any more, but rows that have it were measured by the old rule.
--
-- ── WHY THIS EXISTS ALONGSIDE THE POPUP UPLOAD ──────────────────────────────
-- The existing upload reads the small "Equipment Level" popup and trusts the
-- four numbers the game prints on it. That popup's "Max Weapon Lv." counts
-- every equipped weapon, including a Heroic one — which is exactly the item the
-- guild wants left out. There is no way to subtract it after the fact, because
-- the popup never says which item produced the number.
--
-- So the full equipment window is read instead: every item, its tier, and its
-- level, with the three maxima computed here from the non-Heroic items. Both
-- uploads stay. The popup is faster and still right for anyone with no Heroic
-- gear; the window is the one that can answer "why is that number what it is".

-- ── WHICH UPLOAD PRODUCED THE CURRENT ROW ───────────────────────────────────
-- 'popup'  — the Equipment Level window. Includes Heroic items.
-- 'window' — the full equipment window, Heroic items excluded.
--
-- The two measure different things, so the leaderboard would otherwise be
-- silently comparing members on different rules depending on which screenshot
-- each happened to upload last. Recorded explicitly rather than inferred from
-- "is there a gear_screenshots row", because a member can upload a window and
-- then a popup, and the popup is the newer answer.
--
-- NOT NULL with a default: every row that existed before this migration came
-- from the popup.
alter table gear_levels add column if not exists source text not null default 'popup';
alter table gear_level_history add column if not exists source text not null default 'popup';

-- ── THE STORED SCREENSHOT AND WHAT WAS READ OUT OF IT ───────────────────────
-- One row per member, replaced on re-upload — the same "latest wins" shape as
-- gear_levels, and the reason the storage path is keyed on discord_id alone.
-- Keeping every screenshot forever would grow without bound for a record whose
-- older copies nobody asks for; the numbers still accumulate in
-- gear_level_history, which is the part with a reason to be kept.
--
-- `items` is the full parse, not just the survivors: an officer asking "why is
-- their weapon level 68 when I know they have a 74" needs to see the 74 sitting
-- there marked excluded. Dropping the excluded items at parse time would make
-- that question unanswerable without re-reading the image.
create table if not exists gear_screenshots (
  discord_id text primary key,
  display_name text,
  -- Path within the private 'gear' bucket, not a URL. A stored URL would either
  -- be public (wrong — see the bucket below) or a signed one that expires,
  -- which is a URL that stops working while looking like data.
  storage_path text not null,
  -- [{ slot, name, category, tier, level, excluded }]
  items jsonb not null default '[]',
  -- Computed from the non-Heroic items only. Null where a category had nothing
  -- left after exclusion — distinct from 0, which would read as "level zero".
  weapon int,
  armor int,
  accessory int,
  average int,
  excluded_count int not null default 0,
  submitted_at timestamptz not null default now()
);

alter table gear_screenshots enable row level security;

-- ── THE BUCKET ──────────────────────────────────────────────────────────────
-- PRIVATE. `public = false` is the whole access control story here: the app
-- serves these through short-lived signed URLs from a route that checks the
-- viewer is either the member or an officer. A public bucket would make every
-- member's screenshot readable by anyone who could guess a Discord id, and the
-- route gating would be decoration.
--
-- Note this is the opposite of the 'assets' bucket, which is public on purpose
-- — loot icons are meant to be hotlinked.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gear', 'gear', false, 15728640, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- No storage policies are created, deliberately. The server holds the
-- service_role key, which bypasses RLS on storage.objects the same way it does
-- everywhere else in this app; no anon or authenticated client ever touches
-- this bucket directly.
