// Keeping each run's Discord post in step with the database, and the other
// messages the bot sends into a run's channel or a member's DMs.
const { RESTJSONErrorCodes } = require('discord.js');
const render = require('./render');

// One edit per burst of clicks instead of one per click: long enough to absorb
// the rush when a run goes up, short enough that nobody notices the lag.
const RENDER_DEBOUNCE_MS = 1500;

function createPosts({ client, store, log = console }) {
  const pending = new Map();

  async function fetchChannel(channelId) {
    if (!channelId) return null;
    try {
      const channel = await client.channels.fetch(channelId);
      return channel?.isTextBased() ? channel : null;
    } catch {
      return null;
    }
  }

  // Posts the run and records where it landed. Throws if it can't, so the
  // caller can tell the poster why.
  async function announce(runId) {
    const detail = await store.detail(runId);
    const channel = await fetchChannel(detail.run.channel_id);
    if (!channel) throw new Error("I can't see that channel.");
    const message = await channel.send(render.runMessage(detail));
    await store.setMessage(runId, channel.id, message.id);
    return message;
  }

  // A fresh post for a run whose old one was deleted or buried. The old one is
  // removed if it's still there, so there's only ever one set of buttons.
  async function repost(runId) {
    const { run } = await store.detail(runId);
    const oldChannel = await fetchChannel(run.channel_id);
    const message = await announce(runId);
    if (run.message_id && oldChannel) await oldChannel.messages.delete(run.message_id).catch(() => {});
    return message;
  }

  // Re-renders the post from the database. Reads immediately before editing,
  // so whichever call lands last still writes the newest state.
  async function renderNow(runId) {
    try {
      const detail = await store.detail(runId);
      if (!detail.run.message_id) return;
      const channel = await fetchChannel(detail.run.channel_id);
      if (!channel) return;
      await channel.messages.edit(detail.run.message_id, render.runMessage(detail));
    } catch (err) {
      // Someone deleting the post is the usual reason; the run itself is fine
      // and the lead can repost it from the manage panel.
      if (err.code === RESTJSONErrorCodes.UnknownMessage || err.code === 'not_found') return;
      log.error(`Render error for run ${runId}:`, err.message);
    }
  }

  // Coalesces a burst of changes into one edit. Losing the timers on restart
  // costs nothing: the next change schedules afresh and reads the database.
  function refresh(runId) {
    clearTimeout(pending.get(String(runId)));
    pending.set(String(runId), setTimeout(() => {
      pending.delete(String(runId));
      renderNow(runId);
    }, RENDER_DEBOUNCE_MS));
  }

  // A message in the run's channel, as a reply to its post when it has one.
  async function sendToRun(run, payload) {
    const channel = await fetchChannel(run.channel_id);
    if (!channel) return null;
    try {
      return await channel.send({
        ...payload,
        ...(run.message_id ? { reply: { messageReference: run.message_id, failIfNotExists: false } } : {}),
      });
    } catch (err) {
      log.error(`Send error for run ${run.id}:`, err.message);
      return null;
    }
  }

  // DMs fail whenever someone has them closed, which is their call.
  async function dm(userId, content) {
    try {
      const user = await client.users.fetch(userId);
      await user.send({ content, allowedMentions: { parse: [] } });
      return true;
    } catch {
      return false;
    }
  }

  async function notifyPromotion(run, entry) {
    const guild = client.guilds.cache.get(run.guild_id);
    const link = render.postLink(run);
    return dm(entry.user_id, render.promotionDm(run, entry, guild?.name) + (link ? `\n${link}` : ''));
  }

  function stop() {
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  }

  return { announce, repost, renderNow, refresh, sendToRun, dm, notifyPromotion, fetchChannel, stop };
}

module.exports = { createPosts, RENDER_DEBOUNCE_MS };
