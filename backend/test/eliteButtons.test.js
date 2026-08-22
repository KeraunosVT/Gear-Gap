// backend/test/eliteButtons.test.js — the elite timer board and its buttons.
//
// Tapping a button OVERWRITES the stored timer and the previous kill time is
// gone, so the branching that decides whether to ask first is the part worth
// holding. The rest — which message each path edits, and whether a customId
// survives a location name with a space in it — are the things that break
// silently in Discord rather than throwing.

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const gateway = require('../discordGateway');
const { setEliteTimers, eliteBoard, handleEliteButton } = gateway.__test;

const LOCATIONS = ['Laslan', 'Stoneguard', 'Talandre', 'Laslan Abyss', 'Stoneguard Abyss', 'Talandre Abyss', 'Nyx'];
const HOUR = 3_600_000;

let reported;

// `rows` maps location -> minutes until next spawn (negative = window open).
function stubTimers(rows = {}) {
  reported = [];
  setEliteTimers({
    locations: LOCATIONS,
    all: async () => Object.entries(rows).map(([location, hoursUntil]) => ({
      location,
      next_spawn_at: new Date(Date.now() + hoursUntil * HOUR).toISOString(),
    })),
    report: async (location, killedAt, by) => {
      reported.push({ location, killedAt, by });
      return { location, killed_at: killedAt.toISOString(), next_spawn_at: new Date(killedAt.getTime() + 4 * HOUR).toISOString() };
    },
  });
}

// Records every Discord call a handler makes, so a test can assert which
// message got edited rather than guessing.
function fakeInteraction(customId, { messageId = 'BOARD1', boardExists = true } = {}) {
  const calls = [];
  const board = { id: messageId, edit: async (p) => calls.push(['board.edit', p]) };
  return {
    calls,
    customId,
    user: { username: 'ana', globalName: 'Ana' },
    message: { id: messageId },
    channel: { messages: { fetch: async (id) => (boardExists && id === messageId ? board : Promise.reject(new Error('unknown message'))) } },
    update: async (p) => { calls.push(['update', p]); },
    reply: async (p) => { calls.push(['reply', p]); },
    followUp: async (p) => { calls.push(['followUp', p]); },
  };
}

const find = (calls, kind) => calls.find((c) => c[0] === kind)?.[1];
const flatButtons = (components) => components.flatMap((row) => row.components.map((b) => b.toJSON()));

describe('the board', () => {
  beforeEach(() => stubTimers({ Laslan: -1, Stoneguard: 3 }));

  test('names every tracked location, reported or not', async () => {
    const board = await eliteBoard();
    LOCATIONS.forEach((loc) => assert.ok(board.content.includes(`**${loc}**`), `missing ${loc}`));
    assert.ok(board.content.includes('no report yet'), 'unreported locations say so');
  });

  test('distinguishes an open window from a running timer', async () => {
    const board = await eliteBoard();
    assert.match(board.content, /\*\*Laslan\*\* — spawn window open/);
    assert.match(board.content, /\*\*Stoneguard\*\* — spawns/);
  });

  test('fits Discord component limits', async () => {
    const { components } = await eliteBoard();
    assert.ok(components.length <= 5, 'at most 5 action rows');
    components.forEach((r) => assert.ok(r.components.length <= 5, 'at most 5 buttons per row'));
    flatButtons(components).forEach((b) => {
      assert.ok(b.custom_id.length <= 100, `customId too long: ${b.custom_id}`);
      assert.ok(b.label.length <= 80, `label too long: ${b.label}`);
    });
  });

  test('a boss that is due looks different from one on cooldown', async () => {
    // The tap you are most likely to want is green; the one that will ask you
    // to confirm is grey, so the difference is visible BEFORE the click.
    const buttons = Object.fromEntries(flatButtons((await eliteBoard()).components).map((b) => [b.label, b.style]));
    assert.notEqual(buttons.Laslan, buttons.Stoneguard);
    assert.equal(buttons.Laslan, buttons.Nyx, 'never-reported counts as due');
  });

  test('every location gets a button, plus refresh', async () => {
    const ids = flatButtons((await eliteBoard()).components).map((b) => b.custom_id);
    LOCATIONS.forEach((loc) => assert.ok(ids.includes(`et:kill:${loc}`), `no button for ${loc}`));
    assert.ok(ids.includes('et:refresh'));
  });
});

