// A questionnaire's Responses page, opened from its card on the Polls page's
// Questionnaires tab: who answered what, by name, for officers holding the
// Polls permission. Two views of the same answers — By person (a sortable
// table, a row each) and By question (who picked each choice, each typed
// answer with its writer) — and a name search across both. Members who
// haven't responded are listed beneath either.
import { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { ArrowLeft, Lock, RefreshCw, Search } from 'lucide-react';
import EmptyState from '../ui/EmptyState';
import ErrorState from '../ui/ErrorState';
import Tabs from '../ui/Tabs';
import { Table, Thead, SortableTh, Tr, useSort, sortRows } from '../ui/Table';
import { fmtDatetime } from '../../timeUtils';
import { FIELD, ResultBar, questionHint as hint } from './PollBits';

const VIEWS = [{ key: 'person', label: 'By person' }, { key: 'question', label: 'By question' }];

function Avatar({ person }) {
  return person.avatar
    ? <img src={person.avatar} alt="" className="w-5 h-5 rounded-full border border-line shrink-0" />
    : (
      <span className="w-5 h-5 rounded-full bg-panelup border border-line shrink-0 flex items-center justify-center text-[9px] text-brass">
        {(person.name || '?').slice(0, 1).toUpperCase()}
      </span>
    );
}

function PersonName({ person }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <Avatar person={person} />
      <span className="text-bone truncate">{person.name}</span>
      {person.member === false && <span className="text-[10px] text-ash shrink-0" title="Doesn't have the member role">not a member</span>}
    </span>
  );
}

const Chip = ({ children }) => (
  <span className="inline-block bg-hall border border-line rounded px-1.5 py-0.5 text-xs text-bone mr-1 mb-1">{children}</span>
);
const Blank = () => <span className="text-ash/60">—</span>;

function AnswerCell({ question, answer }) {
  if (question.type === 'text') {
    return answer ? <span className="text-bone text-xs whitespace-pre-line break-words">{answer}</span> : <Blank />;
  }
  return answer.length ? answer.map((p) => <Chip key={p}>{question.options[p]}</Chip>) : <Blank />;
}

// What a column sorts by: the name, the time, or the answer as text.
const sortValue = (questions) => (row, key) => {
  if (key === 'name') return row.name.toLowerCase();
  if (key === 'responded_at') return row.responded_at ? Date.parse(row.responded_at) : 0;
  const i = Number(key.slice(1));
  const q = questions[i];
  const a = row.answers[i];
  return q.type === 'text' ? (a || '').toLowerCase() : a.map((p) => q.options[p]).join(', ').toLowerCase();
};

