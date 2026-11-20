const test = require('node:test');
const assert = require('node:assert/strict');
const render = require('../src/render');
const { canPost, canManage } = require('../src/permissions');
const { PermissionsBitField, PermissionFlagsBits } = require('discord.js');

const run = (over = {}) => ({
  id: '42', guild_id: 'g1', channel_id: 'c1', message_id: 'm1', raid_key: 'altar_of_calanthia',
  segments: [{ mode: 'normal', gates: [1, 2, 3] }, { mode: 'nightmare', gates: [1] }],
  role_caps: { Tank: 1, DPS: 9, Healer: 2 }, title: 'Altar of Calanthia', notes: null,
  starts_at: new Date('2026-11-21T01:00:00Z'), lead_id: 'lead', status: 'open', ...over,
});
const entry = (user, role, status = 'going', benchKind = null, name = user) => ({
  user_id: user, display_name: name, role, status, bench_kind: benchKind,
});
const customIds = (rows) => rows.flatMap((r) => r.components.map((c) => c.custom_id));

test('the post draws every slot and the bench', () => {
  const embed = render.runEmbed({
    run: run({ notes: 'Bring pots\nVoice: Raid 1' }),
    going: [entry('a', 'Tank'), entry('b', 'DPS', 'going', null, 'Under_score*')],
    bench: [entry('c', 'Tank', 'bench', 'overflow'), entry('d', 'Healer', 'bench', 'opt_in')],
  });
  assert.equal(embed.title, '⛩️ Altar of Calanthia');
  assert.match(embed.description, /<t:1795222800:F>/);
  assert.match(embed.description, /Led by <@lead>/);
  assert.match(embed.description, /🟢 \*\*Normal\*\* · Gates 1–3\n🔴 \*\*Nightmare\*\* · Gate 1/);
  assert.match(embed.description, /> Bring pots\n> Voice: Raid 1/);
  assert.match(embed.description, /\*\*2\/12\*\* filled · 2 on the bench/);
  assert.equal(embed.color, 0xd83c55); // hardest mode in the plan

  const [tanks, dps, healers, bench] = embed.fields;
  assert.equal(tanks.name, '🛡️ Tanks (1/1)');
  assert.equal(tanks.value, 'a');
  assert.equal(dps.name, '⚔️ DPS (1/9)');
  assert.equal(dps.value.split('\n').length, 9);
  assert.match(dps.value, /^Under\\_score\\\*/); // names can't break the markdown
  assert.equal(healers.value, '◻ *open*\n◻ *open*');
  assert.equal(bench.name, '🪑 Bench (2)');
  assert.equal(bench.value, '🛡️ c · 💚 d *(if needed)*');
  assert.equal(embed.footer.text, 'Altar of Calanthia · Run #42');
});

test('a huge bench is clipped under the field limit', () => {
  const bench = Array.from({ length: 200 }, (_, i) => entry(`u${i}`, 'DPS', 'bench', 'overflow', `Player number ${i}`));
  const field = render.runEmbed({ run: run(), going: [], bench }).fields.at(-1);
  assert.ok(field.value.length <= 1024);
  assert.match(field.value, /…and \d+ more$/);
});

test('buttons follow the run status', () => {
  assert.deepEqual(customIds(render.runButtons(run())), [
    'rd:join:42:Tank', 'rd:join:42:DPS', 'rd:join:42:Healer', 'rd:bench:42', 'rd:leave:42', 'rd:manage:42',
  ]);
  assert.deepEqual(customIds(render.runButtons(run({ status: 'closed' }))), ['rd:leave:42', 'rd:manage:42']);
  assert.deepEqual(render.runButtons(run({ status: 'cancelled' })), []);
  const cancelled = render.runEmbed({ run: run({ status: 'cancelled' }), going: [], bench: [] });
  assert.match(cancelled.title, /^🚫 CANCELLED/);
  assert.equal(cancelled.color, 0x6b7280);
  // Every customId fits Discord's 100 characters, even with the longest ids.
  const long = run({ id: '9223372036854775807' });
  for (const id of customIds(render.runButtons(long))) assert.ok(id.length <= 100);
});

