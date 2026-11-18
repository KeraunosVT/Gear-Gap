// The Polls page's Questionnaires tab: officers write up to five questions,
// each picked from a list or typed, and the bot posts it with a "Fill in"
// button that opens a Discord form. The list shows how many picked each choice
// and the typed answers without names; each card's Responses button opens
// QuestionnaireResponses, which shows who answered what.
import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Plus, X, Loader2, Lock, Trash2, Send, RefreshCw, ClipboardList } from 'lucide-react';
import Button from '../ui/Button';
import EmptyState from '../ui/EmptyState';
import ErrorState from '../ui/ErrorState';
import Tabs from '../ui/Tabs';
import Toast from '../ui/Toast';
import { useFlash } from '../ui/useFlash';
import { fmtDatetime } from '../../timeUtils';
import { FIELD, PostSettings, ResultBar, AnswerList, questionHint as hint } from './PollBits';
import QuestionnaireResponses from './QuestionnaireResponses';

const REFRESH_MS = 60_000;
const DEFAULT_LIMITS = { questions: 5, title: 100, intro: 500, question: 100, choices: 25, choice: 100 };
const TYPE_TABS = [{ key: 'choice', label: 'Choices' }, { key: 'text', label: 'Typed answer' }];

const blankQuestion = () => ({ type: 'choice', text: '', options: ['', ''], multi: false, all: false, required: true });
// "Must pick all" counts only on a pick-several choice question.
const mustPickAll = (q) => q.type === 'choice' && q.multi && q.all;

