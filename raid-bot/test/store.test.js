const test = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshStore } = require('./helpers/db');
const { migrate } = require('../src/migrate');

const CAPS = { Tank: 1, DPS: 9, Healer: 2 };
const HOUR = 3_600_000;

test('store', { skip }, async (t) => {
  const db = await freshStore();
  const { store } = db;
  t.after(() => db.close());

  const newRun = (over = {}) => store.createRun({
    guildId: 'g1', channelId: 'c1', raidKey: 'altar_of_calanthia',
    segments: [{ mode: 'normal', gates: [1, 2, 3] }], roleCaps: CAPS,
    title: 'Altar', startsAt: new Date(Date.now() + 24 * HOUR), leadId: 'lead', ...over,
  });
  const join = (run, userId, role, extra = {}) => store.join({ runId: run.id, userId, displayName: userId, role, ...extra });
  const where = async (run) => {
    const d = await store.detail(run.id);
    return {
      going: d.going.map((e) => `${e.user_id}:${e.role}`),
      bench: d.bench.map((e) => `${e.user_id}:${e.role}:${e.bench_kind}`),
    };
  };

  await t.test('migrations are safe to run again', async () => {
    await migrate(db.pool, { log: () => {} });
  });

  await t.test('a full role sends people to the bench, in order', async () => {
    const run = await newRun();
    assert.equal((await join(run, 'a', 'Tank')).status, 'going');
    const b = await join(run, 'b', 'Tank');
    assert.deepEqual([b.status, b.benchKind, b.position], ['bench', 'overflow', 1]);
    const c = await join(run, 'c', 'Tank');
    assert.equal(c.position, 2);
    assert.deepEqual(await where(run), { going: ['a:Tank'], bench: ['b:Tank:overflow', 'c:Tank:overflow'] });
  });

  await t.test('clicking again changes nothing and keeps your place', async () => {
    const run = await newRun();
    await join(run, 'a', 'Tank');
    await join(run, 'b', 'Tank');
    await join(run, 'c', 'Tank');
    const again = await join(run, 'b', 'Tank');
    assert.deepEqual([again.changed, again.position], [false, 1]);
    assert.equal((await join(run, 'a', 'Tank')).changed, false);
  });

  await t.test('withdrawing moves the next overflow person up', async () => {
    const run = await newRun();
    await join(run, 'a', 'Tank');
    await join(run, 'b', 'Tank', { bench: true }); // opt-in: only the lead moves them up
    await join(run, 'c', 'Tank');
    const left = await store.withdraw({ runId: run.id, userId: 'a' });
    assert.equal(left.removed, true);
    assert.equal(left.promoted.user_id, 'c');
    assert.deepEqual(await where(run), { going: ['c:Tank'], bench: ['b:Tank:opt_in'] });
    assert.equal((await store.withdraw({ runId: run.id, userId: 'nobody' })).removed, false);
  });

  await t.test('switching role frees the old slot for the bench', async () => {
    const run = await newRun();
    await join(run, 'a', 'Tank');
    await join(run, 'b', 'Tank');
    const moved = await join(run, 'a', 'Healer');
    assert.equal(moved.status, 'going');
    assert.equal(moved.promoted.user_id, 'b');
    assert.deepEqual(await where(run), { going: ['b:Tank', 'a:Healer'], bench: [] });
  });

  await t.test('going from roster to bench yourself frees the slot too', async () => {
    const run = await newRun();
    await join(run, 'a', 'Tank');
    await join(run, 'b', 'Tank');
    const benched = await join(run, 'a', 'Tank', { bench: true });
    assert.deepEqual([benched.status, benched.benchKind], ['bench', 'opt_in']);
    assert.equal(benched.promoted.user_id, 'b');
  });

  await t.test('the last slot goes to exactly one of many at once', async () => {
    const run = await newRun();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => join(run, `u${i}`, 'Tank')));
    assert.equal(results.filter((r) => r.status === 'going').length, 1);
    assert.deepEqual(results.filter((r) => r.status === 'bench').map((r) => r.position).sort(), [1, 2, 3, 4, 5, 6, 7]);
    const d = await store.detail(run.id);
    assert.equal(d.going.length, 1);
    assert.equal(d.bench.length, 7);
  });

  await t.test('lead moves: into a full role is refused, to the bench leaves the slot open', async () => {
    const run = await newRun();
    await join(run, 'a', 'Tank');
    await join(run, 'b', 'Tank');
    await assert.rejects(store.move({ runId: run.id, userId: 'b', to: 'going' }), { code: 'role_full' });
    await store.move({ runId: run.id, userId: 'a', to: 'bench' });
    assert.deepEqual(await where(run), { going: [], bench: ['b:Tank:overflow', 'a:Tank:opt_in'] });
    await store.move({ runId: run.id, userId: 'b', to: 'going' });
    const removed = await store.move({ runId: run.id, userId: 'b', to: 'remove' });
    assert.equal(removed.removed, true);
    assert.equal(removed.promoted, null); // a is opt-in; nobody is waiting for the slot
    await assert.rejects(store.move({ runId: run.id, userId: 'zz', to: 'going' }), { code: 'not_signed_up' });
  });

  await t.test('closed runs refuse members but not the lead; cancelled refuses everyone', async () => {
    const run = await newRun();
    await store.setStatus(run.id, 'closed');
    await assert.rejects(join(run, 'a', 'DPS'), { code: 'closed' });
    assert.equal((await join(run, 'a', 'DPS', { addedBy: 'lead' })).status, 'going');
    await store.setStatus(run.id, 'open');
    await store.setStatus(run.id, 'cancelled');
    await assert.rejects(join(run, 'b', 'DPS', { addedBy: 'lead' }), { code: 'cancelled' });
    await assert.rejects(store.setStatus(run.id, 'open'), { code: 'cancelled' });
  });

  await t.test('a started run cannot be reopened', async () => {
    const run = await newRun({ startsAt: new Date(Date.now() - HOUR) });
    await store.setStatus(run.id, 'closed');
    await assert.rejects(store.setStatus(run.id, 'open'), { code: 'started' });
  });

  await t.test('bad roles and other servers are refused', async () => {
    const run = await newRun();
    await assert.rejects(join(run, 'a', 'Bard'), { code: 'bad_role' });
    await assert.rejects(store.join({ runId: run.id, guildId: 'g2', userId: 'a', displayName: 'a', role: 'DPS' }), { code: 'not_found' });
    await assert.rejects(store.withdraw({ runId: run.id, guildId: 'g2', userId: 'a' }), { code: 'not_found' });
    assert.equal(await store.getRun(run.id, 'g2'), null);
    assert.equal(await store.getRun('not-a-number'), null);
    await assert.rejects(store.detail(run.id, 'g2'), { code: 'not_found' });
  });

  await t.test('reminders: once, not for runs posted inside the window, re-armed by a new time', async () => {
    const now = new Date();
    const soon = await newRun({ guildId: 'gr', startsAt: new Date(now.getTime() + 10 * 60_000) });
    await db.pool.query("update raid_runs set created_at = now() - interval '1 day', message_id = 'm' where id = $1", [soon.id]);
    const late = await newRun({ guildId: 'gr', startsAt: new Date(now.getTime() + 10 * 60_000) }); // posted 10 min before
    await db.pool.query("update raid_runs set message_id = 'm' where id = $1", [late.id]);
    const far = await newRun({ guildId: 'gr', startsAt: new Date(now.getTime() + 3 * HOUR) });
    await db.pool.query("update raid_runs set created_at = now() - interval '1 day', message_id = 'm' where id = $1", [far.id]);

    const first = (await store.claimReminders(now)).filter((r) => r.guild_id === 'gr').map((r) => r.id);
    assert.deepEqual(first, [soon.id]);
    assert.deepEqual((await store.claimReminders(now)).filter((r) => r.guild_id === 'gr'), []);

    await store.updateRun(soon.id, { startsAt: new Date(now.getTime() + 12 * 60_000) });
    assert.deepEqual((await store.claimReminders(now)).map((r) => r.id), [soon.id]);

    // A server can turn reminders off, or lengthen them.
    await store.updateSettings('gr', { reminder_minutes: 0 });
    await store.updateRun(soon.id, { startsAt: new Date(now.getTime() + 14 * 60_000) });
    assert.deepEqual((await store.claimReminders(now)).filter((r) => r.guild_id === 'gr'), []);
    await store.updateSettings('gr', { reminder_minutes: 240 });
    assert.deepEqual((await store.claimReminders(now)).map((r) => r.id).sort(), [soon.id, far.id].sort());
  });

  await t.test('started runs close; old runs are purged with their signups', async () => {
    const started = await newRun({ guildId: 'gs', startsAt: new Date(Date.now() - 60_000) });
    const old = await newRun({ guildId: 'gs', startsAt: new Date(Date.now() - 40 * 24 * HOUR) });
    await join(old, 'a', 'DPS', { addedBy: 'lead' });
    const closed = await store.closeStarted();
    assert.ok(closed.some((r) => r.id === started.id));
    assert.equal((await store.getRun(started.id)).status, 'closed');
    assert.ok(await store.purgeOld() >= 1);
    assert.equal(await store.getRun(old.id), null);
    const { rows } = await db.pool.query('select count(*)::int as n from raid_entries where run_id = $1', [old.id]);
    assert.equal(rows[0].n, 0);
    assert.ok(await store.getRun(started.id));
  });

  await t.test('editing a run', async () => {
    const run = await newRun({ notes: 'old' });
    const edited = await store.updateRun(run.id, { title: 'New', notes: '', segments: [{ mode: 'nightmare', gates: [1] }] });
    assert.equal(edited.title, 'New');
    assert.equal(edited.notes, null);
    assert.deepEqual(edited.segments, [{ mode: 'nightmare', gates: [1] }]);
    assert.equal(new Date(edited.starts_at).getTime(), new Date(run.starts_at).getTime());
  });

  await t.test('listing a server shows only its own upcoming runs', async () => {
    const mine = await newRun({ guildId: 'gl' });
    await join(mine, 'a', 'Tank');
    await join(mine, 'b', 'Tank');
    await newRun({ guildId: 'other' });
    const cancelled = await newRun({ guildId: 'gl' });
    await store.setStatus(cancelled.id, 'cancelled');
    const list = await store.listUpcoming('gl');
    assert.deepEqual(list.map((r) => r.id), [mine.id]);
    assert.deepEqual([list[0].going_count, list[0].bench_count], [1, 1]);
  });

  await t.test('settings and timezones', async () => {
    assert.deepEqual(await store.timezoneFor('u1', 'gt'), { timezone: 'UTC', source: 'default' });
    await store.updateSettings('gt', { timezone: 'Europe/Berlin', raid_channel_id: 'c9' });
    assert.deepEqual(await store.timezoneFor('u1', 'gt'), { timezone: 'Europe/Berlin', source: 'server' });
    await store.setUserTimezone('u1', 'America/Chicago');
    assert.deepEqual(await store.timezoneFor('u1', 'gt'), { timezone: 'America/Chicago', source: 'user' });
    await store.setUserTimezone('u1', null);
    assert.equal(await store.getUserTimezone('u1'), null);

    const s = await store.updateSettings('gt', { reminder_minutes: 30 });
    assert.deepEqual([s.raid_channel_id, s.timezone, s.reminder_minutes], ['c9', 'Europe/Berlin', 30]);
    const reset = await store.updateSettings('gt', { reminder_minutes: null, raid_channel_id: null });
    assert.deepEqual([reset.raid_channel_id, reset.timezone, reset.reminder_minutes], [null, 'Europe/Berlin', 15]);
    assert.equal((await store.getSettings('never-set')).reminder_minutes, 15);
  });

  await t.test('leaving a server deletes everything it owned', async () => {
    const run = await newRun({ guildId: 'gone' });
    await join(run, 'a', 'DPS');
    await store.updateSettings('gone', { timezone: 'UTC' });
    const kept = await newRun({ guildId: 'stays' });
    await store.deleteGuild('gone');
    assert.equal(await store.getRun(run.id), null);
    const { rows } = await db.pool.query("select count(*)::int as n from guild_settings where guild_id = 'gone'");
    assert.equal(rows[0].n, 0);
    assert.ok(await store.getRun(kept.id));
  });
});
