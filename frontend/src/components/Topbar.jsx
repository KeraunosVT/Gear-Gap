import { useState, useRef, useEffect } from 'react';
import { useLocation, NavLink } from 'react-router-dom';
import { Moon, Sun, Check, PanelLeft, ChevronRight } from 'lucide-react';
import { guildLinks, memberLinks, adminLinks } from './Sidebar';
import { applyTheme } from '../theme';
import { applyPalette, PALETTES } from '../palette';

const ALL_LINKS = [...guildLinks, ...memberLinks, ...adminLinks];

function crumbFor(pathname) {
  const exact = ALL_LINKS.find((l) => l.to === pathname);
  if (exact) return exact.label;
  if (pathname.startsWith('/roster/')) return 'Roster';
  return 'House Regard';
}

const PALETTE_META = {
  dispatch: { label: 'Dispatch', swatch: '#d64545' },
  ironverdigris: { label: 'Iron & Verdigris', swatch: '#4f8f7c' },
  throneliberty: { label: 'Throne & Liberty', swatch: '#b8923f' },
};

export default function Topbar({ collapsed, onToggleSidebar }) {
  const { pathname } = useLocation();
  const isHome = pathname === '/';
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark');
  const [palette, setPalette] = useState(() => document.documentElement.dataset.palette || 'dispatch');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const chooseTheme = (next) => {
    applyTheme(next, true);
    setTheme(next);
  };
  const choosePalette = (next) => {
    applyPalette(next);
    setPalette(next);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-line">
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onToggleSidebar}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="p-2 -ml-2 rounded-md text-ash hover:text-bone hover:bg-panel transition-colors shrink-0"
        >
          <PanelLeft className="w-4 h-4" />
        </button>
        <div className="w-px h-5 bg-line shrink-0" />
        <nav className="flex items-center gap-1.5 text-sm min-w-0">
          <NavLink to="/" className={`shrink-0 transition-colors ${isHome ? 'text-bone font-semibold' : 'text-ash hover:text-bone'}`}>
            Dashboard
          </NavLink>
          {!isHome && (
            <>
              <ChevronRight className="w-3.5 h-3.5 text-ash/50 shrink-0" />
              <span className="text-bone font-semibold truncate">{crumbFor(pathname)}</span>
            </>
          )}
        </nav>
      </div>

      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          title="Appearance"
          aria-label="Appearance"
          aria-haspopup="true"
          aria-expanded={open}
          className="p-2 rounded-md text-ash hover:text-bone hover:bg-panel transition-colors"
        >
          {theme === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </button>

        {open && (
          <div className="absolute right-0 mt-2 w-56 panel rounded-lg shadow-xl p-3 z-50">
            <div className="eyebrow text-[10px] text-ash mb-2">Theme</div>
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => chooseTheme('dark')}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm transition-colors ${theme === 'dark' ? 'bg-panelup text-brassbright' : 'text-ash hover:text-bone'}`}
              >
                <Moon className="w-3.5 h-3.5" /> Dark
              </button>
              <button
                onClick={() => chooseTheme('light')}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm transition-colors ${theme === 'light' ? 'bg-panelup text-brassbright' : 'text-ash hover:text-bone'}`}
              >
                <Sun className="w-3.5 h-3.5" /> Light
              </button>
            </div>

            <div className="eyebrow text-[10px] text-ash mb-2">Look</div>
            <div className="space-y-1">
              {PALETTES.map((p) => (
                <button
                  key={p}
                  onClick={() => choosePalette(p)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${palette === p ? 'bg-panelup text-bone' : 'text-ash hover:text-bone'}`}
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: PALETTE_META[p].swatch }} />
                  <span className="flex-1 text-left">{PALETTE_META[p].label}</span>
                  {palette === p && <Check className="w-3.5 h-3.5 text-brass shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
