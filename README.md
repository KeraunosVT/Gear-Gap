# Gear Gap — Guild Hall

A guild-management web app for a *Throne & Liberty* guild, built around Discord: members log in with Discord OAuth, officers run the "war table" (attendance, loot council, rosters), and a companion Discord bot handles slash commands, timers, and announcements. Branding (house name, tag, motto) lives in one file and is meant to be re-themed per guild — see [Configuration](#configuration).

## Features

**For members**
- **Roster & War Record** — every member's all-time PvP stats, drill into a player's match history
- **Loot Wishlist** — pick items you want per build (PvP / PvE / Second Build); see live demand
- **Archboss Shards** — track how many of each archboss shard type you need, plus a weapon wishlist
- **Gear Level** — a **Watermark Upload** (the small in-game Equipment Level popup) has its four numbers read automatically (Gemini). That is the only thing that sets a gear level. Separately you can file a **Gear Screenshot Upload** — your full equipment window: it is stored and visible to you and to officers, and nothing is read out of it — no parse, no numbers, no effect on your level. It used to be parsed item by item to recompute the maxima with Heroic gear excluded, but two uploads writing one column meant the number meant different things for different members, off a per-item read too unreliable to trust without opening the image anyway. The picture is now the evidence, and the watermark is the measurement
- **My Classes** — rank up to 3 classes per mode so officers can plan parties around your build
- **Event Calendar** (`/attendance/calendar`) — the week ahead as an agenda, one section per night, four weeks of paging. It shows the **schedule**, not just opened signups: a recurring event appears on the nights it runs even when nobody has opened it, and saying *I'm in* opens the occurrence on the way through (`POST /api/signups/for-event`, which opens and joins in one request so a failure can't strand an empty signup that looks like a raid call nobody answered). Opening this way is quiet — no Discord post; officers post it from Signups when they want the call made. Members can only open a night that hasn't started and is inside 30 days, and the pager's 4-week ceiling is that same limit, so its arrows can't reach a week the API would refuse. Your own LOA marks a row *you're away*, and *on LOA and signed up* if both — surfaced, never auto-resolved. There is no way to say you're out here; that's what an LOA is
- **Leave of Absence** — submit LOA for a single event, a date range, or recurring days (pick more than one at once); optionally scope any of these to a time window (e.g. "I can make the 6pm event but I'm out after that," or "out 7–8pm, back after") — also via `/loa` in Discord. Cancelling one deletes its announcement, so a nominated member can be [DMed](#guild-settings-adminsettings) when it happens: coming back otherwise *removes* evidence rather than adding it, and nobody planning a night would notice
- **My Attendance** — every night attendance was taken in the last 30 days and whether you were counted. If the snapshot missed you, ask an officer to add you — for 24 hours after attendance was taken, from the site or via `/attendance-late`. Nobody writes their own attendance; a member asks, an officer decides, and you get a DM either way

**For officers**
- **Attendance** — snap a voice channel's members into a logged event, tied to the recurring event schedule; also runnable straight from Discord via `/attendance`. **Refresh** beside the channel line re-reads it and folds latecomers into the snap without disturbing it — people who have since left stay counted, and anyone removed by hand stays removed. One set of window tabs (1 week / 2 weeks / 30 days / all) governs both the per-member rate table and the list of logged nights beside it, so the percentage and the events explaining it always cover the same period
- **The night in full** — every logged event has its own page: one row and exactly one status per member (attended, pending, no-show having signed up, LOA, request denied), anyone who never answered at all in a separate table, the party that was fielded, and bulk approve/deny/add/remove. A **copy** of the party is frozen onto the event when attendance is saved, so editing or deleting the saved roster afterwards can't rewrite what that night ran with
- **Late attendance queue** — pending requests appear above the record with the member's reason and one click each way. Two officers deciding the same request at once produces one attendance row and one "already decided", not two rows and an inflated rate
- **Loot Council** — see wishlist demand, award items, track Lucent and archboss-shard grants per member
- **Parties** — drag-and-drop party builder with roles, saved rosters, posts directly to Discord. Each roster is saved against the date/event it's for, so reopening it re-checks LOA for that occasion and reports what changed since — who has filed since you built it, and who's since cancelled. The posted image lists who's on leave underneath the parties, so members can see they were accounted for
- **Gear Levels / Merge Names** — guild-wide gear-level leaderboard, opening any stored gear screenshot to check a number against the picture. Two counts sit at the top — how many have submitted a gear level, and how many have a gear screenshot on file — kept separate because one no longer implies the other; both narrow with the search box. Members who have filed a gear screenshot but never sent a Watermark Upload appear with no levels and a *screenshot only* tag, rather than dropping off the table with their image unreachable; older rows measured back when the gear screenshot set levels stay marked, since they were scored by a different rule. Reconcile OCR-misread in-game names to the right player
- **Admin** — match/screenshot ingestion, member role management, event schedule management, and a one-click **Sync Item Database** pulling reference data from Questlog: Epic+ gear plus all 192 gear potentials, each with **what it actually does written into its description** — `Attack Power 207–385 · Attack Range 3.5 m · Strength +18` for a weapon, `Ensnaring Arrow's skill level increases by 1.` for a potential. Questlog's own item description is flavour text and never names a stat, so it's kept underneath the summary rather than replaced — the equip rules in it ("Identical rings cannot be equipped at the same time") are the sort of thing nothing else in the app records. See [Stat units](#stat-units)

**Discord bot**
- `/elitetimer`, `/elitetimers` — report and check elite boss respawn timers
- `/loa` — submit or cancel leave of absence from Discord
- `/attendance` — snap a voice channel and log attendance for a scheduled event. Uses the channel you name, else the one you're sitting in, else the guild's configured attendance channel — so it works from a text channel once that's set
- `/attendance-late` — the one attendance command that isn't officers-only: ask to be added to a night the snapshot missed. The autocomplete *is* the 24-hour window, so a member with nothing eligible sees an empty list rather than a rejection
- `/announce` — post a timed announcement (e.g. "get into CTA Comms") with a timestamp that renders in each viewer's own timezone

## Tech stack

- **Frontend**: React + Vite, React Router, Tailwind CSS
- **Backend**: Node.js + Express, `discord.js` (bot/gateway), Discord OAuth2 (login)
- **Database**: Supabase (Postgres)
- **AI**: Google Gemini — parses screenshot uploads (match scoreboards, gear level windows)

Backend and frontend deploy as a single process: `server.js` serves the built frontend (`frontend/dist`) statically alongside the `/api` routes, so there's one server to run.

## Project structure

```
backend/     Express API, Discord bot/gateway, Supabase access
frontend/    React app (Vite)
shared/      Game-data JSON shared by both (shards, weapons, elite boss locations, etc.)
```

## Local development

Requires Node 18+ and a Supabase project (Postgres).

```bash
# from the repo root
npm install        # installs backend + frontend deps, builds the frontend once

# then, for active development with hot reload:
cd backend && npm start      # API on :3000
cd frontend && npm run dev   # Vite dev server on :5173 (set CORS_ORIGINS below)
```

For local dev with two separate dev servers, set `CORS_ORIGINS=http://localhost:5173` in `backend/.env` so the Vite dev server can call the API.

### Tests

```bash
npm test     # from the repo root
```

`node:test`, which is built into Node — no dependency, no config, no runner to install. Lives in [`backend/test/`](backend/test/) and needs no database: everything is driven through a fake Supabase.

The suite is deliberately narrow. It covers the logic where a mistake produces a **plausible wrong answer** rather than an error — row-cap paging, and the guild-night comparisons. Rendering and routing aren't tested and don't need to be; a broken page is obvious the moment you look at it, while a truncated read is not.

### Reading a table that grows

Use [`fetchAll`](backend/pagedRead.js) for any read of a table with no natural bound. PostgREST caps an unbounded `select()` at `max-rows` (1,000 by default) and returns the truncated set **with no error** — so the read starts silently wrong the day the table crosses that line, and the tables it bit here were the ones where wrongness is least visible: absences that stop counting, awards that stop being recognised, attendance rates computed from a partial numerator.

Two rules go with it:

- **Order by something unique**, or add `id` as a final tiebreaker. Range pagination over an ordering with ties is not stable — rows with equal sort keys can land on either side of a page boundary between requests, so one may be skipped or read twice. Sorting in JS afterwards doesn't help; the damage happens between the requests.
- **Never stop on a short page.** `data.length < pageSize` is correct only while `pageSize` isn't larger than the server's own cap — ask for 1,000 from a project set to 500 and the loop reads the first page as "the end". `fetchAll` advances by rows actually received and stops only on an empty page.

## Configuration

Configuration is split in two. **Secrets and identity** are environment variables, read from `backend/.env` or injected by your host. **Everything an officer might want to change** — the guild's name, which channels the bot posts in, which roles mean what — lives in the database and is edited on the **Guild Settings** page.

| Variable | Purpose |
|---|---|
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` | Discord OAuth2 app (member login) |
| `DISCORD_BOT_TOKEN` | Discord bot (gateway, slash commands, session re-verification) |
| `DISCORD_GUILD_ID` | The one Discord server this deployment is bound to |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Database connection |
| `JWT_SECRET` | Signs the session cookie |
| `GEMINI_API_KEY` | Screenshot parsing (match stats, gear level) |
| `GEMINI_MODEL` | Optional, defaults to `gemini-2.5-flash` |
| `PORT` | Optional, defaults to `3000` |
| `CORS_ORIGINS` | Optional, comma-separated trusted origins (local dev only — production is same-origin) |
| `APP_URL`, `NODE_ENV`, `SESSION_REVERIFY_MINUTES`, `GEAR_SUBMIT_LIMIT_PER_HOUR`, `IDENTITY_CACHE_SECONDS`, `MEMBER_CACHE_SECONDS`, `GUILD_CONFIG_CACHE_SECONDS`, `WEAPON_LEGEND_PATH` | Secondary tuning, all have sensible defaults |

### Guild Settings (`/admin/settings`)

Everything below used to be an environment variable or a file in the repo, and changing any of it needed a redeploy. It now lives in the `guild_config` table (one row, migration 014) and is read at call time — so a save takes effect on the next page load, not the next deploy.

| Setting | Was | Notes |
|---|---|---|
| House name, tag, past names | `shared/guild.json` | Past names must stay listed forever — see below |
| Motto, creed | `frontend/src/guild.js` | Shown on the login page |
| Timezone, guild-night rollover | consts in `loa.js` / `timeUtils.js` | See *Guild nights run past midnight* |
| Officer roles | `DISCORD_ADMIN_ROLE_IDS` | Grants every capability, present and future |
| Member allow-list | `DISCORD_ALLOWED_ROLE_IDS` | Who may sign in. Empty = any member of the server |
| Roster roles | `DISCORD_MEMBER_ROLE_IDS` | Who appears in parties, attendance and reminders |
| Roster / LOA / Announce / Signup channels | `DISCORD_*_CHANNEL_ID` | Blank = that feature posts nowhere |
| Attendance voice channel | *(new)* | The one channel the bot **reads** rather than posts to |
| LOA cancellation notice | *(new)* | DMs one member whenever anyone cancels an LOA. Blank = nobody, which is what every deployment did before migration 018 |

**Those environment variables are no longer read.** Setting `DISCORD_LOA_CHANNEL_ID` today does nothing; leaving stale ones in `.env` is harmless but misleading, so delete them once you have migrated.

Two saves are refused rather than confirmed, because neither is recoverable from inside the app:

- **Removing your own officer role**, or a role you hold from the allow-list. Capabilities live in the session cookie and refresh hourly, so the mistake surfaces an hour later — by which point you can't sign in to undo it. Checked against Discord, not the session, and fails closed if Discord is unreachable.
- **Removing a past name that still appears in the war record.** `canonicalGuild()` collapses every listed alias onto the current tag; drop one that history uses and those matches are silently re-read as an enemy guild's, taking their kills out of the record with no error anywhere. Renaming the tag adds the new name automatically for the same reason, pointed at the future.

#### Migrating an existing deployment

Order matters. Doing step 3 before step 2 leaves the bot with no channels and — because the two role lists gate the admin area and the login itself — nobody able to sign in and fix it.

```bash
# 1. Run migrations/014_guild_config.sql in the Supabase SQL editor.

# 2. In the DEPLOYMENT'S OWN environment, so it reads the same DISCORD_* values
#    the server reads. Dry run first; it prints exactly what would change.
node backend/scripts/seedConfigFromEnv.js
node backend/scripts/seedConfigFromEnv.js --write

# 3. Verify row 1 against the current env, then deploy.
```

The seed script never overwrites a set column with a blank one, so re-running it after someone has edited settings in the app won't wipe their work.

### Guild nights run past midnight

A guild night doesn't end at midnight. The 12:30 AM Guild Field Boss is the tail of the previous evening's block, not the start of a new day — so "Saturday's events" means Saturday 8 PM through Sunday 12:30 AM, and a member who files *"out from 9 PM Saturday"* is out for that 12:30 AM boss too.

The schedule stores each event on the calendar day it **actually occurs** (the 12:30 AM boss is stored under Sunday). The code maps that back to the night it belongs to: anything before the **guild-night rollover** (01:00 by default) counts as the night before. It must sit after the guild's latest event and before the earliest of the next evening.

The rollover and the guild timezone are both set on [Guild Settings](#guild-settings-adminsettings). They used to be consts in [`backend/loa.js`](backend/loa.js) and [`frontend/src/timeUtils.js`](frontend/src/timeUtils.js) that had to be edited together; both files now read them at call time — the backend from `guild_config`, the frontend from `GET /api/guild` via `configureGuildTime()`, which runs before anything renders. **Never hoist either value into a module-scope const**: a copy taken at import time keeps the old rollover until the next deploy, and the symptom isn't an error, it's a whole night of LOA, signups and attendance filed against the wrong date.

Moving the rollover re-buckets **existing** records as well as new ones, since the night an event belongs to is derived, not stored. The settings page says so before it saves.

Two consequences worth knowing:

- Times are never compared as `"HH:MM"` strings, since `"00:30" < "21:00"` is true as text but false as a night. Everything goes through `daySlot()`, which measures minutes from the start of the guild night.
- An LOA whose end time is earlier than its start is read as crossing midnight, so *"out 11 PM–1 AM"* is a valid window.

To check which day each event is filed under: `node scripts/dumpEventSchedule.js` (read-only).

### When a page crashes

Two error boundaries, in [`frontend/src/components/ErrorBoundary.jsx`](frontend/src/components/ErrorBoundary.jsx). React unmounts the entire tree when a render throws and nothing catches it — before these, one bad render blanked the whole site: no message, no nav, and no way back except knowing to reload.

- The **page** boundary wraps `<Outlet />`, not the shell, so a crash leaves the sidebar and topbar standing and the fallback has somewhere to send you. It clears itself when the pathname changes — a boundary holds its error forever otherwise, and clicking a sidebar link would change the route while still showing the old page's crash. The reset is driven by a `resetKey` prop rather than a `key` on the boundary: keying it on the pathname would remount it *and its children* on every navigation, including between two routes rendering the same component (`/roster/:name` to another name, `/dashboard` and `/match-stats`).
- The **root** boundary wraps `AuthProvider`, catching the shell itself, the login screen, and anything above the Router. There is nowhere to navigate to from there, so it is fullscreen and only offers a reload.

**They catch render errors only.** A rejected `axios` promise is not something React can see, which is why every page keeps its own `.catch()` and its own `<ErrorState>` — these are the floor under those, not a replacement. Reporting is `console.error` with the component stack; there is no error-collection endpoint, and the fallback deliberately imports nothing beyond React so it can't be taken down by whatever broke.

### Stat units

Questlog serves the game's internal numbers, and several stats are fixed-point: `skill_cooldown_modifier: 250` means **2.5%** Cooldown Speed, `hp_regen: 110250` means **110.25** Health Regen, `attack_range_main_hand: 1600` means **16 m**. Printed raw they're wrong by two or three orders of magnitude, and wrong in the direction that makes gear look better than it is.

Display names and divisors both live in [`shared/stats.json`](shared/stats.json), read by [`backend/questlogImport.js`](backend/questlogImport.js) — which bakes them into stored item descriptions — and by [`frontend/src/components/ItemTooltip.jsx`](frontend/src/components/ItemTooltip.jsx), which renders the same stats live. **One table on purpose:** fix a divisor in only one of them and a stored description and a live tooltip will quote two different figures for one stat.

A stat with no `divisor` is flat and prints as-is; Hit Chance, Max Health and the defenses genuinely are the numbers they say. The table is an explicit list of stat ids rather than a "`_modifier` means percent" rule — an unmapped stat printing raw is a visibly odd number someone reports, whereas a pattern that guesses wrong is a plausible-looking number nobody catches. Still unmapped for want of a confirmed divisor: `move_speed_modifier` and `stamina_regen`. (Block chance was one of these until a full census of all 894 Epic+ items turned up `shield_block_chance`, which is now mapped at /100.)

Descriptions are rebuilt from stored data on every sync, so correcting a divisor here and re-syncing fixes every item already in the table without re-fetching anything. It never touches `loot_items` descriptions — those are hand-editable and an officer's wording isn't the sync's to overwrite; re-linking an item to Questlog is the deliberate way to pull a fresh one.

### Weapon legend (optional, improves screenshot accuracy)

Place a reference image at `backend/assets/weapon-legend.png` (or override the path with `WEAPON_LEGEND_PATH`) showing each Throne & Liberty weapon icon next to its name. When present, it's sent to Gemini as the first image on every screenshot parse so the model can compare each scoreboard icon against a labeled reference — the single biggest accuracy win for weapon detection. Without it, screenshot reading still works from the text descriptions in the prompt, just a bit less reliably.

## Deployment

This runs as a single Node process (Render, Railway, Fly, or similar all work with zero code changes) — the root `postinstall` script installs both `backend/` and `frontend/` and builds the frontend; `npm start` runs `backend/server.js`, which serves everything. Make sure `DISCORD_REDIRECT_URI` matches both your deployed URL and the redirect registered in the Discord Developer Portal.
