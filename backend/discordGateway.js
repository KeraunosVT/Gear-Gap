// backend/discordGateway.js — Lightweight discord.js gateway client.
// Maintains a WebSocket connection so we can read voice-channel state (which the
// REST API does not expose), and handles the guild's slash commands.
const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const createEliteTimers = require('./eliteTimers');
const createLoa = require('./loa');
const createIdentities = require('./identities');
const createAttendance = require('./attendance');
const createEventSignups = require('./eventSignups');
const createLateAttendance = require('./lateAttendance');
const { listMembers } = require('./discord');
const guildConfig = require('./guildConfig');

// Only the three things that are identity or secret still come from the
// environment. Every channel, every role list and the house name are columns on
// guild_config, read through the getters below.
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;

// ── CONFIG GETTERS ──────────────────────────────────────────────────────────
// Every one of these is a function on purpose. The gateway process is long
// lived — it is the same process for weeks — so a value captured in a const
// here would outlive any number of settings saves and there would be no
// symptom beyond posts continuing to arrive in the old channel.
//
// houseName() is branding for embed footers. Not to be confused with GUILD_ID
// above, which is the Discord server's snowflake.
const houseName = () => guildConfig.get().house;
const loaChannelId = () => guildConfig.get().loa_channel_id;
const announceChannelId = () => guildConfig.get().announce_channel_id;
// Signups fall back to the announce channel, so the feature works before anyone
// configures a second one. The fallback lives in guildConfig.signupChannelId().
const signupChannelId = () => guildConfig.signupChannelId();
// The voice channel /attendance snaps when the officer names none and isn't
// sitting in one themselves.
const attendanceVoiceChannelId = () => guildConfig.get().attendance_voice_channel_id;
// Who gets DMed when someone cancels an LOA. Null means nobody, which is what
// this did before migration 018.
const loaNotifyDiscordId = () => guildConfig.get().loa_notify_discord_id;
// Same officer role list auth.js uses to gate the website's admin area, so
// "officer" means the same thing in Discord as it does on the site.
const adminRoleIds = () => guildConfig.get().admin_role_ids;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "21:00" -> "9:00 PM", for echoing a recurring LOA's start time back in chat.
function fmt12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Resolves a freeform time like "9:30pm", "930pm", "2130" or "930et" to the UTC
// instant it occurs today in the guild's timezone, for the /announce command.
// Strips a trailing ET/EST/EDT (redundant — the guild only operates in one zone)
// and expands compact digit shorthand ("930" -> "9:30") before handing off to
// loa.js's am/pm resolution — bare digits with no am/pm are read as 24-hour,
// same convention used everywhere else in this file, so the confirmation
// message always echoes the resolved time back for the officer to sanity-check.
function parseAnnounceTime(input) {
  let s = String(input || '').trim().replace(/\s*(et|est|edt)$/i, '').trim();
  const compact = /^(\d{1,2})(\d{2})\s*([ap]\.?m\.?)?$/i.exec(s);
  if (compact) s = `${compact[1]}:${compact[2]}${compact[3] ? ` ${compact[3]}` : ''}`;

  const hhmm = createLoa.parseTimeOfDay(s);
  if (!hhmm) return null;
  const [hour, minute] = hhmm.split(':').map(Number);
  return createEliteTimers.guildTimeToday(hour, minute);
}

let client = null;
let ready = false;
let eliteTimers = null;
let loa = null;
let identities = null;
let attendance = null;
let signups = null;
let lateAttendance = null;
let sweepTimer = null;

function start(supabase) {
  if (!BOT_TOKEN || !GUILD_ID) {
    console.warn('⚠️  Discord gateway disabled — BOT_TOKEN or GUILD_ID missing.');
    return;
  }

  eliteTimers = supabase ? createEliteTimers(supabase) : null;
  identities = supabase ? createIdentities(supabase) : null;
  loa = supabase ? createLoa(supabase, identities) : null;
  attendance = supabase ? createAttendance(supabase) : null;
  signups = supabase ? createEventSignups(supabase, identities, loa) : null;
  lateAttendance = supabase ? createLateAttendance(supabase, identities) : null;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once('clientReady', async () => {
    ready = true;
    console.log('✅ Discord gateway connected');
    // /announce has no supabase dependency, so commands are always (re)registered
    // once the bot connects, regardless of which optional modules are configured.
    await registerCommands();
    startSignupSweep();
  });

  client.on('interactionCreate', handleInteraction);

  client.on('error', (err) => console.error('Discord gateway error:', err.message));

  client.login(BOT_TOKEN).catch((err) => {
    console.error('❌ Discord gateway login failed:', err.message);
  });
}

function getGuild() {
  if (!ready || !client) return null;
  return client.guilds.cache.get(GUILD_ID) || null;
}

