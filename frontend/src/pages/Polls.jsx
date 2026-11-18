// frontend/src/pages/Polls.jsx — officers create the bot's private polls and
// questionnaires, one tab each.
//
// A poll made here is posted to Discord by the bot with a button per option.
// Members see only how many votes each option has; who voted for what is
// shown only to officers, on Discord, through the poll's "Who voted" button —
// this page never loads voters, only counts. Written-in answers are listed
// without who wrote them. Questionnaires (components/polls/QuestionnairesPanel)
// work the same way.
import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';
import { BarChart3, Plus, X, Loader2, Lock, Trash2, Send, RefreshCw } from 'lucide-react';
import { useAuth } from '../auth';
import { PageShell } from '../components/ui/PageShell';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import ErrorState from '../components/ui/ErrorState';
import RestrictedGate from '../components/ui/RestrictedGate';
import Tabs from '../components/ui/Tabs';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';
import { FIELD, PostSettings, ResultBar, AnswerList } from '../components/polls/PollBits';
import QuestionnairesPanel from '../components/polls/QuestionnairesPanel';
import { fmtDatetime } from '../timeUtils';

const REFRESH_MS = 60_000;
const TABS = [{ key: 'polls', label: 'Polls' }, { key: 'questionnaires', label: 'Questionnaires' }];

export default function Polls() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'questionnaires' ? 'questionnaires' : 'polls';
  // A questionnaire's responses, open: wider, for the table of answers.
  const viewing = tab === 'questionnaires' ? params.get('view') : null;
  const onView = (id) => setParams(id ? { tab: 'questionnaires', view: id } : { tab: 'questionnaires' });

  if (!can('polls')) return <RestrictedGate />;

  return (
    <PageShell width={viewing ? 'standard' : 'narrow'}>
      <div className="flex items-center gap-3 mb-4">
        <BarChart3 className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">POLLS</h1>
      </div>
      <Tabs variant="flat" items={TABS} active={tab}
        onChange={(key) => setParams(key === 'polls' ? {} : { tab: key }, { replace: true })} />
      {tab === 'polls' ? <PollsPanel /> : <QuestionnairesPanel viewing={viewing} onView={onView} />}
    </PageShell>
  );
}

