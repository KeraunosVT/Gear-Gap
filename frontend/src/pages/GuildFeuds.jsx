import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../auth';
import { Swords, RefreshCw, ChevronDown, ArrowLeft, Merge, Undo2, Loader2 } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { Table, Thead, SortableTh, Tr, useSort, sortRows } from '../components/ui/Table';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';

// ── WHO WE FIGHT ────────────────────────────────────────────────────────────
// Every scoreboard stores both teams; nothing read the enemy half until now.
// The aggregation is a SQL function (migrations/019) — doing it here would mean
// paging every player row of every match on each load.
//
// Members see the record. Officers holding 'names' additionally get the merge
// controls, gated inline the way LOA.jsx gates its schedule editor rather than
// splitting this into two pages.

const COLUMNS = [
  { key: 'enemy_guild', label: 'Guild', align: 'left' },
  { key: 'met', label: 'Met', align: 'center' },
  { key: 'wins', label: 'W', align: 'center' },
  { key: 'losses', label: 'L', align: 'center' },
  { key: 'draws', label: 'D', align: 'center' },
  { key: 'win_pct', label: 'Win %', align: 'center' },
  { key: 'kills_for', label: 'Kills', align: 'center' },
  { key: 'kills_against', label: 'Theirs', align: 'center' },
  { key: 'diff', label: 'Diff', align: 'center' },
  { key: 'last_met', label: 'Last met', align: 'center' },
];

const MIN_MET = [
  { key: 1, label: 'All' },
  { key: 2, label: '2+' },
  { key: 5, label: '5+' },
  { key: 10, label: '10+' },
];

const fmt = (n) => (Number(n) || 0).toLocaleString();

const fmtDay = (d) => (d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
  : '—');

