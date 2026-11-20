// The interaction handler end to end, against a real database and fake
// Discord objects: what a click or command stores, and what it answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags, PermissionsBitField, PermissionFlagsBits, Collection } = require('discord.js');
const { skip, freshStore } = require('./helpers/db');
const { createInteractionHandler } = require('../src/interactions');

const KINDS = ['command', 'button', 'select', 'modal', 'autocomplete'];

function fake({
  kind, guildId = 'g1', userId = 'lead', roles = [], perms = [], customId, values, users,
  sub, command = 'raid', strings = {}, channel = null, role = {}, integers = {}, focused, fields = {}, ephemeralMessage = false,
}) {
  assert.ok(KINDS.includes(kind));
  const calls = [];
  const record = (type) => async (payload) => { calls.push({ type, payload }); i[type === 'deferReply' || type === 'deferUpdate' ? 'deferred' : 'replied'] = true; };
  const i = {
    calls, guildId, customId, values, users, commandName: command, deferred: false, replied: false,
    user: { id: userId, username: userId },
    member: { displayName: `${userId}-name`, roles },
    memberPermissions: new PermissionsBitField(perms),
    message: { flags: { has: (f) => ephemeralMessage && f === MessageFlags.Ephemeral } },
    guild: { members: { fetch: async (id) => ({ displayName: `${id}-name`, user: { id } }) } },
    channelId: 'here',
    inGuild: () => !!guildId,
    isAutocomplete: () => kind === 'autocomplete',
    isChatInputCommand: () => kind === 'command',
    isButton: () => kind === 'button',
    isAnySelectMenu: () => kind === 'select',
    isModalSubmit: () => kind === 'modal',
    isRepliable: () => kind !== 'autocomplete',
    reply: record('reply'),
    editReply: record('editReply'),
    followUp: record('followUp'),
    update: record('update'),
    deferReply: record('deferReply'),
    deferUpdate: record('deferUpdate'),
    showModal: async (modal) => calls.push({ type: 'showModal', payload: modal }),
    respond: async (choices) => calls.push({ type: 'respond', payload: choices }),
    options: {
      getSubcommand: () => sub,
      getString: (n) => strings[n] ?? null,
      getChannel: () => channel,
      getRole: (n) => role[n] ?? null,
      getInteger: (n) => integers[n] ?? null,
      getFocused: () => focused,
    },
    fields: { getTextInputValue: (n) => fields[n] ?? '' },
  };
  i.last = () => calls.at(-1);
  i.text = () => {
    const p = calls.filter((c) => c.payload && c.type !== 'deferReply' && c.type !== 'deferUpdate').at(-1)?.payload;
    return typeof p === 'string' ? p : p?.content;
  };
  return i;
}

