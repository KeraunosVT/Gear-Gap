// backend/polls.js — the bot's own polls (migrations/19_polls.sql).
//
// Members vote with buttons on the bot's post and only ever see how many votes
// each option has; who voted for what is read back only for the officers' "Who
// voted" button. The rules — what a valid poll is, what a click does to a
// member's vote, the counts — are plain functions below so they can be tested
// without a database. Knows nothing about Discord; discordGateway.js draws the
// post and handles the buttons, the same split as eventSignups.js.

const crypto = require('crypto');

const MAX_OPTIONS = 10; // Two rows of five buttons; a third row holds "Who voted".
const MAX_QUESTION = 200;
const MAX_OPTION = 80; // Discord's button label limit.
const MAX_WRITE_IN = 100;
const MAX_CLOSE_DAYS = 30;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const oneLine = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

// A new poll from the officer's form, checked. Blank options are dropped and
// repeats refused, since two buttons with one label can't be told apart.
function cleanPoll({ question, options, multi, writeIn, closesInHours, channelId } = {}, now = Date.now()) {
  const q = oneLine(question, MAX_QUESTION);
  if (!q) throw httpError(400, 'Write the question.');
  const opts = (Array.isArray(options) ? options : []).map((o) => oneLine(o, MAX_OPTION)).filter(Boolean);
  if (opts.length < 2) throw httpError(400, 'A poll needs at least two options.');
  if (opts.length > MAX_OPTIONS) throw httpError(400, `A poll can have at most ${MAX_OPTIONS} options.`);
  if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) throw httpError(400, 'Two options are the same.');
  if (!channelId || !/^\d{5,25}$/.test(String(channelId))) throw httpError(400, 'Pick a channel to post it in.');

  let closesAt = null;
  if (closesInHours !== undefined && closesInHours !== null && closesInHours !== '') {
    const h = Number(closesInHours);
    if (!Number.isFinite(h) || h <= 0) throw httpError(400, 'The close time must be a positive number of hours.');
    if (h > MAX_CLOSE_DAYS * 24) throw httpError(400, `A poll can stay open at most ${MAX_CLOSE_DAYS} days.`);
    closesAt = new Date(now + h * 3_600_000).toISOString();
  }
  return { question: q, options: opts, multi: Boolean(multi), writeIn: Boolean(writeIn), closesAt, channelId: String(channelId) };
}

// A member's typed answer, tidied. Empty means "take my write-in back".
const cleanWriteIn = (text) => oneLine(text, MAX_WRITE_IN);

// What a click on option `index` does to a member's picks. Single choice: it
// becomes their vote, and clicking their current vote again takes it back.
// Multiple choice: it toggles that one option.
function toggleVote(current, index, multi) {
  const had = current.includes(index);
  if (multi) return had ? current.filter((i) => i !== index) : [...current, index].sort((a, b) => a - b);
  return had ? [] : [index];
}

// Votes per option, write-ins, and how many people voted at all — someone who
// only wrote in has voted.
function tally(poll, votes, writeIns = []) {
  const counts = poll.options.map(() => 0);
  const voters = new Set();
  votes.forEach((v) => {
    if (v.option_index >= 0 && v.option_index < counts.length) counts[v.option_index] += 1;
    voters.add(String(v.discord_id));
  });
  writeIns.forEach((w) => voters.add(String(w.discord_id)));
  return { counts, writeIns: writeIns.length, voters: voters.size };
}

// Write-ins without who wrote them, the same answer (ignoring case) counted
// together, most common first.
function groupWriteIns(writeIns) {
  const groups = new Map();
  writeIns.forEach((w) => {
    const key = w.answer.toLowerCase();
    const g = groups.get(key);
    if (g) g.count += 1; else groups.set(key, { answer: w.answer, count: 1 });
  });
  return [...groups.values()].sort((a, b) => b.count - a.count
    || a.answer.localeCompare(b.answer, undefined, { sensitivity: 'base' }));
}

const isOpen = (poll, now = Date.now()) => poll.status === 'open'
  && !(poll.closes_at && Date.parse(poll.closes_at) <= now);