function QuestionEditor({ q, n, limits, onChange, onRemove }) {
  const set = (patch) => onChange({ ...q, ...patch });
  const setOption = (i, v) => set({ options: q.options.map((x, j) => (j === i ? v : x)) });
  return (
    <div className="rounded-lg border border-line p-3 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="eyebrow text-[10px] text-brass">Question {n}</span>
        <Tabs items={TYPE_TABS} active={q.type} onChange={(type) => set({ type })} />
        {onRemove && (
          <button type="button" onClick={onRemove} className="ml-auto text-ash hover:text-oxblood" aria-label={`Remove question ${n}`}>
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <input value={q.text} maxLength={limits.question} onChange={(e) => set({ text: e.target.value })}
        placeholder={q.type === 'text' ? 'e.g. Anything we should know?' : 'e.g. What is your main role?'} className={FIELD} />
      {q.text.length > 45 && (
        <p className="text-xs text-ash -mt-2">Discord shows the first 45 characters as the label and the whole question beneath it.</p>
      )}

      {q.type === 'choice' && (
        <div>
          <div className="space-y-2">
            {q.options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-ash text-sm w-5 text-right">{i + 1}.</span>
                <input value={o} maxLength={limits.choice} onChange={(e) => setOption(i, e.target.value)}
                  placeholder={`Choice ${i + 1}`} className={FIELD} />
                {q.options.length > 2 && (
                  <button type="button" onClick={() => set({ options: q.options.filter((_, j) => j !== i) })}
                    className="text-ash hover:text-oxblood" aria-label={`Remove choice ${i + 1}`}>
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {q.options.length < limits.choices && (
            <button type="button" onClick={() => set({ options: [...q.options, ''] })}
              className="mt-2 inline-flex items-center gap-1.5 text-sm text-brass hover:text-brassbright">
              <Plus className="w-4 h-4" /> Add choice
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {q.type === 'choice' && (
          <label className="inline-flex items-center gap-2 text-sm text-bone cursor-pointer">
            <input type="checkbox" checked={q.multi} onChange={(e) => set({ multi: e.target.checked })} className="accent-[rgb(var(--color-brass))]" />
            Allow picking several
          </label>
        )}
        {q.type === 'choice' && q.multi && (
          <label className="inline-flex items-center gap-2 text-sm text-bone cursor-pointer">
            <input type="checkbox" checked={q.all} onChange={(e) => set({ all: e.target.checked })} className="accent-[rgb(var(--color-brass))]" />
            Must pick all
          </label>
        )}
        <label className={`inline-flex items-center gap-2 text-sm text-bone ${mustPickAll(q) ? 'opacity-60' : 'cursor-pointer'}`}>
          <input type="checkbox" checked={q.required || mustPickAll(q)} disabled={mustPickAll(q)}
            onChange={(e) => set({ required: e.target.checked })} className="accent-[rgb(var(--color-brass))]" />
          Required
        </label>
      </div>
      {mustPickAll(q) && (
        <p className="text-xs text-ash -mt-1">Members have to tick every choice before the form will send — e.g. rules to confirm they've read.</p>
      )}
    </div>
  );
}

// `viewing`: the questionnaire whose responses are open, if any (kept in the
// URL by the Polls page, so Back returns to the list); `onView(id|null)`.
export default function QuestionnairesPanel({ viewing = null, onView }) {
  const [list, setList] = useState([]);
  const [channels, setChannels] = useState([]);
  const [limits, setLimits] = useState(DEFAULT_LIMITS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, flash] = useFlash();

  const [title, setTitle] = useState('');
  const [intro, setIntro] = useState('');
  const [questions, setQuestions] = useState([blankQuestion()]);
  const [channelId, setChannelId] = useState('');
  const [closesIn, setClosesIn] = useState('72');

  const load = useCallback(() => axios.get('/api/admin/polls/questionnaires')
    .then((res) => {
      setList(res.data.questionnaires || []);
      setChannels(res.data.channels || []);
      if (res.data.limits) setLimits(res.data.limits);
      setChannelId((cur) => cur || res.data.default_channel_id || '');
      setError('');
    })
    .catch((err) => setError(err.response?.data?.error || 'Could not load questionnaires.'))
    .finally(() => setLoading(false)), []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const cleaned = questions.map((q) => ({
    type: q.type, text: q.text.trim(), required: q.required || mustPickAll(q),
    ...(q.type === 'choice' ? { options: q.options.map((o) => o.trim()).filter(Boolean), multi: q.multi, all: mustPickAll(q) } : {}),
  }));
  const ready = cleaned.every((q) => q.text && (q.type === 'text' || q.options.length >= 2));
  const canPost = title.trim() && ready && channelId && !busy;

  const post = async (e) => {
    e.preventDefault();
    if (!canPost) return;
    setBusy('post');
    try {
      await axios.post('/api/admin/polls/questionnaires', {
        title: title.trim(), intro, questions: cleaned, channel_id: channelId, closes_in_hours: closesIn || null,
      });
      flash('Questionnaire posted.');
      setTitle(''); setIntro(''); setQuestions([blankQuestion()]);
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not post the questionnaire.', false);
    } finally {
      setBusy('');
    }
  };

  const act = async (key, confirmText, request, done, failed) => {
    if (!window.confirm(confirmText)) return;
    setBusy(key);
    try {
      await request();
      flash(done);
      load();
    } catch (err) {
      flash(err.response?.data?.error || failed, false);
    } finally {
      setBusy('');
    }
  };
  const close = (q) => act(`close:${q.id}`, `Close "${q.title}"? Nobody can respond after this.`,
    () => axios.post(`/api/admin/polls/questionnaires/${q.id}/close`), 'Questionnaire closed.', 'Could not close it.');
  const remove = (q) => act(`del:${q.id}`, `Delete "${q.title}"? Its responses and its Discord post are deleted too.`,
    () => axios.delete(`/api/admin/polls/questionnaires/${q.id}`), 'Questionnaire deleted.', 'Could not delete it.');

  const channelName = (id) => channels.find((c) => c.id === id)?.name;

  if (viewing) return <QuestionnaireResponses id={viewing} onBack={() => { onView(null); load(); }} />;
  if (loading) return <EmptyState>Loading questionnaires…</EmptyState>;
  if (error && list.length === 0) {
    return <ErrorState title="Questionnaires couldn't load" message={error} onRetry={() => { setLoading(true); load(); }} />;
  }

  return (
    <>
      <div className="flex items-start gap-3 mb-8">
        <p className="text-ash text-sm">
          Up to {limits.questions} questions, each picked from a list or typed. Members fill it in from a
          {' '}<span className="text-bone">📝 Fill in</span> button and can change their answers until it closes.
          See who said what with a questionnaire's <span className="text-bone">Responses</span> button here, or
          {' '}<span className="text-bone">🔒 Responses</span> on its Discord post.
        </p>
        <button onClick={load} className="ml-auto text-ash hover:text-brass shrink-0" title="Refresh"><RefreshCw className="w-4 h-4" /></button>
      </div>

      <Toast msg={msg} />

      <form onSubmit={post} className="panel rounded-lg p-5 mb-8 space-y-4">
        <div className="eyebrow text-[10px] text-brass">New questionnaire</div>
        <label className="block">
          <span className="eyebrow text-[10px] text-ash block mb-1.5">Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={limits.title}
            placeholder="e.g. Season 3 feedback" className={FIELD} />
        </label>
        <label className="block">
          <span className="eyebrow text-[10px] text-ash block mb-1.5">Intro (optional)</span>
          <textarea value={intro} onChange={(e) => setIntro(e.target.value)} maxLength={limits.intro} rows={2}
            placeholder="Shown above the questions on the post." className={FIELD} />
        </label>

        <div className="space-y-3">
          {questions.map((q, i) => (
            <QuestionEditor key={i} q={q} n={i + 1} limits={limits}
              onChange={(next) => setQuestions((prev) => prev.map((x, j) => (j === i ? next : x)))}
              onRemove={questions.length > 1 ? () => setQuestions((prev) => prev.filter((_, j) => j !== i)) : null} />
          ))}
          {questions.length < limits.questions && (
            <button type="button" onClick={() => setQuestions((prev) => [...prev, blankQuestion()])}
              className="inline-flex items-center gap-1.5 text-sm text-brass hover:text-brassbright">
              <Plus className="w-4 h-4" /> Add question
            </button>
          )}
        </div>

        <PostSettings channels={channels} channelId={channelId} onChannel={setChannelId} closesIn={closesIn} onClosesIn={setClosesIn} />

        <div>
          <Button type="submit" size="sm" disabled={!canPost} icon={busy === 'post' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}>
            Post questionnaire
          </Button>
        </div>
      </form>

      <div className="eyebrow text-[10px] text-brass mb-3">Questionnaires ({list.length})</div>
      {list.length === 0 ? (
        <EmptyState>No questionnaires yet.</EmptyState>
      ) : (
        <div className="space-y-3">
          {list.map((q) => (
            <div key={q.id} className={`panel rounded-lg p-4 ${q.open ? '' : 'opacity-75'}`}>
              <div className="flex items-start gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-bone font-medium">{q.title}</div>
                  <div className="text-xs text-ash mt-0.5">
                    {q.open ? (
                      <span className="text-emerald-400">Open</span>
                    ) : (
                      <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Closed</span>
                    )}
                    {q.open && q.closes_at && <> · closes {fmtDatetime(q.closes_at)}</>}
                    {channelName(q.channel_id) && <> · #{channelName(q.channel_id)}</>}
                    {' '}· {q.respondents} responded
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 flex-wrap">
                  <Button size="sm" icon={<ClipboardList className="w-4 h-4" />} onClick={() => onView(q.id)}>
                    Responses
                  </Button>
                  {q.open && (
                    <Button variant="secondary" size="sm" icon={<Lock className="w-4 h-4" />} disabled={busy === `close:${q.id}`} onClick={() => close(q)}>
                      Close
                    </Button>
                  )}
                  <Button variant="destructive" size="sm" icon={<Trash2 className="w-4 h-4" />} disabled={busy === `del:${q.id}`} onClick={() => remove(q)}>
                    Delete
                  </Button>
                </div>
              </div>

              <div className="mt-4 space-y-4">
                {q.questions.map((question, i) => {
                  const result = q.results?.[i] || {};
                  return (
                    <div key={i}>
                      <div className="text-sm text-bone font-medium">
                        {i + 1}. {question.text} <span className="text-xs text-ash font-normal">· {hint(question)}</span>
                      </div>
                      {question.type === 'choice' ? (
                        <div className="mt-2 space-y-1.5">
                          {question.options.map((opt, j) => (
                            <ResultBar key={j} label={opt} count={result.counts?.[j] || 0} total={q.respondents} />
                          ))}
                        </div>
                      ) : result.answers?.length ? (
                        <AnswerList items={result.answers.map((answer) => ({ answer }))} />
                      ) : (
                        <div className="text-xs text-ash mt-1">No answers yet.</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
