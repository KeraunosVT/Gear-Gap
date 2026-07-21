import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Moon, Sun } from 'lucide-react';
import { guildLinks, memberLinks, adminLinks } from './Sidebar';
import { applyTheme } from '../theme';

const ALL_LINKS = [...guildLinks, ...memberLinks, ...adminLinks];

function crumbFor(pathname) {
  const exact = ALL_LINKS.find((l) => l.to === pathname);
  if (exact) return exact.label;
  if (pathname.startsWith('/roster/')) return 'Roster';
  return 'House Regard';
}

export default function Topbar() {
  const { pathname } = useLocation();
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || 'dark');

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
    setTheme(next);
  };

  return (
    <div className="h-14 shrink-0 flex items-center justify-between px-6 border-b border-line">
      <span className="text-sm font-semibold text-bone">{crumbFor(pathname)}</span>
      <button
        onClick={toggleTheme}
        title="Toggle theme"
        aria-label="Toggle theme"
        className="p-2 rounded-md text-ash hover:text-bone hover:bg-panel transition-colors"
      >
        {theme === 'dark' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
      </button>
    </div>
  );
}