// ── /elitetimer, /elitetimers, /loa ──────────────────────────────────────────
async function registerCommands() {
  if (!CLIENT_ID) {
    console.warn('⚠️  DISCORD_CLIENT_ID missing — commands were not registered.');
    return;
  }
  const commands = [];

  if (eliteTimers) {
    const reportCommand = new SlashCommandBuilder()
      .setName('elitetimer')
      .setDescription('Report an elite boss kill and start its respawn timer.')
      .addStringOption((opt) =>
        opt.setName('location').setDescription('Where it was killed').setRequired(true)
          .addChoices(...eliteTimers.locations.map((name) => ({ name, value: name })))
      )
      .addStringOption((opt) =>
        opt.setName('time').setDescription('Kill time, e.g. 6:40pm').setRequired(true)
      );

    const listCommand = new SlashCommandBuilder()
      .setName('elitetimers')
      .setDescription('Show the current respawn status of all elite bosses.');

    commands.push(reportCommand.toJSON(), listCommand.toJSON());
  }

  if (loa) {
    const loaCommand = new SlashCommandBuilder()
      .setName('loa')
      .setDescription('Manage your leave of absence.')
      .addSubcommand((sub) =>
        sub.setName('event')
          .setDescription('Request LOA for a single date — one event, or everything from a time onward.')
          .addStringOption((opt) => opt.setName('date').setDescription('Event date, YYYY-MM-DD').setRequired(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Visible to officers only').setRequired(true))
          .addStringOption((opt) => opt.setName('event').setDescription('Which event (leave blank + set a start time for "everything after X")').setRequired(false).setAutocomplete(true))
          .addStringOption((opt) => opt.setName('start_time').setDescription('Absent from this time onward, e.g. 9:00 PM (blank = just the picked event)').setRequired(false))
          .addStringOption((opt) => opt.setName('end_time').setDescription('Back after this time, e.g. 10:00 PM (blank = out for the rest of the day)').setRequired(false))
          .addUserOption((opt) => opt.setName('member').setDescription('Officers only: submit on behalf of this member').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub.setName('range')
          .setDescription('Request LOA for a date range.')
          .addStringOption((opt) => opt.setName('start_date').setDescription('Start date, YYYY-MM-DD').setRequired(true))
          .addStringOption((opt) => opt.setName('end_date').setDescription('End date, YYYY-MM-DD').setRequired(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Visible to officers only').setRequired(true))
          .addUserOption((opt) => opt.setName('member').setDescription('Officers only: submit on behalf of this member').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub.setName('recurring')
          .setDescription('Always out on the same day every week, until cancelled.')
          .addStringOption((opt) => opt.setName('day').setDescription('Day of the week').setRequired(true)
            .addChoices(...DAY_NAMES.map((name, value) => ({ name, value: String(value) }))))
          .addStringOption((opt) => opt.setName('reason').setDescription('Visible to officers only').setRequired(true))
          .addStringOption((opt) => opt.setName('event').setDescription('Leave blank for the whole day').setRequired(false).setAutocomplete(true))
          .addStringOption((opt) => opt.setName('start_time').setDescription('Absent from this time onward, e.g. 9:00 PM (blank = all day)').setRequired(false))
          .addStringOption((opt) => opt.setName('end_time').setDescription('Back after this time, e.g. 10:00 PM (blank = out for the rest of the day)').setRequired(false))
          .addUserOption((opt) => opt.setName('member').setDescription('Officers only: submit on behalf of this member').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub.setName('cancel')
          .setDescription('Cancel one of your upcoming LOAs (officers: anyone’s).')
          .addStringOption((opt) => opt.setName('entry').setDescription('Which LOA to cancel').setRequired(true).setAutocomplete(true))
      );

    commands.push(loaCommand.toJSON());
  }

  if (attendance) {
    const attendanceCommand = new SlashCommandBuilder()
      .setName('attendance')
      .setDescription('Officers: snap a voice channel and log attendance for a scheduled event.')
      .addStringOption((opt) =>
        opt.setName('event').setDescription('Which scheduled event').setRequired(true).setAutocomplete(true)
      )
      .addChannelOption((opt) =>
        opt.setName('channel').setDescription('Voice channel to snap (defaults to your current voice channel)')
          .addChannelTypes(ChannelType.GuildVoice).setRequired(false)
      )
      .addStringOption((opt) =>
        opt.setName('date').setDescription('Event date, YYYY-MM-DD (defaults to today)').setRequired(false)
      );

    commands.push(attendanceCommand.toJSON());

    // The one attendance command that is NOT officer-gated: a member asking to
    // be added to a night the snapshot missed. It writes a request, never an
    // attendance row.
    //
    // The event option is autocompleted, and the autocomplete IS the 24-hour
    // window: a member with nothing eligible sees an empty list, which reads as
    // "nothing to do here" rather than as being told no. The window is
    // re-checked server-side on submit regardless — a list being short is not a
    // permission check.
    const lateCommand = new SlashCommandBuilder()
      .setName('attendance-late')
      .setDescription("Ask an officer to add you to a night you attended but the snapshot missed.")
      .addStringOption((opt) =>
        opt.setName('event').setDescription('Which night').setRequired(true).setAutocomplete(true)
      )
      .addStringOption((opt) =>
        opt.setName('reason').setDescription('Anything that helps the officer decide').setRequired(false)
      );
    commands.push(lateCommand.toJSON());
  }

  // No supabase dependency — this just posts a message, so it's always available
  // once the bot itself is running (missing channel/role config is reported at
  // run time instead of skipping registration).
  const announceCommand = new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Officers: post a timed announcement (e.g. "get into CTA Comms") with a dynamic timestamp.')
    .addStringOption((opt) =>
      opt.setName('time').setDescription('e.g. 9:30pm, 930pm, 2130').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName('message').setDescription('Use {time} to place the time inline, e.g. "roll call {time} in CTA comms"').setRequired(false)
    )
    .addRoleOption((opt) =>
      opt.setName('role').setDescription('Role to ping (optional)').setRequired(false)
    );
  commands.push(announceCommand.toJSON());

  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    console.log(`✅ Registered ${commands.length} slash command(s)`);
  } catch (err) {
    console.error('❌ Failed to register commands:', err.message);
  }
}

async function handleInteraction(interaction) {
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
  // Buttons are namespaced by customId prefix so each family owns its own
  // handler: 'sg:' signups, 'et:' elite timers. Anything else falls through
  // rather than being handed to whichever handler happens to be first.
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('et:')) return handleEliteButton(interaction);
    return handleSignupButton(interaction);
  }
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'elitetimer') return handleReport(interaction);
  if (interaction.commandName === 'elitetimers') return handleList(interaction);
  if (interaction.commandName === 'loa') return handleLoa(interaction);
  if (interaction.commandName === 'attendance') return handleAttendance(interaction);
  if (interaction.commandName === 'attendance-late') return handleAttendanceLate(interaction);
  if (interaction.commandName === 'announce') return handleAnnounce(interaction);
}

async function handleReport(interaction) {
  // Ack immediately — Discord requires a response within 3s, and the Supabase
  // round-trip below can occasionally be slower than that. Deferring buys 15 minutes.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!eliteTimers) {
    return interaction.editReply('Elite timers are not configured right now.');
  }

  const location = interaction.options.getString('location');
  const timeInput = interaction.options.getString('time');
  const killedAt = eliteTimers.parseGuildTimeToday(timeInput);
  if (!killedAt) {
    return interaction.editReply(`Couldn't understand "${timeInput}" as a time. Try something like \`6:40pm\`.`);
  }

  try {
    const row = await eliteTimers.report(location, killedAt, interaction.user.username);
    const killedUnix = Math.floor(new Date(row.killed_at).getTime() / 1000);
    const spawnUnix = Math.floor(new Date(row.next_spawn_at).getTime() / 1000);
    // Edit the ephemeral placeholder to a quiet confirmation, then post the actual
    // timer info as a normal public follow-up — deleting the placeholder first caused
    // a "message could not be loaded" flash in Discord's client.
    await interaction.editReply('Recorded ✅');
    await interaction.followUp(
      `**${location}** killed at <t:${killedUnix}:t> — next spawn <t:${spawnUnix}:F> (<t:${spawnUnix}:R>).`
    );
  } catch (err) {
    console.error('elitetimer command error:', err.message);
    await interaction.editReply('Something went wrong saving that timer.');
  }
}

// ── THE TIMER BOARD ─────────────────────────────────────────────────────────
// One renderer shared by /elitetimers and every button that changes something,
// so the board can never disagree with itself depending on how it was drawn.
//
// Relative timestamps (<t:…:R>) are rendered live by Discord, so a board left
// in a channel keeps counting down on its own — the Refresh button is only for
// the parts that are text ("spawn window open" vs "spawns in"), and for picking
// up a report someone made with the command instead of a button.
async function eliteBoard() {
  const rows = await eliteTimers.all();
  const byLocation = Object.fromEntries(rows.map((r) => [r.location, r]));
  const now = Date.now();

  const lines = eliteTimers.locations.map((loc) => {
    const row = byLocation[loc];
    if (!row) return `**${loc}** — no report yet`;
    const spawnUnix = Math.floor(new Date(row.next_spawn_at).getTime() / 1000);
    if (new Date(row.next_spawn_at).getTime() > now) {
      return `**${loc}** — spawns <t:${spawnUnix}:R> (<t:${spawnUnix}:t>)`;
    }
    return `**${loc}** — spawn window open (last reported <t:${spawnUnix}:R>)`;
  });

  return {
    content: `${lines.join('\n')}\n\n-# Tap a boss to report it killed **just now**. Use \`/elitetimer\` for a kill that happened earlier.`,
    components: eliteButtons(byLocation, now),
  };
}

// A button per location, five to a row (Discord's limit), plus Refresh.
//
// Success styling for a boss whose window is open — the one you are most
// likely to be reporting — and Secondary for one still on cooldown, so a
// mistaken tap is visually distinct before you make it rather than after.
function eliteButtons(byLocation, now) {
  const buttons = eliteTimers.locations.map((loc) => {
    const row = byLocation[loc];
    const due = !row || new Date(row.next_spawn_at).getTime() <= now;
    return new ButtonBuilder()
      .setCustomId(`et:kill:${loc}`)
      .setLabel(loc)
      .setStyle(due ? ButtonStyle.Success : ButtonStyle.Secondary);
  });
  buttons.push(new ButtonBuilder().setCustomId('et:refresh').setLabel('↻').setStyle(ButtonStyle.Secondary));

  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
}

async function handleList(interaction) {
  await interaction.deferReply();

  if (!eliteTimers) {
    return interaction.editReply('Elite timers are not configured right now.');
  }

  try {
    await interaction.editReply(await eliteBoard());
  } catch (err) {
    console.error('elitetimers command error:', err.message);
    await interaction.editReply('Something went wrong reading the timers.');
  }
}

// ── ELITE TIMER BUTTONS ─────────────────────────────────────────────────────
// customId carries everything needed to act, so a board posted last week still
// works after a redeploy. No collector, for the same reason the signup buttons
// don't use one: collectors live in memory and die with the process, which
// would silently kill every board already in the channel.
//
//   et:kill:<location>              tap a boss on the board
//   et:refresh                      redraw the board
//   et:force:<messageId>:<location> confirm an overwrite (see below)
//
// The confirm step exists because reporting is destructive and a button is much
// easier to misclick than a typed command: it overwrites the stored timer and
// the previous kill time is gone. Tapping a boss that is ALREADY due needs no
// confirmation — there is nothing useful to lose. Tapping one still on cooldown
// asks first, because that is either a genuine early kill or a fat finger, and
// only the person tapping knows which.
async function handleEliteButton(interaction) {
  if (!eliteTimers) {
    return interaction.reply({ content: 'Elite timers are not configured right now.', flags: MessageFlags.Ephemeral });
  }

  const [, action, ...rest] = interaction.customId.split(':');

  try {
    if (action === 'refresh') {
      return await interaction.update(await eliteBoard());
    }

    if (action === 'kill') {
      // Location names may contain anything but were split on ':', so rejoin.
      const location = rest.join(':');
      if (!eliteTimers.locations.includes(location)) {
        return await interaction.reply({ content: `"${location}" isn't a tracked location any more.`, flags: MessageFlags.Ephemeral });
      }

      const existing = (await eliteTimers.all()).find((r) => r.location === location);
      const nextSpawn = existing ? new Date(existing.next_spawn_at).getTime() : 0;
      if (nextSpawn > Date.now()) {
        const spawnUnix = Math.floor(nextSpawn / 1000);
        return await interaction.reply({
          content: `**${location}** isn't due until <t:${spawnUnix}:t> (<t:${spawnUnix}:R>). Report it killed just now anyway?`,
          flags: MessageFlags.Ephemeral,
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`et:force:${interaction.message.id}:${location}`)
              .setLabel('Yes, killed just now').setStyle(ButtonStyle.Danger),
          )],
        });
      }

      // The button is ON the board, so updating this interaction redraws it —
      // one atomic edit, no message id needed.
      const confirmation = await reportElite(interaction, location);
      await interaction.update(await eliteBoard());
      await interaction.followUp({ content: confirmation, flags: MessageFlags.Ephemeral });
      return undefined;
    }

    if (action === 'force') {
      const [messageId, ...locParts] = rest;
      const location = locParts.join(':');
      if (!eliteTimers.locations.includes(location)) {
        return await interaction.update({ content: `"${location}" isn't a tracked location any more.`, components: [] });
      }
      const confirmation = await reportElite(interaction, location);
      // Here the interaction's message is the ephemeral prompt, not the board.
      // Replacing it removes the confirm button so it can't be pressed twice.
      await interaction.update({ content: confirmation, components: [] });
      // The board is a different message, reached by the id the customId
      // carried. Best-effort: the timer is already saved, and a board that
      // failed to redraw must not read as a report that failed.
      const board = await interaction.channel?.messages.fetch(messageId).catch(() => null);
      if (board) await board.edit(await eliteBoard()).catch((err) => console.error('elite board redraw failed:', err.message));
      return undefined;
    }
  } catch (err) {
    console.error('elite timer button error:', err.message);
    const msg = { content: 'Something went wrong saving that timer.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
  return undefined;
}

// Records the kill at NOW and returns the line telling the tapper what it did.
// Attribution matches the slash command's, so a board report and a typed one
// are indistinguishable in the record.
async function reportElite(interaction, location) {
  const row = await eliteTimers.report(location, new Date(), displayNameFor(interaction.user));
  const spawnUnix = Math.floor(new Date(row.next_spawn_at).getTime() / 1000);
  return `**${location}** killed — next spawn <t:${spawnUnix}:t> (<t:${spawnUnix}:R>).`;
}

// ── /loa ──────────────────────────────────────────────────────────────────
// Matches the display name website logins use (see auth.js) rather than the
// guild nickname, so the same member shows up the same way in both places.
function displayNameFor(user) {
  return user.globalName || user.username || 'Member';
}

function isAdminMember(interaction) {
  const officerRoles = adminRoleIds();
  if (!officerRoles.length) return false;
  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;
  return officerRoles.some((r) => roles.has(r));
}

// Who an LOA submission is for. Defaults to the invoker; if they passed the
// `member` option, this submits on that member's behalf instead — but only
// if the invoker actually holds an admin role, checked here rather than
// trusted from the option existing.
function resolveTarget(interaction) {
  const targetUser = interaction.options.getUser('member');
  if (!targetUser) {
    return { discordId: interaction.user.id, displayName: displayNameFor(interaction.user), onBehalf: false };
  }
  if (!isAdminMember(interaction)) {
    return { error: "Only officers can submit an LOA on someone else's behalf." };
  }
  return { discordId: targetUser.id, displayName: displayNameFor(targetUser), onBehalf: true };
}

// Renders a YYYY-MM-DD calendar date as a Discord timestamp tag (noon UTC —
// these are date-only values, so the exact hour doesn't matter, just the day).
function discordDate(dateStr) {
  const unix = Math.floor(new Date(`${dateStr}T12:00:00Z`).getTime() / 1000);
  return `<t:${unix}:D>`;
}

// Posts an LOA submission to the configured channel. Best-effort — a failure
// here (missing channel, missing permissions) shouldn't undo the LOA itself,
// which is already recorded by the time this runs. Returns the sent message's
// id (so the caller can remember it for later cleanup) or null if nothing sent.
async function announceLoa(text) {
  const loaChannel = loaChannelId();
  if (!loaChannel) return null;
  const guild = getGuild();
  const channel = guild?.channels.cache.get(loaChannel);
  if (!channel?.isTextBased()) {
    console.error(`LOA announce error: channel ${loaChannel} not found or not text-based (check the LOA channel in Guild Settings and the bot's permissions).`);
    return null;
  }
  try {
    const message = await channel.send(text);
    return message.id;
  } catch (err) {
    console.error('LOA announce error:', err.message);
    return null;
  }
}

// Renders the announcement line for an LOA entry. Kept in one place so an LOA
// filed on the website reads exactly like one filed with /loa — the two paths
// used to build this text separately, which is how they drift apart.
function loaAnnouncement({ type, displayName, eventName, eventDate, startDate, endDate, dayOfWeek, startTime, endTime }) {
  const scope = eventName ? ` for **${eventName}**` : '';
  const timeRange = startTime
    ? (endTime ? ` from **${fmt12h(startTime)}** to **${fmt12h(endTime)}**` : ` from **${fmt12h(startTime)}**`)
    : '';
  if (type === 'range') {
    return `📋 **${displayName}** is on LOA — ${discordDate(startDate)} to ${discordDate(endDate)}`;
  }
  if (type === 'recurring') {
    return `📋 **${displayName}** is always on LOA every **${DAY_NAMES[dayOfWeek]}**${timeRange}${scope}`;
  }
  return `📋 **${displayName}** is on LOA${scope} — ${discordDate(eventDate)}${timeRange}`;
}

// Announces an LOA entry. Returns the message id so the caller can record it on
// the row — recording is left to the caller because each one holds its own loa
// instance (the gateway's is null until start() runs).
async function announceLoaEntry(entry) {
  return announceLoa(loaAnnouncement(entry));
}

// Deletes a previously-announced LOA message when its entry is cancelled.
// Best-effort: an already-deleted message (e.g. an officer removed it by hand)
// or a missing channel/permission just gets logged, not surfaced to the caller
// — the LOA record is already gone by the time this runs either way.
async function deleteLoaMessage(messageId) {
  const loaChannel = loaChannelId();
  if (!messageId || !loaChannel) return;
  const guild = getGuild();
  const channel = guild?.channels.cache.get(loaChannel);
  if (!channel?.isTextBased()) return;
  try {
    await channel.messages.delete(messageId);
  } catch (err) {
    console.error('LOA message delete error:', err.message);
  }
}

// DMs one person when an LOA is cancelled.
//
// This exists because cancelling is the only LOA event that leaves no trace.
// Filing one posts to the LOA channel; cancelling *deletes* that post — the
// evidence is removed rather than added to — so anyone planning a night around
// who's out has no way to notice that someone came back. A DM is the point: it
// lands with the one person keeping track, which a channel post doesn't.
//
// Best-effort throughout, and never awaited by its callers. The LOA is already
// gone by the time this runs; a closed DM or an offline bot must not turn a
// successful cancellation into an error the member sees.
async function notifyLoaCancelled(entry, actor) {
  const target = loaNotifyDiscordId();
  if (!ready || !client || !target || !entry) return;

  // No point telling someone what they just did themselves.
  if (actor?.id && String(actor.id) === String(target)) return;

  // Same wording as the original announcement, so the notice reads as the
  // undoing of a specific post rather than as a separate kind of event.
  const summary = loaAnnouncement({
    type: entry.type,
    displayName: entry.display_name || 'Someone',
    eventName: entry.event_name,
    eventDate: entry.event_date,
    startDate: entry.start_date,
    endDate: entry.end_date,
    dayOfWeek: entry.day_of_week,
    startTime: entry.start_time,
    endTime: entry.end_time,
  }).replace(/^📋 /, '');

  // Who cancelled it, but only when that isn't the member themselves —
  // "cancelled by an officer" is the part worth knowing, and saying "cancelled
  // by Sam" under Sam's own LOA is noise.
  const byOther = actor?.id && String(actor.id) !== String(entry.discord_id);
  const lines = [
    `🚫 **LOA cancelled** — was: ${summary}`,
    byOther ? `Cancelled by **${actor.name || actor.id}**.` : null,
    entry.reason ? `Original reason: ${String(entry.reason).slice(0, 300)}` : null,
  ].filter(Boolean);

  try {
    const user = await client.users.fetch(String(target));
    await user.send(lines.join('\n'));
  } catch (err) {
    console.warn(`LOA cancellation DM to ${target} failed:`, err.message);
  }
}

async function handleLoa(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'event') return handleLoaEvent(interaction);
  if (sub === 'range') return handleLoaRange(interaction);
  if (sub === 'recurring') return handleLoaRecurring(interaction);
  if (sub === 'cancel') return handleLoaCancel(interaction);
}

