// Every slash command, autocomplete, button, menu and form the bot answers.
//
// Button customIds carry everything needed to act ("rd:join:<run>:<role>"),
// so a post keeps working across restarts and redeploys. Each one is checked
// against the server it was clicked in, so a run id can never reach another
// server's run, and every lead action re-checks who's asking.
const {
  MessageFlags, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, escapeMarkdown,
} = require('discord.js');
const { raids, raidOf, ROLES, ROLE_EMOJI, ROLE_PLURAL } = require('./catalog');
const { parsePlan, formatPlan, planSuggestions } = require('./plan');
const { parseWhen, resolveTimeZone, zoneSuggestions, whenSuggestions, formatForInput, formatShort, unix } = require('./time');
const { canPost, canManage } = require('./permissions');
const { RaidError } = require('./store');
const render = require('./render');

const EPHEMERAL = MessageFlags.Ephemeral;
const NO_PINGS = { parse: [] };
const PING_COOLDOWN_MS = 10 * 60_000;

const BOT_NEEDS = {
  ViewChannel: 'View Channel',
  SendMessages: 'Send Messages',
  EmbedLinks: 'Embed Links',
  ReadMessageHistory: 'Read Message History',
};

const displayNameOf = (member, user) => member?.displayName || member?.nick
  || user?.globalName || user?.global_name || user?.username || 'Unknown';

const forbidden = () => new RaidError('forbidden', "Only this run's lead or a raid manager can do that.");

function helpText() {
  return [
    '## ⛩️ Raid signups',
    '**Posting a run:** `/raid post plan:normal 1-3 when:fri 8pm`. Add `my_role` to sign yourself up, plus a title or notes if you like.',
    '• **plan** is modes and gates: `normal 1-3`, `nightmare 1`, `normal 1-3 + difficult 1-2`.',
    '• **when** is read on your clock: `fri 8pm`, `tomorrow 20:30`, `nov 21 9pm`, `in 2h`. Set yours once with `/raid timezone`.',
    '',
    '**Signing up:** press your role on the post. If the role is full you go on the bench and move up automatically when a slot opens (you get a DM). **Bench** means "available if needed": the lead brings you in. **Withdraw** takes you off.',
    '',
    "**Leads:** the post's **Manage** button edits the run, closes or reopens signups, pings the roster, moves people between roster and bench, adds people, reposts it, or cancels it. Server staff (Manage Server or Manage Events) and the server's manager role can manage any run.",
    '',
    '**Server admins:** `/raid-setup set` picks a default channel, who may post runs, a manager role, the server timezone and the reminder time. The roster is pinged before each run starts, and signups close when it does.',
  ].join('\n');
}

