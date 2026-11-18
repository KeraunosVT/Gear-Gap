// Pieces the Polls page's two tabs share: the form field style, the channel
// and close-time pickers, and the result bar.

// How a questionnaire question is answered, as the post and form say it.
export const questionHint = (q) => {
  if (q.type === 'text') return `typed answer${q.required ? '' : ' · optional'}`;
  if (q.type === 'choice' && q.multi && q.all) return 'pick all';
  return (q.multi ? 'pick any' : 'pick one') + (q.required ? '' : ' · optional');
};

export const FIELD ='w-full bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass';

const CLOSE_OPTIONS = [
  { value: '', label: 'No close time' },
  { value: '1', label: '1 hour' },
  { value: '6', label: '6 hours' },
  { value: '12', label: '12 hours' },
  { value: '24', label: '1 day' },
  { value: '48', label: '2 days' },
  { value: '72', label: '3 days' },
  { value: '168', label: '7 days' },
];

export function PostSettings({ channels, channelId, onChannel, closesIn, onClosesIn }) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="eyebrow text-[10px] text-ash block mb-1.5">Post in</span>
          <select value={channelId} onChange={(e) => onChannel(e.target.value)} className={FIELD}>
            <option value="">— pick a channel —</option>
            {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="eyebrow text-[10px] text-ash block mb-1.5">Closes after</span>
          <select value={closesIn} onChange={(e) => onClosesIn(e.target.value)} className={FIELD}>
            {CLOSE_OPTIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
      </div>
      {channels.length === 0 && (
        <p className="text-xs text-brassbright">The bot can't see any channels right now — check it's online.</p>
      )}
    </>
  );
}

// One option's share of `total` (the people who voted or responded).
export function ResultBar({ label, count, total, muted = false }) {
  const pct = total ? Math.round((count / total) * 100) : 0;
  return (
    <div className="text-sm">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-bone truncate">{label}</span>
        <span className="font-mono text-xs text-ash shrink-0">{count} · {pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-hall overflow-hidden mt-1">
        <div className={`h-full rounded-full ${muted ? 'bg-brass/60' : 'bg-brass'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// Typed answers, without who wrote them; `count` is shown when above one.
export function AnswerList({ items }) {
  return (
    <ul className="mt-1.5 space-y-0.5 pl-3 border-l border-line max-h-56 overflow-y-auto">
      {items.map((w, i) => (
        <li key={i} className="text-xs text-ash flex justify-between gap-3">
          <span className="text-bone break-words whitespace-pre-line min-w-0">“{w.answer}”</span>
          {w.count > 1 && <span className="font-mono shrink-0">×{w.count}</span>}
        </li>
      ))}
    </ul>
  );
}
