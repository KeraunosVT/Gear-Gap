// backend/test/inHouseChannel.test.js — In-House signups post to their own
// channel, so they stay out of the War Games schedule.
//
// guildConfig is stubbed in the require cache before the gateway loads, the
// way guildNightConformance.test.js stubs it: the gateway reads channels
// through it at call time, so swapping `config` between tests is enough.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

let config = {};
let gateway;
const cfgPath = require.resolve('../guildConfig');
const gwPath = require.resolve('../discordGateway');
let realCfg;

before(() => {
  realCfg = require.cache[cfgPath];
  const real = require('../guildConfig');
  require.cache[cfgPath] = {
    id: cfgPath,
    loaded: true,
    exports: {
      ...real,
      get: () => ({ ...real.DEFAULTS, ...config }),
      signupChannelId: () => config.signup_channel_id || config.announce_channel_id || null,
      inHouseChannelId: () => config.in_house_channel_id || null,
    },
  };
  delete require.cache[gwPath];
  gateway = require('../discordGateway');
});

after(() => {
  if (realCfg) require.cache[cfgPath] = realCfg; else delete require.cache[cfgPath];
  delete require.cache[gwPath];
});

const forEvent = (event) => gateway.__test.signupChannelFor(event);

describe('signupChannelFor', () => {
  test('an In-House event goes to the In-House channel', () => {
    config = { signup_channel_id: 'wargame-schedule', in_house_channel_id: 'in-house' };
    assert.equal(forEvent({ title: 'Scrims', category: 'in_house' }), 'in-house');
    assert.equal(forEvent({ title: 'In-House Wargame' }), 'in-house', 'typed by its name');
  });

  test('everything else stays in the signup channel', () => {
    config = { signup_channel_id: 'wargame-schedule', in_house_channel_id: 'in-house' };
    assert.equal(forEvent({ title: 'War Games', category: 'war_games' }), 'wargame-schedule');
    assert.equal(forEvent({ title: 'Arch Boss' }), 'wargame-schedule');
  });

  test('with no In-House channel set, In-House goes with the other signups', () => {
    config = { signup_channel_id: 'wargame-schedule' };
    assert.equal(forEvent({ title: 'In-House', category: 'in_house' }), 'wargame-schedule');
  });

  test('nothing set at all posts nowhere', () => {
    config = {};
    assert.equal(forEvent({ title: 'In-House', category: 'in_house' }), null);
  });
});
