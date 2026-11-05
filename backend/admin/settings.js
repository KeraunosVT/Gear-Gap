// backend/admin/settings.js — Guild Settings, former-member cleanup, and the permissions grid.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const perms = require('../permissions');
const { listMembers, listRoles } = require('../discord');

module.exports = function registerSettings(router, ctx) {
  const { supabase, gateway, guildSettings, departed } = ctx;

  // ── GUILD SETTINGS ──────────────────────────────────────────────────────────
  // Everything the form needs in one call: the stored values, plus the live
  // Discord lists the pickers offer.
  //
  // The two channel lists are separate and must stay separate. Every
  // *_channel_id except one is a text channel the bot POSTS into;
  // attendance_voice_channel_id is a voice channel the bot READS a member list
  // out of, and a text-channel dropdown cannot offer it.
  //
  // botOnline is sent explicitly rather than left to be inferred from an empty
  // array, because "the bot is offline" and "the bot is online and can see no
  // channels" need different words on screen — and because the page uses it to
  // decide whether an unrecognised stored id means "deleted" or "can't tell
  // right now".
  router.get('/settings', async (req, res) => {
    if (!guildSettings) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const [settings, roles, members] = await Promise.all([
        guildSettings.load(),
        listRoles().catch((err) => { console.error('settings listRoles failed:', err.message); return []; }),
        // For the LOA-cancellation picker, so nobody has to hunt down a
        // snowflake by hand. Soft-failed like roles: not being able to list
        // members is a reason to type an id, not a reason the page won't load.
        listMembers().catch((err) => { console.error('settings listMembers failed:', err.message); return []; }),
      ]);
      const channels = gateway.listTextChannels();
      const voiceChannels = gateway.listVoiceChannels();
      res.json({
        settings,
        roles,
        members,
        channels,
        voice_channels: voiceChannels,
        bot_online: Boolean(channels.length || voiceChannels.length),
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to load settings.' });
    }
  });

  // ── Former members: what they left behind, and clearing it ───────────────────
  // Under /settings so it takes the 'settings' capability: deciding the member
  // role is wrong versus people really having left is a Guild Settings call.
  router.get('/settings/departed', async (req, res) => {
    if (!departed) return res.status(503).json({ error: 'Database not configured.' });
    try {
      res.json(await departed.preview());
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not check for former members.' });
    }
  });

  router.post('/settings/departed/clear', async (req, res) => {
    if (!departed) return res.status(503).json({ error: 'Database not configured.' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'Nobody selected.' });
    try {
      res.json(await departed.clear(ids));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Could not clear former members.' });
    }
  });

  router.patch('/settings', async (req, res) => {
    if (!guildSettings) return res.status(503).json({ error: 'Database not configured.' });
    try {
      // req.user, never a body field: the self-lockout guard is only a guard if
      // the identity it checks is the one that actually made the request.
      const out = await guildSettings.save(req.body, req.user);
      res.json(out);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to save settings.' });
    }
  });

  // ── Permissions: capabilities granted to Discord roles and to individuals ───
  // Gated on the 'permissions' capability itself. There's no lockout risk: a role
  // in DISCORD_ADMIN_ROLE_IDS always holds every capability and can't be edited
  // from here, so someone can always get back in even if every grant is deleted.
  router.get('/permissions', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    // Roles and members come from Discord so the grid can show live names, but a
    // grant whose subject has since been deleted or has left still has to be
    // visible to be removable — hence the stored label as a fallback.
    const [grants, roles, members] = await Promise.all([
      supabase.from('permission_grants').select('*').order('granted_at', { ascending: false })
        .then((r) => r.data || []),
      listRoles().catch((err) => { console.error('listRoles failed:', err.message); return []; }),
      listMembers().catch(() => []),
    ]);
    const roleIds = new Set(roles.map((r) => r.id));
    const memberIds = new Set(members.map((m) => m.id));
    res.json({
      catalog: perms.ALL_PERMISSIONS,
      roles,
      grants: grants.map((g) => ({
        ...g,
        stale: g.subject_type === 'role' ? !roleIds.has(g.subject_id) : !memberIds.has(g.subject_id),
      })),
    });
  });

  router.post('/permissions', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { subject_type, subject_id, subject_label, permission } = req.body || {};
    if (subject_type !== 'role' && subject_type !== 'user') return res.status(400).json({ error: 'Subject must be a role or a member.' });
    if (!subject_id) return res.status(400).json({ error: 'Subject is required.' });
    if (!perms.PERMISSION_KEYS.has(permission)) return res.status(400).json({ error: 'Unknown permission.' });

    const { error } = await supabase.from('permission_grants').upsert({
      subject_type, subject_id: String(subject_id),
      subject_label: (subject_label || '').slice(0, 120) || null,
      permission,
      granted_by: req.user.username || req.user.id,
      granted_at: new Date().toISOString(),
    }, { onConflict: 'subject_type,subject_id,permission' });
    if (error) return res.status(500).json({ error: 'Failed to grant permission.' });
    perms.invalidate();
    res.json({ ok: true });
  });

  router.delete('/permissions', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { subject_type, subject_id, permission } = req.body || {};
    if (!subject_type || !subject_id || !permission) return res.status(400).json({ error: 'Subject and permission are required.' });
    const { error } = await supabase.from('permission_grants').delete()
      .eq('subject_type', subject_type).eq('subject_id', String(subject_id)).eq('permission', permission);
    if (error) return res.status(500).json({ error: 'Failed to revoke permission.' });
    perms.invalidate();
    res.json({ ok: true });
  });
};
