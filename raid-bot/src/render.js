// Everything the bot shows: the run's post, its buttons, the lead's manage
// panel, and the private replies. Pure functions over database rows, so the
// tests can check what people will see without a Discord connection.
//
// Components are plain API objects rather than discord.js builders, which
// discord.js accepts as-is and which compare cleanly in tests.
const { ButtonStyle, ComponentType, escapeMarkdown } = require('discord.js');
const { ROLES, ROLE_EMOJI, ROLE_PLURAL, raidOf, hardestMode } = require('./catalog');
const { planLines } = require('./plan');
const { unix } = require('./time');

const BENCH_EMOJI = '🪑';
// An embed field caps at 1024 characters; a big bench gets clipped well short.
const FIELD_BUDGET = 900;
const GREY = 0x6b7280;

const hexColor = (hex) => parseInt(String(hex || '').replace('#', ''), 16) || 0x4e5058;
const name = (e) => escapeMarkdown(e.display_name || 'Unknown');

const row = (...components) => ({ type: ComponentType.ActionRow, components });
const button = (customId, label, { style = ButtonStyle.Secondary, emoji, disabled = false } = {}) => ({
  type: ComponentType.Button, custom_id: customId, label, style, disabled,
  ...(emoji ? { emoji: { name: emoji } } : {}),
});

// ── The post ────────────────────────────────────────────────────────────────

function runEmbed({ run, going, bench }) {
  const raid = raidOf(run.raid_key);
  const caps = run.role_caps || raid?.roles || {};
  const at = unix(run.starts_at);
  const cancelled = run.status === 'cancelled';
  const closed = run.status !== 'open';

  const byRole = Object.fromEntries(ROLES.map((r) => [r, []]));
  going.forEach((e) => byRole[e.role]?.push(e));
  const seats = ROLES.reduce((n, r) => n + Number(caps[r] || 0), 0);

  // One column per role with its empty slots drawn in: a missing healer is
  // what people scan the post for.
  const fields = ROLES.filter((r) => caps[r] > 0).map((r) => {
    const cap = Number(caps[r]);
    const open = Math.max(0, cap - byRole[r].length);
    const lines = [...byRole[r].map(name), ...Array.from({ length: open }, () => '◻ *open*')];
    return { name: `${ROLE_EMOJI[r]} ${ROLE_PLURAL[r]} (${byRole[r].length}/${cap})`, value: lines.join('\n') || '—', inline: true };
  });

  if (bench.length) {
    const parts = [];
    let used = 0;
    for (const e of bench) {
      const part = `${ROLE_EMOJI[e.role] || '•'} ${name(e)}${e.bench_kind === 'opt_in' ? ' *(if needed)*' : ''}`;
      if (used + part.length + 3 > FIELD_BUDGET) { parts.push(`…and ${bench.length - parts.length} more`); break; }
      parts.push(part);
      used += part.length + 3;
    }
    fields.push({ name: `${BENCH_EMOJI} Bench (${bench.length})`, value: parts.join(' · ') });
  }

  const plan = planLines(raid, run.segments);
  const notes = run.notes ? `\n\n${run.notes.split('\n').map((l) => `> ${l}`).join('\n')}` : '';
  const footing = cancelled ? '\n\n**This run has been cancelled.**'
    : closed ? '\n\n*Signups are closed.*'
      : "\n\nPick your role below. If it's full you go on the bench and move up when a slot opens.";

  return {
    title: `${cancelled ? '🚫 CANCELLED — ' : '⛩️ '}${run.title}`.slice(0, 256),
    description: `<t:${at}:F> (<t:${at}:R>)\nLed by <@${run.lead_id}>`
      + (plan.length ? `\n\n${plan.join('\n')}` : '')
      + notes
      + `\n\n**${going.length}/${seats}** filled${bench.length ? ` · ${bench.length} on the bench` : ''}`
      + footing,
    color: cancelled ? GREY : hexColor(hardestMode(run.raid_key, run.segments)?.color),
    fields,
    footer: { text: `${raid?.name || 'Raid'} · Run #${run.id}` },
  };
}