module.exports = function createPolls(supabase) {
  const fail = (what, error) => {
    console.error(`polls.${what} error:`, error?.message);
    return httpError(500, `Failed to ${what.replace(/([A-Z])/g, ' $1').toLowerCase()} — have migrations 19 and 20 been run?`);
  };

  async function load(id) {
    const { data, error } = await supabase.from('polls').select('*').eq('id', id).maybeSingle();
    if (error) throw fail('load', error);
    if (!data) throw httpError(404, 'That poll no longer exists.');
    return data;
  }

  async function votesFor(id) {
    const { data, error } = await supabase.from('poll_votes')
      .select('discord_id, display_name, option_index, voted_at').eq('poll_id', id);
    if (error) throw fail('loadVotes', error);
    return data || [];
  }

  // Takes the poll, not its id: a poll without write-ins never touches the
  // write-in table, so those keep working before migration 20 has run.
  async function writeInsFor(poll) {
    if (!poll.write_in) return [];
    const { data, error } = await supabase.from('poll_write_ins')
      .select('discord_id, display_name, answer, written_at').eq('poll_id', poll.id);
    if (error) throw fail('loadWriteIns', error);
    return data || [];
  }

  async function dropWriteIn(id, discordId) {
    const { error } = await supabase.from('poll_write_ins').delete().eq('poll_id', id).eq('discord_id', String(discordId));
    if (error) throw fail('writeIn', error);
  }

  return {
    load,
    votesFor,
    writeInsFor,

    async create(input, createdBy = null) {
      const clean = cleanPoll(input);
      const row = {
        id: crypto.randomUUID(),
        question: clean.question,
        options: clean.options,
        multi: clean.multi,
        closes_at: clean.closesAt,
        channel_id: clean.channelId,
        created_by: createdBy,
      };
      // Only sent when on, so polls without write-ins don't need migration 20.
      if (clean.writeIn) row.write_in = true;
      const { data, error } = await supabase.from('polls').insert(row).select('*').single();
      if (error || !data) throw fail('create', error);
      return data;
    },

    // Everyone's polls, newest first, with their counts — never their voters.
    async list() {
      const { data, error } = await supabase.from('polls').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) throw fail('list', error);
      const polls = data || [];
      if (!polls.length) return [];
      const { data: votes, error: vErr } = await supabase.from('poll_votes')
        .select('poll_id, discord_id, option_index').in('poll_id', polls.map((p) => p.id));
      if (vErr) throw fail('list', vErr);
      const withWriteIns = polls.filter((p) => p.write_in).map((p) => p.id);
      let writeIns = [];
      if (withWriteIns.length) {
        const { data: w, error: wErr } = await supabase.from('poll_write_ins')
          .select('poll_id, discord_id, answer').in('poll_id', withWriteIns);
        if (wErr) throw fail('list', wErr);
        writeIns = w || [];
      }
      return polls.map((p) => {
        const mine = writeIns.filter((w) => w.poll_id === p.id);
        const t = tally(p, (votes || []).filter((v) => v.poll_id === p.id), mine);
        return {
          ...p, open: isOpen(p), counts: t.counts, voter_count: t.voters,
          write_in_count: t.writeIns, write_ins: groupWriteIns(mine),
        };
      });
    },

    // A member's click. Returns their picks afterwards, as option indexes.
    async vote(id, discordId, displayName, index) {
      const poll = await load(id);
      if (!isOpen(poll)) throw httpError(409, 'This poll is closed.');
      if (!Number.isInteger(index) || index < 0 || index >= poll.options.length) throw httpError(400, 'That option no longer exists.');
      const { data: mine, error } = await supabase.from('poll_votes')
        .select('option_index').eq('poll_id', id).eq('discord_id', String(discordId));
      if (error) throw fail('vote', error);
      const next = toggleVote((mine || []).map((v) => v.option_index), index, poll.multi);

      const { error: delErr } = await supabase.from('poll_votes').delete().eq('poll_id', id).eq('discord_id', String(discordId));
      if (delErr) throw fail('vote', delErr);
      if (next.length) {
        const { error: insErr } = await supabase.from('poll_votes').insert(next.map((i) => ({
          poll_id: id, discord_id: String(discordId), display_name: String(displayName || '').slice(0, 120), option_index: i,
        })));
        if (insErr) throw fail('vote', insErr);
        // Single choice: picking an option replaces a write-in.
        if (poll.write_in && !poll.multi) await dropWriteIn(id, discordId);
      }
      return { poll, choices: next };
    },

    // What the member wrote last time, to fill in the box again ('' if none).
    async myWriteIn(id, discordId) {
      const poll = await load(id);
      if (!poll.write_in) return { poll, answer: '' };
      const { data, error } = await supabase.from('poll_write_ins')
        .select('answer').eq('poll_id', id).eq('discord_id', String(discordId)).maybeSingle();
      if (error) throw fail('writeIn', error);
      return { poll, answer: data?.answer || '' };
    },

    // Saves a member's own answer, replacing any earlier one; empty takes it
    // back. Single choice: a write-in replaces their option vote.
    async writeIn(id, discordId, displayName, text) {
      const poll = await load(id);
      if (!isOpen(poll)) throw httpError(409, 'This poll is closed.');
      if (!poll.write_in) throw httpError(400, "This poll doesn't take written answers.");
      const answer = cleanWriteIn(text);
      await dropWriteIn(id, discordId);
      if (answer) {
        const { error } = await supabase.from('poll_write_ins').insert({
          poll_id: id, discord_id: String(discordId), display_name: String(displayName || '').slice(0, 120), answer,
        });
        if (error) throw fail('writeIn', error);
        if (!poll.multi) {
          const { error: delErr } = await supabase.from('poll_votes').delete().eq('poll_id', id).eq('discord_id', String(discordId));
          if (delErr) throw fail('writeIn', delErr);
        }
      }
      return { poll, answer };
    },

    async setMessage(id, channelId, messageId) {
      const { error } = await supabase.from('polls').update({ channel_id: channelId, message_id: messageId }).eq('id', id);
      if (error) throw fail('setMessage', error);
    },

    async close(id) {
      const { data, error } = await supabase.from('polls')
        .update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', id).select('*').maybeSingle();
      if (error) throw fail('close', error);
      if (!data) throw httpError(404, 'That poll no longer exists.');
      return data;
    },

    async remove(id) {
      const poll = await load(id);
      const { error } = await supabase.from('polls').delete().eq('id', id);
      if (error) throw fail('remove', error);
      return poll;
    },

    // Open polls whose close time has passed, for the bot's minute sweep.
    async dueToClose() {
      const { data, error } = await supabase.from('polls').select('*')
        .eq('status', 'open').not('closes_at', 'is', null).lte('closes_at', new Date().toISOString());
      if (error) { console.error('polls.dueToClose error:', error.message); return []; }
      return data || [];
    },
  };
};

module.exports.cleanPoll = cleanPoll;
module.exports.toggleVote = toggleVote;
module.exports.tally = tally;
module.exports.groupWriteIns = groupWriteIns;
module.exports.cleanWriteIn = cleanWriteIn;
module.exports.isOpen = isOpen;
module.exports.MAX_OPTIONS = MAX_OPTIONS;
module.exports.MAX_WRITE_IN = MAX_WRITE_IN;