function ByPerson({ questions, rows }) {
  const textKeys = ['name', ...questions.map((_, i) => `q${i}`)];
  const { key, dir, sortBy } = useSort(textKeys);
  const sorted = sortRows(rows, key, dir, sortValue(questions));
  if (!rows.length) return <EmptyState>No responses match.</EmptyState>;
  return (
    <Table maxHeight="max-h-[70vh]" minWidth="min-w-[720px]">
      <Thead sticky>
        <SortableTh label="Name" sortKey="name" activeKey={key} dir={dir} onSort={sortBy} dense />
        <SortableTh label="Responded" sortKey="responded_at" activeKey={key} dir={dir} onSort={sortBy} dense />
        {questions.map((q, i) => (
          <SortableTh key={i} label={<span title={q.text} className="normal-case">{i + 1}. {q.text.length > 40 ? `${q.text.slice(0, 39)}…` : q.text}</span>}
            sortKey={`q${i}`} activeKey={key} dir={dir} onSort={sortBy} dense />
        ))}
      </Thead>
      <tbody>
        {sorted.map((r) => (
          <Tr key={r.id}>
            <td className="p-2.5 align-top whitespace-nowrap max-w-[220px]"><PersonName person={r} /></td>
            <td className="p-2.5 align-top whitespace-nowrap text-xs text-ash">{r.responded_at ? fmtDatetime(r.responded_at) : '—'}</td>
            {questions.map((q, i) => (
              <td key={i} className="p-2.5 align-top min-w-[140px] max-w-[320px]"><AnswerCell question={q} answer={r.answers[i]} /></td>
            ))}
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

function ByQuestion({ questions, rows, total }) {
  return (
    <div className="space-y-3">
      {questions.map((q, i) => {
        const textAnswers = q.type === 'text' ? rows.filter((r) => r.answers[i]) : [];
        return (
          <div key={i} className="panel rounded-lg p-4">
            <div className="text-sm text-bone font-medium mb-3">
              {i + 1}. {q.text} <span className="text-xs text-ash font-normal">· {hint(q)}</span>
            </div>
            {q.type === 'choice' ? (
              <div className="space-y-3">
                {q.options.map((opt, j) => {
                  const who = rows.filter((r) => r.answers[i].includes(j));
                  return (
                    <div key={j}>
                      <ResultBar label={opt} count={who.length} total={total} />
                      {who.length > 0 && (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-xs">
                          {who.map((r) => <PersonName key={r.id} person={r} />)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : textAnswers.length ? (
              <ul className="divide-y divide-line/60">
                {textAnswers.map((r) => (
                  <li key={r.id} className="py-2 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
                    <span className="sm:w-48 shrink-0 text-xs"><PersonName person={r} /></span>
                    <span className="text-sm text-bone whitespace-pre-line break-words min-w-0">{r.answers[i]}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-ash">No answers{rows.length ? '' : ' match'}.</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function QuestionnaireResponses({ id, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState('person');
  const [query, setQuery] = useState('');

  const load = useCallback(() => axios.get(`/api/admin/polls/questionnaires/${id}/responses`)
    .then((res) => { setData(res.data); setError(''); })
    .catch((err) => setError(err.response?.data?.error || 'Could not load the responses.')), [id]);

  useEffect(() => { load(); }, [load]);

  const back = (
    <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-brass hover:text-brassbright mb-4">
      <ArrowLeft className="w-4 h-4" /> All questionnaires
    </button>
  );

  if (error && !data) return <>{back}<ErrorState title="Responses couldn't load" message={error} onRetry={load} /></>;
  if (!data) return <>{back}<EmptyState>Loading responses…</EmptyState></>;

  const { questionnaire, responses, not_responded: notResponded, member_count: memberCount, members_responded: membersResponded } = data;
  const q = query.trim().toLowerCase();
  const match = (p) => !q || p.name.toLowerCase().includes(q);
  const rows = responses.filter(match);
  const waiting = notResponded.filter(match);

  return (
    <>
      {back}
      <div className="flex items-start gap-3 mb-1">
        <h2 className="font-display text-xl text-bone tracking-wide min-w-0 break-words">{questionnaire.title}</h2>
        <button onClick={load} className="ml-auto text-ash hover:text-brass shrink-0 mt-1" title="Refresh"><RefreshCw className="w-4 h-4" /></button>
      </div>
      <div className="text-xs text-ash mb-5">
        {questionnaire.open ? <span className="text-emerald-400">Open</span> : <span className="inline-flex items-center gap-1"><Lock className="w-3 h-3" /> Closed</span>}
        {questionnaire.open && questionnaire.closes_at && <> · closes {fmtDatetime(questionnaire.closes_at)}</>}
        {' '}· <span className="text-bone">{membersResponded} of {memberCount}</span> members responded
        {responses.length > membersResponded && <> · {responses.length - membersResponded} not in the member role</>}
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="[&>div]:mb-0"><Tabs variant="flat" items={VIEWS} active={view} onChange={setView} /></div>
        <label className="relative ml-auto w-full sm:w-56">
          <span className="sr-only">Search names</span>
          <Search className="w-4 h-4 text-ash absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names" className={`${FIELD} pl-8 py-1.5 text-sm`} />
        </label>
      </div>

      {responses.length === 0 ? (
        <EmptyState>Nobody has responded yet.</EmptyState>
      ) : view === 'person' ? (
        <ByPerson questions={questionnaire.questions} rows={rows} />
      ) : (
        <ByQuestion questions={questionnaire.questions} rows={rows} total={responses.length} />
      )}

      <div className="panel rounded-lg p-4 mt-4">
        <div className="eyebrow text-[10px] text-oxblood mb-2">Not responded ({waiting.length}{q ? ` of ${notResponded.length}` : ''})</div>
        {waiting.length ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-xs">
            {waiting.map((p) => <PersonName key={p.id} person={p} />)}
          </div>
        ) : (
          <div className="text-xs text-ash">{notResponded.length ? 'Nobody matches.' : 'Every member has responded 🎉'}</div>
        )}
      </div>
    </>
  );
}
