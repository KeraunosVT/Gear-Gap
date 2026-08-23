import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import axios from 'axios';
import { ArrowLeft, Users, RefreshCw, TrendingUp, Merge, Undo2, Loader2 } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import ErrorState from '../components/ui/ErrorState';
import EmptyState from '../components/ui/EmptyState';
import { Table, Thead, SortableTh, Tr, useSort, sortRows } from '../components/ui/Table';
import PlayerGuildHistory from '../components/PlayerGuildHistory';
import Modal from '../components/ui/Modal';
import Button from '../components/ui/Button';
import Toast from '../components/ui/Toast';
import { useFlash } from '../components/ui/useFlash';
import { useAuth } from '../auth';

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

  // ── MERGING MISREAD NAMES ─────────────────────────────────────────────────
  // OCR turns one person into three rows, each with a third of their matches —
  // which also drops all three under the standout floor, so the misread hides
  // exactly the player it fragments. Officers holding 'names' can fold them.
  const { can } = useAuth();
  const isOfficer = can('names');
  const [merge, setMerge] = useState({ aliases: [], suggestions: [] });
  const [mergeFrom, setMergeFrom] = useState(null);
  const [mergeTo, setMergeTo] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, flash] = useFlash();

  const sort = useSort(['main_class', 'player_name'], 'appearances', 'desc');

  const load = useCallback(() => {
    setError('');
    Promise.all([
      axios.get(`/api/guilds/feuds/${encodeURIComponent(enemy)}`),
      // The head-to-head line above the table. Soft-failed — the roster is the
      // page, and a missing record shouldn't cost you it.
      axios.get('/api/guilds/feuds').then((r) => (r.data.feuds || []).find((f) => f.enemy_guild === enemy)).catch(() => null),
      // Officer-only, and soft-failed: the roster is the page, and a member
      // without 'names' simply gets no merge controls.
      axios.get('/api/admin/enemy-players', { params: { guild: enemy } })
        .then((r) => r.data).catch(() => null),
    ])
      .then(([roster, rec, mg]) => {
        setData(roster.data); setRecord(rec);
        if (mg) setMerge({ aliases: mg.aliases || [], suggestions: mg.suggestions || [] });
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load that guild.'))
      .finally(() => setLoading(false));
  }, [enemy]);

  useEffect(() => { load(); }, [load]);

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      await fn();
      load();
      if (ok) flash(ok);
    } catch (err) {
      flash(err.response?.data?.error || 'That did not work.', false);
    } finally {
      setBusy('');
    }
  };

  const applyMerge = (alias, canonical) => run(`merge:${alias}`, async () => {
    const res = await axios.post('/api/admin/enemy-players', { alias, canonical });
    const also = res.data.repointed || [];
    // Others may have pointed at this spelling; they get re-pointed forward so
    // the table stays one level deep. Say so, since only one merge was asked for.
    if (also.length) flash(`"${alias}" is now "${canonical}" — and so ${also.length === 1 ? 'is' : 'are'} ${also.join(', ')}.`);
  }, `"${alias}" and "${canonical}" are one player now.`);

  const undoMerge = (alias) => run(`undo:${alias}`,
    () => axios.delete(`/api/admin/enemy-players/${encodeURIComponent(alias)}`),
    `"${alias}" is its own player again.`);

  const submitMerge = (e) => {
    e.preventDefault();
    const target = mergeTo.trim();
    if (!target) return flash('Pick or type the name to merge into.', false);
    if (target.toLowerCase() === mergeFrom.toLowerCase()) return flash('That maps a name to itself.', false);
    setMergeFrom(null); setMergeTo('');
    return applyMerge(mergeFrom, target);
  };

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

      <Toast msg={msg} />

      {isOfficer && merge.suggestions.length > 0 && (
        <div className="panel rounded-lg p-4 mb-5 border border-brass/30">
          <div className="eyebrow text-[10px] text-brass mb-3">Possible misreads</div>
          <div className="space-y-2">
            {merge.suggestions.map((sg) => (
              <div key={`${sg.alias}->${sg.canonical}`} className="flex items-center gap-3 flex-wrap text-sm">
                <span className="text-bone">{sg.alias}</span>
                <span className="text-ash/60">looks like</span>
                <span className="text-bone">{sg.canonical}</span>
                <button
                  onClick={() => applyMerge(sg.alias, sg.canonical)} disabled={busy === `merge:${sg.alias}`}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs border border-brass/50 text-brassbright hover:bg-panelup transition-colors disabled:opacity-40"
                >
                  {busy === `merge:${sg.alias}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Merge className="w-3 h-3" />}
                  Same player
                </button>
              </div>
            ))}
          </div>
          <p className="text-ash/60 text-xs mt-3">
            Suggested by name similarity within this guild only — two people can genuinely have similar names, so
            nothing merges until you say so.
          </p>
        </div>
      )}

      {isOfficer && merge.aliases.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-ash/60">Merged:</span>
          {merge.aliases.map((a) => (
            <button
              key={a.alias} onClick={() => undoMerge(a.alias)} disabled={busy === `undo:${a.alias}`}
              title={`Split "${a.alias}" back out from "${a.canonical}"`}
              className="inline-flex items-center gap-1.5 bg-panel border border-line rounded-full px-3 py-1 text-ash hover:text-oxblood transition-colors disabled:opacity-40"
            >
              {a.alias} → {a.canonical} <Undo2 className="w-3 h-3" />
            </button>
          ))}
        </div>
      )}

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
                  {isOfficer && (
                    <button
                      onClick={() => { setMergeFrom(p.player_name); setMergeTo(''); }}
                      title={`${p.player_name} is really another name on this list`}
                      className="text-ash/40 hover:text-brass transition-colors ml-2 align-middle"
                    >
                      <Merge className="w-3 h-3" />
                    </button>
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

      {mergeFrom && (
        <Modal onClose={() => setMergeFrom(null)} maxWidth="max-w-md">
          <div className="eyebrow text-brass text-[11px] mb-3">Same player</div>
          <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-1">{mergeFrom}</h2>
          <p className="text-ash text-sm mb-5">
            Their matches fold into whichever name you pick, and this spelling stops appearing on its own.
            Reversible from the chips above the table.
          </p>
          <form onSubmit={submitMerge}>
            <label className="eyebrow text-[10px] text-ash/75 block mb-1.5">Really this player</label>
            <input
              list="feud-player-names" value={mergeTo} onChange={(e) => setMergeTo(e.target.value)}
              placeholder="Pick a name from this roster" autoFocus
              className="w-full bg-hall border border-line rounded-lg px-4 py-2.5 text-bone focus:outline-none focus:border-brass"
            />
            <datalist id="feud-player-names">
              {(data?.players || [])
                .map((x) => x.player_name)
                .filter((n) => n !== mergeFrom)
                .map((n) => <option key={n} value={n} />)}
            </datalist>
            <div className="flex justify-end gap-3 mt-6">
              <Button type="button" variant="neutral" size="none" className="px-4 py-2" onClick={() => setMergeFrom(null)}>Cancel</Button>
              <Button type="submit" size="none" className="px-5 py-2" icon={<Merge className="w-4 h-4" />}>Merge</Button>
            </div>
          </form>
        </Modal>
      )}
    </PageShell>
  );
}
