// backend/test/enemyPlayers.test.js — merging OCR misreads of enemy players.
//
// The bug this fixes is quiet in a specific way: one person read three ways
// occupies three rows with a third of their matches each, which ALSO drops all
// three under the standout floor. The misread hides exactly the player it
// fragments, and the sheet looks complete while doing it.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

const DISCORD = require.resolve('../discord');
require.cache[DISCORD] = {
  id: DISCORD,
  loaded: true,
  exports: { listMembers: async () => [], listRoles: async () => [], postEmbed: async () => null, postImage: async () => null },
};

const CFG = require.resolve('../guildConfig');
require.cache[CFG] = {
  id: CFG,
  loaded: true,
  exports: {
    get: () => ({ tag: 'FTP', aliases: [], timezone: 'America/New_York', day_start: '01:00' }),
    aliasMap: () => ({ FTP: 'FTP' }),
    canonicalGuild: (n) => n,
  },
};

const createAdminRouter = require('../admin');

// One person read three ways, plus an unrelated name.
const ROSTER = [
  { player_name: 'Ravager', own_guild: 'Iron Vow', appearances: 9 },
  { player_name: 'Ravag3r', own_guild: 'Iron Vow', appearances: 2 },
  { player_name: 'Nightfall', own_guild: 'Iron Vow', appearances: 7 },
];

// Our own members, who must be merged on the Names page and not here.
const OUR_MEMBERS = new Set(['Keraunos']);

let aliasRows = [];
let handlers = {};

function fakeSupabase() {
  return {
    rpc: async (name) => {
      if (name === 'get_guild_feud_roster') return { data: ROSTER, error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table) => {
      if (table !== 'enemy_player_aliases') throw new Error(`unexpected table ${table}`);
      const q = {
        _v: null,
        select: () => q,
        order: () => q,
        ilike(_c, v) { q._v = v; return q; },
        maybeSingle: async () => ({
          data: aliasRows.find((r) => r.alias.toLowerCase() === String(q._v).toLowerCase()) || null,
        }),
        upsert: async (row) => {
          aliasRows = aliasRows.filter((r) => r.alias.toLowerCase() !== row.alias.toLowerCase()).concat(row);
          return { error: null };
        },
        update(patch) {
          return {
            ilike: (_c, v) => ({
              select: async () => {
                const hit = aliasRows.filter((r) => r.canonical.toLowerCase() === String(v).toLowerCase());
                hit.forEach((r) => { r.canonical = patch.canonical; });
                return { data: hit.map((r) => ({ alias: r.alias })), error: null };
              },
            }),
          };
        },
        delete: () => ({
          ilike: async (_c, v) => {
            aliasRows = aliasRows.filter((r) => r.alias.toLowerCase() !== String(v).toLowerCase());
            return { error: null };
          },
        }),
        then: (resolve) => Promise.resolve({ data: aliasRows, error: null }).then(resolve),
      };
      return q;
    },
  };
}

const identities = {
  load: async () => ({
    identityForName: (n) => (OUR_MEMBERS.has(n) ? { display_name: n } : null),
    displayNameFor: (id, fb) => fb || id,
  }),
};

before(() => {
  const router = createAdminRouter(fakeSupabase(), {}, { priorities: new Set() }, identities);
  const grab = (method, path) => {
    const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
    return layer.route.stack[0].handle;
  };
  handlers = {
    list: grab('get', '/enemy-players'),
    create: grab('post', '/enemy-players'),
    remove: grab('delete', '/enemy-players/:alias'),
  };
});

function call(handler, { body = {}, params = {}, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
    };
    Promise.resolve(handler({ body, params, query, user: { id: 'o', username: 'Officer' } }, res)).catch(reject);
  });
}

