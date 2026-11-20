// The slash commands, as registered with Discord.
//
// /raid        — everyone: post a run, list runs, set your own timezone, help.
// /raid-setup  — the server's settings. Hidden from anyone without Manage
//                Server unless an admin grants it in Server Settings →
//                Integrations, and checked again when it runs.
const {
  SlashCommandBuilder, ChannelType, PermissionFlagsBits, InteractionContextType, ApplicationIntegrationType,
} = require('discord.js');
const { raids, ROLES } = require('./catalog');

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

const raid = new SlashCommandBuilder()
  .setName('raid')
  .setDescription('Throne & Liberty raid signups')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .addSubcommand((sub) => sub
    .setName('post')
    .setDescription('Post a raid run people can sign up for')
    .addStringOption((o) => o.setName('plan').setDescription('Modes and gates, e.g. "normal 1-3" or "normal 1-3 + nightmare 1"')
      .setRequired(true).setAutocomplete(true).setMaxLength(100))
    .addStringOption((o) => o.setName('when').setDescription('When it starts, e.g. "fri 8pm", "tomorrow 20:30", "in 2h"')
      .setRequired(true).setAutocomplete(true).setMaxLength(100))
    .addStringOption((o) => o.setName('my_role').setDescription('Sign yourself up as this role')
      .addChoices(...ROLES.map((r) => ({ name: r, value: r }))))
    .addStringOption((o) => o.setName('title').setDescription('Defaults to the raid name').setMaxLength(100))
    .addStringOption((o) => o.setName('notes').setDescription('Anything people should know (requirements, voice channel…)').setMaxLength(500))
    .addChannelOption((o) => o.setName('channel').setDescription("Where to post it. Defaults to the server's raid channel")
      .addChannelTypes(...TEXT_CHANNELS))
    .addStringOption((o) => o.setName('raid').setDescription(`Which raid. Defaults to ${raids[0].name}`)
      .addChoices(...raids.map((r) => ({ name: r.name, value: r.key })))))
  .addSubcommand((sub) => sub
    .setName('list')
    .setDescription('Upcoming runs on this server'))
  .addSubcommand((sub) => sub
    .setName('timezone')
    .setDescription('Set the timezone the times you type are read in')
    .addStringOption((o) => o.setName('zone').setDescription('e.g. America/New_York, Europe/Berlin, EST. Leave empty to see yours')
      .setAutocomplete(true).setMaxLength(64)))
  .addSubcommand((sub) => sub
    .setName('help')
    .setDescription('How raid signups work'));

const setup = new SlashCommandBuilder()
  .setName('raid-setup')
  .setDescription('Raid signup settings for this server')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) => sub
    .setName('show')
    .setDescription("This server's raid settings"))
  .addSubcommand((sub) => sub
    .setName('set')
    .setDescription('Change one or more settings')
    .addChannelOption((o) => o.setName('channel').setDescription('Where runs are posted by default')
      .addChannelTypes(...TEXT_CHANNELS))
    .addRoleOption((o) => o.setName('poster_role').setDescription('Only this role may post runs (default: anyone)'))
    .addRoleOption((o) => o.setName('manager_role').setDescription("This role may manage anyone's run"))
    .addStringOption((o) => o.setName('timezone').setDescription("How typed times are read for members who haven't set their own")
      .setAutocomplete(true).setMaxLength(64))
    .addIntegerOption((o) => o.setName('reminder_minutes').setDescription('Ping the roster this long before a run (0 = never)')
      .setMinValue(0).setMaxValue(240)))
  .addSubcommand((sub) => sub
    .setName('reset')
    .setDescription('Put one setting back to its default')
    .addStringOption((o) => o.setName('setting').setDescription('Which one').setRequired(true).addChoices(
      { name: 'Raid channel', value: 'raid_channel_id' },
      { name: 'Poster role (anyone may post)', value: 'poster_role_id' },
      { name: 'Manager role (none)', value: 'manager_role_id' },
      { name: 'Timezone (UTC)', value: 'timezone' },
      { name: 'Reminder (15 minutes)', value: 'reminder_minutes' },
    )));

const commands = [raid.toJSON(), setup.toJSON()];

module.exports = { commands };
