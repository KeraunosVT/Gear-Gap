// backend/questionnaires.js — the bot's questionnaires (migrations/21_questionnaires.sql).
//
// A questionnaire is up to five questions, each either picked from a list
// (one, or several) or typed. Members answer in a Discord form opened from the
// bot's post, and can open it again to change their answers. Like polls
// (polls.js), who answered what is read back only for the officers'
// "Responses" button; the website gets counts and typed answers, never names.
// The rules are plain functions below so they can be tested without a
// database; discordGateway.js draws the post and the form.

const crypto = require('crypto');
const { httpError, oneLine, cleanChannel, cleanClosesAt, isOpen } = require('./polls');

const MAX_QUESTIONS = 5; // A Discord form holds five.
const MAX_TITLE = 100;
const MAX_INTRO = 500;
const MAX_QUESTION = 100; // The form shows 45 as the label, the rest beneath.
const MAX_CHOICES = 25; // A Discord dropdown's limit.
const MAX_CHOICE = 100;
const MAX_ANSWER = 1000;

const TYPES = ['choice', 'text'];

// A typed answer: kept on several lines, but no runs of blank ones.
const cleanText = (v) => String(v ?? '').replace(/\r\n?/g, '\n').split('\n')
  .map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_ANSWER);

// A new questionnaire from the officer's form, checked.
function cleanQuestionnaire({ title, intro, questions, closesInHours, channelId } = {}, now = Date.now()) {
  const t = oneLine(title, MAX_TITLE);
  if (!t) throw httpError(400, 'Give the questionnaire a title.');
  const list = Array.isArray(questions) ? questions : [];
  if (!list.length) throw httpError(400, 'Add at least one question.');
  if (list.length > MAX_QUESTIONS) throw httpError(400, `A questionnaire can have at most ${MAX_QUESTIONS} questions.`);

  const qs = list.map((q, i) => {
    const n = i + 1;
    const type = TYPES.includes(q?.type) ? q.type : null;
    if (!type) throw httpError(400, `Question ${n} needs a type.`);
    const text = oneLine(q.text, MAX_QUESTION);
    if (!text) throw httpError(400, `Write question ${n}.`);
    const required = q.required !== false;
    if (type === 'text') return { type, text, required };

    const options = (Array.isArray(q.options) ? q.options : []).map((o) => oneLine(o, MAX_CHOICE)).filter(Boolean);
    if (options.length < 2) throw httpError(400, `Question ${n} needs at least two choices.`);
    if (options.length > MAX_CHOICES) throw httpError(400, `Question ${n} can have at most ${MAX_CHOICES} choices.`);
    if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw httpError(400, `Question ${n} has two choices that are the same.`);
    return { type, text, required, options, multi: Boolean(q.multi) };
  });

  return {
    title: t,
    intro: cleanText(intro).slice(0, MAX_INTRO),
    questions: qs,
    closesAt: cleanClosesAt(closesInHours, now),
    channelId: cleanChannel(channelId),
  };
}

// A member's form, checked against the questions. `raw` lines up with the
// questions: a list of picked choice numbers for a choice question, the text
// for a typed one. Returns the answers in the same shape: [] or '' for one
// left blank.
function cleanAnswers(questionnaire, raw) {
  const given = Array.isArray(raw) ? raw : [];
  return questionnaire.questions.map((q, i) => {
    const n = i + 1;
    if (q.type === 'text') {
      const text = cleanText(given[i]);
      if (q.required && !text) throw httpError(400, `Answer question ${n}.`);
      return text;
    }
    const picked = [...new Set((Array.isArray(given[i]) ? given[i] : []).map(Number))].sort((a, b) => a - b);
    if (picked.some((p) => !Number.isInteger(p) || p < 0 || p >= q.options.length)) throw httpError(400, `Question ${n} has a choice that no longer exists.`);
    if (!q.multi && picked.length > 1) throw httpError(400, `Pick only one answer for question ${n}.`);
    if (q.required && !picked.length) throw httpError(400, `Answer question ${n}.`);
    return picked;
  });
}

const isBlank = (answers) => answers.every((a) => (Array.isArray(a) ? !a.length : !a));

// What the website shows: per question, the count for each choice or the
// typed answers — never who gave them.
function summarize(questionnaire, responses) {
  return {
    respondents: responses.length,
    results: questionnaire.questions.map((q, i) => {
      if (q.type === 'text') {
        return { answers: responses.map((r) => r.answers?.[i]).filter((a) => typeof a === 'string' && a) };
      }
      const counts = q.options.map(() => 0);
      responses.forEach((r) => (Array.isArray(r.answers?.[i]) ? r.answers[i] : []).forEach((p) => {
        if (p >= 0 && p < counts.length) counts[p] += 1;
      }));
      return { counts };
    }),
  };
}