function runButtons(run) {
  const id = run.id;
  if (run.status === 'cancelled') return [];
  const manage = button(`rd:manage:${id}`, 'Manage', { emoji: '⚙️' });
  const leave = button(`rd:leave:${id}`, 'Withdraw');
  if (run.status !== 'open') return [row(leave, manage)];
  const caps = run.role_caps || {};
  return [
    row(
      ...ROLES.filter((r) => caps[r] > 0).map((r) => button(`rd:join:${id}:${r}`, r, { emoji: ROLE_EMOJI[r] })),
      button(`rd:bench:${id}`, 'Bench', { emoji: BENCH_EMOJI, style: ButtonStyle.Primary }),
      leave,
    ),
    row(manage),
  ];
}

const runMessage = (detail) => ({ embeds: [runEmbed(detail)], components: runButtons(detail.run) });

// "Bench as which role?", so the bench always knows what it holds.
function benchPicker(run) {
  const caps = run.role_caps || {};
  return {
    content: 'Bench as which role? The lead can bring you in if they need you.',
    components: [row(...ROLES.filter((r) => caps[r] > 0)
      .map((r) => button(`rd:benchas:${run.id}:${r}`, r, { emoji: ROLE_EMOJI[r] })))],
  };
}

// ── Private replies ─────────────────────────────────────────────────────────

const roleText = (role) => `${ROLE_EMOJI[role] || ''} **${role}**`;

function joinReply(result) {
  const role = roleText(result.role);
  const moved = result.promoted
    ? `\n**${escapeMarkdown(result.promoted.display_name)}** moved up from the bench into your old ${result.promoted.role} slot.`
    : '';
  if (!result.changed) {
    if (result.status === 'going') return `You're already in as ${role}.`;
    if (result.benchKind === 'overflow') return `You're already **#${result.position}** on the bench for ${role}.`;
    return `You're already on the bench as ${role}.`;
  }
  if (result.status === 'going') return `You're in as ${role} ✅${moved}`;
  if (result.benchKind === 'overflow') {
    return `**${ROLE_PLURAL[result.role]}** are full, so you're **#${result.position}** on the bench for ${role}.`
      + ` You'll be moved up and DM'd if a slot opens.${moved}`;
  }
  return `You're on the bench as ${role}, available if needed. The lead can bring you in.${moved}`;
}

function withdrawReply(result) {
  if (!result.removed) return "You weren't signed up for this one.";
  const moved = result.promoted
    ? ` **${escapeMarkdown(result.promoted.display_name)}** moved up from the bench into your slot.`
    : '';
  return `You're off this run.${moved}`;
}

const promotionDm = (run, entry, guildName) => `✅ A slot opened up. You're in for **${escapeMarkdown(run.title)}**`
  + `${guildName ? ` in **${escapeMarkdown(guildName)}**` : ''} as ${roleText(entry.role)}, starting <t:${unix(run.starts_at)}:R>.`;

const postLink = (run) => (run.message_id
  ? `https://discord.com/channels/${run.guild_id}/${run.channel_id}/${run.message_id}` : null);

// ── The lead's panel ────────────────────────────────────────────────────────

function entryLabel(e, benchOrder) {
  if (e.status === 'going') return `${e.role} · in`;
  if (e.bench_kind === 'overflow') return `${e.role} · bench #${benchOrder.get(e.user_id)}`;
  return `${e.role} · bench (if needed)`;
}

// Overflow position per person within their role, for labels.
function benchOrder(bench) {
  const seen = {};
  const order = new Map();
  for (const e of bench) {
    if (e.bench_kind !== 'overflow') continue;
    seen[e.role] = (seen[e.role] || 0) + 1;
    order.set(e.user_id, seen[e.role]);
  }
  return order;
}

function managePanel({ run, going, bench }) {
  const at = unix(run.starts_at);
  const head = `**Managing ${escapeMarkdown(run.title)}** · run #${run.id}\n<t:${at}:F> (<t:${at}:R>)`;
  if (run.status === 'cancelled') return { content: `${head}\n\nThis run was cancelled.`, components: [] };

  const id = run.id;
  const rows = [row(
    button(`rd:edit:${id}`, 'Edit', { emoji: '✏️' }),
    run.status === 'open'
      ? button(`rd:close:${id}`, 'Close signups', { emoji: '🔒' })
      : button(`rd:reopen:${id}`, 'Reopen signups', { emoji: '🔓' }),
    button(`rd:ping:${id}`, 'Ping roster', { emoji: '📣', disabled: going.length === 0 }),
    button(`rd:repost:${id}`, 'Repost', { emoji: '🔁' }),
    button(`rd:cancel:${id}`, 'Cancel run', { emoji: '🚫', style: ButtonStyle.Danger }),
  )];

  const everyone = [...going, ...bench];
  if (everyone.length) {
    const order = benchOrder(bench);
    rows.push(row({
      type: ComponentType.StringSelect,
      custom_id: `rd:pick:${id}`,
      placeholder: 'Move or remove someone…',
      options: everyone.slice(0, 25).map((e) => ({
        label: (e.display_name || 'Unknown').slice(0, 100),
        description: entryLabel(e, order),
        value: e.user_id,
        emoji: { name: e.status === 'going' ? ROLE_EMOJI[e.role] : BENCH_EMOJI },
      })),
    }));
  }
  rows.push(row({ type: ComponentType.UserSelect, custom_id: `rd:add:${id}`, placeholder: 'Add someone to this run…' }));

  const status = run.status === 'open' ? 'Signups open' : 'Signups closed';
  const more = everyone.length > 25 ? `\n*The list shows the first 25 of ${everyone.length}.*` : '';
  return { content: `${head}\n${status} · ${going.length} in · ${bench.length} on the bench${more}`, components: rows };
}

