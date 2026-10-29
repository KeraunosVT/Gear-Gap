// backend/test/builds.test.js — PvE and PvP builds read from screenshots.
//
// The model is not under test here; what it hands back is. interpretReading is
// where a misread turns into a flag a member can see instead of a wrong number
// stored quietly, and save() decides what "Last updated" and the history say.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const createBuilds = require('../builds');
const { interpretReading, cleanStats, cleanFlags, diffStats, buildPrompt, SCHEMA } = createBuilds;
const STATS = require('../../shared/buildStats.json');

describe('the shared stat list', () => {
  test('every id is unique', () => {
    const ids = STATS.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('the prompt and the schema both cover every stat', () => {
    const prompt = buildPrompt();
    for (const { id } of STATS) assert.ok(prompt.includes(`- ${id}:`), `${id} missing from the prompt`);
    assert.deepEqual(SCHEMA.properties.stats.items.properties.id.enum, STATS.map((s) => s.id));
  });
});

describe('interpretReading', () => {
  test('keeps what was read and lists what wasn\'t', () => {
    const { stats, flags, missing } = interpretReading([
      { id: 'melee_armor', value: 4175, unsure: false },
      { id: 'skill_cooldown_modifier', value: 96.5, unsure: false },
    ]);
    assert.deepEqual(stats, { melee_armor: 4175, skill_cooldown_modifier: 96.5 });
    assert.deepEqual(flags, {});
    assert.equal(missing.length, STATS.length - 2);
    assert.ok(!missing.includes('melee_armor'));
  });

  test('the same stat read twice and agreeing is fine', () => {
    // The two combat screenshots overlap by a row.
    const { stats, flags } = interpretReading([
      { id: 'range_double_attack', value: 327, unsure: true },
      { id: 'range_double_attack', value: 327, unsure: false },
    ]);
    assert.equal(stats.range_double_attack, 327);
    // The first read was unsure, and nothing since says it was wrong.
    assert.ok(flags.range_double_attack);
  });

  test('the same stat read twice and disagreeing is flagged, first value kept', () => {
    const { stats, flags } = interpretReading([
      { id: 'range_double_attack', value: 327, unsure: false },
      { id: 'range_double_attack', value: 321, unsure: false },
    ]);
    assert.equal(stats.range_double_attack, 327);
    assert.match(flags.range_double_attack, /327 and 321/);
  });

  test('a negative where the game never shows one is flagged', () => {
    // The real one: Boss Melee Heavy Attack Chance read as -7 beside two 17s.
    const { stats, flags } = interpretReading([{ id: 'boss_melee_double_attack', value: -7, unsure: false }]);
    assert.equal(stats.boss_melee_double_attack, -7);
    assert.match(flags.boss_melee_double_attack, /isn't normally negative/);
  });

  test('a negative on a stat that is negative is not', () => {
    const { flags } = interpretReading([
      { id: 'debuff_taken_duration_modifier', value: -31.81, unsure: false },
      { id: 'pvp_damage_taken_modifier', value: -10, unsure: false },
    ]);
    assert.deepEqual(flags, {});
  });

  test('unknown ids and non-numbers are dropped', () => {
    const { stats } = interpretReading([
      { id: 'not_a_stat', value: 1, unsure: false },
      { id: 'hp_max', value: 'lots', unsure: false },
      null,
    ]);
    assert.deepEqual(stats, {});
  });
});

describe('cleaning and diffing', () => {
  test('cleanStats keeps known stats as numbers and drops the rest', () => {
    assert.deepEqual(
      cleanStats({ hp_max: '33,552', hp_regen: 2596.4, nope: 3, cost_max: 'x', move_speed: 0.1 + 0.2 }),
      { hp_max: 33552, hp_regen: 2596.4, move_speed: 0.3 },
    );
  });

  test('cleanFlags keeps notes only for stats the build has', () => {
    assert.deepEqual(cleanFlags({ hp_max: ' check ', cost_max: 'gone', hp_regen: '' }, { hp_max: 1, hp_regen: 2 }), { hp_max: 'check' });
  });

  test('diffStats reports changes, additions and removals in catalog order', () => {
    const changes = diffStats({ hp_max: 100, cost_max: 50, move_speed: 762 }, { hp_max: 120, cost_max: 50, stamina_max: 100 });
    assert.deepEqual(changes, [
      { id: 'hp_max', from: 100, to: 120 },
      { id: 'stamina_max', from: null, to: 100 },
      { id: 'move_speed', from: 762, to: null },
    ]);
  });
});

// Just enough PostgREST for builds.save and setKeyStats.
function fakeSupabase(existing = null) {
  const state = { build: existing, upserts: [], history: [], keyStats: [] };
  const api = {
    from(table) {
      if (table === 'builds') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: state.build, error: null }) }) }) }),
          upsert: (row) => { state.upserts.push(row); state.build = row; return Promise.resolve({ error: null }); },
        };
      }
      if (table === 'build_history') {
        return { insert: (row) => { state.history.push(row); return Promise.resolve({ error: null }); } };
      }
      if (table === 'build_key_stats') {
        return { upsert: (row) => { state.keyStats.push(row); return Promise.resolve({ error: null }); } };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { api, state };
}

