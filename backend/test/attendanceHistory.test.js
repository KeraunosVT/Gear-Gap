// backend/test/attendanceHistory.test.js — reading a TLGM member export.
//
// The rows here are shaped like the real export: every TLGM column, the
// Discord username as the account handle, and one in-game name that went
// through Excel and came back as mojibake.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseTlgm, repairMojibake } = require('../attendanceHistory');

const HEADER = 'Username,Discord Username,Role,Rank,Status,Primary Weapon,Secondary Weapon,Custom Role,Subguild,'
  + 'DKP Balance,Gearscore,Activity Points,Total Activities,Attended Activities,Attendance %,No Reply %,Gear Updated,Note,Join Date';
const row = (name, discord, total, attended) =>
  `${name},${discord},healer,member,active,orb,wand_and_tome,Not set,Not set,0,7000,${attended},${total},${attended},0%,0%,Yes,,26/04/2026 04:10`;
const csv = (...rows) => Buffer.from([HEADER, ...rows].join('\n'), 'utf8');

const members = [
  { id: '100', name: 'Boharding', username: 'boharding' },
  { id: '200', name: 'Azzy', username: 'burberries8' },
  { id: '300', name: 'Bladurken', username: 'someoneelse' },
  { id: '400', name: 'Kera', username: 'kera' },
];

// The two lookups parseTlgm uses from an identities snapshot.
const identities = (byName = {}, names = {}) => ({
  discordIdFor: (n) => byName[n.trim().toLowerCase()] || null,
  displayNameFor: (id, fallback) => names[id] || fallback,
});

describe('parseTlgm', () => {
  test('matches on Discord username and keeps the counts', () => {
    const { rows, skipped } = parseTlgm(csv(row('Boharding', 'boharding', 775, 496)), members, identities());
    assert.deepEqual(skipped, []);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { id: rows[0].discord_id, attended: rows[0].attended, total: rows[0].total, by: rows[0].matched_by },
      { id: '100', attended: 496, total: 775, by: 'discord username' },
    );
  });

  test('a Discord username that matches no one falls back to the in-game name', () => {
    const { rows } = parseTlgm(
      csv(row('Kerazzz', 'renamed_account', 10, 5)),
      members,
      identities({ kerazzz: '400' }),
    );
    assert.equal(rows[0].discord_id, '400');
    assert.equal(rows[0].matched_by, 'in-game name');
  });

  test('the in-game name can match a server nickname', () => {
    const { rows } = parseTlgm(csv(row('Bladurken', 'ebonylobster', 439, 295)), members, identities());
    assert.equal(rows[0].discord_id, '300');
    assert.equal(rows[0].matched_by, 'server nickname');
  });

  test('a player who left is skipped, not imported', () => {
    const { rows, skipped } = parseTlgm(
      csv(row('Gone', 'gone_user', 10, 5)),
      members,
      identities({ gone: '999' }),
    );
    assert.equal(rows.length, 0);
    assert.match(skipped[0].reason, /no longer a guild member/);
  });

  test('unknown players, bad numbers, empty totals and duplicates are each skipped with a reason', () => {
    const { rows, skipped } = parseTlgm(csv(
      row('Nobody', 'nobody', 10, 5),
      row('Boharding', 'boharding', 10, 'x'),
      row('Boharding', 'boharding', 5, 9),
      row('Boons', 'kera', 0, 0),
      row('Boharding', 'boharding', 775, 496),
      row('Bohardingalt', 'boharding', 20, 10),
    ), members, identities());
    assert.equal(rows.length, 1);
    assert.deepEqual(skipped.map((s) => s.row), [2, 3, 4, 5, 7]);
    assert.match(skipped[4].reason, /Same member as row 6/);
  });

  test('uses the mapped display name', () => {
    const { rows } = parseTlgm(
      csv(row('Azriel', 'burberries8', 12, 7)),
      members,
      identities({}, { 200: 'Azriel' }),
    );
    assert.equal(rows[0].display_name, 'Azriel');
  });

  test('a file without the TLGM columns is refused', () => {
    const result = parseTlgm(Buffer.from('member,amount\nKera,5'), members, identities());
    assert.match(result.error, /doesn't look like a TLGM export/);
  });

  test('reads a file Excel re-saved as Windows-1252', () => {
    // "Boomäff" in Windows-1252 bytes: ä is 0xE4, which is not valid UTF-8 on its own.
    const latin = Buffer.concat([
      Buffer.from(`${HEADER}\n(pullonme)Boom`), Buffer.from([0xE4]),
      Buffer.from(`ff,kensei5134,tank,member,active,a,b,c,d,2,8219,296,367,296,80%,19%,Yes,,x`),
    ]);
    const { rows, skipped } = parseTlgm(latin, [...members, { id: '500', name: 'X', username: 'kensei5134' }], identities());
    assert.deepEqual(skipped, []);
    assert.equal(rows[0].source_name, '(pullonme)Boomäff');
  });
});

describe('repairMojibake', () => {
  test('restores UTF-8 that was read as Windows-1252', () => {
    const original = 'すず6';
    const garbled = new TextDecoder('windows-1252').decode(Buffer.from(original, 'utf8'));
    assert.notEqual(garbled, original);
    assert.equal(repairMojibake(garbled), original);
  });

  test('leaves plain and genuinely accented names alone', () => {
    assert.equal(repairMojibake('Boharding'), 'Boharding');
    assert.equal(repairMojibake('Zoë'), 'Zoë');
    assert.equal(repairMojibake('すず'), 'すず');
  });
});