function memberPanel(run, entry, benchList) {
  const id = run.id;
  const where = entry.status === 'going' ? 'in the roster'
    : entry.bench_kind === 'overflow' ? `#${benchOrder(benchList).get(entry.user_id)} on the bench`
      : 'on the bench (if needed)';
  return {
    content: `**${escapeMarkdown(entry.display_name)}** · ${roleText(entry.role)}, ${where}.`,
    components: [row(
      button(`rd:mv:${id}:${entry.user_id}:going`, 'Into roster', { emoji: '⬆️', disabled: entry.status === 'going' }),
      button(`rd:mv:${id}:${entry.user_id}:bench`, 'To bench', {
        emoji: BENCH_EMOJI, disabled: entry.status === 'bench' && entry.bench_kind === 'opt_in',
      }),
      button(`rd:mv:${id}:${entry.user_id}:remove`, 'Remove', { emoji: '✖️', style: ButtonStyle.Danger }),
      button(`rd:manage:${id}`, 'Back'),
    )],
  };
}

function addPanel(run, userId, displayName) {
  const caps = run.role_caps || {};
  return {
    content: `Add **${escapeMarkdown(displayName)}** as:`,
    components: [row(
      ...ROLES.filter((r) => caps[r] > 0).map((r) => button(`rd:addas:${run.id}:${userId}:${r}`, r, { emoji: ROLE_EMOJI[r] })),
      button(`rd:manage:${run.id}`, 'Back'),
    )],
  };
}

const cancelConfirm = (run) => ({
  content: `Cancel **${escapeMarkdown(run.title)}**? Everyone signed up is pinged, and this can't be undone.`,
  components: [row(
    button(`rd:cancelyes:${run.id}`, 'Yes, cancel it', { style: ButtonStyle.Danger }),
    button(`rd:manage:${run.id}`, 'Keep it'),
  )],
});

// ── Channel messages ────────────────────────────────────────────────────────

const mentions = (entries) => entries.map((e) => `<@${e.user_id}>`).join(' ');

function reminderMessage({ run, going }) {
  return {
    content: `⏰ **${escapeMarkdown(run.title)}** starts <t:${unix(run.starts_at)}:R>.`
      + (going.length ? `\n${mentions(going)}` : '\nNobody is in the roster yet.'),
    allowedMentions: { users: going.slice(0, 100).map((e) => e.user_id) },
  };
}

function cancelMessage({ run, going, bench }, byId) {
  const everyone = [...going, ...bench];
  return {
    content: `🚫 **${escapeMarkdown(run.title)}** (<t:${unix(run.starts_at)}:F>) was cancelled by <@${byId}>.`
      + (everyone.length ? `\n${mentions(everyone)}` : ''),
    allowedMentions: { users: everyone.slice(0, 100).map((e) => e.user_id) },
  };
}

function pingMessage({ run, going }, byId) {
  return {
    content: `📣 <@${byId}> is calling the roster for **${escapeMarkdown(run.title)}** (<t:${unix(run.starts_at)}:R>).\n${mentions(going)}`,
    allowedMentions: { users: going.slice(0, 100).map((e) => e.user_id) },
  };
}

module.exports = {
  runEmbed, runButtons, runMessage, benchPicker,
  joinReply, withdrawReply, promotionDm, postLink,
  managePanel, memberPanel, addPanel, cancelConfirm,
  reminderMessage, cancelMessage, pingMessage,
};