function PollsPanel() {
  const [polls, setPolls] = useState([]);
  const [channels, setChannels] = useState([]);
  const [maxOptions, setMaxOptions] = useState(10);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, flash] = useFlash();

  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [channelId, setChannelId] = useState('');
  const [multi, setMulti] = useState(false);
  const [writeIn, setWriteIn] = useState(false);
  const [closesIn, setClosesIn] = useState('24');

  const load = useCallback(() => axios.get('/api/admin/polls')
    .then((res) => {
      setPolls(res.data.polls || []);
      setChannels(res.data.channels || []);
      if (res.data.max_options) setMaxOptions(res.data.max_options);
      setChannelId((cur) => cur || res.data.default_channel_id || '');
      setError('');
    })
    .catch((err) => setError(err.response?.data?.error || 'Could not load polls.'))
    .finally(() => setLoading(false)), []);

  useEffect(() => { load(); }, [load]);
  // Counts move as members vote; this keeps the list current without a reload.
  useEffect(() => {
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const canPost = question.trim() && filled.length >= 2 && channelId && !busy;

  const post = async (e) => {
    e.preventDefault();
    if (!canPost) return;
    setBusy('post');
    try {
      await axios.post('/api/admin/polls', {
        question: question.trim(), options: filled, multi, write_in: writeIn, channel_id: channelId, closes_in_hours: closesIn || null,
      });
      flash('Poll posted.');
      setQuestion(''); setOptions(['', '']); setMulti(false); setWriteIn(false);
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not post the poll.', false);
    } finally {
      setBusy('');
    }
  };

  const close = async (p) => {
    if (!window.confirm(`Close "${p.question}"? Nobody can vote after this.`)) return;
    setBusy(`close:${p.id}`);
    try {
      await axios.post(`/api/admin/polls/${p.id}/close`);
      flash('Poll closed.');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not close the poll.', false);
    } finally {
      setBusy('');
    }
  };

  const remove = async (p) => {
    if (!window.confirm(`Delete "${p.question}"? Its votes and its Discord post are deleted too.`)) return;
    setBusy(`del:${p.id}`);
    try {
      await axios.delete(`/api/admin/polls/${p.id}`);
      flash('Poll deleted.');
      load();
    } catch (err) {
      flash(err.response?.data?.error || 'Could not delete the poll.', false);
    } finally {
      setBusy('');
    }
  };

  const channelName = (id) => channels.find((c) => c.id === id)?.name;

  if (loading) return <EmptyState>Loading polls…</EmptyState>;
  if (error && polls.length === 0) {
    return <ErrorState title="Polls couldn't load" message={error} onRetry={() => { setLoading(true); load(); }} />;
  }

  return (
    <>
      <div className="flex items-start gap-3 mb-8">
        <p className="text-ash text-sm">
          Private polls: the bot posts them with a button per option. Members see only how many votes each option has.
          Officers see who voted for what with the <span className="text-bone">🔒 Who voted</span> button on the poll in Discord.
        </p>
        <button onClick={load} className="ml-auto text-ash hover:text-brass shrink-0" title="Refresh"><RefreshCw className="w-4 h-4" /></button>
      </div>

      <Toast msg={msg} />

      <form onSubmit={post} className="panel rounded-lg p-5 mb-8 space-y-4">
        <div className="eyebrow text-[10px] text-brass">New poll</div>
        <label className="block">
          <span className="eyebrow text-[10px] text-ash block mb-1.5">Question</span>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={200}
            placeholder="e.g. Which night works for the next raid?" className={FIELD} />
        </label>

        <div>
          <span className="eyebrow text-[10px] text-ash block mb-1.5">Options</span>
          <div className="space-y-2">
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-ash text-sm w-5 text-right">{i + 1}.</span>
                <input value={o} maxLength={80} onChange={(e) => setOptions((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder={`Option ${i + 1}`} className={FIELD} />
                {options.length > 2 && (
                  <button type="button" onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                    className="text-ash hover:text-oxblood" aria-label={`Remove option ${i + 1}`}>
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          {options.length < maxOptions && (
            <button type="button" onClick={() => setOptions((prev) => [...prev, ''])}
              className="mt-2 inline-flex items-center gap-1.5 text-sm text-brass hover:text-brassbright">
              <Plus className="w-4 h-4" /> Add option
            </button>
          )}
        </div>

        <PostSettings channels={channels} channelId={channelId} onChannel={setChannelId} closesIn={closesIn} onClosesIn={setClosesIn} />

        <label className="inline-flex items-center gap-2 text-sm text-bone cursor-pointer">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} className="accent-[rgb(var(--color-brass))]" />
          Allow multiple choices
        </label>

        <div>
          <label className="inline-flex items-center gap-2 text-sm text-bone cursor-pointer">
            <input type="checkbox" checked={writeIn} onChange={(e) => setWriteIn(e.target.checked)} className="accent-[rgb(var(--color-brass))]" />
            Let members write in their own answer
          </label>
          {writeIn && (
            <p className="text-xs text-ash mt-1 ml-6">
              Adds a ✏️ Write my own button.{' '}
              {multi ? 'A written answer counts alongside any options they pick.' : 'A written answer is their one vote, in place of an option.'}
            </p>
          )}
        </div>

        <div>
          <Button type="submit" size="sm" disabled={!canPost} icon={busy === 'post' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}>
            Post poll
          </Button>
        </div>
      </form>

      <div className="eyebrow text-[10px] text-brass mb-3">Polls ({polls.length})</div>
      {polls.length === 0 ? (
        <EmptyState>No polls yet.</EmptyState>
      ) : (
        <div className="space-y-3">
          {polls.map((p) => (
            <div key={p.id} className={`panel rounded-lg p-4 ${p.open ? '' : 'opacity-75'}`}>
              <div className="flex items-start gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-bone font-medium">{p.question}</div>
                  <div className="text-xs text-ash mt-0.5">
                    {p.open ? (
                      <span className="text-emerald-400">Open</span>
                    ) : (
                      <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Closed</span>
                    )}
                    {p.open && p.closes_at && <> · closes {fmtDatetime(p.closes_at)}</>}
                    {channelName(p.channel_id) && <> · #{channelName(p.channel_id)}</>}
                    {p.multi && <> · multiple choice</>}
                    {p.write_in && <> · write-ins</>}
                    {' '}· {p.voter_count} voted
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {p.open && (
                    <Button variant="secondary" size="sm" icon={<Lock className="w-4 h-4" />} disabled={busy === `close:${p.id}`} onClick={() => close(p)}>
                      Close
                    </Button>
                  )}
                  <Button variant="destructive" size="sm" icon={<Trash2 className="w-4 h-4" />} disabled={busy === `del:${p.id}`} onClick={() => remove(p)}>
                    Delete
                  </Button>
                </div>
              </div>
              <div className="mt-3 space-y-1.5">
                {p.options.map((opt, i) => (
                  <ResultBar key={i} label={opt} count={p.counts?.[i] || 0} total={p.voter_count} />
                ))}
                {p.write_in && (
                  <div>
                    <ResultBar label="✏️ Written in" count={p.write_in_count || 0} total={p.voter_count} muted />
                    {p.write_ins?.length > 0 && <AnswerList items={p.write_ins} />}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
