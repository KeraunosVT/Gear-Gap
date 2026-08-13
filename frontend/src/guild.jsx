import { createContext, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import { configureGuildTime } from './timeUtils';

// ── GUILD IDENTITY, FETCHED AT RUNTIME ───────────────────────────────────────
// This used to be `import identity from '../../shared/guild.json'` — a build-time
// import, which meant renaming the house needed a rebuild and a deploy. The
// values now live in guild_config and are edited from Guild Settings, so they
// have to arrive over the wire.
//
// GET /api/guild is deliberately PUBLIC and outside the login wall: the login
// page renders the house name, so gating it behind auth would mean nobody could
// see whose hall they were signing in to.
//
// ── WHY THE FALLBACK MATTERS ────────────────────────────────────────────────
// As a bundled JSON import, branding could not fail. As a fetch, it can. If a
// database blip took this endpoint down and the provider refused to render, it
// would take the login page — and therefore the whole site — with it, over a
// motto. So a failed fetch logs, keeps FALLBACK, and renders anyway. The
// timezone default in timeUtils matches, so dates stay coherent rather than
// merely present.

const GuildContext = createContext(null);

const FALLBACK = {
  house: 'Guild Hall',
  tag: '',
  aliases: [],
  motto: null,
  creed: null,
  timezone: 'America/New_York',
  dayStart: '01:00',
};

export function GuildProvider({ children }) {
  const [guild, setGuild] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await axios.get('/api/guild');
        if (cancelled) return;
        const g = { ...FALLBACK, ...(res.data || {}) };
        // Before children render, not after. daySlot(), todayInGuildTz() and
        // friends read this live, and a component that resolves "today" one
        // render early would use the fallback rollover — which is not a visible
        // error, it is a date one day off in an LOA or an attendance snap.
        configureGuildTime(g.timezone, g.dayStart);
        setGuild(g);
      } catch (err) {
        if (cancelled) return;
        console.error('Could not load guild identity — using defaults:', err.message);
        setGuild(FALLBACK);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // The browser tab. This used to be a synchronous assignment in main.jsx from
  // the bundled import; it has to live here now, because the name isn't known
  // until the fetch lands. index.html carries a neutral placeholder until then.
  useEffect(() => {
    if (guild?.house) document.title = `${guild.house} — Guild Hall`;
  }, [guild]);

  // Nothing renders until identity resolves — one paint, with the right name and
  // the right timezone already in place. This is a same-origin request that
  // resolves in a few milliseconds, so there is no spinner: a flash of one would
  // be more disruptive than the wait.
  if (!ready) return null;

  return (
    <GuildContext.Provider value={guild || FALLBACK}>
      {children}
    </GuildContext.Provider>
  );
}

export function useGuild() {
  const ctx = useContext(GuildContext);
  // Not an error — a component rendered outside the provider (a test harness, a
  // future error boundary above it) should show the neutral name rather than
  // crash the tree over branding.
  return ctx || FALLBACK;
}