async function handleLoaEvent(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!loa) return interaction.editReply('LOA tracking is not configured right now.');

  const target = resolveTarget(interaction);
  if (target.error) return interaction.editReply(target.error);

  const date = interaction.options.getString('date');
  const eventScheduleId = interaction.options.getString('event');
  const startTimeRaw = interaction.options.getString('start_time');
  const endTimeRaw = interaction.options.getString('end_time');
  const reason = interaction.options.getString('reason') || '';
  if (!eventScheduleId && !startTimeRaw) return interaction.editReply('Pick an event, a start time, or both.');

  const startTime = startTimeRaw ? loa.parseTimeOfDay(startTimeRaw) : null;
  if (startTimeRaw && !startTime) {
    return interaction.editReply(`Couldn't read "${startTimeRaw}" as a time — try something like 9:00 PM or 21:00.`);
  }
  const endTime = endTimeRaw ? loa.parseTimeOfDay(endTimeRaw) : null;
  if (endTimeRaw && !endTime) {
    return interaction.editReply(`Couldn't read "${endTimeRaw}" as a time — try something like 9:00 PM or 21:00.`);
  }

  try {
    // displayName comes back resolved to the member's site alias — target's is
    // only the Discord-side fallback for someone with no identity row.
    const { id, displayName, eventName } = await loa.submitEvent({
      discordId: target.discordId,
      displayName: target.displayName,
      eventDate: date,
      eventScheduleId,
      startTime,
      endTime,
      reason,
    });
    const scope = eventName ? ` for **${eventName}**` : '';
    const timeRange = startTime ? (endTime ? ` from **${fmt12h(startTime)}** to **${fmt12h(endTime)}**` : ` from **${fmt12h(startTime)}**`) : '';
    await interaction.editReply(target.onBehalf
      ? `Recorded ✅ — LOA submitted for **${displayName}** on ${date}${timeRange}${scope}.`
      : `Recorded ✅ — LOA submitted for ${date}${timeRange}${scope}.`);
    const messageId = await announceLoaEntry({
      type: 'event', displayName, eventName, eventDate: date, startTime, endTime,
    });
    if (messageId) await loa.setMessageId(id, messageId);
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong submitting that LOA.');
  }
}