module.exports = function createQuestionnaires(supabase) {
  const fail = (what, error) => {
    console.error(`questionnaires.${what} error:`, error?.message);
    return httpError(500, `Failed to ${what.replace(/([A-Z])/g, ' $1').toLowerCase()} — has migration 21 been run?`);
  };

  async function load(id) {
    const { data, error } = await supabase.from('questionnaires').select('*').eq('id', id).maybeSingle();
    if (error) throw fail('load', error);
    if (!data) throw httpError(404, 'That questionnaire no longer exists.');
    return data;
  }

  async function responsesFor(id) {
    const { data, error } = await supabase.from('questionnaire_responses')
      .select('discord_id, display_name, answers, responded_at').eq('questionnaire_id', id);
    if (error) throw fail('loadResponses', error);
    return data || [];
  }

  return {
    load,
    responsesFor,

    async create(input, createdBy = null) {
      const clean = cleanQuestionnaire(input);
      const row = {
        id: crypto.randomUUID(),
        title: clean.title,
        intro: clean.intro,
        questions: clean.questions,
        closes_at: clean.closesAt,
        channel_id: clean.channelId,
        created_by: createdBy,
      };
      const { data, error } = await supabase.from('questionnaires').insert(row).select('*').single();
      if (error || !data) throw fail('create', error);
      return data;
    },

    // Newest first, each with its summary — never who answered.
    async list() {
      const { data, error } = await supabase.from('questionnaires').select('*').order('created_at', { ascending: false }).limit(100);
      if (error) throw fail('list', error);
      const list = data || [];
      if (!list.length) return [];
      const { data: responses, error: rErr } = await supabase.from('questionnaire_responses')
        .select('questionnaire_id, answers').in('questionnaire_id', list.map((q) => q.id));
      if (rErr) throw fail('list', rErr);
      return list.map((q) => ({
        ...q, open: isOpen(q), ...summarize(q, (responses || []).filter((r) => r.questionnaire_id === q.id)),
      }));
    },

    // Their earlier answers, to fill the form in again (null if none).
    async myResponse(id, discordId) {
      const questionnaire = await load(id);
      const { data, error } = await supabase.from('questionnaire_responses')
        .select('answers').eq('questionnaire_id', id).eq('discord_id', String(discordId)).maybeSingle();
      if (error) throw fail('loadResponse', error);
      return { questionnaire, answers: data?.answers || null };
    },

    // Saves a member's form, replacing their earlier one. A form left
    // entirely blank (only possible when nothing is required) takes it back.
    async respond(id, discordId, displayName, raw) {
      const questionnaire = await load(id);
      if (!isOpen(questionnaire)) throw httpError(409, 'This questionnaire is closed.');
      const answers = cleanAnswers(questionnaire, raw);
      const { error: delErr } = await supabase.from('questionnaire_responses')
        .delete().eq('questionnaire_id', id).eq('discord_id', String(discordId));
      if (delErr) throw fail('respond', delErr);
      if (isBlank(answers)) return { questionnaire, answers, removed: true };
      const { error } = await supabase.from('questionnaire_responses').insert({
        questionnaire_id: id, discord_id: String(discordId), display_name: String(displayName || '').slice(0, 120), answers,
      });
      if (error) throw fail('respond', error);
      return { questionnaire, answers, removed: false };
    },

    async setMessage(id, channelId, messageId) {
      const { error } = await supabase.from('questionnaires').update({ channel_id: channelId, message_id: messageId }).eq('id', id);
      if (error) throw fail('setMessage', error);
    },

    async close(id) {
      const { data, error } = await supabase.from('questionnaires')
        .update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', id).select('*').maybeSingle();
      if (error) throw fail('close', error);
      if (!data) throw httpError(404, 'That questionnaire no longer exists.');
      return data;
    },

    async remove(id) {
      const questionnaire = await load(id);
      const { error } = await supabase.from('questionnaires').delete().eq('id', id);
      if (error) throw fail('remove', error);
      return questionnaire;
    },

    // Open ones whose close time has passed, for the bot's minute sweep.
    // Quiet before migration 21, so the sweep doesn't log every minute.
    async dueToClose() {
      const { data, error } = await supabase.from('questionnaires').select('*')
        .eq('status', 'open').not('closes_at', 'is', null).lte('closes_at', new Date().toISOString());
      if (error) return [];
      return data || [];
    },
  };
};

module.exports.cleanQuestionnaire = cleanQuestionnaire;
module.exports.cleanAnswers = cleanAnswers;
module.exports.summarize = summarize;
module.exports.isBlank = isBlank;
module.exports.LIMITS = {
  questions: MAX_QUESTIONS, title: MAX_TITLE, intro: MAX_INTRO, question: MAX_QUESTION,
  choices: MAX_CHOICES, choice: MAX_CHOICE, answer: MAX_ANSWER,
};
