import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import { ArrowLeft, Users, RefreshCw, TrendingUp } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { Table, Thead, SortableTh, Tr, useSort, sortRows } from '../components/ui/Table';
import PlayerGuildHistory from '../components/PlayerGuildHistory';

// ── ONE GUILD'S ROSTER ──────────────────────────────────────────────────────
// Everyone they field, what they play, and which of them is the actual problem.
//
// A marked player is at least twice their OWN guild's median for that stat —
// not the top of a column. Crowning column leaders marks somebody in every
// guild, including one where five players are indistinguishable; this marks
// three in a guild with three carries and nobody in an even one, which is
// itself the answer. See backend/feudRoster.js.

const COLUMNS = [
  { key: 'main_class', label: 'Class', align: 'left' },
  { key: 'player_name', label: 'Player', align: 'left' },
  { key: 'recent_appearances', label: 'Recent', align: 'center' },
  { key: 'appearances', label: 'Met', align: 'center' },
  { key: 'k_m', label: 'K / match', align: 'center' },
  { key: 'dmg_m', label: 'Dmg / match', align: 'center' },
  { key: 'heal_m', label: 'Heal / match', align: 'center' },
];

// Who they're fielding NOW versus everyone they ever have. Two different
// questions, and the recent one is what you want before a match — so it leads.
const SCOPES = [
  { key: 'recent', label: 'Current roster' },
  { key: 'all', label: 'All time' },
];

const fmtM = (n) => ((Number(n) || 0) / 1e6).toFixed(1) + 'M';
const fmt1 = (n) => (Number(n) || 0).toFixed(1);

// The ratio beside a stat that earned a mark. Rendered as a number so the
// reader judges the margin rather than trusting a badge.
function Mark({ ratio }) {
  if (!ratio) return null;
  return (
    <span className="text-brassbright text-[10px] font-mono ml-1.5 whitespace-nowrap" title={`${ratio}× their guild's median`}>
      ▲{ratio}×
    </span>
  );
}

