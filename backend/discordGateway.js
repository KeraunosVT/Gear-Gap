// backend/discordGateway.js — Lightweight discord.js gateway client.
// Maintains a WebSocket connection so we can read voice-channel state (which the
// REST API does not expose), and handles the /elitetimer slash command plus its
// 10-minute-before-spawn reminder sweep.
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } = require('discord.js');
const createEliteTimers = require('./eliteTimers');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ELITE_CHANNEL_ID = process.env.DISCORD_ELITE_CHANNEL_ID;

const SWEEP_INTERVAL_MS = 60 * 1000;
const WARNING_WINDOW_MS = 10 * 60 * 1000;

let client = null;
let ready = false;
let eliteTimers = null;

function start(supabase) {
  if (!BOT_TOKEN || !GUILD_ID) {
    console.warn('⚠️  Discord gateway disabled — BOT_TOKEN or GUILD_ID missing.');
    return;
  }

  eliteTimers = supabase ? createEliteTimers(supabase) : null;

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  client.once('clientReady', async () => {
    ready = true;
    console.log('✅ Discord gateway connected');
    if (eliteTimers) {
      await registerCommands();
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

// ── /elitetimer, /elitetimers ────────────────────────────────────────────────
async function registerCommands() {
  if (!CLIENT_ID) {
    console.warn('⚠️  DISCORD_CLIENT_ID missing — elite timer commands were not registered.');
    return;
  }
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

  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [reportCommand.toJSON(), listCommand.toJSON()],
    });
    console.log('✅ /elitetimer and /elitetimers commands registered');
  } catch (err) {
    console.error('❌ Failed to register elite timer commands:', err.message);
  }
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'elitetimer') return handleReport(interaction);
  if (interaction.commandName === 'elitetimers') return handleList(interaction);
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

module.exports = { start, listVoiceChannels, getVoiceMembers };