async function handleLoaRange(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!loa) return interaction.editReply('LOA tracking is not configured right now.');

  const target = resolveTarget(interaction);
  if (target.error) return interaction.editReply(target.error);

  const startDate = interaction.options.getString('start_date');
  const endDate = interaction.options.getString('end_date');
  const reason = interaction.options.getString('reason') || '';

  try {
    const { id, displayName } = await loa.submitRange({
      discordId: target.discordId,
      displayName: target.displayName,
      startDate, endDate, reason,
    });
    await interaction.editReply(target.onBehalf
      ? `Recorded ✅ — LOA submitted for **${displayName}**, ${startDate} to ${endDate}.`
      : `Recorded ✅ — LOA submitted for ${startDate} to ${endDate}.`);
    const messageId = await announceLoaEntry({
      type: 'range', displayName, startDate, endDate,
    });
    if (messageId) await loa.setMessageId(id, messageId);
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong submitting that LOA.');
  }
}

async function handleLoaRecurring(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!loa) return interaction.editReply('LOA tracking is not configured right now.');

  const target = resolveTarget(interaction);
  if (target.error) return interaction.editReply(target.error);

  const dow = parseInt(interaction.options.getString('day'), 10);
  const eventScheduleId = interaction.options.getString('event') || null;
  const startTimeRaw = interaction.options.getString('start_time') || null;
  const endTimeRaw = interaction.options.getString('end_time') || null;
  const reason = interaction.options.getString('reason') || '';

  const startTime = startTimeRaw ? loa.parseTimeOfDay(startTimeRaw) : null;
  if (startTimeRaw && !startTime) {
    return interaction.editReply(`Couldn't read "${startTimeRaw}" as a time — try something like 9:00 PM or 21:00.`);
  }
  const endTime = endTimeRaw ? loa.parseTimeOfDay(endTimeRaw) : null;
  if (endTimeRaw && !endTime) {
    return interaction.editReply(`Couldn't read "${endTimeRaw}" as a time — try something like 9:00 PM or 21:00.`);
  }

  try {
    const { id, displayName, eventName } = await loa.submitRecurring({
      discordId: target.discordId,
      displayName: target.displayName,
      dayOfWeek: dow,
      eventScheduleId,
      startTime,
      endTime,
      reason,
    });
    const scope = eventName ? ` for **${eventName}**` : '';
    const timeRange = startTime ? (endTime ? ` from **${fmt12h(startTime)}** to **${fmt12h(endTime)}**` : ` from **${fmt12h(startTime)}**`) : '';
    await interaction.editReply(target.onBehalf
      ? `Recorded ✅ — **${displayName}** is now always out on **${DAY_NAMES[dow]}**${timeRange}${scope}.`
      : `Recorded ✅ — you're now always out on **${DAY_NAMES[dow]}**${timeRange}${scope}.`);
    const messageId = await announceLoaEntry({
      type: 'recurring', displayName, eventName, dayOfWeek: dow, startTime, endTime,
    });
    if (messageId) await loa.setMessageId(id, messageId);
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong submitting that LOA.');
  }
}

