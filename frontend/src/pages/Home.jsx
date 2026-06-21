import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import Sigil from '../components/Sigil';
import { GUILD } from '../guild';

export default function Home() {
  const [stats, setStats] = useState({});
  const [recentMatches, setRecentMatches] = useState([]);
  const [wdl, setWdl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError(false);
    try {
      const [statsRes, matchesRes, last10Res] = await Promise.all([
        axios.get('/api/stats/summary'),
        axios.get('/api/matches/recent?limit=6'),
        axios.get('/api/matches/recent?limit=10'),
      ]);
      setStats(statsRes.data);
      setRecentMatches(matchesRes.data);
      const last10 = last10Res.data || [];
      const w = last10.filter((m) => m.result === 'Win').length;
      const d = last10.filter((m) => m.result === 'Draw').length;
      const l = last10.filter((m) => m.result === 'Loss').length;
      if (w + d + l > 0) setWdl({ w, d, l });
    } catch (err) {
      console.error(err);
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const ledger = [
    { label: 'Engagements', value: stats.totalMatches ?? '—' },
    { label: 'Kills',       value: stats.totalKills ?? '—' },
    { label: 'Damage',      value: stats.totalDamage ?? '—' },
    { label: 'Healing',     value: stats.totalHealing ?? '—' },
  ];

  return (
    <div>
      {/* ── BANNER HERO ─────────────────────────────────────────── */}
      <section className="hall-grain border-b border-line">
        <div className="max-w-6xl mx-auto px-6 pt-20 pb-16 flex flex-col items-center text-center">
          {/* Heraldic banner */}
          <div className="rise relative mb-8">
            <div
              className="w-28 h-40 bg-gradient-to-b from-oxblood to-oxblooddeep border-x border-t border-brass/40 flex items-start justify-center pt-7"
              style={{ clipPath: 'polygon(0 0, 100% 0, 100% 86%, 50% 100%, 0 86%)' }}
            >
              <Sigil className="w-14 h-[4.5rem] text-brassbright" />
            </div>
          </div>

          <div className="rise rise-1 eyebrow text-brass text-[11px] mb-5">
            Throne &amp; Liberty
          </div>
          <h1 className="rise rise-1 font-display font-bold text-bone text-5xl md:text-7xl tracking-[0.08em] leading-tight">
            {GUILD.house}
          </h1>
          <p className="rise rise-2 font-display text-brassbright text-lg md:text-xl tracking-[0.12em] mt-6">
            {GUILD.motto}
          </p>
          <p className="rise rise-2 max-w-xl text-ash mt-5 leading-relaxed">
            {GUILD.creed}
          </p>

          <Link
            to="/war-record"
            className="rise rise-3 mt-10 inline-flex items-center gap-2 px-8 py-3.5 bg-brass hover:bg-brassbright text-ink font-semibold tracking-wide rounded-sm transition-colors"
          >
            Enter the War Record
            <span aria-hidden>→</span>
          </Link>
        </div>
      </section>

      {/* ── STANDING OF THE HOUSE (engraved ledger) ─────────────── */}
      <section className="border-b border-line bg-hall">
        <div className="max-w-6xl mx-auto px-6 py-10">
          <div className="eyebrow text-ash text-[11px] text-center mb-7">
            Standing of the House
          </div>

          {error ? (
            <HallError onRetry={fetchData} message="The standing could not be read from the records." />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4">
              {ledger.map((item, i) => (
                <div
                  key={item.label}
                  className={`px-6 py-5 text-center ${
                    i !== 0 ? 'border-l border-line' : ''
                  } ${i === 2 ? 'border-l-0 md:border-l border-line' : ''}`}
                >
                  <div className="font-mono text-3xl md:text-4xl text-brassbright tabular-nums">
                    {loading ? '·' : item.value}
                  </div>
                  <div className="eyebrow text-[10px] text-ash mt-3">{item.label}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── WAR RECORD (recent engagements) ─────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="flex items-baseline justify-between mb-2">
          <div className="flex items-baseline gap-4">
            <h2 className="font-display text-2xl text-bone tracking-[0.1em]">War Record</h2>
            {wdl && (
              <span className="text-sm text-ash font-mono">
                Last 10: <span className="text-emerald-400">{wdl.w}</span>/<span className="text-amber-400">{wdl.d}</span>/<span className="text-oxblood">{wdl.l}</span>
              </span>
            )}
          </div>
          <Link to="/war-record" className="text-sm text-brass hover:text-brassbright transition-colors">
            Full record →
          </Link>
        </div>
        <div className="rule-fade mb-8" />

        {error && !loading ? (
          <HallError onRetry={fetchData} message="The war record could not be summoned." />
        ) : loading ? (
          <div className="py-16 text-center text-ash">Reading the record…</div>
        ) : recentMatches.length === 0 ? (
          <div className="py-16 text-center text-ash">
            No engagements logged yet. The field awaits.
          </div>
        ) : (
          <div className="border border-line rounded-sm divide-y divide-line overflow-hidden">
            {recentMatches.map((m) => (
              <EngagementRow key={m.id} match={m} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function EngagementRow({ match }) {
  const result = match.result;
  const held = result ? result === 'Win' : (match.winningGuild === GUILD.tag || match.winningGuild === 'FTP');
  const draw = result === 'Draw';
  const decided = result ? result !== 'Draw' : match.killDifference > 0;

  const date = match.match_date
    ? new Date(match.match_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—';
  const year = match.match_date ? new Date(match.match_date + 'T12:00:00').getFullYear() : '';

  return (
    <Link
      to={`/war-record?match=${match.id}`}
      className="group flex items-center gap-5 px-5 py-4 bg-panel hover:bg-panelup transition-colors"
    >
      <div className="w-14 shrink-0 text-center">
        <div className="font-mono text-bone leading-none">{date}</div>
        <div className="font-mono text-[10px] text-ash mt-1">{year}</div>
      </div>

      <div className="w-px self-stretch bg-line" />

      <div className="min-w-0 flex-1">
        <div className="font-medium text-bone truncate group-hover:text-brassbright transition-colors">
          {match.title || 'Wargame engagement'}
        </div>
        <div className="font-mono text-xs text-ash mt-1">
          {(match.kills ?? 0).toLocaleString()} kills · {match.damage ? (match.damage / 1e6).toFixed(1) + 'M dmg' : '—'}
        </div>
      </div>

      <div className="shrink-0 text-right">
        {decided ? (
          <>
            <div className={`eyebrow text-[10px] ${held ? 'text-brassbright' : 'text-oxblood'}`}>
              {held ? 'Held the field' : 'Lost the field'}
            </div>
            <div className="font-mono text-sm text-ash mt-1">+{match.killDifference}</div>
          </>
        ) : (
          <div className="eyebrow text-[10px] text-amber-400">Contested field</div>
        )}
      </div>
    </Link>
  );
}

function HallError({ onRetry, message }) {
  return (
    <div className="panel rounded-sm p-8 text-center">
      <div className="font-display text-oxblood tracking-wide text-lg mb-2">The record is sealed</div>
      <p className="text-ash mb-6">{message} The hall may be offline — try again.</p>
      <button
        onClick={onRetry}
        className="px-6 py-2.5 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
