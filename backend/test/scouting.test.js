// backend/test/scouting.test.js — the scouting report, and when it goes out.
//
// The claims worth holding:
//   - the post leads with who they field NOW, and names standouts from that
//     roster only — a marked player who hasn't turned up lately is listed
//     separately, not mixed in with the ones you'll actually meet;
//   - an even guild says so rather than posting an empty list;
//   - posting by hand for a signup claims its automatic post, but only once
//     the post has gone — a refused post must leave the automatic one armed;
//   - the automatic post goes once, re-arms when the opponent changes, and
//     never fires for a cancelled night, one already posted, or one in the past.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Stubs, installed before anything requires them ─────────────────────────
const posted = [];
let refusePost = false;
const DISCORD = require.resolve('../discord');
require.cache[DISCORD] = {
  id: DISCORD, filename: DISCORD, loaded: true,
  exports: {
    listMembers: async () => [],
    listRoles: async () => [],
    postEmbed: async () => null,
    postImage: async () => null,
    postToChannel: async (channelId, payload) => {
      if (refusePost) throw Object.assign(new Error('nope'), { response: { data: { message: 'Missing Access' } } });
      posted.push({ channelId, payload });
    },
  },
};

let scoutingChannel = null;
const CFG = require.resolve('../guildConfig');
require.cache[CFG] = {
  id: CFG, filename: CFG, loaded: true,
  exports: {
    get: () => ({ tag: 'FTP', house: 'For The Plot', aliases: [], timezone: 'America/New_York', day_start: '01:00' }),
    aliasMap: () => ({ FTP: 'FTP' }),
    scoutingChannelId: () => scoutingChannel,
    calendarChannelId: () => 'cal-channel',
    signupChannelId: () => null,
  },
};

const { buildScoutingPost, fitLines } = require('../scouting');
const createEventSignups = require('../eventSignups');
const createAdminRouter = require('../admin');

// ── A small in-memory Supabase: enough of the query builder for these paths ─
let TABLES;
let RPC;
function fakeSupabase() {
  return {
    rpc: async (name) => ({ data: RPC[name] || [], error: null }),
    from(name) {
      const rows = TABLES[name];
      const state = { patch: null, tests: [] };
      const matching = () => rows.filter((r) => state.tests.every((t) => t(r)));
      const run = () => {
        const hit = matching();
        if (state.patch) hit.forEach((r) => Object.assign(r, state.patch));
        return { data: hit.map((r) => ({ ...r })), error: null };
      };
      const time = (v) => Date.parse(v);
      const q = {
        select: () => q,
        update: (patch) => { state.patch = patch; return q; },
        eq: (f, v) => { state.tests.push((r) => String(r[f]) === String(v)); return q; },
        neq: (f, v) => { state.tests.push((r) => String(r[f]) !== String(v)); return q; },
        is: (f, v) => { state.tests.push((r) => (r[f] ?? null) === v); return q; },
        not: (f, op, v) => { state.tests.push((r) => (r[f] ?? null) !== v); return q; },
        gt: (f, v) => { state.tests.push((r) => r[f] != null && time(r[f]) > time(v)); return q; },
        lte: (f, v) => { state.tests.push((r) => r[f] != null && time(r[f]) <= time(v)); return q; },
        single: () => {
          const { data } = run();
          return Promise.resolve(data.length ? { data: data[0], error: null } : { data: null, error: { message: 'none' } });
        },
        then: (resolve) => Promise.resolve(run()).then(resolve),
      };
      return q;
    },
  };
}

const inMinutes = (m) => new Date(Date.now() + m * 60_000).toISOString();

// A player as foldRoster returns them — only the fields the post reads.
const player = (name, { recent = 1, cls = 'Paladin', standout, sub_for = null } = {}) => ({
  player_name: name, recent_appearances: recent, main_class: cls, sub_for, ...(standout ? { standout } : {}),
});
const roster = (players) => ({ players, recent_games: 3, standout_ratio: 2, min_appearances: 5 });
const RECORD = { enemy_guild: 'Iron Vow', met: 7, wins: 4, losses: 2, draws: 1, kills_for: 310, kills_against: 255, last_met: '2026-10-30' };

