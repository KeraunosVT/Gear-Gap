// backend/attendanceHistory.js — attendance totals carried over from TLGM.
//
// TLGM exports one row per member: in-game name, Discord username, and how many
// activities they attended out of how many they could have. There is no
// per-night detail, so this can't become events — it is stored as-is in
// attendance_history and shown beside the app's own rates (see migration 027
// for why it is not added into them).
//
// Split in two: parseTlgm() is pure (buffer + member list + identities in, a
// preview out) so the import can be previewed and tested without a database;
// the factory below does the reads and writes.
const Papa = require('papaparse');

const SOURCE = 'tlgm';

const norm = (s) => (s || '').trim().toLowerCase();
const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

// TLGM's column names, lower-cased, mapped onto ours. The aliases are the
// obvious variants — a hand-edited copy loses capitals and gains spaces.
const HEADER_MAP = {
  username: 'name', 'in-game name': 'name', 'ingame name': 'name', character: 'name', name: 'name',
  'discord username': 'discord', discord: 'discord', 'discord name': 'discord',
  'attended activities': 'attended', attended: 'attended',
  'total activities': 'total', total: 'total',
  'join date': 'joined', joined: 'joined', 'date joined': 'joined', 'joined at': 'joined',
};

// TLGM's "Join Date" — when they joined the guild in game, which is a better
// answer to "since when is this person ours" than anything Discord holds (see
// memberTenure.js). Written day-first with a time: "26/04/2026 04:10", in US
// Eastern wall-clock time — TLGM's export says no zone, but this guild's export
// is Eastern. America/New_York rather than a fixed UTC-5, so a summer join
// reads as EDT the way the export's clock did. ISO is accepted too, for a
// hand-edited copy. Anything else, or a date in the future, is null — a guessed
// join date would quietly move someone's denominator, which is worse than
// leaving it to the Discord fallback.
const TLGM_TZ = 'America/New_York';

// How far `tz` is ahead of UTC at instant `ms`, in ms (negative for the Americas).
function tzOffset(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - ms;
}

// A wall-clock time in `tz` as a UTC instant. The offset is taken twice
// because the first guess can land on the other side of a DST change.
function wallClockToUtc(y, mo, d, h, mi, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const first = naive - tzOffset(naive, tz);
  return naive - tzOffset(first, tz);
}

function toJoinedAt(v) {
  const s = String(v ?? '').trim();
  let y; let mo; let d; let h = 12; let mi = 0;
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) {
    [d, mo, y] = [m[1], m[2], m[3]].map(Number);
    if (m[4] !== undefined) { h = Number(m[4]); mi = Number(m[5]); }
  } else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/))) {
    [y, mo, d] = [m[1], m[2], m[3]].map(Number);
    if (m[4] !== undefined) { h = Number(m[4]); mi = Number(m[5]); }
  } else {
    return null;
  }
  // Date.UTC rolls 31/02 into March rather than refusing it, so the calendar
  // date is checked before any zone shifts it.
  const cal = new Date(Date.UTC(y, mo - 1, d));
  if (cal.getUTCFullYear() !== y || cal.getUTCMonth() !== mo - 1 || cal.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59) return null;
  const at = wallClockToUtc(y, mo, d, h, mi, TLGM_TZ);
  if (at > Date.now()) return null;
  return new Date(at).toISOString();
}

// ── Text that went through Excel ───────────────────────────────────────────
// TLGM writes UTF-8. Opened in Excel and saved again, a name like a Japanese
// one comes back as "ã‚™ã‚“" — its UTF-8 bytes read one by one as Windows-1252
// characters. Two layers can be wrong, and each is undone separately:
//
//   - the file's own encoding: if it isn't valid UTF-8 any more, read it as
//     Windows-1252, which is what Excel saves a "CSV" as;
//   - each name: if its characters, turned back into Windows-1252 bytes, form
//     valid UTF-8, those bytes were the real name.
//
// The second check is strict on purpose (fatal decoding, and every character
// has to map to a byte), so a name that is genuinely "Ã©" stays "Ã©" unless it
// also happens to be a valid UTF-8 sequence — which real names essentially
// never are.
const CP1252 = new TextDecoder('windows-1252');
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
const CHAR_TO_BYTE = new Map();
for (let b = 0; b < 256; b++) CHAR_TO_BYTE.set(CP1252.decode(Uint8Array.of(b)), b);

function decodeFile(buffer) {
  let text;
  try {
    text = UTF8_STRICT.decode(buffer);
  } catch {
    text = CP1252.decode(buffer);
  }
  return text.replace(/^﻿/, '');
}

function repairMojibake(s) {
  // eslint-disable-next-line no-control-regex
  if (!s || /^[\x00-\x7F]*$/.test(s)) return s;
  const bytes = [];
  for (const ch of s) {
    const b = CHAR_TO_BYTE.get(ch);
    if (b === undefined) return s; // a character Windows-1252 can't hold: not mojibake
    bytes.push(b);
  }
  try {
    return UTF8_STRICT.decode(Uint8Array.from(bytes));
  } catch {
    return s;
  }
}

