-- 014_guild_config.sql — move guild identity and Discord wiring out of the
-- environment and into a row the app can write.
--
-- Everything here used to be either a `process.env.DISCORD_*` read at module
-- scope or a value in shared/guild.json compiled into the frontend bundle.
-- Both are unreachable from a settings page: an env var needs a redeploy to
-- change, and a bundled JSON file needs a rebuild. A page that saves and then
-- appears to do nothing is worse than no page, so the storage has to move
-- before the page can exist.
--
-- ── WHAT STAYS IN THE ENVIRONMENT ───────────────────────────────────────────
--   DISCORD_BOT_TOKEN   — a secret. Secrets do not belong in a table the app
--                         serves to a browser, however carefully projected.
--   DISCORD_CLIENT_ID   — half of the OAuth identity, paired with the secret.
--   DISCORD_GUILD_ID    — which Discord server this hall *is*. Repointing it is
--                         not a setting, it is a different installation.
-- Everything else — which channels to post in, which roles mean officer, what
-- the house is called — is configuration, and lives below.
--
-- ── ORDER OF OPERATIONS (this matters) ──────────────────────────────────────
-- 1. Run this migration.
-- 2. Run `node backend/scripts/seedConfigFromEnv.js` IN THE DEPLOYMENT'S OWN
--    ENVIRONMENT, so it reads the same DISCORD_* values the server reads.
-- 3. Verify row 1 against the current env, then deploy the code that stops
--    reading env.
-- Doing 3 before 2 leaves the bot with no channels and — because admin_role_ids
-- gates the admin area and allowed_role_ids gates login itself — nobody able to
-- sign in and fix it.

-- One row, forever. The `check (id = 1)` is what makes this a settings record
-- rather than a tenant registry: a second row is a bug, and the constraint says
-- so at the point of insert instead of leaving the code to wonder which row
-- won. Every read is `.eq('id', 1)`.
create table if not exists guild_config (
  id int primary key default 1 check (id = 1),

  -- Identity. `house` is the ceremonial name shown large, `tag` the active
  -- in-game guild tag. Previously shared/guild.json.
  house text not null default 'Gear Gap',
  tag text not null default 'Gear Gap',

  -- Every name this guild has ever played under, including the current tag.
  -- server.js collapses all of them onto `tag` so a rename doesn't split the
  -- war record. Removing an entry that history still uses silently re-reads
  -- those matches as an enemy guild's — guildSettings.js refuses that; see the
  -- alias guard there. In practice this list is append-only.
  aliases text[] not null default '{}',

  -- Lore, shown on the home page and login. Nothing depends on them.
  motto text,
  creed text,

  -- The guild-night model, mirrored in backend/loa.js and frontend/timeUtils.js.
  -- A guild night doesn't end at midnight: the 12:30am field boss is the tail of
  -- the previous evening. `day_start` is where the line falls — it has to sit
  -- after the guild's latest event and before the earliest of the following
  -- evening.
  timezone text not null default 'America/New_York',
  day_start text not null default '01:00'
    check (day_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),

  -- ── ROLES ─────────────────────────────────────────────────────────────────
  -- admin_role_ids  — officer. Grants every capability, present and future.
  -- allowed_role_ids— may sign in at all. EMPTY means "any member of the
  --                   server", which is a real and safe configuration.
  -- member_role_ids — counts as roster. Decides who listMembers() returns, and
  --                   therefore who appears in parties, attendance and reminder
  --                   fan-outs.
  -- Empty admin_role_ids fails closed (nobody is an officer), which is why the
  -- settings save refuses to write it.
  admin_role_ids text[] not null default '{}',
  allowed_role_ids text[] not null default '{}',
  member_role_ids text[] not null default '{}',

  -- ── CHANNELS ──────────────────────────────────────────────────────────────
  -- Text channels the bot POSTS into. Null means "this feature posts nowhere",
  -- which is legal and simply disables the announcement.
  roster_channel_id text,
  loa_channel_id text,
  announce_channel_id text,
  -- Signups fall back to the announce channel when this is null, so the feature
  -- works before anyone configures a second channel. That fallback lives in
  -- discordGateway.js, not here.
  signup_channel_id text,

  -- The one channel the bot READS rather than writes: the voice channel
  -- /attendance snaps a member list out of when nobody names another. Note the
  -- type — a text-channel dropdown cannot offer it, so the settings route feeds
  -- this field from listVoiceChannels() and every other channel field from
  -- listTextChannels(). Null means "ask every time", which is what officers do
  -- today.
  attendance_voice_channel_id text,

  updated_at timestamptz not null default now()
);

-- The singleton. `on conflict do nothing` makes re-running this file a no-op
-- rather than an error, and — more importantly — makes it safe to run after
-- the seed script has already put real values in.
insert into guild_config (id) values (1) on conflict (id) do nothing;

-- Same posture as every other table here: RLS on with no policies, and the
-- service_role key the server uses bypasses it. Nothing but the server ever
-- holds a key that can read this, which matters more than usual — the row
-- carries role and channel ids that the browser is never sent.
alter table guild_config enable row level security;
