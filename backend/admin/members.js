// backend/admin/members.js — The member pool, saved member roles, and the gear-level leaderboard.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const { listMembers } = require('../discord');

module.exports = function registerMembers(router, ctx) {
  const { supabase, identities } = ctx;

  // ── Party member pool (Discord members with the member role) ────────────────
  router.get('/members', async (req, res) => {
    try {
      const members = await listMembers();
      if (supabase) {
        const [{ data: roleData, error: roleError }, ids] = await Promise.all([
          supabase.from('member_roles').select('discord_id, pvp_role, pve_role, pvp_classes, pve_classes'),
          identities.load(),
        ]);
        if (roleError) console.error('member_roles load error:', roleError.message);
        const roleMap = {};
        const classMap = {};
        (roleData || []).forEach((r) => {
          roleMap[r.discord_id] = { pvp: r.pvp_role || '', pve: r.pve_role || '' };
          classMap[r.discord_id] = {
            pvp_classes: Array.isArray(r.pvp_classes) ? r.pvp_classes : [],
            pve_classes: Array.isArray(r.pve_classes) ? r.pve_classes : [],
          };
        });

        members.forEach((m) => {
          m.pvp_role = roleMap[m.id]?.pvp || '';
          m.pve_role = roleMap[m.id]?.pve || '';
          m.pvp_classes = classMap[m.id]?.pvp_classes || [];
          m.pve_classes = classMap[m.id]?.pve_classes || [];
          m.name = ids.displayNameFor(m.id, m.name);
        });
      }
      res.json({ members });
    } catch (err) {
      console.error('Member list error:', err.response?.data?.message || err.message);
      res.status(502).json({ error: err.response?.data?.message || err.message });
    }
  });

  // ── Persist a member's role (sticks across rosters) ─────────────────────────
  // Tracked separately per PvP/PvE mode — someone can be a Tank for one and a
  // Healer for the other.
  router.put('/member-roles', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { id, mode, role } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Member id required.' });
    const column = mode === 'pve' ? 'pve_role' : 'pvp_role';
    const { error } = await supabase.from('member_roles')
      .upsert({ discord_id: String(id), [column]: role || null, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: 'Failed to save role.' });
    res.json({ ok: true });
  });

  // ── Gear item levels (admin-only comparison table) ───────────────────────────
  router.get('/gear-ilvl', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    // The third query is deliberately thin: the leaderboard needs to know
    // WHETHER each member has a stored equipment window so it can offer the
    // button, and when it arrived. Selecting the parsed item lists (still on
    // pre-existing rows) would ship a full inventory per member to render one
    // icon.
    const [{ data, error }, ids, { data: shots }] = await Promise.all([
      supabase.from('gear_levels').select('*'),
      identities.load(),
      supabase.from('gear_screenshots').select('discord_id, display_name, excluded_count, submitted_at'),
    ]);
    if (error) return res.status(500).json({ error: 'Failed to load gear levels.' });
    const shotBy = new Map((shots || []).map((s) => [String(s.discord_id), s]));
    const entries = (data || []).map((e) => ({
      ...e,
      display_name: ids.displayNameFor(e.discord_id, e.display_name),
      has_screenshot: shotBy.has(String(e.discord_id)),
      excluded_count: shotBy.get(String(e.discord_id))?.excluded_count ?? 0,
    }));

    // Uploading an equipment window no longer creates a gear level, so a member
    // can have a screenshot on file and no row above. They still belong in this
    // table: it is the only place an officer can open that screenshot, and
    // leaving them out would make an uploaded image unreachable. Levels come
    // through as null, which the page renders as a dash — the honest answer to
    // "what is their gear level" for someone who never sent the popup.
    const levelled = new Set((data || []).map((e) => String(e.discord_id)));
    (shots || []).forEach((s) => {
      const id = String(s.discord_id);
      if (levelled.has(id)) return;
      entries.push({
        discord_id: id,
        display_name: ids.displayNameFor(id, s.display_name),
        weapon: null, armor: null, accessory: null, average: null,
        maxed_at: null, source: null,
        submitted_at: s.submitted_at,
        has_screenshot: true,
        excluded_count: s.excluded_count ?? 0,
      });
    });

    res.json({ entries });
  });

  router.get('/gear-ilvl/:discordId/history', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase.from('gear_level_history')
      .select('*').eq('discord_id', req.params.discordId).order('submitted_at', { ascending: false });
    if (error) return res.status(500).json({ error: 'Failed to load gear level history.' });
    res.json({ entries: data || [] });
  });
};
