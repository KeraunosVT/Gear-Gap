// backend/admin/polls.js — the Polls page: create, list, close and delete the
// bot's own polls (backend/polls.js) and questionnaires
// (backend/questionnaires.js). Registered onto the one admin router by
// ../admin.js; gated on 'polls' by route prefix in ../permissions.js.
//
// Nothing here returns who voted for what in a poll; officers see that only on
// Discord, privately, through the poll's "Who voted" button. The one route
// that names people is a questionnaire's Responses page.
const createPolls = require('../polls');
const createQuestionnaires = require('../questionnaires');
const guildConfig = require('../guildConfig');
const { listMembers } = require('../discord');

const { isOpen } = createPolls;

module.exports = function registerPolls(router, ctx) {
  const { supabase, gateway, identities } = ctx;
  const polls = supabase ? createPolls(supabase) : null;
  const questionnaires = supabase ? createQuestionnaires(supabase) : null;

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

  // ── Questionnaires ─────────────────────────────────────────────────────
  // Under /polls so they share its permission and audit-log label. The list
  // carries counts and typed answers only; names are on the Responses route.
  router.get('/polls/questionnaires', async (req, res) => {
    if (!questionnaires) return res.status(503).json({ error: 'Database not configured.' });
    try {
      res.json({
        questionnaires: await questionnaires.list(),
        channels: gateway.listTextChannels ? gateway.listTextChannels() : [],
        default_channel_id: guildConfig.get().announce_channel_id || null,
        limits: createQuestionnaires.LIMITS,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Saved, then posted; removed again if the post fails, as for polls.
  router.post('/polls/questionnaires', async (req, res) => {
    if (!questionnaires) return res.status(503).json({ error: 'Database not configured.' });
    let questionnaire;
    try {
      const { title, intro, questions, closes_in_hours, channel_id } = req.body || {};
      questionnaire = await questionnaires.create({ title, intro, questions, closesInHours: closes_in_hours, channelId: channel_id },
        req.user?.username || req.user?.id || null);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    try {
      await gateway.postQuestionnaire(questionnaire.id);
      res.json({ questionnaire });
    } catch (err) {
      await questionnaires.remove(questionnaire.id).catch(() => {});
      res.status(502).json({ error: `The questionnaire couldn't be posted: ${err.message}` });
    }
  });

  // The Responses page: who answered what, by name — the one route here that
  // returns that, for officers holding the Polls permission.
  router.get('/polls/questionnaires/:id/responses', async (req, res) => {
    if (!questionnaires) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const [questionnaire, responses, roster, ids] = await Promise.all([
        questionnaires.load(req.params.id),
        questionnaires.responsesFor(req.params.id),
        listMembers().catch(() => []),
        identities ? identities.load().catch(() => null) : null,
      ]);
      const rosterName = new Map(roster.map((m) => [String(m.id), m.name]));
      const answeredAs = new Map(responses.map((r) => [String(r.discord_id), r.display_name]));
      const nameFor = (id) => {
        const fallback = rosterName.get(String(id)) || answeredAs.get(String(id)) || 'Unknown';
        return ids ? ids.displayNameFor(String(id), fallback) || fallback : fallback;
      };
      const { id, title, intro, questions, status, closes_at: closesAt, created_at: createdAt } = questionnaire;
      res.json({
        questionnaire: {
          id, title, intro, questions, status, closes_at: closesAt, created_at: createdAt, open: isOpen(questionnaire),
        },
        ...createQuestionnaires.responseSheet({ questions, responses, roster, nameFor }),
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.post('/polls/questionnaires/:id/close', async (req, res) => {
    if (!questionnaires) return res.status(503).json({ error: 'Database not configured.' });
    try {
      await questionnaires.close(req.params.id);
      res.json({ ok: true });
      gateway.refreshQuestionnaire?.(req.params.id);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Deletes it, its responses and its Discord post.
  router.delete('/polls/questionnaires/:id', async (req, res) => {
    if (!questionnaires) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const questionnaire = await questionnaires.remove(req.params.id);
      res.json({ ok: true });
      gateway.deleteQuestionnaireMessage?.(questionnaire);
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