export default function GuildFeuds() {
  const { can } = useAuth();
  const isOfficer = can('names');

  const [data, setData] = useState(null);
  const [merge, setMerge] = useState({ aliases: [], suggestions: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [minMet, setMinMet] = useState(1);
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [rosters, setRosters] = useState({});
  const [busy, setBusy] = useState('');
  const [msg, flash] = useFlash();

  const sort = useSort(['enemy_guild', 'last_met'], 'met', 'desc');

  const load = useCallback(() => {
    setError('');
    const calls = [axios.get('/api/guilds/feuds')];
    if (isOfficer) calls.push(axios.get('/api/admin/enemy-guilds'));
    Promise.all(calls)
      .then(([feuds, mergeRes]) => {
        setData(feuds.data);
        if (mergeRes) setMerge({ aliases: mergeRes.data.aliases || [], suggestions: mergeRes.data.suggestions || [] });
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load the feud list.'))
      .finally(() => setLoading(false));
  }, [isOfficer]);

  useEffect(() => { load(); }, [load]);

  // Derived here rather than in SQL: both are pure arithmetic on columns that
  // are already in the row, and win_pct has to be null (not 0) when a guild has
  // somehow been met zero times — "never fought" is not "never won".
  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const decorated = (data?.feuds || []).map((r) => ({
      ...r,
      met: Number(r.met) || 0,
      wins: Number(r.wins) || 0,
      losses: Number(r.losses) || 0,
      draws: Number(r.draws) || 0,
      kills_for: Number(r.kills_for) || 0,
      kills_against: Number(r.kills_against) || 0,
      win_pct: Number(r.met) > 0 ? Math.round((Number(r.wins) / Number(r.met)) * 100) : null,
      diff: (Number(r.kills_for) || 0) - (Number(r.kills_against) || 0),
    }));
    const filtered = decorated.filter(
      (r) => r.met >= minMet && (r.enemy_guild || '').toLowerCase().includes(f),
    );
    return sortRows(filtered, sort.key, sort.dir, (r, k) => (k === 'win_pct' ? (r.win_pct ?? -1) : r[k]));
  }, [data, filter, minMet, sort.key, sort.dir]);

  const openRoster = (name) => {
    if (expanded === name) return setExpanded(null);
    setExpanded(name);
    if (rosters[name]) return;
    axios.get(`/api/guilds/feuds/${encodeURIComponent(name)}`)
      .then((res) => setRosters((r) => ({ ...r, [name]: res.data })))
      .catch(() => flash('Could not load that guild.', false));
  };

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      await fn();
      // Rosters are keyed by the pre-merge name, so they'd be stale.
      setRosters({});
      setExpanded(null);
      load();
      if (ok) flash(ok);
    } catch (err) {
      flash(err.response?.data?.error || "That didn't work.", false);
    } finally {
      setBusy('');
    }
  };

  const applyMerge = (alias, canonical) => run(
    `merge:${alias}`,
    () => axios.post('/api/admin/enemy-guilds', { alias, canonical }),
    `"${alias}" now counts as "${canonical}".`,
  );

  const undoMerge = (alias) => run(
    `undo:${alias}`,
    () => axios.delete(`/api/admin/enemy-guilds/${encodeURIComponent(alias)}`),
    `"${alias}" is its own guild again.`,
  );

  if (loading) return <PageShell maxWidth="max-w-5xl"><EmptyState>Reading the war record…</EmptyState></PageShell>;
  if (error) {
    return (
      <PageShell maxWidth="max-w-5xl">
        <ErrorState title="THE RECORD IS SEALED" message={error} onRetry={() => { setLoading(true); load(); }} />
      </PageShell>
    );
  }

  const { excluded = 0, total_matches: totalMatches = 0 } = data?.coverage || {};

  return (
    <PageShell maxWidth="max-w-5xl">
      <Link to="/war-record" className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> War Record
      </Link>

      <div className="flex items-center gap-3 mb-2">
        <Swords className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">FEUDS</h1>
      </div>
      <p className="text-ash text-sm mb-6">
        Every guild we've met, and how we've done against them. Both sides of each scoreboard are already on
        file — this reads the half nobody was looking at.
      </p>

      <Toast msg={msg} />

      {/* Officer-only, and only when there is something to act on. */}
      {isOfficer && merge.suggestions.length > 0 && (
        <div className="panel rounded-lg p-4 mb-5 border border-brass/30">
          <div className="eyebrow text-[10px] text-brass mb-3">Possible misreads</div>
          <div className="space-y-2">
            {merge.suggestions.map((s) => (
              <div key={`${s.alias}->${s.canonical}`} className="flex items-center gap-3 flex-wrap text-sm">
                <span className="text-bone">{s.alias}</span>
                <span className="text-ash/60">looks like</span>
                <span className="text-bone">{s.canonical}</span>
                <button
                  onClick={() => applyMerge(s.alias, s.canonical)}
                  disabled={busy === `merge:${s.alias}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs border border-brass/50 text-brassbright hover:bg-panelup transition-colors disabled:opacity-40"
                >
                  {busy === `merge:${s.alias}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Merge className="w-3 h-3" />}
                  Merge
                </button>
              </div>
            ))}
          </div>
          <p className="text-ash/60 text-xs mt-3">
            Suggested by name similarity only — two genuinely different guilds can look alike, so nothing merges
            until you say so.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search guilds…"
          className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        <div className="flex items-center gap-1">
          {MIN_MET.map(({ key, label }) => (
            <button
              key={key} onClick={() => setMinMet(key)}
              className={`px-3 py-1 rounded-full text-xs font-semibold tracking-wide transition-colors border ${
                minMet === key ? 'bg-brass text-ink border-transparent' : 'border-line text-ash hover:text-bone'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <span className="text-sm text-ash">{rows.length} guild{rows.length === 1 ? '' : 's'}</span>
        <button onClick={load} title="Refresh" className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState>{filter || minMet > 1 ? 'Nothing matching.' : 'No enemy guilds on record yet.'}</EmptyState>
      ) : (
        <Table maxHeight="max-h-[70vh]" minWidth="min-w-[760px]">
          <Thead sticky>
            {COLUMNS.map((c) => (
              <SortableTh
                key={c.key} label={c.label} sortKey={c.key} align={c.align} dense
                activeKey={sort.key} dir={sort.dir} onSort={sort.sortBy}
              />
            ))}
            <th className="p-2.5 w-8"></th>
          </Thead>
          <tbody>
            {rows.map((r) => {
              const alias = merge.aliases.filter((a) => a.canonical === r.enemy_guild);
              return (
                <FeudRow
                  key={r.enemy_guild} row={r} expanded={expanded === r.enemy_guild}
                  roster={rosters[r.enemy_guild]} onToggle={() => openRoster(r.enemy_guild)}
                  mergedFrom={alias} isOfficer={isOfficer} busy={busy} onUndo={undoMerge}
                />
              );
            })}
          </tbody>
        </Table>
      )}

      <div className="text-ash/60 text-xs mt-4 space-y-1">
        <p>
          A match against allied guilds counts once for <em>each</em> of them, so these totals add up to more than
          the number of matches played. Kills are the totals from matches against that guild, not a share-out.
        </p>
        {excluded > 0 && (
          <p className="text-brass">
            {excluded} of {totalMatches} matches aren&apos;t counted — none of our players could be matched on either
            team, so there was no way to tell which side we were.{' '}
            {isOfficer && (
              <>Usually a name missing from the aliases in{' '}
                <Link to="/admin/settings" className="underline hover:text-brassbright">Guild Settings</Link>.
              </>
            )}
          </p>
        )}
      </div>
    </PageShell>
  );
}

function FeudRow({ row, expanded, roster, onToggle, mergedFrom, isOfficer, busy, onUndo }) {
  const colSpan = COLUMNS.length + 1;
  return (
    <>
      <Tr className="cursor-pointer">
        <td className="p-2.5 text-bone font-semibold" onClick={onToggle}>
          {row.enemy_guild}
          {mergedFrom.length > 0 && (
            <span className="text-ash/50 text-xs ml-2" title={`Also counts: ${mergedFrom.map((a) => a.alias).join(', ')}`}>
              +{mergedFrom.length}
            </span>
          )}
        </td>
        <td className="p-2.5 text-center font-mono text-bone" onClick={onToggle}>{row.met}</td>
        <td className="p-2.5 text-center font-mono text-emerald-400">{row.wins}</td>
        <td className="p-2.5 text-center font-mono text-oxblood">{row.losses}</td>
        <td className="p-2.5 text-center font-mono text-ash">{row.draws}</td>
        <td className="p-2.5 text-center font-mono">
          {row.win_pct === null
            ? <span className="text-ash/40">—</span>
            : <span className={row.win_pct >= 50 ? 'text-bone' : 'text-brassbright'}>{row.win_pct}%</span>}
        </td>
        <td className="p-2.5 text-center font-mono text-ash">{fmt(row.kills_for)}</td>
        <td className="p-2.5 text-center font-mono text-ash">{fmt(row.kills_against)}</td>
        <td className={`p-2.5 text-center font-mono ${row.diff > 0 ? 'text-emerald-400' : row.diff < 0 ? 'text-oxblood' : 'text-ash/40'}`}>
          {row.diff > 0 ? '+' : ''}{fmt(row.diff)}
        </td>
        <td className="p-2.5 text-center text-xs text-ash">{fmtDay(row.last_met)}</td>
        <td className="p-2.5 text-ash" onClick={onToggle}>
          <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </td>
      </Tr>

      {expanded && (
        <tr className="border-b border-line/60">
          <td colSpan={colSpan} className="p-0">
            <div className="bg-hall px-5 py-4">
              {!roster ? (
                <div className="text-ash text-sm">Reading their roster…</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <div className="eyebrow text-[10px] text-brass mb-2">Most seen</div>
                    {roster.players.length === 0 ? (
                      <p className="text-ash text-sm">No named players on record.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {roster.players.slice(0, 12).map((p) => (
                          <div key={p.player_name} className="flex items-baseline gap-2 text-sm">
                            <span className="font-mono text-ash w-8 shrink-0 text-right">{p.appearances}</span>
                            <span className="text-bone truncate">{p.player_name}</span>
                            <span className="text-ash/50 text-xs truncate">{p.main_class}</span>
                          </div>
                        ))}
                        {roster.players.length > 12 && (
                          <div className="text-ash/50 text-xs pt-1">+{roster.players.length - 12} more</div>
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="eyebrow text-[10px] text-brass mb-2">What they field</div>
                    <div className="space-y-1.5">
                      {roster.class_mix.slice(0, 12).map((c) => (
                        <div key={c.name} className="flex items-baseline gap-2 text-sm">
                          <span className="font-mono text-ash w-8 shrink-0 text-right">{c.count}</span>
                          <span className="text-brassbright truncate">{c.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {isOfficer && mergedFrom.length > 0 && (
                <div className="mt-4 pt-3 border-t border-line flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-ash/60">Merged in:</span>
                  {mergedFrom.map((a) => (
                    <button
                      key={a.alias} onClick={() => onUndo(a.alias)} disabled={busy === `undo:${a.alias}`}
                      title="Split this spelling back out"
                      className="inline-flex items-center gap-1.5 bg-panel border border-line rounded-full px-3 py-1 text-ash hover:text-oxblood transition-colors disabled:opacity-40"
                    >
                      {a.alias} <Undo2 className="w-3 h-3" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