function createInteractionHandler({ store, posts, client, log = console }) {
  const lastPing = new Map();

  // ── Helpers ───────────────────────────────────────────────────────────────

  // An answer to whatever state the interaction is in.
  async function say(interaction, content) {
    if (interaction.isAutocomplete()) return interaction.respond([]);
    if (interaction.deferred && !interaction.replied) return interaction.editReply({ content, components: [], allowedMentions: NO_PINGS });
    if (interaction.replied) return interaction.followUp({ content, flags: EPHEMERAL, allowedMentions: NO_PINGS });
    return interaction.reply({ content, flags: EPHEMERAL, allowedMentions: NO_PINGS });
  }

  function missingPermissions(channel) {
    const perms = channel.permissionsFor?.(client.user);
    const needed = { ...BOT_NEEDS };
    if (channel.isThread?.()) {
      delete needed.SendMessages;
      needed.SendMessagesInThreads = 'Send Messages in Threads';
    }
    if (!perms) return Object.values(needed);
    return Object.keys(needed).filter((flag) => !perms.has(PermissionFlagsBits[flag])).map((flag) => needed[flag]);
  }

  // The run, if the person asking may manage it.
  async function managedRun(interaction, id) {
    const run = await store.getRun(id, interaction.guildId);
    if (!run) throw new RaidError('not_found', "This run doesn't exist any more.");
    const settings = await store.getSettings(interaction.guildId);
    if (!canManage({
      userId: interaction.user.id, member: interaction.member, perms: interaction.memberPermissions, settings, run,
    })) throw forbidden();
    return run;
  }

  const fromPanel = (interaction) => !!interaction.message?.flags?.has(MessageFlags.Ephemeral);

  // The lead's panel: a fresh private one from the post, or the same one
  // redrawn when acting from it.
  async function showPanel(interaction, id, note) {
    const payload = render.managePanel(await store.detail(id, interaction.guildId));
    if (note) payload.content = `${note}\n\n${payload.content}`;
    payload.allowedMentions = NO_PINGS;
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    if (fromPanel(interaction)) return interaction.update(payload);
    return interaction.reply({ ...payload, flags: EPHEMERAL });
  }

  function tzNote(date, tz) {
    const shown = `${formatShort(date, tz.timezone)} ${tz.timezone}`;
    if (tz.source === 'user') return `-# Read as ${shown}, your timezone.`;
    if (tz.source === 'server') return `-# Read as ${shown}, the server's timezone. Set your own with \`/raid timezone\`.`;
    return `-# Read as ${shown}. Set your timezone with \`/raid timezone\`, or the server's with \`/raid-setup set\`.`;
  }

  // ── Autocomplete ──────────────────────────────────────────────────────────

  async function autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const typed = String(focused.value || '');
    let choices = [];
    if (focused.name === 'plan') {
      choices = planSuggestions(raidOf(interaction.options.getString('raid')) || raids[0], typed);
    } else if (focused.name === 'when') {
      const tz = await store.timezoneFor(interaction.user.id, interaction.guildId);
      choices = whenSuggestions(typed, tz.timezone);
    } else if (focused.name === 'zone' || focused.name === 'timezone') {
      choices = zoneSuggestions(typed).map((z) => ({ name: z, value: z }));
      if (focused.name === 'zone' && (!typed || 'server'.startsWith(typed.toLowerCase()))) {
        choices = [{ name: "Use the server's timezone", value: 'server' }, ...choices].slice(0, 25);
      }
    }
    return interaction.respond(choices);
  }

  // ── /raid ─────────────────────────────────────────────────────────────────

  async function postRun(interaction) {
    const { guildId, options, user } = interaction;
    const settings = await store.getSettings(guildId);
    if (!canPost({ member: interaction.member, perms: interaction.memberPermissions, settings })) {
      return say(interaction, `Only <@&${settings.poster_role_id}> can post runs on this server.`);
    }

    const raid = raidOf(options.getString('raid')) || raids[0];
    const plan = parsePlan(raid, options.getString('plan', true));
    if (!plan.ok) return say(interaction, plan.error);

    const tz = await store.timezoneFor(user.id, guildId);
    const when = parseWhen(options.getString('when', true), { timeZone: tz.timezone });
    if (!when.ok) return say(interaction, `${when.error}\n-# Times are read in ${tz.timezone}.`);

    const channelId = options.getChannel('channel')?.id || settings.raid_channel_id || interaction.channelId;
    const channel = await posts.fetchChannel(channelId);
    if (!channel) return say(interaction, `I can't see <#${channelId}>. Give me access to it, or post somewhere else with the \`channel\` option.`);
    const missing = missingPermissions(channel);
    if (missing.length) return say(interaction, `I need **${missing.join(', ')}** in <#${channel.id}> to post there.`);

    await interaction.deferReply({ flags: EPHEMERAL });
    const run = await store.createRun({
      guildId, channelId: channel.id, raidKey: raid.key, segments: plan.segments, roleCaps: raid.roles,
      title: options.getString('title')?.trim() || raid.name,
      notes: options.getString('notes')?.trim() || null,
      startsAt: when.date, leadId: user.id,
    });
    const myRole = options.getString('my_role');
    if (myRole) {
      await store.join({ runId: run.id, guildId, userId: user.id, displayName: displayNameOf(interaction.member, user), role: myRole });
    }

    let message;
    try {
      message = await posts.announce(run.id);
    } catch (err) {
      await store.deleteRun(run.id);
      return say(interaction, `Couldn't post in <#${channel.id}>: ${err.message}`);
    }
    const at = unix(when.date);
    return interaction.editReply({
      content: `Posted **${escapeMarkdown(run.title)}** for <t:${at}:F> (<t:${at}:R>): ${message.url}\n${tzNote(when.date, tz)}`,
      allowedMentions: NO_PINGS,
    });
  }

  async function listRuns(interaction) {
    const runs = await store.listUpcoming(interaction.guildId);
    if (!runs.length) return say(interaction, 'No upcoming runs. Post one with `/raid post`.');
    const lines = runs.map((r) => {
      const seats = ROLES.reduce((n, role) => n + Number(r.role_caps?.[role] || 0), 0);
      const link = render.postLink(r);
      return `• <t:${unix(r.starts_at)}:f> **${escapeMarkdown(r.title)}** · ${r.going_count}/${seats} in`
        + (r.bench_count ? ` · ${r.bench_count} on the bench` : '')
        + (r.status === 'closed' ? ' · closed' : '')
        + (link ? ` · [post](${link})` : '');
    });
    return say(interaction, `**Upcoming runs**\n${lines.join('\n')}`);
  }

  async function setMyTimezone(interaction) {
    const zone = interaction.options.getString('zone')?.trim();
    const { user, guildId } = interaction;
    const server = (await store.getSettings(guildId)).timezone;
    const fallback = server ? `the server's (**${server}**)` : '**UTC**';

    if (!zone) {
      const mine = await store.getUserTimezone(user.id);
      return say(interaction, mine
        ? `Times you type are read in **${mine}** (it's ${formatShort(new Date(), mine)} there).`
        : `You haven't set a timezone, so times you type are read in ${fallback}. Set one with \`/raid timezone zone:\`.`);
    }
    if (['server', 'none', 'clear', 'reset'].includes(zone.toLowerCase())) {
      await store.setUserTimezone(user.id, null);
      return say(interaction, `Cleared. Times you type are read in ${fallback}.`);
    }
    const tz = resolveTimeZone(zone);
    if (!tz) return say(interaction, `"${zone}" isn't a timezone I know. Try one from the list, like America/New_York or Europe/Berlin.`);
    await store.setUserTimezone(user.id, tz);
    return say(interaction, `Times you type are now read in **${tz}** (it's ${formatShort(new Date(), tz)} there). This applies on every server.`);
  }

  // ── /raid-setup ───────────────────────────────────────────────────────────
  // Discord hides it from anyone without Manage Server unless an admin has
  // granted it to a role in Server Settings → Integrations; that grant is the
  // admin's call, so it isn't second-guessed here.

  function settingsText(s) {
    return [
      '**Raid settings**',
      `Raid channel: ${s.raid_channel_id ? `<#${s.raid_channel_id}>` : 'none (runs post where `/raid post` is used)'}`,
      `Who can post runs: ${s.poster_role_id ? `<@&${s.poster_role_id}>, plus server staff` : 'anyone'}`,
      `Who can manage any run: ${s.manager_role_id ? `<@&${s.manager_role_id}>, ` : ''}anyone with Manage Server or Manage Events, plus each run's own lead`,
      `Timezone: ${s.timezone || 'UTC (not set)'} · used for members who haven't set their own`,
      `Reminder: ${s.reminder_minutes ? `${s.reminder_minutes} minutes before a run` : 'off'}`,
    ].join('\n');
  }

  async function setup(interaction) {
    const { guildId, options } = interaction;
    const sub = options.getSubcommand();

    if (sub === 'show') return say(interaction, settingsText(await store.getSettings(guildId)));

    if (sub === 'reset') {
      const saved = await store.updateSettings(guildId, { [options.getString('setting', true)]: null });
      return say(interaction, `Reset.\n\n${settingsText(saved)}`);
    }

    const patch = {};
    const warnings = [];
    const channel = options.getChannel('channel');
    if (channel) {
      patch.raid_channel_id = channel.id;
      const fetched = await posts.fetchChannel(channel.id);
      const missing = fetched ? missingPermissions(fetched) : Object.values(BOT_NEEDS);
      if (missing.length) warnings.push(`⚠️ I'll need **${missing.join(', ')}** in <#${channel.id}> to post there.`);
    }
    const posterRole = options.getRole('poster_role');
    if (posterRole) patch.poster_role_id = posterRole.id;
    const managerRole = options.getRole('manager_role');
    if (managerRole) patch.manager_role_id = managerRole.id;
    const zone = options.getString('timezone');
    if (zone) {
      const tz = resolveTimeZone(zone);
      if (!tz) return say(interaction, `"${zone}" isn't a timezone I know. Try one from the list, like America/New_York.`);
      patch.timezone = tz;
    }
    const reminder = options.getInteger('reminder_minutes');
    if (reminder !== null) patch.reminder_minutes = reminder;

    if (!Object.keys(patch).length) return say(interaction, 'Pick at least one setting to change.');
    const saved = await store.updateSettings(guildId, patch);
    return say(interaction, `Saved.${warnings.length ? `\n${warnings.join('\n')}` : ''}\n\n${settingsText(saved)}`);
  }

  async function command(interaction) {
    if (interaction.commandName === 'raid-setup') return setup(interaction);
    if (interaction.commandName !== 'raid') return undefined;
    switch (interaction.options.getSubcommand()) {
      case 'post': return postRun(interaction);
      case 'list': return listRuns(interaction);
      case 'timezone': return setMyTimezone(interaction);
      default: return say(interaction, helpText());
    }
  }

  // ── Signing up ────────────────────────────────────────────────────────────

  async function joinRun(interaction, id, role, bench) {
    // The bench role picker is itself a private message, so its answer
    // replaces it rather than stacking a second one underneath.
    if (bench) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: EPHEMERAL });
    const result = await store.join({
      runId: id, guildId: interaction.guildId, userId: interaction.user.id,
      displayName: displayNameOf(interaction.member, interaction.user), role, bench,
    });
    if (result.changed) posts.refresh(id);
    if (result.promoted) posts.notifyPromotion(result.run, result.promoted);
    return interaction.editReply({ content: render.joinReply(result), components: [], allowedMentions: NO_PINGS });
  }

  async function benchPicker(interaction, id) {
    const run = await store.getRun(id, interaction.guildId);
    if (!run) return say(interaction, "This run doesn't exist any more.");
    if (run.status !== 'open') return say(interaction, 'Signups for this run are closed.');
    return interaction.reply({ ...render.benchPicker(run), flags: EPHEMERAL });
  }

  async function leaveRun(interaction, id) {
    await interaction.deferReply({ flags: EPHEMERAL });
    const result = await store.withdraw({ runId: id, guildId: interaction.guildId, userId: interaction.user.id });
    if (result.removed) posts.refresh(id);
    if (result.promoted) posts.notifyPromotion(result.run, result.promoted);
    return interaction.editReply({ content: render.withdrawReply(result), allowedMentions: NO_PINGS });
  }

  // ── Managing a run ────────────────────────────────────────────────────────

  function editModal(run, tz) {
    const raid = raidOf(run.raid_key) || raids[0];
    const input = (id, label, style, value, { required = true, max = 100 } = {}) => {
      const field = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style)
        .setRequired(required).setMaxLength(max);
      if (value) field.setValue(String(value).slice(0, max));
      return new ActionRowBuilder().addComponents(field);
    };
    return new ModalBuilder().setCustomId(`rd:editform:${run.id}`).setTitle('Edit run').addComponents(
      input('title', 'Title', TextInputStyle.Short, run.title),
      input('when', `Start (${tz})`, TextInputStyle.Short, formatForInput(run.starts_at, tz)),
      input('plan', 'Plan (modes and gates)', TextInputStyle.Short, formatPlan(raid, run.segments)),
      input('notes', 'Notes', TextInputStyle.Paragraph, run.notes, { required: false, max: 500 }),
    );
  }

  async function saveEdit(interaction, id) {
    const run = await managedRun(interaction, id);
    const raid = raidOf(run.raid_key) || raids[0];
    const tz = await store.timezoneFor(interaction.user.id, interaction.guildId);
    const field = (name) => interaction.fields.getTextInputValue(name)?.trim() || '';

    const plan = parsePlan(raid, field('plan'));
    if (!plan.ok) return say(interaction, plan.error);

    // An untouched time keeps the stored one, so a run that has already
    // started can still have its title or notes fixed.
    let startsAt;
    if (field('when') !== formatForInput(run.starts_at, tz.timezone)) {
      const when = parseWhen(field('when'), { timeZone: tz.timezone });
      if (!when.ok) return say(interaction, `${when.error}\n-# Times are read in ${tz.timezone}.`);
      startsAt = when.date;
    }

    await store.updateRun(id, { title: field('title') || run.title, notes: field('notes'), startsAt, segments: plan.segments });
    await posts.renderNow(id);
    return showPanel(interaction, id, '✅ Saved.');
  }

  async function moveMember(interaction, id, userId, to) {
    await managedRun(interaction, id);
    const before = await store.detail(id, interaction.guildId);
    const entry = [...before.going, ...before.bench].find((e) => e.user_id === userId);
    const who = `**${escapeMarkdown(entry?.display_name || 'They')}**`;
    const result = await store.move({ runId: id, guildId: interaction.guildId, userId, to });
    posts.refresh(id);

    let note;
    if (to === 'remove') {
      note = result.removed ? `Removed ${who}.` : "They weren't signed up.";
      if (result.promoted) {
        note += ` **${escapeMarkdown(result.promoted.display_name)}** moved up from the bench.`;
        posts.notifyPromotion(result.run, result.promoted);
      }
    } else if (to === 'going') {
      note = result.changed ? `Moved ${who} into the roster.` : `${who} is already in the roster.`;
      if (result.changed) posts.notifyPromotion(result.run, result.entry);
    } else {
      note = `Moved ${who} to the bench. Their slot is open for you to fill.`;
    }
    return showPanel(interaction, id, note);
  }

  async function addMember(interaction, id, userId, role) {
    const run = await managedRun(interaction, id);
    let name = 'Unknown';
    try {
      const member = await interaction.guild?.members.fetch(userId);
      name = displayNameOf(member, member?.user);
    } catch {
      const user = await client.users.fetch(userId).catch(() => null);
      name = displayNameOf(null, user);
    }
    const result = await store.join({
      runId: id, guildId: interaction.guildId, userId, displayName: name, role, addedBy: interaction.user.id,
    });
    if (result.changed) posts.refresh(id);
    if (result.promoted) posts.notifyPromotion(result.run, result.promoted);

    const who = `**${escapeMarkdown(name)}**`;
    let note;
    if (!result.changed) note = `${who} is already signed up as ${ROLE_EMOJI[role]} ${role}.`;
    else if (result.status === 'going') {
      note = `Added ${who} as ${ROLE_EMOJI[role]} ${role}.`;
      posts.dm(userId, `📋 <@${interaction.user.id}> added you to **${escapeMarkdown(run.title)}** as ${ROLE_EMOJI[role]} **${role}**, starting <t:${unix(run.starts_at)}:R>.`
        + (render.postLink(run) ? `\n${render.postLink(run)}` : ''));
    } else note = `${ROLE_PLURAL[role]} are full, so ${who} is #${result.position} on the bench.`;
    return showPanel(interaction, id, note);
  }

  async function manage(interaction, action, id, a, b) {
    switch (action) {
      case 'manage':
        await managedRun(interaction, id);
        return showPanel(interaction, id);

      case 'edit': {
        const run = await managedRun(interaction, id);
        const tz = await store.timezoneFor(interaction.user.id, interaction.guildId);
        return interaction.showModal(editModal(run, tz.timezone));
      }

      case 'close':
      case 'reopen':
        await managedRun(interaction, id);
        await store.setStatus(id, action === 'close' ? 'closed' : 'open');
        await posts.renderNow(id);
        return showPanel(interaction, id, action === 'close' ? '🔒 Signups closed.' : '🔓 Signups reopened.');

      case 'ping': {
        const run = await managedRun(interaction, id);
        const last = lastPing.get(String(id)) || 0;
        if (Date.now() - last < PING_COOLDOWN_MS) {
          return showPanel(interaction, id, `The roster was pinged <t:${Math.floor(last / 1000)}:R>. Give it a few minutes.`);
        }
        const detail = await store.detail(id, interaction.guildId);
        if (!detail.going.length) return showPanel(interaction, id, 'Nobody is in the roster yet.');
        lastPing.set(String(id), Date.now());
        const sent = await posts.sendToRun(run, render.pingMessage(detail, interaction.user.id));
        return showPanel(interaction, id, sent ? '📣 Pinged the roster.' : "Couldn't send in the run's channel.");
      }

      case 'cancel': {
        const run = await managedRun(interaction, id);
        return interaction.update(render.cancelConfirm(run));
      }

      case 'cancelyes': {
        await managedRun(interaction, id);
        await store.setStatus(id, 'cancelled');
        const detail = await store.detail(id, interaction.guildId);
        await posts.renderNow(id);
        await posts.sendToRun(detail.run, render.cancelMessage(detail, interaction.user.id));
        return showPanel(interaction, id, '🚫 Cancelled, and everyone signed up was pinged.');
      }

      case 'repost': {
        await managedRun(interaction, id);
        await interaction.deferUpdate();
        try {
          const message = await posts.repost(id);
          return showPanel(interaction, id, `Reposted: ${message.url}`);
        } catch (err) {
          return showPanel(interaction, id, `Couldn't repost: ${err.message}`);
        }
      }

      case 'pick': {
        await managedRun(interaction, id);
        const detail = await store.detail(id, interaction.guildId);
        const entry = [...detail.going, ...detail.bench].find((e) => e.user_id === interaction.values?.[0]);
        if (!entry) return showPanel(interaction, id, "They're no longer signed up.");
        return interaction.update({ ...render.memberPanel(detail.run, entry, detail.bench), allowedMentions: NO_PINGS });
      }

      case 'mv':
        if (!['going', 'bench', 'remove'].includes(b)) return undefined;
        return moveMember(interaction, id, a, b);

      case 'add': {
        const run = await managedRun(interaction, id);
        const user = interaction.users?.first();
        if (!user) return showPanel(interaction, id);
        if (user.bot) return showPanel(interaction, id, "Bots can't sign up.");
        const name = displayNameOf(interaction.members?.get(user.id), user);
        return interaction.update({ ...render.addPanel(run, user.id, name), allowedMentions: NO_PINGS });
      }

      case 'addas':
        if (!ROLES.includes(b)) return undefined;
        return addMember(interaction, id, a, b);

      default:
        return undefined;
    }
  }

  async function component(interaction) {
    const [ns, action, id, a, b] = interaction.customId.split(':');
    if (ns !== 'rd' || !id) return undefined;
    switch (action) {
      case 'join': return joinRun(interaction, id, a, false);
      case 'benchas': return joinRun(interaction, id, a, true);
      case 'bench': return benchPicker(interaction, id);
      case 'leave': return leaveRun(interaction, id);
      default: return manage(interaction, action, id, a, b);
    }
  }

  async function modal(interaction) {
    const [ns, action, id] = interaction.customId.split(':');
    if (ns === 'rd' && action === 'editform' && id) return saveEdit(interaction, id);
    return undefined;
  }

  // ── Entry point ───────────────────────────────────────────────────────────

  return async function handle(interaction) {
    try {
      if (!interaction.inGuild()) {
        if (interaction.isRepliable()) await say(interaction, 'Raid signups only work inside a server.');
        return;
      }
      if (interaction.isAutocomplete()) await autocomplete(interaction);
      else if (interaction.isChatInputCommand()) await command(interaction);
      else if (interaction.isButton() || interaction.isAnySelectMenu()) await component(interaction);
      else if (interaction.isModalSubmit()) await modal(interaction);
    } catch (err) {
      const expected = err instanceof RaidError;
      if (!expected) log.error(`Interaction error (${interaction.customId || interaction.commandName}):`, err);
      await say(interaction, expected ? err.message : 'Something went wrong. Try again in a moment.').catch(() => {});
    }
  };
}

module.exports = { createInteractionHandler, helpText, displayNameOf };
