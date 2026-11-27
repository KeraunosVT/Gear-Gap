import { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import { RefreshCw } from 'lucide-react';
import { useAuth } from '../auth';
import RestrictedGate from '../components/ui/RestrictedGate';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import ErrorBanner from '../components/ui/ErrorBanner';
import Tabs from '../components/ui/Tabs';
import { Table, Thead, SortableTh, Tr, useSort, sortRows } from '../components/ui/Table';
import { fmtGuildDay, todayInGuildTz } from '../timeUtils';

// Who holds the Guild Member role now, who has left, and who held it on a
// given night. Read from member_tenure, which the hourly role check keeps —
// see backend/membership.js for what that table can and can't answer.

const DAY = 86_400_000;
const daysBetween = (from, to) => Math.max(0, Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / DAY));

// "9d", "5w", "4mo", "1.5y" — a length of membership, read at a glance.
function fmtSpan(days) {
  if (days == null) return '—';
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30.44)}mo`;
  return `${(days / 365.25).toFixed(1).replace(/\.0$/, '')}y`;
}

const fmtDay = (d) => (d ? fmtGuildDay(d, { weekday: false, year: true }) : '—');

// How far to trust a join date. tlgm and audit_log are the real grant (or the
// in-game join); a server join stands in for a grant older than the audit log
// keeps, so it can be earlier than the role.
const SOURCE_NOTE = {
  tlgm: 'In-game join date, from a TLGM import',
  audit_log: 'When the role was granted, from the server audit log',
  discord_join: 'Approximate: when they joined the Discord server. The role grant was too old for the audit log.',
  sweep: 'When the hourly role check first saw them',
};

function Joined({ m }) {
  if (!m.since) {
    return <span className="text-ash" title="Not recorded yet. The hourly role check picks up new and returning members within the hour.">—</span>;
  }
  const approx = m.source === 'discord_join';
  return (
    <span title={SOURCE_NOTE[m.source] || undefined} className={approx ? 'text-ash' : 'text-bone'}>
      {approx && '~'}{fmtDay(m.since)}
    </span>
  );
}

const nameCell = (m) => (
  <span className="font-semibold text-bone">{m.name}</span>
);
const usernameCell = (m) => <span className="text-ash">{m.username ? `@${m.username}` : '—'}</span>;

const VIEWS = {
  active: {
    columns: [
      { key: 'name', label: 'Member', render: nameCell },
      { key: 'username', label: 'Discord', render: usernameCell },
      { key: 'since', label: 'Joined', align: 'right', render: (m) => <Joined m={m} /> },
      { key: 'days', label: 'In guild', align: 'right', render: (m) => <span className="font-mono text-brassbright">{fmtSpan(m.days)}</span> },
    ],
    empty: 'No one holds the member role.',
  },
  past: {
    columns: [
      { key: 'name', label: 'Member', render: nameCell },
      { key: 'username', label: 'Discord', render: usernameCell },
      { key: 'since', label: 'Joined', align: 'right', render: (m) => <Joined m={m} /> },
      { key: 'until', label: 'Left', align: 'right', render: (m) => <span className="text-bone">{fmtDay(m.until)}</span> },
      { key: 'days', label: 'Stayed', align: 'right', render: (m) => <span className="font-mono text-brassbright">{fmtSpan(m.days)}</span> },
    ],
    empty: 'Nobody has left since the role check started keeping track.',
  },
  date: {
    columns: [
      { key: 'name', label: 'Member', render: nameCell },
      { key: 'username', label: 'Discord', render: usernameCell },
      { key: 'since', label: 'Joined', align: 'right', render: (m) => <Joined m={m} /> },
      { key: 'until', label: 'Left', align: 'right', render: (m) => (m.until
        ? <span className="text-bone">{fmtDay(m.until)}</span>
        : <span className="text-emerald-400">Still in</span>) },
    ],
    empty: 'No one on record held the member role that night.',
  },
};

const TEXT_KEYS = ['name', 'username'];

export default function Members() {
  const { can } = useAuth();
  const today = todayInGuildTz();
  const [view, setView] = useState('active');
  const [onDate, setOnDate] = useState(today);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [dateError, setDateError] = useState('');
  const [filter, setFilter] = useState('');
  const { key: sortKey, dir: sortDir, sortBy } = useSort(TEXT_KEYS);
  // Only the newest request may land: picking dates quickly would otherwise
  // let a slow earlier answer overwrite a later one.
  const seq = useRef(0);

  const load = (date = onDate) => {
    const mine = ++seq.current;
    if (data) setRefreshing(true); else setLoading(true);
    setError(''); setDateError('');
    axios.get('/api/admin/membership', { params: date ? { on: date } : {} })
      .then((res) => { if (mine === seq.current) setData(res.data); })
      .catch((err) => {
        if (mine !== seq.current) return;
        const msg = err.response?.data?.error || 'Could not load the member history.';
        // A bad date is the picker's problem, not the page's — keep showing
        // what was already loaded.
        if (data && err.response?.status === 400) setDateError(msg); else setError(msg);
      })
      .finally(() => { if (mine === seq.current) { setLoading(false); setRefreshing(false); } });
  };
  useEffect(() => { if (can('parties')) load(); }, []);

  const pickDate = (d) => {
    setOnDate(d);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) load(d);
  };

  const lists = useMemo(() => {
    if (!data) return { active: [], past: [], date: [] };
    return {
      active: data.active.map((m) => ({ ...m, days: m.since ? daysBetween(m.since, today) : null })),
      past: data.past.map((m) => ({ ...m, days: m.since ? daysBetween(m.since, m.until) : null })),
      date: data.on?.members || [],
    };
  }, [data, today]);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = lists[view].filter((m) => !f
      || (m.name || '').toLowerCase().includes(f)
      || (m.username || '').toLowerCase().includes(f));
    return sortRows(list, sortKey, sortDir);
  }, [lists, view, filter, sortKey, sortDir]);

  if (!can('parties')) return <RestrictedGate />;

  const tabs = [
    { key: 'active', label: `Active${data ? ` (${lists.active.length})` : ''}` },
    { key: 'past', label: `Past${data ? ` (${lists.past.length})` : ''}` },
    { key: 'date', label: 'On a date' },
  ];
  const { columns, empty } = VIEWS[view];

  return (
    <PageShell>
      <Tabs variant="flat" items={tabs} active={view} onChange={setView} />

      <div className="flex flex-wrap items-center justify-between mb-5 gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
            className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
          />
          {view === 'date' && (
            <label className="flex items-center gap-2 text-sm text-ash">
              In the guild on
              <input
                type="date" value={onDate} max={today} onChange={(e) => pickDate(e.target.value)}
                className="bg-panel border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass"
              />
            </label>
          )}
        </div>
        <div className="flex items-center gap-4">
          {!loading && !error && (
            <span className="text-sm text-ash">
              <span className="text-bone font-mono">{rows.length}</span> member{rows.length === 1 ? '' : 's'}
              {view === 'date' && data?.on && <> on {fmtGuildDay(data.on.date, { year: true })}</>}
            </span>
          )}
          <button onClick={() => load()} disabled={refreshing} title="Refresh" aria-label="Refresh"
            className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {data?.discordUnavailable && view === 'active' && (
        <ErrorBanner>
          Discord couldn&apos;t be reached, so this is the roster as of the last hourly role check rather than live.
        </ErrorBanner>
      )}
      {dateError && view === 'date' && <ErrorBanner>{dateError}</ErrorBanner>}

      {error ? (
        <ErrorState message={error} onRetry={() => load()} />
      ) : loading ? (
        <EmptyState>Reading the roll…</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState>{filter ? 'No one matches that search.' : empty}</EmptyState>
      ) : (
        <Table maxHeight="max-h-[70vh]">
          <Thead sticky>
            <th className="p-2.5 text-center font-normal w-12">#</th>
            {columns.map((c) => (
              <SortableTh key={c.key} label={c.label} sortKey={c.key} activeKey={sortKey} dir={sortDir} onSort={sortBy} align={c.align} dense />
            ))}
          </Thead>
          <tbody>
            {rows.map((m, i) => (
              <Tr key={m.discord_id}>
                <td className="p-2.5 text-center font-mono text-ash">{i + 1}</td>
                {columns.map((c) => (
                  <td key={c.key} className={`p-2.5 whitespace-nowrap ${c.align === 'right' ? 'text-right' : ''}`}>
                    {c.render(m)}
                  </td>
                ))}
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {view !== 'active' && !loading && !error && (
        <p className="text-ash text-xs mt-4 max-w-3xl leading-relaxed">
          Join and leave dates come from the hourly role check, so they can be up to an hour off. It keeps one
          stretch per person: someone who left and came back only shows from their latest return. Nobody is on
          record from before the check started keeping track.
        </p>
      )}
    </PageShell>
  );
}