const actor = { id: 'member-1', name: 'Ravager' };
const saveArgs = (over = {}) => ({
  discordId: 'member-1', displayName: 'Ravager', kind: 'pve', buildClass: 'Ravager', stats: { hp_max: 33552, cost_max: 16800 }, flags: {}, how: 'scan', actor, ...over,
});

describe('builds.save', () => {
  test('a first build is recorded as an upload, without listing every stat', async () => {
    const { api, state } = fakeSupabase(null);
    const res = await createBuilds(api).save(saveArgs());
    assert.equal(res.changed, true);
    assert.deepEqual(state.upserts[0].stats, { hp_max: 33552, cost_max: 16800 });
    assert.equal(state.history.length, 1);
    assert.equal(state.history[0].how, 'upload');
    assert.deepEqual(state.history[0].changes, []);
    assert.equal(state.history[0].changed_count, 2);
  });

  test('a rescan records exactly what moved', async () => {
    const { api, state } = fakeSupabase({ discord_id: 'member-1', kind: 'pve', class: 'Ravager', stats: { hp_max: 33552, cost_max: 16800 }, flags: {} });
    await createBuilds(api).save(saveArgs({ stats: { hp_max: 38904, cost_max: 16800 } }));
    assert.equal(state.history[0].how, 'scan');
    assert.deepEqual(state.history[0].changes, [{ id: 'hp_max', from: 33552, to: 38904 }]);
  });

  test('an officer\'s fix is recorded as an edit, under the officer\'s name', async () => {
    const { api, state } = fakeSupabase({ discord_id: 'member-1', kind: 'pvp', stats: { stun_tolerance: 1316.2 }, flags: { stun_tolerance: 'check' } });
    await createBuilds(api).save(saveArgs({
      kind: 'pvp', stats: { stun_tolerance: 1416.2 }, flags: {}, how: 'edit', actor: { id: 'officer-1', name: 'Sample Officer' },
    }));
    assert.equal(state.history[0].how, 'edit');
    assert.equal(state.history[0].changed_by, 'officer-1');
    assert.deepEqual(state.build.flags, {}, 'flag cleared with the fix');
  });

  test('saving the same numbers writes nothing', async () => {
    const { api, state } = fakeSupabase({ discord_id: 'member-1', kind: 'pve', class: 'Ravager', stats: { hp_max: 33552, cost_max: 16800 }, flags: {} });
    const res = await createBuilds(api).save(saveArgs());
    assert.equal(res.changed, false);
    assert.deepEqual(state.upserts, []);
    assert.deepEqual(state.history, []);
  });

  test('confirming a flagged value updates the build but adds no history line', async () => {
    const { api, state } = fakeSupabase({ discord_id: 'member-1', kind: 'pve', class: 'Ravager', stats: { hp_max: 33552, cost_max: 16800 }, flags: { hp_max: 'check' } });
    const res = await createBuilds(api).save(saveArgs());
    assert.equal(res.changed, true);
    assert.deepEqual(state.build.flags, {});
    assert.deepEqual(state.history, []);
  });

  test('changing only the class updates the build but adds no history line', async () => {
    const { api, state } = fakeSupabase({ discord_id: 'member-1', kind: 'pve', class: 'Ravager', stats: { hp_max: 33552, cost_max: 16800 }, flags: {} });
    const res = await createBuilds(api).save(saveArgs({ buildClass: 'Oracle (DPS)', how: 'edit' }));
    assert.equal(res.changed, true);
    assert.equal(state.build.class, 'Oracle (DPS)');
    assert.deepEqual(state.history, []);
  });

  test('a build saved before classes takes one on its next save', async () => {
    const { api, state } = fakeSupabase({ discord_id: 'member-1', kind: 'pve', stats: { hp_max: 33552, cost_max: 16800 }, flags: {} });
    const res = await createBuilds(api).save(saveArgs({ how: 'edit' }));
    assert.equal(res.changed, true);
    assert.equal(state.build.class, 'Ravager');
  });

  test('refuses a bad build type, an unknown update kind, no stats, or a missing or unknown class', async () => {
    const { api } = fakeSupabase(null);
    const b = createBuilds(api);
    await assert.rejects(b.save(saveArgs({ kind: 'raid' })), { status: 400 });
    await assert.rejects(b.save(saveArgs({ how: 'magic' })), { status: 400 });
    await assert.rejects(b.save(saveArgs({ stats: { nope: 1 } })), { status: 400 });
    await assert.rejects(b.save(saveArgs({ buildClass: '' })), { status: 400 });
    await assert.rejects(b.save(saveArgs({ buildClass: 'Necromancer' })), { status: 400 });
  });
});

describe('builds.setKeyStats', () => {
  test('keeps the order given, minus duplicates and unknown ids', async () => {
    const { api, state } = fakeSupabase();
    const out = await createBuilds(api).setKeyStats('pvp', ['stun_tolerance', 'nope', 'hp_max', 'stun_tolerance', 'pvp_melee_critical_defense'], 'officer-1');
    assert.deepEqual(out, ['stun_tolerance', 'hp_max', 'pvp_melee_critical_defense']);
    assert.deepEqual(state.keyStats[0].stat_ids, out);
  });

  test('refuses a bad build type', async () => {
    const { api } = fakeSupabase();
    await assert.rejects(createBuilds(api).setKeyStats('raid', []), { status: 400 });
  });
});