test('interactions', { skip }, async (t) => {
  const db = await freshStore();
  const { store } = db;
  t.after(() => db.close());

  const sent = [];
  const dms = [];
  const refreshed = [];
  const channelOk = { id: 'c1', isThread: () => false, permissionsFor: () => ({ has: () => true }) };
  const channelNoEmbeds = { id: 'c2', isThread: () => false, permissionsFor: () => ({ has: (f) => f !== PermissionFlagsBits.EmbedLinks }) };
  const posts = {
    fetchChannel: async (id) => ({ c1: channelOk, c2: channelNoEmbeds, here: { ...channelOk, id: 'here' } }[id] || null),
    announce: async (runId) => {
      const run = await store.getRun(runId);
      await store.setMessage(runId, run.channel_id, `msg${runId}`);
      return { url: `https://discord.com/channels/g/${run.channel_id}/msg${runId}` };
    },
    repost: async (runId) => posts.announce(runId),
    refresh: (id) => refreshed.push(String(id)),
    renderNow: async () => {},
    sendToRun: async (run, payload) => { sent.push(payload); return {}; },
    notifyPromotion: async (run, entry) => { dms.push(entry.user_id); },
    dm: async (userId) => { dms.push(userId); return true; },
  };
  const client = { user: { id: 'bot' }, users: { fetch: async (id) => ({ id, username: id }) } };
  const handle = createInteractionHandler({ store, posts, client, log: { error: () => {} } });
  const run = async (opts) => { const i = fake(opts); await handle(i); return i; };

  const post = (strings, extra = {}) => run({ kind: 'command', sub: 'post', strings: { plan: 'normal 1-3', when: 'in 2h', ...strings }, ...extra });
  const latestRun = async (guildId = 'g1') => (await db.pool.query('select * from raid_runs where guild_id = $1 order by id desc limit 1', [guildId])).rows[0];

  await t.test('posting a run stores it, posts it, and signs up the lead', async () => {
    const i = await post({ plan: 'nm 1 + normal', title: 'Tuesday clear', my_role: 'Tank' });
    assert.match(i.text(), /Posted \*\*Tuesday clear\*\*.*https:\/\/discord\.com/);
    assert.match(i.text(), /Set your timezone with `\/raid timezone`/);
    const r = await latestRun();
    assert.deepEqual(r.segments, [{ mode: 'normal', gates: [1, 2, 3] }, { mode: 'nightmare', gates: [1] }]);
    assert.equal(r.channel_id, 'here'); // no raid channel set: where the command was used
    assert.equal(r.message_id, `msg${r.id}`);
    const d = await store.detail(r.id);
    assert.deepEqual(d.going.map((e) => [e.user_id, e.role, e.display_name]), [['lead', 'Tank', 'lead-name']]);
  });

  await t.test('bad input is answered privately and stores nothing', async () => {
    const before = (await latestRun()).id;
    assert.match((await post({ plan: 'normal 7' })).text(), /Gates go from 1 to 3/);
    assert.match((await post({ when: '8' })).text(), /8am or 8pm[\s\S]*read in UTC/);
    const i = await post({}, { channel: { id: 'c2' } });
    assert.match(i.text(), /I need \*\*Embed Links\*\* in <#c2>/);
    assert.equal(i.calls[0].payload.flags, MessageFlags.Ephemeral);
    assert.equal((await latestRun()).id, before);
  });

  await t.test('the server raid channel, poster role and timezone apply', async () => {
    await run({ kind: 'command', command: 'raid-setup', sub: 'set', channel: { id: 'c1' }, role: { poster_role: { id: 'raiders' } }, strings: { timezone: 'est' } });
    const settings = await store.getSettings('g1');
    assert.deepEqual([settings.raid_channel_id, settings.poster_role_id, settings.timezone], ['c1', 'raiders', 'America/New_York']);

    assert.match((await post({}, { userId: 'pleb' })).text(), /Only <@&raiders> can post runs/);
    const ok = await post({}, { userId: 'raider', roles: ['raiders'] });
    assert.match(ok.text(), /the server's timezone/);
    assert.equal((await latestRun()).channel_id, 'c1');

    assert.match((await run({ kind: 'command', command: 'raid-setup', sub: 'set', strings: { timezone: 'Narnia' } })).text(), /isn't a timezone/);
    await run({ kind: 'command', command: 'raid-setup', sub: 'reset', strings: { setting: 'poster_role_id' } });
    assert.equal((await store.getSettings('g1')).poster_role_id, null);
  });

  await t.test('signing up from the post', async () => {
    const r = await latestRun();
    const i = await run({ kind: 'button', customId: `rd:join:${r.id}:Healer`, userId: 'h1' });
    assert.equal(i.calls[0].type, 'deferReply');
    assert.match(i.text(), /You're in as 💚 \*\*Healer\*\* ✅/);
    assert.ok(refreshed.includes(String(r.id)));

    // Bench asks for a role, then answers in place of the question.
    const pick = await run({ kind: 'button', customId: `rd:bench:${r.id}`, userId: 'b1' });
    assert.match(pick.text(), /Bench as which role/);
    const chosen = await run({ kind: 'button', customId: `rd:benchas:${r.id}:DPS`, userId: 'b1', ephemeralMessage: true });
    assert.equal(chosen.calls[0].type, 'deferUpdate');
    assert.match(chosen.text(), /on the bench as ⚔️ \*\*DPS\*\*/);

    const left = await run({ kind: 'button', customId: `rd:leave:${r.id}`, userId: 'h1' });
    assert.match(left.text(), /You're off this run/);
  });

  await t.test("a run can't be reached from another server", async () => {
    const r = await latestRun();
    const i = await run({ kind: 'button', customId: `rd:join:${r.id}:DPS`, guildId: 'elsewhere', userId: 'x' });
    assert.match(i.text(), /doesn't exist any more/);
    assert.equal((await store.detail(r.id)).going.some((e) => e.user_id === 'x'), false);
  });

  await t.test('only the lead, managers and staff can manage', async () => {
    const r = await latestRun();
    assert.match((await run({ kind: 'button', customId: `rd:manage:${r.id}`, userId: 'rando' })).text(), /Only this run's lead/);
    assert.match((await run({ kind: 'button', customId: `rd:cancelyes:${r.id}`, userId: 'rando' })).text(), /Only this run's lead/);
    assert.equal((await store.getRun(r.id)).status, 'open');

    const lead = await run({ kind: 'button', customId: `rd:manage:${r.id}`, userId: r.lead_id });
    assert.equal(lead.last().type, 'reply');
    assert.equal(lead.last().payload.flags, MessageFlags.Ephemeral);
    assert.match(lead.text(), /Managing/);
    const staff = await run({ kind: 'button', customId: `rd:manage:${r.id}`, userId: 'admin', perms: [PermissionFlagsBits.ManageGuild] });
    assert.match(staff.text(), /Managing/);
  });

  await t.test('lead moves, adds and removes people', async () => {
    await post({ plan: 'normal' }, { userId: 'boss' });
    const r = await latestRun();
    for (const u of ['t1', 't2', 't3']) await run({ kind: 'button', customId: `rd:join:${r.id}:Tank`, userId: u });

    const asLead = (opts) => run({ userId: 'boss', ephemeralMessage: true, ...opts });
    const pick = await asLead({ kind: 'select', customId: `rd:pick:${r.id}`, values: ['t2'] });
    assert.match(pick.text(), /\*\*t2-name\*\* · 🛡️ \*\*Tank\*\*, #1 on the bench/);

    dms.length = 0;
    const removed = await asLead({ kind: 'button', customId: `rd:mv:${r.id}:t1:remove` });
    assert.match(removed.text(), /Removed \*\*t1-name\*\*\. \*\*t2-name\*\* moved up from the bench/);
    assert.deepEqual(dms, ['t2']);

    const full = await asLead({ kind: 'button', customId: `rd:mv:${r.id}:t3:going` });
    assert.match(full.text(), /That role is full/);

    const adder = await asLead({ kind: 'select', customId: `rd:add:${r.id}`, users: new Collection([['newbie', { id: 'newbie', username: 'newbie', bot: false }]]) });
    assert.match(adder.text(), /Add \*\*newbie\*\* as:/);
    const added = await asLead({ kind: 'button', customId: `rd:addas:${r.id}:newbie:Healer` });
    assert.match(added.text(), /Added \*\*newbie-name\*\* as 💚 Healer/);
    assert.ok(dms.includes('newbie'));
    assert.equal(added.last().type, 'update');
  });

  await t.test('closing, reopening, pinging and cancelling', async () => {
    const r = await latestRun();
    const asLead = (customId) => run({ kind: 'button', customId, userId: 'boss', ephemeralMessage: true });

    assert.match((await asLead(`rd:close:${r.id}`)).text(), /Signups closed/);
    assert.match((await run({ kind: 'button', customId: `rd:join:${r.id}:DPS`, userId: 'late' })).text(), /closed/);
    assert.match((await asLead(`rd:reopen:${r.id}`)).text(), /Signups reopened/);

    sent.length = 0;
    assert.match((await asLead(`rd:ping:${r.id}`)).text(), /Pinged the roster/);
    assert.match((await asLead(`rd:ping:${r.id}`)).text(), /was pinged/); // cooldown
    assert.equal(sent.length, 1);

    assert.match((await asLead(`rd:cancel:${r.id}`)).text(), /Cancel \*\*Altar of Calanthia\*\*\?/);
    assert.match((await asLead(`rd:cancelyes:${r.id}`)).text(), /Cancelled/);
    assert.equal((await store.getRun(r.id)).status, 'cancelled');
    assert.match(sent.at(-1).content, /was cancelled by <@boss>/);
    assert.ok(sent.at(-1).allowedMentions.users.includes('t2'));
  });

  await t.test('editing keeps an untouched time, even after the start', async () => {
    await post({ title: 'Old' }, { userId: 'ed' });
    const r = await latestRun();
    await db.pool.query("update raid_runs set starts_at = now() - interval '10 minutes', status = 'closed' where id = $1", [r.id]);

    const open = await run({ kind: 'button', customId: `rd:edit:${r.id}`, userId: 'ed', ephemeralMessage: true });
    const modal = open.last().payload.toJSON();
    const when = modal.components[1].components[0];
    assert.match(when.label, /^Start \(America\/New_York\)$/);

    const saved = await run({
      kind: 'modal', customId: `rd:editform:${r.id}`, userId: 'ed', ephemeralMessage: true,
      fields: { title: 'New title', when: when.value, plan: 'nightmare 2', notes: 'bring food' },
    });
    assert.match(saved.text(), /Saved/);
    const after = await store.getRun(r.id);
    assert.deepEqual([after.title, after.notes, after.segments], ['New title', 'bring food', [{ mode: 'nightmare', gates: [2] }]]);
    assert.equal(new Date(after.starts_at).getTime(), new Date((await db.pool.query('select starts_at from raid_runs where id=$1', [r.id])).rows[0].starts_at).getTime());

    const bad = await run({
      kind: 'modal', customId: `rd:editform:${r.id}`, userId: 'ed', ephemeralMessage: true,
      fields: { title: 'x', when: 'yesterday-ish', plan: 'normal' },
    });
    assert.match(bad.text(), /Couldn't read/);
  });

  await t.test('personal timezone, list, help and autocomplete', async () => {
    const tz = await run({ kind: 'command', sub: 'timezone', strings: { zone: 'cet' }, userId: 'tz' });
    assert.match(tz.text(), /now read in \*\*Europe\/Berlin\*\*/);
    assert.equal(await store.getUserTimezone('tz'), 'Europe/Berlin');
    await run({ kind: 'command', sub: 'timezone', strings: { zone: 'server' }, userId: 'tz' });
    assert.equal(await store.getUserTimezone('tz'), null);

    const list = await run({ kind: 'command', sub: 'list' });
    assert.match(list.text(), /Upcoming runs/);
    assert.doesNotMatch(list.text(), /Tuesday clear.*cancelled/);
    assert.match((await run({ kind: 'command', sub: 'help' })).text(), /Raid signups/);
    assert.match((await run({ kind: 'command', sub: 'list', guildId: 'empty' })).text(), /No upcoming runs/);

    const when = await run({ kind: 'autocomplete', focused: { name: 'when', value: 'sat 8pm' } });
    assert.match(when.last().payload[0].name, /^✓ sat 8pm → Sat, .* \(America\/New_York\)$/);
    const plan = await run({ kind: 'autocomplete', focused: { name: 'plan', value: '' } });
    assert.ok(plan.last().payload.length > 3);
    const zone = await run({ kind: 'autocomplete', focused: { name: 'zone', value: '' } });
    assert.equal(zone.last().payload[0].value, 'server');
  });

  await t.test('outside a server', async () => {
    const i = await run({ kind: 'command', sub: 'list', guildId: null });
    assert.match(i.text(), /only work inside a server/);
  });
});
