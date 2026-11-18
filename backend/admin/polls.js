// backend/admin/polls.js — the Polls page: create, list, close and delete the
// bot's own polls (backend/polls.js). Registered onto the one admin router by
// ../admin.js; gated on 'polls' by route prefix in ../permissions.js.
//
// Nothing here returns who voted for what. Officers see that only on Discord,
// privately, through the poll's "Who voted" button.
const createPolls = require('../polls');
const guildConfig = require('../guildConfig');

module.exports = function registerPolls(router, ctx) {
  const { supabase, gateway } = ctx;
  const polls = supabase ? createPolls(supabase) : null;

  router.get('/polls', async (req, res) => {
    if (!polls) return res.status(503).json({ error: 'Database not configured.' });
    try {
      res.json({
        polls: await polls.list(),
        channels: gateway.listTextChannels ? gateway.listTextChannels() : [],
        default_channel_id: guildConfig.get().announce_channel_id || null,
        max_options: createPolls.MAX_OPTIONS,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Saved, then posted. If the post fails the poll is removed again, so a
  // retry doesn't leave a poll nobody can vote in behind.
  router.post('/polls', async (req, res) => {
    if (!polls) return res.status(503).json({ error: 'Database not configured.' });
    let poll;
    try {
      const { question, options, multi, write_in, closes_in_hours, channel_id } = req.body || {};
      poll = await polls.create({ question, options, multi, writeIn: write_in, closesInHours: closes_in_hours, channelId: channel_id },
        req.user?.username || req.user?.id || null);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    try {
      await gateway.postPoll(poll.id);
      res.json({ poll });
    } catch (err) {
      await polls.remove(poll.id).catch(() => {});
      res.status(502).json({ error: `The poll couldn't be posted: ${err.message}` });
    }
  });

  router.post('/polls/:id/close', async (req, res) => {
    if (!polls) return res.status(503).json({ error: 'Database not configured.' });
    try {
      await polls.close(req.params.id);
      res.json({ ok: true });
      gateway.refreshPoll?.(req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Deletes the poll, its votes and its Discord post.
  router.delete('/polls/:id', async (req, res) => {
    if (!polls) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const poll = await polls.remove(req.params.id);
      res.json({ ok: true });
      gateway.deletePollMessage?.(poll);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
};
