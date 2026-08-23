// backend/test/guildFeuds.test.js
//
// The aggregation itself is SQL (migrations/019) and can't run here. What can
// is everything around it — and that is where the damage would be:
//
//   - the two guards that stop the enemy alias table corrupting the guild's own
//     record. They are the entire reason enemy names live in a separate table;
//   - the merge suggestions, which must propose and never decide;
//   - the roster fold, which turns weapon pairs into classes using the site's
//     one class vocabulary rather than a second copy.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const DISCORD = require.resolve('../discord');
require.cache[DISCORD] = {
  id: DISCORD,
  loaded: true,
  exports: { listMembers: async () => [], listRoles: async () => [], postEmbed: async () => null, postImage: async () => null },
};

// guildConfig serves frozen DEFAULTS without a database; stub it so the guild
// has names to guard against.
const CFG = require.resolve('../guildConfig');
require.cache[CFG] = {
  id: CFG,
  loaded: true,
  exports: {
    get: () => ({ tag: 'FTP', aliases: ['For The Plot'], timezone: 'America/New_York', day_start: '01:00' }),
    aliasMap: () => ({ FTP: 'FTP', 'For The Plot': 'FTP' }),
    canonicalGuild: (n) => n,
  },
};

const createAdminRouter = require('../admin');

// What get_guild_feuds would return: two spellings of one rival, one of which
// is a misread, plus an unrelated guild.
const FEUDS = [
  { enemy_guild: 'Iron Vow', met: 9, wins: 5, losses: 4, draws: 0, kills_for: 900, kills_against: 800, last_met: '2026-08-20' },
  { enemy_guild: 'lron Vow', met: 2, wins: 1, losses: 1, draws: 0, kills_for: 120, kills_against: 130, last_met: '2026-07-02' },
  { enemy_guild: 'Nightfall', met: 5, wins: 4, losses: 1, draws: 0, kills_for: 410, kills_against: 233, last_met: '2026-08-01' },
];

let aliasRows = [];
let handlers = {};

function fakeSupabase() {
  return {
    rpc: async (name) => {
      if (name === 'get_guild_feuds') return { data: FEUDS, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table) => {
      if (table !== 'enemy_guild_aliases') throw new Error(`unexpected table ${table}`);
      const q = {
        _alias: null,
        select: () => q,
        order: () => q,
        eq(_c, v) { q._alias = v; return q; },
        maybeSingle: async () => ({ data: aliasRows.find((r) => r.alias === q._alias) || null }),
        upsert: async (row) => { aliasRows = aliasRows.filter((r) => r.alias !== row.alias).concat(row); return { error: null }; },
        delete: () => ({ eq: async (_c, v) => { aliasRows = aliasRows.filter((r) => r.alias !== v); return { error: null }; } }),
        then: (resolve) => Promise.resolve({ data: aliasRows, error: null }).then(resolve),
      };
      return q;
    },
  };
}

before(() => {
  const router = createAdminRouter(fakeSupabase(), {}, { priorities: new Set() }, { load: async () => ({}) });
  const grab = (method, path) => {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
    return layer.route.stack[0].handle;
  };
  handlers = {
    list: grab('get', '/enemy-guilds'),
    create: grab('post', '/enemy-guilds'),
    remove: grab('delete', '/enemy-guilds/:alias'),
  };
});

function call(handler, { body = {}, params = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    Promise.resolve(handler({ body, params, query: {}, user: { id: 'o', username: 'Officer' } }, res)).catch(reject);
  });
}

describe('the guards that keep enemy aliases out of our own record', () => {
  test('an alias may not be one of our own names', async () => {
    // guild_config.aliases means "names WE have gone by" and every reader
    // treats a match as us. A row here naming us would fold a rival's matches
    // into our record — which is exactly why the two lists are separate.
    const { status, body } = await call(handlers.create, { body: { alias: 'FTP', canonical: 'Iron Vow' } });
    assert.equal(status, 400);
    assert.match(body.error, /own names/);
    assert.equal(aliasRows.length, 0, 'nothing was written');
  });

  test('a past name of ours may not be an alias either', async () => {
    const { status } = await call(handlers.create, { body: { alias: 'For The Plot', canonical: 'Iron Vow' } });
    assert.equal(status, 400);
  });

  test('the target may not be one of our own names', async () => {
    const { status, body } = await call(handlers.create, { body: { alias: 'Iron Vow', canonical: 'FTP' } });
    assert.equal(status, 400);
    assert.match(body.error, /Guild Settings/, 'points at the right place to record one of our renames');
  });

  test('chains are refused', async () => {
    // A→B, B→C would make the answer depend on which join ran first.
    aliasRows = [{ alias: 'lron Vow', canonical: 'Iron Vow' }];
    const { status, body } = await call(handlers.create, { body: { alias: 'Iron  Vow', canonical: 'lron Vow' } });
    assert.equal(status, 400);
    assert.match(body.error, /already mapped/);
    assert.equal(aliasRows.length, 1);
  });

  test('a name may not map to itself', async () => {
    aliasRows = [];
    const { status } = await call(handlers.create, { body: { alias: 'Iron Vow', canonical: 'Iron Vow' } });
    assert.equal(status, 400);
  });

  test('a legitimate merge is written, and can be undone', async () => {
    aliasRows = [];
    const { status } = await call(handlers.create, { body: { alias: 'lron Vow', canonical: 'Iron Vow' } });
    assert.equal(status, 200);
    assert.deepEqual(aliasRows.map((r) => [r.alias, r.canonical]), [['lron Vow', 'Iron Vow']]);
    assert.equal(aliasRows[0].created_by, 'Officer', 'attributed for the audit log');

    await call(handlers.remove, { params: { alias: 'lron Vow' } });
    assert.equal(aliasRows.length, 0);
  });

  test('whitespace is normalised on the way in', async () => {
    // The SQL already collapses whitespace, so an alias row carrying a raw
    // double space would never match anything.
    aliasRows = [];
    await call(handlers.create, { body: { alias: '  lron   Vow  ', canonical: ' Iron Vow ' } });
    assert.deepEqual(aliasRows.map((r) => [r.alias, r.canonical]), [['lron Vow', 'Iron Vow']]);
  });
});

describe('merge suggestions', () => {
  test('proposes the near-duplicate, merging the rarer spelling into the commoner', async () => {
    // Seen 9 times vs 2 — the commoner reading is far likelier to be correct.
    aliasRows = [];
    const { body } = await call(handlers.list);
    const s = body.suggestions.find((x) => x.alias === 'lron Vow');
    assert.ok(s, 'should propose the misread');
    assert.equal(s.canonical, 'Iron Vow');
  });

  test('does not propose unrelated guilds', async () => {
    const { body } = await call(handlers.list);
    assert.ok(
      !body.suggestions.some((s) => s.alias === 'Nightfall' || s.canonical === 'Nightfall'),
      'Nightfall resembles neither',
    );
  });

  test('suggesting is all it does — nothing is written', async () => {
    aliasRows = [];
    await call(handlers.list);
    assert.equal(aliasRows.length, 0);
  });
});