async function handleLoaCancel(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!loa) return interaction.editReply('LOA tracking is not configured right now.');

  const id = interaction.options.getString('entry');
  if (!id) return interaction.editReply('No LOA selected — pick one from the list.');

  try {
    // Officers can cancel anyone's LOA from Discord (matches the website,
    // where the LOA Board's cancel button shows for admins on any entry);
    // everyone else can only cancel their own, enforced in loa.cancel().
    const { messageId, entry } = await loa.cancel(id, interaction.user.id, isAdminMember(interaction));
    await interaction.editReply('Cancelled ✅');
    await deleteLoaMessage(messageId);
    // Not awaited: the cancellation is done and the member has been told, so a
    // slow or closed DM shouldn't sit in front of either.
    notifyLoaCancelled(entry, {
      id: interaction.user.id,
      name: interaction.member?.displayName || interaction.user.username,
    }).catch(() => {});
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong cancelling that LOA.');
  }
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName === 'attendance') return autocompleteAttendanceEvent(interaction);
  if (interaction.commandName === 'attendance-late') return autocompleteLateEvent(interaction);
  if (interaction.commandName !== 'loa') return interaction.respond([]).catch(() => {});
  const sub = interaction.options.getSubcommand();
  if (sub === 'event') return autocompleteLoaEvent(interaction);
  if (sub === 'recurring') return autocompleteLoaRecurring(interaction);
  if (sub === 'cancel') return autocompleteLoaCancel(interaction);
  return interaction.respond([]).catch(() => {});
}

async function autocompleteAttendanceEvent(interaction) {
  if (!attendance) return interaction.respond([]).catch(() => {});
  const focused = interaction.options.getFocused().toLowerCase();
  const events = await attendance.listSchedule();
  const choices = events
    .filter((e) => e.name.toLowerCase().includes(focused))
    .slice(0, 25)
    // Labelled by the night it belongs to, matching how the guild talks about
    // it — an after-midnight event is stored on the next calendar day, so
    // DAY_NAMES[e.day_of_week] alone would name the wrong night.
    .map((e) => {
      const night = DAY_NAMES[createLoa.guildDayOfWeek(e.day_of_week, e.event_time)];
      const late = createLoa.isAfterMidnight(e.event_time) ? ' night' : '';
      return {
        name: e.event_time ? `${e.name} (${night}${late}, ${fmt12h(e.event_time)})` : `${e.name} (${night})`,
        value: e.id,
      };
    });
  await interaction.respond(choices).catch(() => {});
}