describe('tapping a boss', () => {
  test('a due boss is reported immediately and the board redrawn', async () => {
    stubTimers({ Laslan: -1 });
    const i = fakeInteraction('et:kill:Laslan');
    await handleEliteButton(i);

    assert.equal(reported.length, 1);
    assert.equal(reported[0].location, 'Laslan');
    assert.ok(Math.abs(reported[0].killedAt - Date.now()) < 5000, 'killed at roughly now');
    assert.equal(reported[0].by, 'Ana', 'attributed the same way the slash command does');
    // The button is on the board, so update() redraws it — no fetch needed.
    assert.ok(find(i.calls, 'update')?.content.includes('**Laslan**'));
    assert.match(find(i.calls, 'followUp').content, /killed — next spawn/);
  });

  test('a boss still on cooldown asks before overwriting', async () => {
    stubTimers({ Stoneguard: 3 });
    const i = fakeInteraction('et:kill:Stoneguard');
    await handleEliteButton(i);

    assert.equal(reported.length, 0, 'nothing is written until confirmed');
    const prompt = find(i.calls, 'reply');
    assert.match(prompt.content, /isn't due until/);
    const confirm = flatButtons(prompt.components)[0];
    assert.equal(confirm.custom_id, 'et:force:BOARD1:Stoneguard', 'carries the board id so it can be redrawn later');
  });

  test('a location name with a space survives the customId round trip', async () => {
    // Split on ':' and rejoined — a space is fine, but the rejoin is the part
    // that would silently break if someone switched to a different delimiter.
    stubTimers({ 'Stoneguard Abyss': -1 });
    const i = fakeInteraction('et:kill:Stoneguard Abyss');
    await handleEliteButton(i);
    assert.equal(reported[0]?.location, 'Stoneguard Abyss');
  });

  test('a location that no longer exists is refused, not reported', async () => {
    stubTimers({});
    const i = fakeInteraction('et:kill:Atlantis');
    await handleEliteButton(i);
    assert.equal(reported.length, 0);
    assert.match(find(i.calls, 'reply').content, /isn't a tracked location/);
  });
});

describe('confirming an overwrite', () => {
  test('writes the timer, clears the prompt, and redraws the board by id', async () => {
    stubTimers({ Stoneguard: 3 });
    const i = fakeInteraction('et:force:BOARD1:Stoneguard');
    await handleEliteButton(i);

    assert.equal(reported[0]?.location, 'Stoneguard');
    const upd = find(i.calls, 'update');
    assert.match(upd.content, /killed — next spawn/);
    assert.deepEqual(upd.components, [], 'the confirm button is removed so it cannot be pressed twice');
    // The board is a DIFFERENT message here, reached by the carried id.
    assert.ok(find(i.calls, 'board.edit')?.content.includes('**Stoneguard**'));
  });

  test('a deleted board does not turn a saved report into an error', async () => {
    stubTimers({ Stoneguard: 3 });
    const i = fakeInteraction('et:force:GONE:Stoneguard', { boardExists: false });
    await handleEliteButton(i);

    assert.equal(reported.length, 1, 'the timer is still recorded');
    assert.match(find(i.calls, 'update').content, /killed — next spawn/);
  });
});

describe('refresh', () => {
  test('redraws in place without writing anything', async () => {
    stubTimers({ Laslan: 2 });
    const i = fakeInteraction('et:refresh');
    await handleEliteButton(i);
    assert.equal(reported.length, 0);
    assert.ok(find(i.calls, 'update')?.content.includes('**Laslan**'));
  });
});