export default function GuildFeudRoster() {
  const { guild } = useParams();
  const enemy = decodeURIComponent(guild || '');

  const [data, setData] = useState(null);
  const [record, setRecord] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [scope, setScope] = useState('recent');
  const [lookup, setLookup] = useState(null);

  const sort = useSort(['main_class', 'player_name'], 'appearances', 'desc');

  const load = useCallback(() => {
    setError('');
    Promise.all([
      axios.get(`/api/guilds/feuds/${encodeURIComponent(enemy)}`),
      // The head-to-head line above the table. Soft-failed — the roster is the
      // page, and a missing record shouldn't cost you it.
      axios.get('/api/guilds/feuds').then((r) => (r.data.feuds || []).find((f) => f.enemy_guild === enemy)).catch(() => null),
    ])
      .then(([roster, rec]) => { setData(roster.data); setRecord(rec); })
      .catch((err) => setError(err.response?.data?.error || 'Could not load that guild.'))
      .finally(() => setLoading(false));
  }, [enemy]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const decorated = (data?.players || []).map((p) => ({
      ...p,
      k_m: p.per_match?.kills || 0,
      dmg_m: p.per_match?.damage_dealt || 0,
      heal_m: p.per_match?.healing || 0,
    }));
    const filtered = decorated.filter(
      (p) => (scope === 'all' || p.recent_appearances > 0)
        && (p.player_name || '').toLowerCase().includes(f),
    );
    return sortRows(filtered, sort.key, sort.dir);
  }, [data, filter, scope, sort.key, sort.dir]);

  if (loading) return <PageShell maxWidth="max-w-5xl"><EmptyState>Reading their roster…</EmptyState></PageShell>;
  if (error) {
    return (
      <PageShell maxWidth="max-w-5xl">
        <ErrorState title="NO SUCH GUILD" message={error} onRetry={() => { setLoading(true); load(); }} />
      </PageShell>
    );
  }

  const marked = (data?.players || []).filter((p) => p.standout).length;

  return (
    <PageShell maxWidth="max-w-5xl">
      <Link to="/war-record/feuds" className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass mb-6 transition-colors">
        <ArrowLeft className="w-4 h-4" /> Feuds
      </Link>

      <div className="flex items-center gap-3 mb-2">
        <Users className="w-6 h-6 text-brass" />
        <h1 className="font-display text-2xl tracking-wide text-bone">{enemy.toUpperCase()}</h1>
      </div>
      <p className="text-ash text-sm mb-6">
        <span className="font-mono text-bone">{data?.recent_count || 0}</span> in the last{' '}
        {data?.recent_games || 3} games
        {' · '}<span className="font-mono text-ash">{data?.players?.length || 0}</span> all time
        {record && (
          <>
            {' · '}met <span className="font-mono text-bone">{record.met}</span>
            {' · '}<span className="text-emerald-400">{record.wins}</span>-
            <span className="text-oxblood">{record.losses}</span>-
            <span className="text-ash">{record.draws}</span>
          </>
        )}
        {marked > 0 && <>{' · '}<span className="text-brassbright">{marked} standing out</span></>}
      </p>

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search players…"
          className="bg-panel border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        <div className="flex items-center gap-1">
          {SCOPES.map(({ key, label }) => (
            <button
              key={key} onClick={() => setScope(key)}
              className={`px-3 py-1 rounded-full text-xs font-semibold tracking-wide transition-colors border ${
                scope === key ? 'bg-brass text-ink border-transparent' : 'border-line text-ash hover:text-bone'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <span className="text-sm text-ash">
          {rows.length} shown
          {scope === 'recent' && data?.recent_games ? ` · last ${data.recent_games} games` : ''}
        </span>
        <button onClick={load} title="Refresh" className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass transition-colors">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState>
          {filter ? 'Nobody matching.'
            : scope === 'recent' ? `Nobody fielded in the last ${data?.recent_games || 3} games — try All time.`
              : 'No players on record for this guild.'}
        </EmptyState>
      ) : (
        <Table maxHeight="max-h-[70vh]" minWidth="min-w-[720px]">
          <Thead sticky>
            {COLUMNS.map((c) => (
              <SortableTh
                key={c.key} label={c.label} sortKey={c.key} align={c.align} dense
                activeKey={sort.key} dir={sort.dir} onSort={sort.sortBy}
              />
            ))}
          </Thead>
          <tbody>
            {rows.map((p) => (
              <Tr key={p.player_name}>
                <td className="p-2.5 text-brassbright">{p.main_class}</td>
                <td className="p-2.5">
                  <button
                    onClick={() => setLookup(p.player_name)}
                    title="Where else has this name played?"
                    className={`hover:text-brassbright transition-colors ${p.sub_for ? 'text-ash' : 'text-bone font-semibold'}`}
                  >
                    {p.player_name}
                  </button>
                  {/* Borrowed, not theirs — otherwise a loaned healer reads as
                      part of their usual composition. */}
                  {p.sub_for && (
                    <span className="text-brass/70 text-xs ml-2" title={`Subbed in from ${p.sub_for}`}>← {p.sub_for}</span>
                  )}
                </td>
                <td className="p-2.5 text-center font-mono">
                  <span className={p.recent_appearances ? 'text-bone' : 'text-ash/30'}>{p.recent_appearances}</span>
                </td>
                <td className="p-2.5 text-center font-mono text-ash">{p.appearances}</td>
                <td className="p-2.5 text-center font-mono whitespace-nowrap">
                  <span className={p.standout?.kills ? 'text-bone' : 'text-ash'}>{fmt1(p.k_m)}</span>
                  <Mark ratio={p.standout?.kills} />
                </td>
                <td className="p-2.5 text-center font-mono whitespace-nowrap">
                  <span className={p.standout?.damage_dealt ? 'text-bone' : 'text-ash'}>{fmtM(p.dmg_m)}</span>
                  <Mark ratio={p.standout?.damage_dealt} />
                </td>
                <td className="p-2.5 text-center font-mono whitespace-nowrap">
                  <span className={p.standout?.healing ? 'text-bone' : 'text-ash/40'}>{fmtM(p.heal_m)}</span>
                  <Mark ratio={p.standout?.healing} />
                </td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* The rule, in words. A badge nobody can explain gets ignored. */}
      <p className="text-ash/60 text-xs mt-4 flex items-start gap-1.5">
        <TrendingUp className="w-3.5 h-3.5 shrink-0 mt-0.5 text-brassbright" />
        <span>
          <span className="text-brassbright font-mono">▲</span> marks a player at least{' '}
          <span className="text-ash">{data?.standout_ratio || 2}×</span> their guild&apos;s median for that stat, over{' '}
          <span className="text-ash">{data?.min_appearances || 5}</span> matches or more. The median is taken across their{' '}
          <span className="text-ash">{data?.eligible_count || 0}</span> regulars, borrowed players excluded — so an even
          guild marks nobody, which is itself worth knowing.
          {' '}The list windows to the last <span className="text-ash">{data?.recent_games || 3}</span> games, but every
          rate and mark comes from that player&apos;s <span className="text-ash">full</span> history against you: three
          games is the right lens on a current roster and far too few to judge anyone by.
          {' '}Click any name to see where else they&apos;ve played.
        </span>
      </p>

      {lookup && <PlayerGuildHistory name={lookup} onClose={() => setLookup(null)} />}
    </PageShell>
  );
}
