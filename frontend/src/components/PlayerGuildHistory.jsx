import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { ExternalLink } from 'lucide-react';
import Modal from './ui/Modal';

// ── WHERE ELSE HAS THIS NAME PLAYED ─────────────────────────────────────────
// The question you ask standing on an enemy roster: have we seen this one
// before? A name under three guilds in a year is a mercenary; one that moved
// from a guild you beat to a guild you lose to is a transfer worth knowing.
//
// Opened from a name on the roster page and from the Feuds page search, so both
// paths land on the same answer.
//
// Guild names resolve through the same alias table the Feuds page uses, or a
// player's history would split across the very misreads that page merges.

const fmtM = (n) => ((Number(n) || 0) / 1e6).toFixed(1) + 'M';

const fmtDay = (d) => (d
  ? new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  : '—');

export default function PlayerGuildHistory({ name, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null); setError('');
    axios.get(`/api/players/${encodeURIComponent(name)}/guilds`)
      .then((res) => setData(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not look that name up.'));
  }, [name]);

  return (
    <Modal onClose={onClose} maxWidth="max-w-lg" scrollable>
      <div className="eyebrow text-brass text-[11px] mb-3">Where they&apos;ve played</div>
      <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-1">{name}</h2>

      {data && (
        <p className="text-ash text-sm mb-5">
          <span className="font-mono text-bone">{data.matches}</span> match{data.matches === 1 ? '' : 'es'} across{' '}
          <span className="font-mono text-bone">{data.guilds.length}</span> guild{data.guilds.length === 1 ? '' : 's'}
          {/* Only our own members resolve through identities — an enemy name
              simply isn't in it, so this link never appears for them. */}
          {data.member && (
            <>
              {' · '}
              <Link to={`/roster/${encodeURIComponent(data.member.display_name)}`} className="inline-flex items-center gap-1 text-brass hover:text-brassbright underline underline-offset-2">
                one of ours <ExternalLink className="w-3 h-3" />
              </Link>
            </>
          )}
        </p>
      )}

      {error ? (
        <p className="text-bone text-sm px-4 py-2.5 rounded-lg border border-oxblood/50 bg-oxblooddeep/20">{error}</p>
      ) : !data ? (
        <p className="text-ash text-sm">Looking…</p>
      ) : data.guilds.length === 0 ? (
        <p className="text-ash text-sm">No matches on record under that name.</p>
      ) : (
        <div className="space-y-2">
          {/* Newest first — the guild they're with NOW is the one you care
              about, and it reads as a history from the top down. */}
          {data.guilds.map((g) => (
            <div key={g.guild} className={`rounded-lg border px-4 py-3 ${g.is_ours ? 'border-brass/40 bg-panelup' : 'border-line bg-hall'}`}>
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <span className={g.is_ours ? 'text-brassbright font-semibold' : 'text-bone'}>
                  {g.guild}
                  {g.is_ours && <span className="eyebrow text-[10px] text-brass ml-2">us</span>}
                </span>
                <span className="font-mono text-sm text-ash">
                  {g.matches} match{Number(g.matches) === 1 ? '' : 'es'}
                </span>
              </div>
              <div className="flex items-baseline gap-x-4 gap-y-1 flex-wrap mt-1 text-xs text-ash/70 font-mono">
                <span>{fmtDay(g.first_seen)} – {fmtDay(g.last_seen)}</span>
                <span>{Number(g.kills) || 0} kills</span>
                <span>{fmtM(g.damage_dealt)} dmg</span>
                {Number(g.healing) > 0 && <span>{fmtM(g.healing)} heal</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
