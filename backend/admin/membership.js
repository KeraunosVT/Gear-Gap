// backend/admin/membership.js — the Members page: the current roster, former
// members, and who was in the guild on a given night.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const { listMembers } = require('../discord');
const { todayInGuildTz } = require('../loa');
const createMembership = require('../membership');

const { DATE_RE } = createMembership;

module.exports = function registerMembership(router, ctx) {
  const { supabase, identities } = ctx;
  const membership = supabase ? createMembership(supabase, listMembers, identities) : null;

  // ?on=YYYY-MM-DD adds who held the role that night. A night that hasn't
  // happened yet has no answer — it would just be today's roster presented as
  // a prediction.
  router.get('/membership', async (req, res) => {
    if (!membership) return res.status(503).json({ error: 'Database not configured.' });
    const on = req.query.on ? String(req.query.on) : null;
    if (on && !DATE_RE.test(on)) return res.status(400).json({ error: 'Date must be in YYYY-MM-DD format.' });
    if (on && on > todayInGuildTz()) return res.status(400).json({ error: "That night hasn't happened yet." });
    try {
      res.json(await membership.read({ on }));
    } catch (err) {
      console.error('Membership read failed:', err.message);
      res.status(500).json({ error: 'Could not load the member history.' });
    }
  });
};
