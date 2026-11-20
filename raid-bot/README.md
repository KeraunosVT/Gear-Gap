# T&L Raid Signups

A Discord bot for *Throne & Liberty* raid signups that **any server can invite**. A lead posts a run, people pick Tank, DPS or Healer on the post, and anyone past a role's cap goes to the bench and moves up automatically when a slot opens.

It's the raid-run feature from Gear Gap's Guild Hall, rebuilt to stand alone. There's no website, no login and no per-server setup required, and one copy of the bot serves every server it's in.

## What it does

**Posting a run.** `/raid post plan:normal 1-3 when:fri 8pm`
- **plan** is modes and gates: `normal 1-3`, `nm 1`, `normal 1-3 + nightmare 1`, `difficult` (all gates). The box suggests plans as you type, and reads yours back so you can see it parsed.
- **when** is read on *your* clock: `fri 8pm`, `tomorrow 20:30`, `nov 21 9pm`, `2026-11-21 20:00`, `in 2h`. The box shows the exact time it understood before you post, and the post itself uses Discord timestamps, so everyone sees it in their own timezone. A bare `8` is refused rather than guessed.
- Optional: `my_role` (sign yourself up), `title`, `notes`, `channel`.

**The post.** One column per role with its empty slots drawn in, the plan, notes and the bench. Buttons:
- **🛡️ Tank / ⚔️ DPS / 💚 Healer:** join in that role. If it's full you're on the bench, in order, and moved up with a DM when a slot opens. Picking a different role moves you, and your old slot goes to the next person waiting.
- **🪑 Bench:** "available if needed". You're never moved up automatically; the lead brings you in.
- **Withdraw:** leave. Your slot goes to the next person waiting.
- **⚙️ Manage:** the lead's private panel.

**Managing a run** (its lead, the server's manager role, or anyone with Manage Server / Manage Events):
- Edit the title, time, plan or notes.
- Close or reopen signups, and ping the roster.
- Move someone between roster and bench, or remove them.
- Add someone who hasn't clicked.
- Repost a post that was deleted or buried.
- Cancel the run, which pings everyone who signed up.

**Automatically:**
- The roster is pinged 15 minutes before the start (configurable). A run posted inside that window isn't pinged, and moving its time re-arms the reminder.
- Signups close when the run starts.
- Runs are deleted 30 days after they start.
- Removing the bot from a server deletes everything it stored for that server.

**Other commands**
- `/raid list`: upcoming runs on this server, with links.
- `/raid timezone`: set your own timezone, which applies on every server.
- `/raid help`
- `/raid-setup show | set | reset`: Manage Server only, unless an admin grants it in *Server Settings → Integrations*. It sets the default channel, who may post runs (default: anyone), a manager role, the server's timezone (used for members who haven't set their own) and the reminder time.

## Running it

You need three things: a Discord application, a Postgres database, and somewhere that keeps a Node process running.

### 1. The Discord application

Create a **new** application for this bot at <https://discord.com/developers/applications>. Don't reuse Gear Gap's: that one belongs to one server.

1. **Bot** tab: *Reset Token* and copy it (that's `DISCORD_TOKEN`). Turn **Public Bot** on, so other servers can invite it. Leave every *Privileged Gateway Intent* off: the bot doesn't need them.
2. **Installation** tab: set *Installation Contexts* to **Guild Install** only. For *Install Link*, choose *Discord Provided Link*. Give *Guild Install* the scopes `applications.commands` and `bot`, with the permissions **View Channels, Send Messages, Send Messages in Threads, Embed Links, Read Message History**.
3. Set the app's name, icon and description. They're what server admins see when they invite it.

The bot also prints a working invite link in its log every time it starts.

### 2. The database

Any Postgres 13+ works. With Supabase, create a project (a separate one from Gear Gap's keeps things tidy; the table names don't collide if you'd rather share). Copy its connection string into `DATABASE_URL`. The bot creates its tables on first start.

### 3. Hosting

Any host that runs `npm start` and keeps it running: Railway, Render (a *Background Worker*, not a web service), Fly.io, or a small VPS. It needs no open port. Set the variables from [`.env.example`](.env.example), with this folder as the app's root:

```bash
cd raid-bot
npm ci
npm start
```

Run **one** instance. Two would both answer every click.

### Testing before going public

Set `DEV_GUILD_ID` to your own server's ID. Commands then register on that server only, and show up instantly. Global commands can take a while to appear the first time. Remove it, restart, and the commands go global.

## Growing

- **No privileged intents** means nothing to apply for as the bot grows.
- **At 75 servers**, Discord invites you to verify the bot. **Past 100**, it can't join more until you do. Verification needs a privacy policy and terms of service URL on the app. This bot stores Discord user and server IDs, display names, signups and settings, deletes runs 30 days after they start, and deletes a server's data when it's removed. A short page saying that is the substance of the privacy policy.
- **Around 2,500 servers** Discord requires sharding. That's a small change in `src/index.js` (discord.js `ShardingManager`), but not needed before then.

## Adding raids

Add an entry to [`raids.json`](raids.json): its modes (easiest first, each with a colour, emoji and any short aliases like `nm`), how many gates it has, and its role caps. `/raid post` offers it in the `raid` option after a restart. Changing a raid's caps never reshuffles a run already posted: each run copies the caps when it's posted.

## Layout

| File | What it is |
|---|---|
| `src/index.js` | Startup: database, migrations, Discord, command registration, sweeper |
| `src/interactions.js` | Every command, button, menu and form |
| `src/store.js` | Every database read and write. Signup moves lock the run's row, so two people can't take one slot |
| `src/render.js` | The post, panels and replies |
| `src/posts.js` | Keeping posts in step with the database; DMs |
| `src/sweeper.js` | Reminders, closing at the start, cleanup |
| `src/time.js` · `src/plan.js` | Reading typed times and plans |
| `migrations/` | The schema, applied in order on start |

## Tests

```bash
npm test                                      # parsing and rendering
TEST_DATABASE_URL=postgres://… npm test       # plus the database and interaction tests
```

The database tests create and drop their own schema, so they won't touch other tables, but point them at a scratch database anyway. CI runs everything against a Postgres service.
