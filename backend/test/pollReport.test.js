// backend/test/pollReport.test.js — the "Check poll votes" report.
//
// Who voted for what and who hasn't, against the member list. What breaks
// quietly here is the arithmetic (a non-member counted as a member, a
// multiple-choice voter counted twice) and the 2000-character limit, which
// Discord enforces by refusing the whole reply.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { pollReport } = require('../discordGateway').__test;

const roster = [{ id: '1', name: 'Ana' }, { id: '2', name: 'Bo' }, { id: '3', name: 'Cy' }];
const names = { 1: 'Ana', 2: 'Bo', 3: 'Cy', 9: 'Visitor' };
const nameFor = (id) => names[id] || `<@${id}>`;

describe('pollReport', () => {
  test("lists each answer's voters and the members who haven't voted", () => {
    const [msg, ...rest] = pollReport({
      question: 'Raid Saturday?',
      answers: [{ text: 'Yes', voterIds: ['2', '1'] }, { text: 'No', voterIds: [] }],
      roster, nameFor,
    });
    assert.equal(rest.length, 0);
    assert.match(msg, /\*\*Raid Saturday\?\*\*/);
    assert.match(msg, /\*\*2 of 3\*\* members have voted/);
    assert.match(msg, /\*\*Yes \(2\)\*\*\nAna, Bo/);
    assert.match(msg, /\*\*No \(0\)\*\*\n—/);
    assert.match(msg, /Haven't voted \(1\)\*\*\nCy/);
  });

  test('a multiple-choice voter counts once; a non-member is listed but never counted', () => {
    const [msg] = pollReport({
      question: 'Which nights?',
      answers: [{ text: 'Fri', voterIds: ['1', '9'] }, { text: 'Sat', voterIds: ['1'] }],
      roster, nameFor,
    });
    assert.match(msg, /\*\*1 of 3\*\* members have voted/);
    assert.match(msg, /Ana, Visitor \*\(not a member\)\*/);
    assert.match(msg, /Haven't voted \(2\)\*\*\nBo, Cy/);
  });

  test('everyone voted, and a closed poll says so', () => {
    const [msg] = pollReport({
      question: 'Done?', answers: [{ text: 'Yes', voterIds: ['1', '2', '3'] }], roster, nameFor, closed: true,
    });
    assert.match(msg, /\*\*Done\?\*\* \(closed\)/);
    assert.match(msg, /Everyone has voted/);
  });

  test('a big guild is split into messages under 2000 characters, losing nobody', () => {
    const big = Array.from({ length: 400 }, (_, i) => ({ id: String(1000 + i), name: `Member Number ${i}` }));
    const bigName = (id) => big.find((m) => m.id === id)?.name || id;
    const msgs = pollReport({
      question: 'Big poll', answers: [{ text: 'Yes', voterIds: big.slice(0, 150).map((m) => m.id) }],
      roster: big, nameFor: bigName,
    });
    assert.ok(msgs.length > 1);
    msgs.forEach((m) => assert.ok(m.length <= 2000, `message of ${m.length} characters`));
    const all = msgs.join('\n');
    big.forEach((m) => assert.ok(all.includes(m.name), `${m.name} missing`));
  });
});