describe('buildScoutingPost', () => {
  test('leads with the head-to-head and who they field now', () => {
    const { embeds } = buildScoutingPost({
      enemy: 'Iron Vow',
      record: RECORD,
      roster: roster([player('A'), player('B', { cls: 'Ranger' }), player('C'), player('Old', { recent: 0 })]),
    });
    const [embed] = embeds;
    assert.equal(embed.title, '🔭 Scouting: Iron Vow');
    assert.match(embed.description, /\*\*4W 2L 1D\*\* over 7 matches · kills 310–255 · last met 2026-10-30/);
    assert.equal(embed.fields[0].name, 'Fielding now — last 3 games');
    // Three current players, not four: "Old" hasn't been seen in the window.
    assert.equal(embed.fields[0].value, '**3** players · 2 Paladin · 1 Ranger');
  });

  test('watch list is the CURRENT roster\'s standouts, biggest margin first', () => {
    const { embeds } = buildScoutingPost({
      enemy: 'Iron Vow', record: RECORD,
      roster: roster([
        player('Mild', { standout: { kills: 2.1 } }),
        player('Wrecker', { standout: { kills: 2.4, damage_dealt: 3.5 } }),
        player('Benched', { recent: 0, standout: { healing: 4 } }),
        player('Loaner', { standout: { kills: 2.2 }, sub_for: 'Other Guild' }),
      ]),
    });
    const watch = embeds[0].fields[1];
    assert.equal(watch.name, '▲ Watch for');
    const lines = watch.value.split('\n');
    assert.equal(lines[0], '**Wrecker** (Paladin) — kills 2.4× · damage 3.5×');
    assert.equal(lines[1], '**Loaner** (Paladin) — kills 2.2× · subbing from Other Guild');
    assert.equal(lines[2], '**Mild** (Paladin) — kills 2.1×');
    assert.ok(!watch.value.includes('Benched'), 'a player not seen lately is not on the watch list');
    // ...but is still named, in its own field.
    assert.equal(embeds[0].fields[2].name, 'Marked, but not seen lately');
    assert.equal(embeds[0].fields[2].value, 'Benched (Paladin)');
  });

  test('an even guild says so instead of posting an empty list', () => {
    const { embeds } = buildScoutingPost({ enemy: 'Iron Vow', record: RECORD, roster: roster([player('A'), player('B')]) });
    assert.equal(embeds[0].fields[1].value, 'Nobody on their current roster stands out — an even guild.');
    assert.equal(embeds[0].fields.length, 2, 'no "not seen lately" field when nobody is marked');
  });

  test('a guild never met still gets a post that says so', () => {
    const { embeds } = buildScoutingPost({ enemy: 'New Kids', record: null, roster: roster([]) });
    assert.match(embeds[0].description, /No matches against them on record yet\./);
    assert.match(embeds[0].description, /No players on record for them\./);
    assert.deepEqual(embeds[0].fields, []);
  });

  test('the event line uses Discord timestamps, and names are escaped', () => {
    const startsAt = '2026-11-07T01:00:00.000Z';
    const unix = Date.parse(startsAt) / 1000;
    const { embeds } = buildScoutingPost({
      enemy: 'Iron Vow', record: RECORD,
      roster: roster([player('x_Slayer_x', { standout: { kills: 3 } })]),
      event: { title: 'Guild War', startsAt },
    });
    assert.equal(embeds[0].description.split('\n')[0], `**Guild War** · <t:${unix}:F> · <t:${unix}:R>`);
    assert.match(embeds[0].fields[1].value, /\*\*x\\_Slayer\\_x\*\*/);
  });

  test('the officer\'s note is the message text; none means none', () => {
    const base = { enemy: 'Iron Vow', record: RECORD, roster: roster([]) };
    assert.equal(buildScoutingPost({ ...base, note: '  Healers on the left  ' }).content, 'Healers on the left');
    assert.equal(buildScoutingPost(base).content, undefined);
  });

  test('links the roster page only when given an absolute URL', () => {
    const base = { enemy: 'Iron Vow', record: RECORD, roster: roster([]) };
    assert.equal(buildScoutingPost(base).embeds[0].url, undefined);
    assert.equal(buildScoutingPost({ ...base, pageUrl: 'https://x.test/war-record/feuds/Iron%20Vow' }).embeds[0].url,
      'https://x.test/war-record/feuds/Iron%20Vow');
  });
});

describe('fitLines', () => {
  test('stops at the line limit and says how many were left out', () => {
    assert.equal(fitLines(['a', 'b', 'c', 'd'], { limit: 2 }), 'a\nb\n…and 2 more');
  });

  test('never exceeds the character limit, and never cuts a line', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `player-${String(i).padStart(2, '0')} — kills 2.5×`);
    const out = fitLines(lines, { max: 200 });
    assert.ok(out.length <= 200, `got ${out.length} chars`);
    const kept = out.split('\n');
    assert.match(kept.at(-1), /^…and \d+ more$/);
    kept.slice(0, -1).forEach((l) => assert.ok(lines.includes(l), `"${l}" is a whole line`));
    assert.equal(kept.length - 1 + Number(kept.at(-1).match(/\d+/)[0]), 50);
  });

  test('everything fits: no trailer', () => {
    assert.equal(fitLines(['a', 'b']), 'a\nb');
  });
});

