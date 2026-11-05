// backend/admin.js — the officer API, mounted at /api/admin behind requireAdminArea.
//
// This file builds the services every feature shares and hands them to the
// feature files in ./admin/, each of which registers its routes onto this one
// router. Registering onto the same router (rather than mounting sub-routers)
// keeps router.stack flat, which the tests rely on to find a handler by path.
// Access is decided by route prefix in permissions.js, so moving a route
// between files changes nothing about who can call it.
const express = require('express');
const { listMembers } = require('./discord');
const createLoa = require('./loa');
const { todayInGuildTz } = createLoa;
const createAttendance = require('./attendance');
const createEventSignups = require('./eventSignups');
const createGuildSettings = require('./guildSettings');
const createLateAttendance = require('./lateAttendance');
const createEventDetail = require('./eventDetail');
const createAttendanceHistory = require('./attendanceHistory');
const createDepartedRequests = require('./departedRequests');
const createMemberTenure = require('./memberTenure');

// In registration order. Prefixes don't overlap between files, so the order
// only matters within a file, where each keeps the order it always had.
const FEATURES = [
  require('./admin/settings'),
  require('./admin/members'),
  require('./admin/loot'),
  require('./admin/lootCurrency'),
  require('./admin/names'),
  require('./admin/lootItems'),
  require('./admin/parties'),
  require('./admin/warRecord'),
  require('./admin/attendance'),
  require('./admin/signups'),
  require('./admin/schedule'),
  require('./admin/scouting'),
];

module.exports = function createAdminRouter(supabase, gateway, lootCatalog, identities) {
  const router = express.Router();
  const attendance = supabase ? createAttendance(supabase) : null;
  const loa = supabase ? createLoa(supabase, identities) : null;
  const signups = supabase ? createEventSignups(supabase, identities, loa) : null;
  const guildSettings = supabase ? createGuildSettings(supabase) : null;
  const lateAttendance = supabase ? createLateAttendance(supabase, identities) : null;
  const attendanceHistory = supabase ? createAttendanceHistory(supabase) : null;
  // Read-only here: the sweep that writes member_tenure runs from server.js.
  const tenure = supabase ? createMemberTenure(supabase) : null;
  const loadTenure = () => (tenure ? tenure.load() : Promise.resolve(new Map()));
  // The officer-run half of the former-member cleanup. The hourly sweep is a
  // separate instance started in server.js; the two share no state, and need
  // none — clear() re-checks the member list itself.
  const departed = supabase
    ? createDepartedRequests(supabase, listMembers, { deleteLoaMessage: gateway?.deleteLoaMessage })
    : null;
  // One assembler for a logged night, shared with the member-facing route in
  // server.js. Both must describe the same night; see eventDetail.js's header.
  const eventDetail = supabase
    ? createEventDetail(supabase, { identities, loa, signups, lateAttendance, listMembers, tenure })
    : null;

  // ── THE TIME WINDOW, RESOLVED ONCE ──────────────────────────────────────────
  // ?window=7|14|30|all, defaulting to 30. Used by the event list AND the
  // attendance-rate table, from this one helper — two copies of the arithmetic
  // is how the list and the rate come to disagree about which nights count,
  // which shows up as rates that don't match the events on screen.
  //
  // The cutoff is (days - 1) back from today so `window=7` means "this night and
  // the six before it" — seven nights, which is what someone picking "7 days"
  // is counting.
  const WINDOWS = { 7: 7, 14: 14, 30: 30 };
  function attendanceWindow(req) {
    const raw = String(req.query.window || '30');
    if (raw === 'all') return { days: null, since: null };
    const days = WINDOWS[raw] || 30;
    const today = todayInGuildTz();
    const since = new Date(new Date(`${today}T12:00:00Z`).getTime() - (days - 1) * 86_400_000)
      .toISOString().slice(0, 10);
    return { days, since };
  }

  router.get('/whoami', (req, res) => {
    res.json({ admin: true, username: req.user.username });
  });

  const ctx = {
    supabase, gateway, lootCatalog, identities,
    attendance, loa, signups, guildSettings, lateAttendance, attendanceHistory,
    tenure, loadTenure, departed, eventDetail, attendanceWindow,
  };
  for (const register of FEATURES) register(router, ctx);

  return router;
};
