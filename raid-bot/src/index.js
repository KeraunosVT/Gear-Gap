// Starts the bot: database, migrations, Discord, commands, sweeper.
//
// Environment (see .env.example):
//   DISCORD_TOKEN      the bot's token (Developer Portal → Bot)
//   DATABASE_URL       Postgres connection string
//   DATABASE_CA_FILE   optional, the database's CA certificate (see db.js)
//   DEV_GUILD_ID       optional, register commands on this one server only
//                      (instant), instead of globally, while testing
//   REGISTER_COMMANDS  optional, "false" to skip registering on start
const { Client, Events, GatewayIntentBits, REST, Routes, PermissionsBitField, OAuth2Scopes } = require('discord.js');
const { createPool } = require('./db');
const { migrate } = require('./migrate');
const { createStore } = require('./store');
const { createPosts } = require('./posts');
const { createSweeper } = require('./sweeper');
const { createInteractionHandler } = require('./interactions');
const { commands } = require('./commands');

// What the invite link asks for: post, edit its own posts, and reply to them.
const BOT_PERMISSIONS = new PermissionsBitField([
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.SendMessagesInThreads,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.ReadMessageHistory,
]);

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error('DISCORD_TOKEN is not set.');

  const pool = createPool();
  await migrate(pool);
  const store = createStore(pool);

  // Guilds is the only intent, and it isn't privileged: the bot never reads
  // messages or member lists, so it needs no approval from Discord to grow.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const posts = createPosts({ client, store });
  const sweeper = createSweeper({ store, posts });
  const handle = createInteractionHandler({ store, posts, client });

  client.on(Events.InteractionCreate, handle);

  // Removed from a server: forget it. (An outage emits GuildUnavailable
  // instead, so this only fires for a real removal.)
  client.on(Events.GuildDelete, (guild) => {
    if (guild.available === false) return;
    store.deleteGuild(guild.id)
      .then(() => console.log(`Removed from ${guild.id}; its data is deleted.`))
      .catch((err) => console.error(`Couldn't delete data for ${guild.id}:`, err.message));
  });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Logged in as ${c.user.tag}, in ${c.guilds.cache.size} server(s).`);
    if (process.env.REGISTER_COMMANDS !== 'false') {
      const rest = new REST().setToken(token);
      const dev = process.env.DEV_GUILD_ID;
      try {
        await rest.put(dev ? Routes.applicationGuildCommands(c.application.id, dev) : Routes.applicationCommands(c.application.id), { body: commands });
        console.log(dev ? `Commands registered on server ${dev}.` : 'Commands registered globally.');
      } catch (err) {
        console.error('Command registration failed:', err.message);
      }
    }
    console.log(`Invite link: ${c.generateInvite({ scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands], permissions: BOT_PERMISSIONS })}`);
    sweeper.start();
  });

  const shutdown = async () => {
    sweeper.stop();
    posts.stop();
    await client.destroy();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await client.login(token);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