describe('suggestions', () => {
  test('proposes the misread, folding the rarer spelling into the commoner', async () => {
    // Seen twice against nine — the commoner reading is far likelier correct.
    aliasRows = [];
    const { body } = await call(handlers.list, { query: { guild: 'Iron Vow' } });
    const s = body.suggestions.find((x) => x.alias === 'Ravag3r');
    assert.ok(s, 'should propose it');
    assert.equal(s.canonical, 'Ravager');
  });

  test('does not propose unrelated names', async () => {
    const { body } = await call(handlers.list, { query: { guild: 'Iron Vow' } });
    assert.ok(!body.suggestions.some((s) => s.alias === 'Nightfall' || s.canonical === 'Nightfall'));
  });

  test('suggesting writes nothing', async () => {
    aliasRows = [];
    await call(handlers.list, { query: { guild: 'Iron Vow' } });
    assert.equal(aliasRows.length, 0);
  });

  test('a guild is required — this is scoped to one roster on purpose', async () => {
    // Across the whole record, unrelated players with similar names in
    // different guilds would be proposed constantly.
    const { status } = await call(handlers.list, { query: {} });
    assert.equal(status, 400);
  });
});

describe('the guards', () => {
  test('a name belonging to one of our members is refused as an alias', async () => {
    // Our members are merged on the Names page, backed by player_identities.
    // A name handled by both systems diverges the moment either is edited.
    aliasRows = [];
    const { status, body } = await call(handlers.create, { body: { alias: 'Keraunos', canonical: 'Ravager' } });
    assert.equal(status, 400);
    assert.match(body.error, /Names page/);
    assert.equal(aliasRows.length, 0);
  });

  test('and refused as the target', async () => {
    const { status, body } = await call(handlers.create, { body: { alias: 'Ravag3r', canonical: 'Keraunos' } });
    assert.equal(status, 400);
    assert.match(body.error, /can't point at us/);
  });

  test('a name may not map to itself, in any case', async () => {
    aliasRows = [];
    const a = await call(handlers.create, { body: { alias: 'Ravager', canonical: 'Ravager' } });
    assert.equal(a.status, 400);
    const b = await call(handlers.create, { body: { alias: 'Ravager', canonical: 'RAVAGER' } });
    assert.equal(b.status, 400, 'case alone is not a difference');
  });

  test('chains are refused', async () => {
    aliasRows = [{ alias: 'Ravag3r', canonical: 'Ravager' }];
    const { status, body } = await call(handlers.create, { body: { alias: 'Ravaqer', canonical: 'Ravag3r' } });
    assert.equal(status, 400);
    assert.match(body.error, /already mapped/);
  });
});

describe('merging', () => {
  test('a merge is written, attributed, and reversible', async () => {
    aliasRows = [];
    const { status } = await call(handlers.create, { body: { alias: 'Ravag3r', canonical: 'Ravager' } });
    assert.equal(status, 200);
    assert.deepEqual(aliasRows.map((r) => [r.alias, r.canonical]), [['Ravag3r', 'Ravager']]);
    assert.equal(aliasRows[0].created_by, 'Officer', 'attributed for the audit log');

    await call(handlers.remove, { params: { alias: 'Ravag3r' } });
    assert.equal(aliasRows.length, 0);
  });

  test('whitespace is collapsed on the way in', async () => {
    aliasRows = [];
    await call(handlers.create, { body: { alias: '  Ravag3r ', canonical: ' Ravager ' } });
    assert.deepEqual(aliasRows.map((r) => [r.alias, r.canonical]), [['Ravag3r', 'Ravager']]);
  });

  test('a second merge re-points the first rather than leaving a chain', async () => {
    // Three spellings of one person, merged in two steps. Every one must end up
    // on the final name — the lookup is a single join, so a two-level table
    // would leave the first spelling resolving to a name nothing else uses.
    aliasRows = [];
    await call(handlers.create, { body: { alias: 'Ravaqer', canonical: 'Ravag3r' } });
    const { body } = await call(handlers.create, { body: { alias: 'Ravag3r', canonical: 'Ravager' } });

    assert.deepEqual(body.repointed, ['Ravaqer'], 'reports what else moved');
    const byAlias = Object.fromEntries(aliasRows.map((r) => [r.alias, r.canonical]));
    assert.deepEqual(byAlias, { Ravaqer: 'Ravager', Ravag3r: 'Ravager' });
  });

  test('re-pointing is case-insensitive', async () => {
    aliasRows = [{ alias: 'Ravaqer', canonical: 'RAVAG3R' }];
    await call(handlers.create, { body: { alias: 'Ravag3r', canonical: 'Ravager' } });
    assert.equal(
      aliasRows.find((r) => r.alias === 'Ravaqer').canonical,
      'Ravager',
      'a differently-cased target still gets carried forward',
    );
  });
});
