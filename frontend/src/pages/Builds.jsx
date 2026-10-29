import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { Search, ChevronRight } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import { useAuth } from '../auth';
import { KINDS, KIND_LABEL, KIND_CHIP } from '../buildStats';

// A build older than this gets marked, the same "is this still true?" nudge
// the gear level tile gives.
const STALE_DAYS = 30;

const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function Updated({ iso, cls }) {
  if (!iso) return <span className="text-ash/40 text-xs whitespace-nowrap">Not uploaded</span>;
  const d = daysAgo(iso);
  const stale = d >= STALE_DAYS;
  return (
    <span className="min-w-0">
      {cls && <span className="block text-xs text-bone truncate">{cls}</span>}
      <span className={`block text-xs whitespace-nowrap ${stale ? 'text-oxblood' : 'text-ash'}`} title={stale ? `Not updated for ${d} days` : undefined}>
        {fmtDate(iso)} · {d === 0 ? 'today' : `${d}d ago`}
      </span>
    </span>
  );
}

// The guild's builds at a glance: who has uploaded which, and how recently.
// Each member's actual numbers are one click away on /builds/:discordId.
export default function Builds() {
  const { user } = useAuth();
  const [members, setMembers] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    axios.get('/api/builds')
      .then((r) => setMembers(r.data.members || []))
      .catch((err) => setError(err.response?.data?.error || 'Could not load builds.'));
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (members || [])
      // A member's name or either build's class, so "templar" finds the Templars.
      .filter((m) => !q || [m.display_name, m.classes?.pve, m.classes?.pvp].some((s) => (s || '').toLowerCase().includes(q)))
      .filter((m) => filter === 'all' || (filter === 'missing' ? !m.pve || !m.pvp : m.pve || m.pvp))
      .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  }, [members, query, filter]);

  const mine = members?.find((m) => m.discord_id === user?.id);
  const counts = useMemo(() => ({
    both: (members || []).filter((m) => m.pve && m.pvp).length,
    total: (members || []).length,
  }), [members]);

  if (error) return <PageShell maxWidth="max-w-5xl"><EmptyState>{error}</EmptyState></PageShell>;
  if (!members) return <PageShell maxWidth="max-w-5xl"><EmptyState>Loading…</EmptyState></PageShell>;

  return (
    <PageShell maxWidth="max-w-5xl">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
        <p className="text-sm text-ash max-w-xl">
          Every member&apos;s PvE and PvP stats, read from their character stats screenshots.
          {' '}<span className="text-bone">{counts.both}</span> of {counts.total} members have uploaded both.
        </p>
        <Link
          to={`/builds/${user?.id}`}
          className="px-4 py-2 bg-brass hover:bg-brassbright text-ink text-sm font-semibold rounded-lg transition-colors shrink-0"
        >
          {mine?.pve || mine?.pvp ? 'My builds' : 'Upload my builds'}
        </Link>
      </div>

      <div className="flex items-center gap-3 flex-wrap mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-ash absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a member or class"
            className="w-full bg-hall border border-line rounded-lg pl-9 pr-4 py-2 text-sm text-bone focus:outline-none focus:border-brass"
          />
        </div>
        <div className="inline-flex items-center rounded-full border border-line bg-hall p-0.5">
          {[['all', 'Everyone'], ['has', 'Has a build'], ['missing', 'Missing one']].map(([k, label]) => (
            <button key={k} onClick={() => setFilter(k)}
              className={`px-3 py-1 rounded-full text-xs font-bold tracking-wide transition-all ${filter === k ? 'bg-brass text-ink' : 'text-ash'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="panel rounded-lg p-10 text-center text-ash">Nobody matches that.</div>
      ) : (
        <div className="panel rounded-lg divide-y divide-line">
          <div className="hidden sm:grid grid-cols-[1fr_220px_220px_20px] gap-4 px-5 py-2 eyebrow text-[10px] text-ash">
            <span>Member</span>
            {KINDS.map((k) => <span key={k}>{KIND_LABEL[k]} build</span>)}
            <span />
          </div>
          {rows.map((m) => (
            <Link
              key={m.discord_id} to={`/builds/${m.discord_id}`}
              className="grid grid-cols-[1fr_20px] sm:grid-cols-[1fr_220px_220px_20px] gap-x-4 gap-y-1 items-center px-5 py-3 hover:bg-panelup transition-colors"
            >
              <span className="text-bone text-sm font-medium truncate">
                {m.display_name || 'Member'}
                {m.discord_id === user?.id && <span className="text-ash text-xs font-normal"> · you</span>}
              </span>
              {KINDS.map((k) => (
                <span key={k} className="flex items-center gap-2 col-start-1 sm:col-start-auto">
                  <span className={`sm:hidden text-[10px] font-bold tracking-wide rounded-full px-2 py-0.5 border ${KIND_CHIP[k]}`}>{KIND_LABEL[k]}</span>
                  <Updated iso={m[k]} cls={m.classes?.[k]} />
                </span>
              ))}
              {/* Pinned beside the name on phones, where the dates stack below
                  it. Both overrides matter on wider screens: leaving row-start-1
                  in place makes the grid place the chevron first, in column 1,
                  and every other cell shifts one column right. */}
              <ChevronRight className="w-4 h-4 text-ash row-start-1 col-start-2 sm:row-start-auto sm:col-start-auto justify-self-end" />
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  );
}