describe('signup opponent and the automatic post', () => {
  let signups;
  beforeEach(() => {
    TABLES = {
      signup_events: [
        { id: 'due', status: 'open', opponent_guild: 'Iron Vow', scouting_sent_at: null, starts_at: inMinutes(30) },
        { id: 'closed', status: 'closed', opponent_guild: 'Iron Vow', scouting_sent_at: null, starts_at: inMinutes(45) },
        { id: 'cancelled', status: 'cancelled', opponent_guild: 'Iron Vow', scouting_sent_at: null, starts_at: inMinutes(30) },
        { id: 'sent', status: 'open', opponent_guild: 'Iron Vow', scouting_sent_at: inMinutes(-5), starts_at: inMinutes(30) },
        { id: 'noOpp', status: 'open', opponent_guild: null, scouting_sent_at: null, starts_at: inMinutes(30) },
        { id: 'later', status: 'open', opponent_guild: 'Iron Vow', scouting_sent_at: null, starts_at: inMinutes(180) },
        { id: 'past', status: 'open', opponent_guild: 'Iron Vow', scouting_sent_at: null, starts_at: inMinutes(-10) },
      ],
    };
    signups = createEventSignups(fakeSupabase());
  });

  test('due: within the lead, has an opponent, not posted, not cancelled — closed still counts', async () => {
    const due = (await signups.dueForScouting(60)).map((e) => e.id).sort();
    assert.deepEqual(due, ['closed', 'due']);
  });

  test('the claim succeeds once', async () => {
    assert.equal(await signups.claimScouting('due'), true);
    assert.equal(await signups.claimScouting('due'), false);
    assert.deepEqual((await signups.dueForScouting(60)).map((e) => e.id), ['closed']);
  });

  test('changing the opponent re-arms a post already sent, and tidies the name', async () => {
    const row = await signups.setOpponent('sent', '  Iron   Covenant ');
    assert.equal(row.opponent_guild, 'Iron Covenant');
    assert.equal(row.scouting_sent_at, null);
  });

  test('clearing the opponent stores null, so nothing posts', async () => {
    await signups.setOpponent('due', '   ');
    assert.ok(!(await signups.dueForScouting(60)).some((e) => e.id === 'due'));
  });
});

describe('POST /scouting/post', () => {
  const handler = (path) => {
    const router = createAdminRouter(fakeSupabase(), { listTextChannels: () => [] }, { priorities: new Set() }, { load: async () => ({}) });
    return router.stack.find((l) => l.route?.path === path && l.route.methods.post).route.stack[0].handle;
  };
  const call = (body) => new Promise((resolve, reject) => {
    let status = 200;
    Promise.resolve(handler('/scouting/post')({ body, user: { id: 'o' } }, {
      status(s) { status = s; return this; },
      json: (b) => resolve({ status, body: b }),
    })).catch(reject);
  });

  beforeEach(() => {
    posted.length = 0;
    refusePost = false;
    scoutingChannel = null;
    RPC = { get_guild_feuds: [RECORD], get_guild_feud_roster: [] };
    TABLES = {
      signup_events: [
        { id: 'war', title: 'Guild War', status: 'open', opponent_guild: 'Iron Vow', scouting_sent_at: null, starts_at: inMinutes(40) },
        { id: 'bare', title: 'Riftstone', status: 'open', opponent_guild: null, scouting_sent_at: null, starts_at: inMinutes(40) },
      ],
    };
  });

  test('posting for a signup uses its opponent and claims the automatic post', async () => {
    const res = await call({ signup_id: 'war', channel_id: 'chan' });
    assert.equal(res.status, 200);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].channelId, 'chan');
    assert.equal(posted[0].payload.embeds[0].title, '🔭 Scouting: Iron Vow');
    assert.match(posted[0].payload.embeds[0].description, /^\*\*Guild War\*\* · <t:\d+:F>/);
    assert.ok(TABLES.signup_events[0].scouting_sent_at, 'the sweep will not post it again');
  });

  test('a refused post leaves the automatic one armed', async () => {
    refusePost = true;
    const res = await call({ signup_id: 'war', channel_id: 'chan' });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /Missing Access/);
    assert.equal(TABLES.signup_events[0].scouting_sent_at, null);
  });

  test('a signup with no opponent is refused, not posted blank', async () => {
    const res = await call({ signup_id: 'bare', channel_id: 'chan' });
    assert.equal(res.status, 400);
    assert.equal(posted.length, 0);
  });

  test('no channel picked and none configured is refused', async () => {
    const res = await call({ guild: 'Iron Vow' });
    assert.equal(res.status, 400);
    assert.equal(posted.length, 0);
  });

  test('from the Feuds page: just a guild, falling back to the Scouting channel', async () => {
    scoutingChannel = 'scout-chan';
    const res = await call({ guild: 'iron  vow' });
    assert.equal(res.status, 200);
    assert.equal(res.body.enemy, 'Iron Vow', 'resolved to the record\'s own spelling');
    assert.equal(posted[0].channelId, 'scout-chan');
  });
});