async function autocompleteLoaEvent(interaction) {
  if (!loa) return interaction.respond([]).catch(() => {});
  const date = interaction.options.getString('date');
  if (!loa.isValidDate(date)) return interaction.respond([]).catch(() => {});

  const focused = interaction.options.getFocused().toLowerCase();
  const events = await loa.eventsForDate(date);
  if (events.length === 0) {
    return interaction.respond([{ name: '— no events scheduled that day —', value: '' }]).catch(() => {});
  }
  const choices = events
    .filter((e) => e.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((e) => ({ name: e.event_time ? `${e.name} (${e.event_time})` : e.name, value: e.id }));
  await interaction.respond(choices).catch(() => {});
}

// `event` is optional here (blank = whole day), so unlike autocompleteLoaEvent
// there's no placeholder needed for the zero-results case — the field just
// shows no suggestions and the member leaves it blank.
async function autocompleteLoaRecurring(interaction) {
  if (!loa) return interaction.respond([]).catch(() => {});
  const day = interaction.options.getString('day');
  const dow = day === null ? NaN : parseInt(day, 10);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return interaction.respond([]).catch(() => {});

  const focused = interaction.options.getFocused().toLowerCase();
  const events = await loa.eventsForDay(dow);
  const choices = events
    .filter((e) => e.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((e) => ({ name: e.event_time ? `${e.name} (${e.event_time})` : e.name, value: e.id }));
  await interaction.respond(choices).catch(() => {});
}

async function autocompleteLoaCancel(interaction) {
  if (!loa) return interaction.respond([]).catch(() => {});
  const admin = isAdminMember(interaction);
  const entries = admin ? await loa.all(true) : await loa.mine(interaction.user.id);
  const today = createLoa.todayInGuildTz();
  const upcoming = entries.filter((e) => {
    if (e.type === 'event') return e.event_date >= today;
    if (e.type === 'range') return e.end_date >= today;
    return true; // recurring — always current until explicitly cancelled
  });
  if (upcoming.length === 0) {
    return interaction.respond([{ name: '— no upcoming LOAs —', value: '' }]).catch(() => {});
  }
  const label = (e) => {
    const who = admin ? `${e.display_name} — ` : '';
    if (e.type === 'event') return `${who}Event — ${e.event_date}`;
    if (e.type === 'range') return `${who}Range — ${e.start_date} to ${e.end_date}`;
    return `${who}Recurring — ${DAY_NAMES[e.day_of_week]}`;
  };
  const focused = interaction.options.getFocused().toLowerCase();
  const choices = upcoming
    .map((e) => ({ name: label(e), value: e.id }))
    .filter((c) => c.name.toLowerCase().includes(focused))
    .slice(0, 25);
  await interaction.respond(choices).catch(() => {});
}

// ── /attendance ───────────────────────────────────────────────────────────
async function handleAttendance(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!attendance) return interaction.editReply('Attendance tracking is not configured right now.');
  if (!isAdminMember(interaction)) return interaction.editReply('Officers only.');

  const eventScheduleId = interaction.options.getString('event');
  const ev = await attendance.getScheduleEvent(eventScheduleId);
  if (!ev) return interaction.editReply('Unknown event — pick one from the list.');

  // Three ways to find the channel, in order of how specific the intent is:
  // what the officer named on the command, where they are sitting, and the
  // guild's configured default. The default is last so it can never override
  // someone who said what they meant — but it is there so /attendance works
  // from a text channel, which is where officers usually run it.
  const channelOpt = interaction.options.getChannel('channel');
  const configuredVoice = attendanceVoiceChannelId();
  const channel = channelOpt
    || interaction.member?.voice?.channel
    || (configuredVoice ? getGuild()?.channels.cache.get(configuredVoice) : null);
  if (!channel) {
    return interaction.editReply(
      "You're not in a voice channel, and no default is set. Name one with the `channel` option, "
      + 'or pick an attendance voice channel in Guild Settings.'
    );
  }

  const dateInput = interaction.options.getString('date');
  const eventDate = dateInput || createLoa.todayInGuildTz();
  if (!loa.isValidDate(eventDate)) return interaction.editReply('Date must be in YYYY-MM-DD format.');

  const members = getVoiceMembers(channel.id);
  if (members.length === 0) return interaction.editReply('No one is in that voice channel right now.');

  const ids = await identities.load();
  members.forEach((m) => { m.name = ids.displayNameFor(m.id, m.name); });

  try {
    await attendance.createEvent({ title: ev.name, eventDate, eventScheduleId, attendees: members });
  } catch (err) {
    return interaction.editReply(err.message || 'Something went wrong saving that attendance.');
  }

  let names = members.map((m) => m.name).join(', ');
  const header = `✅ Logged attendance for **${ev.name}** — ${eventDate} — ${members.length} member(s): `;
  if (header.length + names.length > 1900) {
    names = `${names.slice(0, 1900 - header.length)}…`;
  }
  await interaction.editReply(`${header}${names}`);

  notifyAttendance(members, ev.name, eventDate).catch(() => {});
}

// ── /attendance-late ──────────────────────────────────────────────────────
// The list a member could actually file against: recent nights they weren't
// snapped for, inside the 24-hour window, with no pending ask already. All of
// that is decided by lateAttendance.eligibleEvents, so this and the website
// can't drift apart about who may ask for what.
async function autocompleteLateEvent(interaction) {
  if (!lateAttendance) return interaction.respond([]).catch(() => {});
  try {
    const focused = interaction.options.getFocused().toLowerCase();
    const events = await lateAttendance.eligibleEvents(interaction.user.id);
    const choices = events
      .filter((e) => String(e.title || '').toLowerCase().includes(focused))
      .slice(0, 25)
      .map((e) => ({
        name: `${e.title}${e.event_date ? ` — ${e.event_date}` : ''}`.slice(0, 100),
        value: e.id,
      }));
    await interaction.respond(choices).catch(() => {});
  } catch (err) {
    console.error('attendance-late autocomplete error:', err.message);
    await interaction.respond([]).catch(() => {});
  }
}

async function handleAttendanceLate(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!lateAttendance) return interaction.editReply('Attendance tracking is not configured right now.');

  try {
    const out = await lateAttendance.request({
      eventId: interaction.options.getString('event'),
      // The invoker, always. There is no member option on this command and
      // there should not be one — adding someone else is an officer action,
      // and it lives on the website where it is audited.
      discordId: interaction.user.id,
      displayName: displayNameFor(interaction.user),
      reason: interaction.options.getString('reason'),
    });
    await interaction.editReply(
      `Asked an officer to add you to **${out.event_title}**. You'll get a DM either way.`
    );
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong filing that request.');
  }
}

// A DM, not a channel post. Being turned down is between the member and the
// officers — announcing it to the guild would make asking cost something, and
// the whole point is that correcting a missed snapshot should be cheap.
async function notifyLateAttendance(request) {
  if (!ready || !client || !request?.discord_id) return;
  const title = request.event?.title || 'that night';
  const text = request.status === 'approved'
    ? `✅ You've been added to attendance for **${title}**.`
    : `❌ Your late attendance request for **${title}** wasn't approved. Talk to an officer if you think that's wrong.`;
  try {
    const user = await client.users.fetch(String(request.discord_id));
    await user.send(text);
  } catch (err) {
    // Closed DMs are the common case and are not an error worth surfacing —
    // the decision is recorded either way, and the member sees it on the site.
    console.warn(`Late attendance DM to ${request.discord_id} failed:`, err.message);
  }
}

// ── /announce ─────────────────────────────────────────────────────────────
async function handleAnnounce(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!isAdminMember(interaction)) return interaction.editReply('Officers only.');
  const announceChannel = announceChannelId();
  if (!announceChannel) return interaction.editReply('Announcements are not configured — pick an announce channel in Guild Settings.');

  const timeInput = interaction.options.getString('time');
  const message = interaction.options.getString('message') || 'Get into CTA Comms — {time}';

  const when = parseAnnounceTime(timeInput);
  if (!when) return interaction.editReply(`Couldn't understand "${timeInput}" as a time. Try something like \`9:30pm\` or \`2130\`.`);

  const guild = getGuild();
  const channel = guild?.channels.cache.get(announceChannel);
  if (!channel?.isTextBased()) {
    return interaction.editReply("Announcement channel not found — check the announce channel in Guild Settings and the bot's permissions.");
  }

  const unix = Math.floor(when.getTime() / 1000);
  const timeTag = `<t:${unix}:t>`;
  // {time} lets the officer place the timestamp anywhere in the sentence
  // ("roll call {time} in CTA comms"); with no placeholder it's appended at the end.
  const body = /\{time\}/i.test(message) ? message.replace(/\{time\}/i, timeTag) : `${message} — ${timeTag}`;
  const role = interaction.options.getRole('role');
  const ping = role ? `${role.toString()} ` : '';
  try {
    await channel.send(`${ping}${body}`);
    await interaction.editReply(`Posted ✅ — resolved to <t:${unix}:F>. If that's not what you meant, re-run with an explicit am/pm (e.g. \`9:30pm\`).`);
  } catch (err) {
    console.error('Announce post error:', err.message);
    await interaction.editReply('Something went wrong posting that announcement.');
  }
}

// DMs each attendee a simple confirmation that their attendance was logged.
// Best-effort per member — a member with DMs from server members disabled (or
// who has left the guild) just gets logged and skipped, not surfaced as a
// failure of the save itself, which has already succeeded by the time this runs.
async function notifyAttendance(attendees, title, eventDate) {
  if (!ready || !client) return;
  const dateText = eventDate ? ` on ${discordDate(eventDate)}` : '';
  const text = `✅ Your attendance for **${title}**${dateText} has been recorded. Thanks for showing up!`;
  for (const a of attendees) {
    try {
      const user = await client.users.fetch(a.id);
      await user.send(text);
    } catch (err) {
      console.error(`Attendance DM error for ${a.id}:`, err.message);
    }
  }
}

