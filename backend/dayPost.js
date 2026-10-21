// backend/dayPost.js — one night's events as a Discord post.
//
// Times go out as Discord timestamps (<t:unix:t>, <t:unix:R>), which every
// reader's client renders in their own timezone and keeps counting down live —
// so the post never says "9 PM" to someone for whom it's 3 AM, and never goes
// stale while it sits in the channel.
//
// The event list comes from the officer, not the schedule: the calendar fills
// it in, and the officer adds, edits or drops lines before posting. This module
// only validates and renders.

const createEliteTimers = require('./eliteTimers');
const createLoa = require('./loa');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_EVENTS = 25;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// "21:00" on the night of `date` → unix seconds. An after-midnight time is
// the next calendar day, same as the schedule and resolveStartsAt.
function unixFor(date, time) {
  const [h, m] = time.split(':').map(Number);
  const day = createLoa.isAfterMidnight(time) ? addDays(date, 1) : date;
  return Math.floor(createEliteTimers.guildTimeOn(day, h, m).getTime() / 1000);
}

// Throws a 400 on anything malformed; returns the cleaned events, timed ones
// in start order and untimed ones last.
function normalise({ date, events }) {
  if (!DATE_RE.test(date || '')) throw httpError(400, 'Date must be in YYYY-MM-DD format.');
  if (!Array.isArray(events)) throw httpError(400, 'Events must be a list.');
  const cleaned = events
    .map((e) => ({ name: String(e?.name || '').trim().slice(0, 120), time: e?.time ? String(e.time).slice(0, 5) : null }))
    .filter((e) => e.name);
  if (!cleaned.length) throw httpError(400, 'Add at least one event to post.');
  if (cleaned.length > MAX_EVENTS) throw httpError(400, `At most ${MAX_EVENTS} events in one post.`);
  cleaned.forEach((e) => {
    if (e.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(e.time)) throw httpError(400, `"${e.name}" has an invalid time.`);
  });
  return cleaned
    .map((e) => ({ ...e, unix: e.time ? unixFor(date, e.time) : null }))
    .sort((a, b) => (a.unix ?? Infinity) - (b.unix ?? Infinity) || a.name.localeCompare(b.name));
}

function buildDayPost({ date, events, note = '', house = '' }) {
  const list = normalise({ date, events });
  const dow = new Date(`${date}T12:00:00`).getDay();
  const lines = list.map((e) => (e.unix
    ? `<t:${e.unix}:t> — **${e.name}** · <t:${e.unix}:R>`
    : `Time TBA — **${e.name}**`));
  // The night's date as <t:…:D> (anchored at noon guild time), so it also
  // reads in each viewer's own date format.
  const embed = {
    title: `📅 ${DAY_NAME[dow]}'s events`,
    description: `<t:${unixFor(date, '12:00')}:D>\n\n${lines.join('\n')}`,
    color: 0xc9973a,
    timestamp: new Date().toISOString(),
  };
  if (house) embed.footer = { text: house };
  const content = String(note || '').trim().slice(0, 1500);
  return { content: content || undefined, embeds: [embed] };
}

module.exports = { buildDayPost, unixFor };
