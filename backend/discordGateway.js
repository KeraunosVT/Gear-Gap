// backend/discordGateway.js — Lightweight discord.js gateway client.
// Maintains a WebSocket connection so we can read voice-channel state (which the
// REST API does not expose), and handles the /elitetimer slash command plus its
// 10-minute-before-spawn reminder sweep.
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } = require('discord.js');
const createEliteTimers = require('./eliteTimers');
const createLoa = require('./loa');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ELITE_CHANNEL_ID = process.env.DISCORD_ELITE_CHANNEL_ID;
const LOA_CHANNEL_ID = process.env.DISCORD_LOA_CHANNEL_ID;
// Same admin role list auth.js uses to gate the website's admin area, so
// "officer" means the same thing in Discord as it does on the site.
const ADMIN_ROLE_IDS = (process.env.DISCORD_ADMIN_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "21:00" -> "9:00 PM", for echoing a recurring LOA's start time back in chat.
function fmt12h(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

const SWEEP_INTERVAL_MS = 60 * 1000;
const WARNING_WINDOW_MS = 10 * 60 * 1000;

let client = null;
let ready = false;
let eliteTimers = null;
let loa = null;

function start(supabase) {
  if (!BOT_TOKEN || !GUILD_ID) {
    console.warn('⚠️  Discord gateway disabled — BOT_TOKEN or GUILD_ID missing.');
    return;
  }

  eliteTimers = supabase ? createEliteTimers(supabase) : null;
  loa = supabase ? createLoa(supabase) : null;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once('clientReady', async () => {
    ready = true;
    console.log('✅ Discord gateway connected');
    if (eliteTimers || loa) {
      await registerCommands();
    }
    if (eliteTimers) {
      setInterval(sweepEliteTimers, SWEEP_INTERVAL_MS);
    }
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
          .setDescription('Request LOA for a single scheduled event.')
          .addStringOption((opt) => opt.setName('date').setDescription('Event date, YYYY-MM-DD').setRequired(true))
          .addStringOption((opt) => opt.setName('event').setDescription('Which event').setRequired(true).setAutocomplete(true))
          .addStringOption((opt) => opt.setName('reason').setDescription('Visible to officers only').setRequired(true))
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
          .addUserOption((opt) => opt.setName('member').setDescription('Officers only: submit on behalf of this member').setRequired(false))
      )
      .addSubcommand((sub) =>
        sub.setName('cancel')
          .setDescription('Cancel one of your upcoming LOAs (officers: anyone’s).')
          .addStringOption((opt) => opt.setName('entry').setDescription('Which LOA to cancel').setRequired(true).setAutocomplete(true))
      );

    commands.push(loaCommand.toJSON());
  }

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
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'elitetimer') return handleReport(interaction);
  if (interaction.commandName === 'elitetimers') return handleList(interaction);
  if (interaction.commandName === 'loa') return handleLoa(interaction);
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

async function handleList(interaction) {
  await interaction.deferReply();

  if (!eliteTimers) {
    return interaction.editReply('Elite timers are not configured right now.');
  }

  try {
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
    await interaction.editReply(lines.join('\n'));
  } catch (err) {
    console.error('elitetimers command error:', err.message);
    await interaction.editReply('Something went wrong reading the timers.');
  }
}

// ── /loa ──────────────────────────────────────────────────────────────────
// Matches the display name website logins use (see auth.js) rather than the
// guild nickname, so the same member shows up the same way in both places.
function displayNameFor(user) {
  return user.globalName || user.username || 'Member';
}

function isAdminMember(interaction) {
  if (!ADMIN_ROLE_IDS.length) return false;
  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;
  return ADMIN_ROLE_IDS.some((r) => roles.has(r));
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
  if (!LOA_CHANNEL_ID) return null;
  const guild = getGuild();
  const channel = guild?.channels.cache.get(LOA_CHANNEL_ID);
  if (!channel?.isTextBased()) {
    console.error(`LOA announce error: channel ${LOA_CHANNEL_ID} not found or not text-based (check DISCORD_LOA_CHANNEL_ID and bot permissions).`);
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

// Deletes a previously-announced LOA message when its entry is cancelled.
// Best-effort: an already-deleted message (e.g. an officer removed it by hand)
// or a missing channel/permission just gets logged, not surfaced to the caller
// — the LOA record is already gone by the time this runs either way.
async function deleteLoaMessage(messageId) {
  if (!messageId || !LOA_CHANNEL_ID) return;
  const guild = getGuild();
  const channel = guild?.channels.cache.get(LOA_CHANNEL_ID);
  if (!channel?.isTextBased()) return;
  try {
    await channel.messages.delete(messageId);
  } catch (err) {
    console.error('LOA message delete error:', err.message);
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
  const reason = interaction.options.getString('reason') || '';
  if (!eventScheduleId) return interaction.editReply('No event selected — pick one from the list.');

  try {
    const { id, eventName } = await loa.submitEvent({
      discordId: target.discordId,
      displayName: target.displayName,
      eventDate: date,
      eventScheduleId,
      reason,
    });
    await interaction.editReply(target.onBehalf
      ? `Recorded ✅ — LOA submitted for **${target.displayName}** on ${date}.`
      : `Recorded ✅ — LOA submitted for ${date}.`);
    const messageId = await announceLoa(`📋 **${target.displayName}** is on LOA for **${eventName}** — ${discordDate(date)}`);
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
    const { id } = await loa.submitRange({
      discordId: target.discordId,
      displayName: target.displayName,
      startDate, endDate, reason,
    });
    await interaction.editReply(target.onBehalf
      ? `Recorded ✅ — LOA submitted for **${target.displayName}**, ${startDate} to ${endDate}.`
      : `Recorded ✅ — LOA submitted for ${startDate} to ${endDate}.`);
    const messageId = await announceLoa(`📋 **${target.displayName}** is on LOA — ${discordDate(startDate)} to ${discordDate(endDate)}`);
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
  const reason = interaction.options.getString('reason') || '';

  const startTime = startTimeRaw ? loa.parseTimeOfDay(startTimeRaw) : null;
  if (startTimeRaw && !startTime) {
    return interaction.editReply(`Couldn't read "${startTimeRaw}" as a time — try something like 9:00 PM or 21:00.`);
  }

  try {
    const { id, eventName } = await loa.submitRecurring({
      discordId: target.discordId,
      displayName: target.displayName,
      dayOfWeek: dow,
      eventScheduleId,
      startTime,
      reason,
    });
    const scope = eventName ? ` for **${eventName}**` : '';
    const fromTime = startTime ? ` from **${fmt12h(startTime)}**` : '';
    await interaction.editReply(target.onBehalf
      ? `Recorded ✅ — **${target.displayName}** is now always out on **${DAY_NAMES[dow]}**${fromTime}${scope}.`
      : `Recorded ✅ — you're now always out on **${DAY_NAMES[dow]}**${fromTime}${scope}.`);
    const messageId = await announceLoa(`📋 **${target.displayName}** is always on LOA every **${DAY_NAMES[dow]}**${fromTime}${scope}`);
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
    const { messageId } = await loa.cancel(id, interaction.user.id, isAdminMember(interaction));
    await interaction.editReply('Cancelled ✅');
    await deleteLoaMessage(messageId);
  } catch (err) {
    await interaction.editReply(err.message || 'Something went wrong cancelling that LOA.');
  }
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'loa') return interaction.respond([]).catch(() => {});
  const sub = interaction.options.getSubcommand();
  if (sub === 'event') return autocompleteLoaEvent(interaction);
  if (sub === 'recurring') return autocompleteLoaRecurring(interaction);
  if (sub === 'cancel') return autocompleteLoaCancel(interaction);
  return interaction.respond([]).catch(() => {});
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

async function sweepEliteTimers() {
  if (!eliteTimers || !ready) return;
  if (!ELITE_CHANNEL_ID) return;

  let due;
  try {
    due = await eliteTimers.getDue(WARNING_WINDOW_MS);
  } catch (err) {
    console.error('Elite timer sweep error:', err.message);
    return;
  }
  if (due.length === 0) return;

  const guild = getGuild();
  const channel = guild?.channels.cache.get(ELITE_CHANNEL_ID);
  if (!channel?.isTextBased()) {
    console.error(`Elite timer sweep error: channel ${ELITE_CHANNEL_ID} not found or not text-based (check DISCORD_ELITE_CHANNEL_ID and bot permissions).`);
    return;
  }

  // Each location pings independently — one failure (e.g. a permissions issue)
  // shouldn't block the others, and a failed send leaves `pinged` false so it
  // retries next sweep instead of being silently skipped forever.
  for (const row of due) {
    try {
      const spawnUnix = Math.floor(new Date(row.next_spawn_at).getTime() / 1000);
      await channel.send(`⏰ **${row.location}** spawns <t:${spawnUnix}:R> (<t:${spawnUnix}:t>)!`);
      await eliteTimers.markPinged(row.location);
    } catch (err) {
      console.error(`Elite timer sweep error for ${row.location}:`, err.message);
    }
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

// List voice channels the bot can see.
function listVoiceChannels() {
  const guild = getGuild();
  if (!guild) return [];
  return guild.channels.cache
    .filter((ch) => ch.type === 2) // GuildVoice
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((ch) => ({ id: ch.id, name: ch.name, memberCount: ch.members.size }));
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

module.exports = { start, listVoiceChannels, getVoiceMembers, deleteLoaMessage, notifyAttendance };