// ── Event signups ────────────────────────────────────────────────────────────
// Buttons on an announcement post, backed entirely by the database. The uuid in
// each customId is the whole lookup key, which is what lets a button on a post
// from three days ago still work after a deploy — deliberately NOT a
// createMessageComponentCollector(), which lives in memory and would go dead on
// every restart, silently, for every existing post.
//
// Sibling of admin.js's ROLE_EMOJI. Kept local rather than shared because the
// two render for different surfaces (a roster image caption vs. a signup list)
// and neither should have to change when the other's presentation does.
const ROLE_EMOJI = { Tank: '🛡️', DPS: '⚔️', Healer: '💚' };
// A Discord embed field value caps at 1024 characters, and a full guild will
// blow past that — clip well short and point at the "Who's coming?" button.
const FIELD_CHAR_BUDGET = 900;
// One edit per burst of clicks instead of one per click. Long enough to absorb
// a rush when a post goes up, short enough that nobody notices the lag.
const RENDER_DEBOUNCE_MS = 1500;
// Each DM opens a new channel; a guild-wide reminder in a tight loop trips a
// global 429 that costs the whole batch.
const DM_PACING_MS = 250;
const SWEEP_INTERVAL_MS = 60_000;

const pendingRenders = new Map();

const signupUnix = (row) => (row.starts_at
  ? Math.floor(Date.parse(row.starts_at) / 1000)
  : Math.floor(new Date(`${row.event_date}T12:00:00Z`).getTime() / 1000));

// Names as "🛡️ Someone", clipped to fit the field with a pointer to the button
// that shows the untruncated list. `withEmoji` is off for the role columns,
// where the header already says which role these are.
function nameLines(entries, withEmoji = true) {
  if (!entries.length) return '—';
  const lines = [];
  let used = 0;
  for (const e of entries) {
    const line = withEmoji ? `${ROLE_EMOJI[e.pvp_role] || '•'} ${e.display_name}` : e.display_name;
    if (used + line.length + 1 > FIELD_CHAR_BUDGET) {
      lines.push(`…and ${entries.length - lines.length} more`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

// Discord lays out up to three consecutive `inline` fields side by side, which
// is the only column mechanism an embed has. Four groups would wrap Unassigned
// onto its own row — which is fine, and it only appears when someone actually
// has no role on file.
const ROLE_COLUMNS = ['Tank', 'DPS', 'Healer'];
const columnFor = (role) => (ROLE_COLUMNS.includes(role) ? role : 'Unassigned');

// Raw object rather than EmbedBuilder, matching admin.js's rosterEmbed — the
// only other embed in the codebase.
function signupEmbed({ event, going, waitlist }) {
  const unix = signupUnix(event);
  const cap = event.capacity ? `/${event.capacity}` : '';
  const waiting = waitlist.length ? ` · ${waitlist.length} waiting` : '';
  const closed = event.status !== 'open';

  // Grouped rather than one flat list, so the shape of the raid reads at a
  // glance — "12 going" says nothing about whether it has a tank.
  const byRole = { Tank: [], DPS: [], Healer: [], Unassigned: [] };
  going.forEach((e) => byRole[columnFor(e.pvp_role)].push(e));

  const fields = ROLE_COLUMNS.map((role) => ({
    name: `${ROLE_EMOJI[role]} ${role} (${byRole[role].length})`,
    // Names alone here: the column header already carries the role, so the
    // per-name emoji nameLines() adds would just be the same glyph repeated.
    value: nameLines(byRole[role], false),
    inline: true,
  }));
  if (byRole.Unassigned.length) {
    fields.push({
      name: `• No role set (${byRole.Unassigned.length})`,
      value: nameLines(byRole.Unassigned, false),
      inline: true,
    });
  }
  if (waitlist.length) {
    // Full width, and keeps its emoji: a waitlist is read in order, not by role.
    fields.push({ name: `⏳ Waitlist (${waitlist.length})`, value: nameLines(waitlist) });
  }

  return {
    title: event.title,
    description: `<t:${unix}:F> (<t:${unix}:R>)\n**${going.length}${cap}** going${waiting}`
      + `\n${ROLE_COLUMNS.map((r) => `${ROLE_EMOJI[r]} ${byRole[r].length}`).join('   ')}`
      + (closed ? '\n\n*Signups are closed.*' : ''),
    color: 0xc9973a,
    fields,
    footer: { text: houseName() },
    timestamp: new Date().toISOString(),
  };
}

function signupButtons(id, closed) {
  if (closed) return []; // Closing strips the buttons rather than disabling them.
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sg:join:${id}`).setLabel("I'm in").setStyle(ButtonStyle.Success),
    // "Withdraw", not "Can't make it" — the latter reads as declaring absence,
    // which signups never record. This just takes your name back off the list.
    new ButtonBuilder().setCustomId(`sg:leave:${id}`).setLabel('Withdraw').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sg:who:${id}`).setLabel("Who's coming?").setStyle(ButtonStyle.Secondary),
  )];
}

async function signupChannel(channelId) {
  const guild = getGuild();
  const channel = guild?.channels.cache.get(channelId || signupChannelId());
  return channel?.isTextBased() ? channel : null;
}

// Posts (or re-posts) the announcement and records where it landed. Called when
// a signup opens, and again by hand if someone deletes the message.
async function announceSignup(signupEventId) {
  const target = signupChannelId();
  if (!ready || !signups || !target) return null;
  try {
    const detail = await signups.detail(signupEventId);
    const channel = await signupChannel(null);
    if (!channel) {
      console.error(`Signup announce error: channel ${target} not found or not text-based.`);
      return null;
    }
    const message = await channel.send({
      embeds: [signupEmbed(detail)],
      components: signupButtons(signupEventId, detail.event.status !== 'open'),
    });
    await signups.setMessageId(signupEventId, channel.id, message.id);
    return message.id;
  } catch (err) {
    console.error('Signup announce error:', err.message);
    return null;
  }
}

// Re-renders the post from the database. Always reads immediately before
// editing, so whichever call wins the race still writes the newest state.
async function renderSignupMessage(signupEventId) {
  if (!ready || !signups) return;
  try {
    const detail = await signups.detail(signupEventId);
    const { discord_channel_id: channelId, discord_message_id: messageId } = detail.event;
    if (!messageId) return; // Never announced — nothing to keep in sync.
    const channel = await signupChannel(channelId);
    if (!channel) return;
    await channel.messages.edit(messageId, {
      embeds: [signupEmbed(detail)],
      components: signupButtons(signupEventId, detail.event.status !== 'open'),
    });
  } catch (err) {
    // An officer deleting the post by hand is the common case here; the signup
    // itself is unaffected and /announce can put a fresh one up.
    console.error('Signup render error:', err.message);
  }
}

// Coalesces a burst of clicks into one edit. The map is purely an optimisation —
// losing it on restart costs nothing, because the next click schedules afresh
// and the render reads from the database either way.
function refreshSignupMessage(signupEventId) {
  if (!signupEventId || pendingRenders.has(signupEventId)) return;
  pendingRenders.set(signupEventId, setTimeout(() => {
    pendingRenders.delete(signupEventId);
    renderSignupMessage(signupEventId);
  }, RENDER_DEBOUNCE_MS));
}

async function deleteSignupMessage(row) {
  if (!ready || !row?.discord_message_id) return;
  try {
    const channel = await signupChannel(row.discord_channel_id);
    if (channel) await channel.messages.delete(row.discord_message_id);
  } catch (err) {
    console.error('Signup message delete error:', err.message);
  }
}

async function notifySignupPromotion(member, signupEventId) {
  if (!ready || !client || !member?.discord_id) return;
  try {
    const { event } = await signups.detail(signupEventId);
    const user = await client.users.fetch(member.discord_id);
    await user.send(`✅ A slot opened up — you're off the waitlist and in for **${event.title}** (<t:${signupUnix(event)}:R>).`);
  } catch (err) {
    console.error(`Signup promotion DM error for ${member.discord_id}:`, err.message);
  }
}

async function handleSignupButton(interaction) {
  if (!interaction.customId.startsWith('sg:')) return;
  const [, action, id] = interaction.customId.split(':');
  if (!id) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!signups) return interaction.editReply('Signups are not available right now.');

  try {
    if (action === 'who') {
      const { event, going, waitlist } = await signups.detail(id);
      // Grouped the same way the post is, so this reads as the untruncated
      // version of what they just looked at rather than a different view.
      const grouped = { Tank: [], DPS: [], Healer: [], Unassigned: [] };
      going.forEach((e) => grouped[columnFor(e.pvp_role)].push(e.display_name));
      const list = going.length
        ? [...ROLE_COLUMNS, 'Unassigned']
          .filter((r) => grouped[r].length)
          .map((r) => `**${ROLE_EMOJI[r] || '•'} ${r} (${grouped[r].length})**\n${grouped[r].join('\n')}`)
          .join('\n\n')
        : 'Nobody yet.';
      const waiting = waitlist.length
        ? `\n\n**Waitlist (${waitlist.length})**\n${waitlist.map((e, i) => `${i + 1}. ${e.display_name}`).join('\n')}`
        : '';
      // Ephemeral, so the full list can run long without flooding the channel —
      // this is the escape hatch for the clipped embed.
      return interaction.editReply(`**${event.title} — going (${going.length})**\n${list}${waiting}`.slice(0, 1900));
    }

    if (action === 'join') {
      const result = await signups.join({
        id, discordId: interaction.user.id, displayName: displayNameFor(interaction.user),
      });
      refreshSignupMessage(id);

      // A member on LOA who signs up anyway is allowed — they may have filed a
      // range and made an exception for this night. Flagged, not blocked.
      let note = '';
      if (loa) {
        const { event } = await signups.detail(id);
        const out = await loa.unavailableOn({ date: event.event_date, eventScheduleId: event.event_schedule_id })
          .catch(() => []);
        if (out.some((e) => e.discord_id === interaction.user.id)) {
          note = "\n\n⚠️ Heads up — you still have an LOA on file for that night. Cancel it with `/loa cancel` if you're coming after all.";
        }
      }

      if (!result.wasNew) {
        return interaction.editReply(result.status === 'waitlist'
          ? `You're already on the waitlist for this one.${note}`
          : `You're already down as going.${note}`);
      }
      if (result.status === 'waitlist') {
        // Deliberately not "going/capacity": the RPC returns counts, not the cap,
        // and after a capacity cut the two disagree — a headcount is always true.
        return interaction.editReply(`This one's full (**${result.going}** going). You're **#${result.waitlist}** on the waitlist — you'll be moved up and DM'd if a slot opens.${note}`);
      }
      return interaction.editReply(`You're in ✅ — **${result.going}** going.${note}`);
    }

    if (action === 'leave') {
      const result = await signups.withdraw({ id, discordId: interaction.user.id });
      if (!result.removed) return interaction.editReply("You weren't signed up for this one.");
      refreshSignupMessage(id);
      if (result.promoted) notifySignupPromotion(result.promoted, id);
      return interaction.editReply(result.promoted
        ? `Withdrawn. **${result.promoted.display_name}** moved up off the waitlist.`
        : 'Withdrawn — your name is off the list.');
    }
  } catch (err) {
    return interaction.editReply(err.message || 'Something went wrong with that signup.');
  }
}

