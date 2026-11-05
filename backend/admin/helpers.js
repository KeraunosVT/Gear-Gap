// backend/admin/helpers.js — small helpers more than one admin feature file uses.
const multer = require('multer');
const { countsFor } = require('../memberTenure');

// How many of `events` count against this member: every night since they got
// the member role, plus any night they attended regardless — so a rate can
// never pass 100%, and a trial run before the role still earns its credit.
function eligibleCount(events, tenure, attendedIds) {
  if (!tenure) return events.length;
  let n = 0;
  for (const e of events) {
    if ((attendedIds && attendedIds.has(String(e.id))) || countsFor(tenure, e.event_date)) n++;
  }
  return n;
}

const norm = (s) => (s || '').trim().toLowerCase();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

module.exports = { eligibleCount, norm, upload, clean };
