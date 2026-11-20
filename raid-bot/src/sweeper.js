// Once a minute: ping the roster before each run, close signups on runs that
// have started, and (hourly) delete runs finished long ago.
//
// Every step claims its rows in the database before acting, so a restart, a
// slow sweep overlapping the next, or a second instance can't send anything
// twice.
const render = require('./render');

const SWEEP_MS = 60_000;
const PURGE_EVERY = 60; // sweeps

function createSweeper({ store, posts, log = console }) {
  let timer = null;
  let running = false;
  let count = 0;

  async function sweep(now = new Date()) {
    if (running) return;
    running = true;
    try {
      for (const run of await store.closeStarted(now)) await posts.renderNow(run.id);

      for (const run of await store.claimReminders(now)) {
        const detail = await store.detail(run.id).catch(() => null);
        if (detail?.going.length) await posts.sendToRun(detail.run, render.reminderMessage(detail));
      }

      if (count % PURGE_EVERY === 0) {
        const purged = await store.purgeOld(now);
        if (purged) log.log(`Purged ${purged} finished run(s).`);
      }
      count += 1;
    } catch (err) {
      log.error('Sweep error:', err.message);
    } finally {
      running = false;
    }
  }

  return {
    sweep,
    start() {
      if (!timer) timer = setInterval(sweep, SWEEP_MS);
      sweep();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createSweeper };