test('join replies', () => {
  assert.equal(render.joinReply({ changed: true, status: 'going', role: 'Tank' }), "You're in as 🛡️ **Tank** ✅");
  assert.match(render.joinReply({ changed: true, status: 'bench', benchKind: 'overflow', position: 2, role: 'Healer' }),
    /\*\*Healers\*\* are full, so you're \*\*#2\*\* on the bench/);
  assert.match(render.joinReply({ changed: true, status: 'bench', benchKind: 'opt_in', role: 'DPS' }), /available if needed/);
  assert.equal(render.joinReply({ changed: false, status: 'going', role: 'DPS' }), "You're already in as ⚔️ **DPS**.");
  assert.match(render.joinReply({
    changed: true, status: 'going', role: 'DPS', promoted: { display_name: 'Zed', role: 'Tank' },
  }), /\*\*Zed\*\* moved up from the bench into your old Tank slot/);
});

test('manage panel lists people with where they stand', () => {
  const panel = render.managePanel({
    run: run(),
    going: [entry('a', 'Tank')],
    bench: [entry('b', 'Tank', 'bench', 'overflow'), entry('c', 'Tank', 'bench', 'overflow'), entry('d', 'DPS', 'bench', 'opt_in')],
  });
  const [buttons, picker, adder] = panel.components;
  assert.deepEqual(buttons.components.map((c) => c.custom_id), ['rd:edit:42', 'rd:close:42', 'rd:ping:42', 'rd:repost:42', 'rd:cancel:42']);
  assert.deepEqual(picker.components[0].options.map((o) => o.description), [
    'Tank · in', 'Tank · bench #1', 'Tank · bench #2', 'DPS · bench (if needed)',
  ]);
  assert.equal(adder.components[0].custom_id, 'rd:add:42');
  assert.match(panel.content, /1 in · 3 on the bench/);

  const closed = render.managePanel({ run: run({ status: 'closed' }), going: [], bench: [] });
  assert.equal(closed.components[0].components[1].custom_id, 'rd:reopen:42');
  assert.equal(closed.components[0].components[2].disabled, true); // nobody to ping
  assert.equal(closed.components.length, 2); // no picker when nobody is signed up
  assert.deepEqual(render.managePanel({ run: run({ status: 'cancelled' }), going: [], bench: [] }).components, []);
});

test('reminders and cancellations ping exactly who they name', () => {
  const going = [entry('a', 'Tank'), entry('b', 'DPS')];
  const bench = [entry('c', 'DPS', 'bench', 'overflow')];
  const reminder = render.reminderMessage({ run: run(), going });
  assert.deepEqual(reminder.allowedMentions.users, ['a', 'b']);
  assert.match(reminder.content, /<@a> <@b>/);
  const cancel = render.cancelMessage({ run: run(), going, bench }, 'lead');
  assert.deepEqual(cancel.allowedMentions.users, ['a', 'b', 'c']);
  assert.match(cancel.content, /cancelled by <@lead>/);
});

test('posting: anyone, unless a poster role is set', () => {
  const none = new PermissionsBitField();
  const staff = new PermissionsBitField(PermissionFlagsBits.ManageEvents);
  const open = { poster_role_id: null, manager_role_id: null };
  const limited = { poster_role_id: 'raiders', manager_role_id: 'officers' };
  assert.equal(canPost({ member: { roles: [] }, perms: none, settings: open }), true);
  assert.equal(canPost({ member: { roles: [] }, perms: none, settings: limited }), false);
  assert.equal(canPost({ member: { roles: ['raiders'] }, perms: none, settings: limited }), true);
  assert.equal(canPost({ member: { roles: ['officers'] }, perms: none, settings: limited }), true);
  assert.equal(canPost({ member: { roles: [] }, perms: staff, settings: limited }), true);
  // A cached GuildMember keeps its roles in a collection.
  const cached = { roles: { cache: new Map([['raiders', {}]]) } };
  assert.equal(canPost({ member: cached, perms: none, settings: limited }), true);
});

test('managing: the lead, the manager role, or server staff', () => {
  const none = new PermissionsBitField();
  const settings = { manager_role_id: 'officers' };
  const r = run();
  assert.equal(canManage({ userId: 'lead', member: { roles: [] }, perms: none, settings, run: r }), true);
  assert.equal(canManage({ userId: 'x', member: { roles: [] }, perms: none, settings, run: r }), false);
  assert.equal(canManage({ userId: 'x', member: { roles: ['officers'] }, perms: none, settings, run: r }), true);
  assert.equal(canManage({ userId: 'x', member: { roles: [] }, perms: new PermissionsBitField(PermissionFlagsBits.ManageGuild), settings, run: r }), true);
  assert.equal(canManage({ userId: 'x', member: { roles: ['officers'] }, perms: none, settings: { manager_role_id: null }, run: r }), false);
});