// DMs everyone who hasn't responded and isn't already on LOA. Claims the send
// first, so the minute timer and a manual "remind now" can't both fire.
async function sendSignupReminder(signupEventId) {
  if (!ready || !client || !signups) return;
  try {
    if (!(await signups.claimReminder(signupEventId))) return;
    const roster = await listMembers().catch(() => []);
    const { event, members } = await signups.nonResponders(signupEventId, roster);
    if (!members.length) return;

    const text = `📋 **${event.title}** starts <t:${signupUnix(event)}:R> and we haven't heard from you.`
      + '\nHit **I\'m in** on the signup post if you\'re coming, or file an LOA with `/loa` if you\'re not.';
    for (const m of members) {
      try {
        const user = await client.users.fetch(m.id);
        await user.send(text);
      } catch (err) {
        console.error(`Signup reminder DM error for ${m.id}:`, err.message);
      }
      await new Promise((r) => setTimeout(r, DM_PACING_MS));
    }
  } catch (err) {
    console.error('Signup reminder error:', err.message);
  }
}

// The only scheduler in the backend. Runs in the web process, so it does nothing
// while that process is asleep — and the `starts_at > now()` guard in
// dueForReminder means a long outage suppresses stale reminders rather than
// sending a burst of them on wake. Two instances would each run a sweep, but the
// claimReminder compare-and-set still makes a duplicate DM impossible.
function startSignupSweep() {
  if (!signups || sweepTimer) return;
  sweepTimer = setInterval(async () => {
    try {
      for (const event of await signups.dueForReminder()) await sendSignupReminder(event.id);
      for (const event of await signups.dueToClose()) {
        await signups.setStatus(event.id, 'closed');
        await renderSignupMessage(event.id); // Immediate, not debounced — nobody is racing this.
      }
    } catch (err) {
      console.error('Signup sweep error:', err.message);
    }
  }, SWEEP_INTERVAL_MS);
}

// List voice channels the bot can see.
function listVoiceChannels() {
  const guild = getGuild();
  if (!guild) return [];
  return guild.channels.cache
    .filter((ch) => ch.type === 2) // GuildVoice
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((ch) => ({ id: ch.id, name: ch.name, memberCount: ch.members.size }));
}

// List text channels the bot can see, for the channel pickers in Guild
// Settings. Announcement channels (type 5) are included because a guild
// announcing its CTAs in one is entirely normal and the bot can post there the
// same way.
//
// An EMPTY list is ambiguous and the settings route has to say which kind it
// is: the bot being offline, and the bot being online but able to see nothing,
// look identical from here. That distinction is why the page never silently
// blanks a stored channel id it can't find in this list.
function listTextChannels() {
  const guild = getGuild();
  if (!guild) return [];
  return guild.channels.cache
    .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((ch) => ({ id: ch.id, name: ch.name }));
}

// Snap the current members in a voice channel.
function getVoiceMembers(channelId) {
  const guild = getGuild();
  if (!guild) return [];
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== 2) return [];
  return channel.members.map((m) => ({
    id: m.user.id,
    name: m.nickname || m.user.globalName || m.user.username,
    avatar: m.user.avatar
      ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`
      : null,
  }));
}

module.exports = {
  start,
  listVoiceChannels,
  listTextChannels,
  getVoiceMembers,
  announceLoaEntry,
  deleteLoaMessage,
  notifyLoaCancelled,
  notifyAttendance,
  announceSignup,
  refreshSignupMessage,
  deleteSignupMessage,
  notifySignupPromotion,
  sendSignupReminder,
  notifyLateAttendance,
};

// Exposed for backend/test/eliteButtons.test.js, and for nothing else. The
// gateway's own `eliteTimers` is set by start(), which opens a websocket and
// logs in — so a test can't reach the board rendering or the button branching
// any other way. Same motivation as gearIlvl exporting parseGearScreenshot for
// its CLI script: a seam for a caller that can't take the normal route.
module.exports.__test = {
  setEliteTimers: (t) => { eliteTimers = t; },
  eliteBoard,
  handleEliteButton,
};
