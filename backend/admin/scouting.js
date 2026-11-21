// backend/admin/scouting.js — post an enemy guild's scouting report to Discord.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
//
// These are the buttons: one on the Feuds roster page, one on a signup card.
// Both go through postScouting(). Nothing posts a report automatically.
const guildConfig = require('../guildConfig');
const { postScouting } = require('../scouting');

module.exports = function registerScouting(router, ctx) {
  const { supabase, gateway, signups } = ctx;

  // The channel picker. Starts on the Scouting channel from Guild Settings,
  // else the calendar's — a button press is an explicit choice, so it is fine
  // for it to default somewhere.
  router.get('/scouting/channels', (req, res) => {
    res.json({
      channels: gateway.listTextChannels(),
      default_channel_id: guildConfig.scoutingChannelId() || guildConfig.calendarChannelId(),
      scouting_channel_id: guildConfig.scoutingChannelId(),
    });
  });

  // { guild, channel_id, note? } — or { signup_id, channel_id, note? }, which
  // takes the guild from the signup's opponent and adds the event line.
  router.post('/scouting/post', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { guild, channel_id, signup_id, note } = req.body || {};
    try {
      const channelId = channel_id || guildConfig.scoutingChannelId();
      if (!channelId) return res.status(400).json({ error: 'Pick a channel to post to.' });

      let event = null;
      let enemy = guild;
      if (signup_id) {
        if (!signups) return res.status(503).json({ error: 'Database not configured.' });
        const row = await signups.get(signup_id);
        enemy = guild || row.opponent_guild;
        if (!enemy) return res.status(400).json({ error: 'Set an opponent on this signup first.' });
        event = { title: row.title, startsAt: row.starts_at };
      }

      const result = await postScouting(supabase, { enemy, channelId, event, note });
      res.json({ ok: true, enemy: result.enemy });
    } catch (err) {
      const discordMsg = err.response?.data?.message;
      res.status(err.status || (discordMsg ? 502 : 500)).json({
        error: discordMsg ? `Discord refused the post: ${discordMsg}` : err.message || 'Failed to post.',
      });
    }
  });
};