// Whole numbers only; "1,234" tolerated. Anything else is null, not 0 — a
// blank cell read as zero attendance would be a fact nobody stated.
function toCount(v) {
  const s = String(v ?? '').replace(/[, ]/g, '');
  if (!/^\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

// Who each row is, in order of how sure the match is:
//   1. the Discord username — unique, and exactly what Discord calls them
//   2. the in-game name, through player_identities
//   3. the in-game name against a member's server nickname
// Every match must be a CURRENT member. Someone who has left would only add a
// row to the table for a person the departed sweep is clearing out everywhere
// else.
function parseTlgm(buffer, members, ids) {
  const parsed = Papa.parse(decodeFile(buffer), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => HEADER_MAP[norm(h)] || norm(h),
  });
  const fields = parsed.meta?.fields || [];
  const missing = ['discord', 'attended', 'total'].filter((f) => !fields.includes(f));
  if (missing.length) {
    const labels = { discord: 'Discord Username', attended: 'Attended Activities', total: 'Total Activities' };
    return { error: `This doesn't look like a TLGM export — no ${missing.map((m) => `"${labels[m]}"`).join(', ')} column.` };
  }

  const current = new Map(members.map((m) => [String(m.id), m]));
  const byUsername = new Map();
  const byNick = new Map();
  members.forEach((m) => {
    if (m.username) byUsername.set(norm(m.username), m);
    if (m.name) byNick.set(norm(m.name), m);
  });

  const rows = [];
  const skipped = [];
  const taken = new Map(); // discord_id -> row number that claimed it

  (parsed.data || []).forEach((raw, idx) => {
    const rowNum = idx + 2; // the header is row 1
    const name = repairMojibake(clean(raw.name));
    const discordName = clean(raw.discord);
    const label = name || discordName || `row ${rowNum}`;
    const skip = (reason) => skipped.push({ row: rowNum, name: label, discord_username: discordName, reason });

    const attended = toCount(raw.attended);
    const total = toCount(raw.total);
    if (attended === null || total === null) return skip('Attended or total activities is not a whole number.');
    if (attended > total) return skip(`Attended (${attended}) is more than the total (${total}).`);
    if (total === 0) return skip('No TLGM activities to carry over.');

    let member = discordName ? byUsername.get(norm(discordName)) : null;
    let matchedBy = 'discord username';
    const viaIdentity = !member && name ? ids.discordIdFor(name) : null;
    if (viaIdentity) {
      member = current.get(String(viaIdentity));
      matchedBy = 'in-game name';
    }
    if (!member && name) {
      member = byNick.get(norm(name));
      matchedBy = 'server nickname';
    }
    if (!member) {
      return skip(viaIdentity
        ? 'Matched a player who is no longer a guild member.'
        : `No current member with Discord username "${discordName ?? ''}" or name "${name ?? ''}".`);
    }

    const id = String(member.id);
    if (taken.has(id)) return skip(`Same member as row ${taken.get(id)}.`);
    taken.set(id, rowNum);

    rows.push({
      row: rowNum,
      discord_id: id,
      display_name: ids.displayNameFor(id, member.name),
      source_name: name,
      attended,
      total,
      matched_by: matchedBy,
      // null when the column is missing or unreadable; the row still imports,
      // only the join date falls back to Discord's.
      joined_at: fields.includes('joined') ? toJoinedAt(raw.joined) : null,
      joined_raw: clean(raw.joined),
    });
  });

  return { rows, skipped };
}

module.exports = function createAttendanceHistory(supabase) {
  return {
    async list() {
      const { data, error } = await supabase.from('attendance_history')
        .select('discord_id, display_name, source_name, attended, total, imported_at')
        .eq('source', SOURCE);
      if (error) throw new Error(error.message);
      return data || [];
    },

    // Upsert first, then remove whoever this file no longer lists. The other
    // order — clear, then insert — leaves the table empty if the insert fails,
    // and a re-import is exactly when nobody expects to lose what was there.
    async replace(rows, importedBy) {
      const now = new Date().toISOString();
      const { error } = await supabase.from('attendance_history').upsert(rows.map((r) => ({
        source: SOURCE,
        discord_id: r.discord_id,
        display_name: r.display_name,
        source_name: r.source_name,
        attended: r.attended,
        total: r.total,
        imported_at: now,
        imported_by: importedBy,
      })));
      if (error) throw new Error(error.message);

      // Discord ids are digits, so they need no quoting inside the in-list.
      const keep = rows.map((r) => r.discord_id).filter((id) => /^\d+$/.test(id));
      let del = supabase.from('attendance_history').delete().eq('source', SOURCE);
      if (keep.length) del = del.not('discord_id', 'in', `(${keep.join(',')})`);
      const { error: delErr } = await del;
      if (delErr) throw new Error(delErr.message);
    },

    async clear() {
      const { error } = await supabase.from('attendance_history').delete().eq('source', SOURCE);
      if (error) throw new Error(error.message);
    },
  };
};

module.exports.parseTlgm = parseTlgm;
module.exports.repairMojibake = repairMojibake;
module.exports.toJoinedAt = toJoinedAt;
