import { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { LogOut, ChevronDown } from 'lucide-react';
import Sigil from './Sigil';
import { GUILD } from '../guild';
import { useAuth } from '../auth';

const topLinks = [
  { to: '/', label: 'The Hall', end: true },
  { to: '/war-record', label: 'War Record' },
  { to: '/roster', label: 'Roster' },
];

const membersLinks = [
  { to: '/shards', label: 'Shards' },
  { to: '/loot', label: 'Loot' },
  { to: '/loa', label: 'LOA' },
];

const adminLinks = [
  { to: '/admin', label: 'Upload Match', end: true },
  { to: '/admin/parties', label: 'Parties' },
  { to: '/admin/names', label: 'Names' },
  { to: '/admin/loot', label: 'Loot Council' },
  { to: '/admin/attendance', label: 'Attendance' },
];

const linkClass = ({ isActive }) =>
  `px-4 py-2 rounded-md font-medium tracking-wide transition-colors ${
    isActive ? 'text-brassbright bg-panel' : 'text-ash hover:text-bone'
  }`;

export default function Masthead() {
  const { user, logout } = useAuth();

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-ink/85 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
        <NavLink to="/" className="flex items-center gap-3 group shrink-0">
          <Sigil className="w-7 h-9 text-brass group-hover:text-brassbright transition-colors" />
          <div className="leading-none">
            <div className="font-display text-bone text-sm tracking-[0.22em]">{GUILD.house.toUpperCase()}</div>
            <div className="text-[10px] text-ash tracking-[0.3em] mt-1">⟨ {GUILD.tag} ⟩</div>
          </div>
        </NavLink>

        <div className="flex items-center gap-2">
          <nav className="flex items-center gap-1 text-sm">
            {topLinks.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={linkClass}>{l.label}</NavLink>
            ))}
            {user && <NavDropdown label="Members" links={membersLinks} />}
            {user?.isAdmin && <NavDropdown label="Admin" links={adminLinks} />}
          </nav>

          {user && (
            <div className="flex items-center gap-3 pl-3 ml-1 border-l border-line">
              {user.avatar
                ? <img src={user.avatar} alt="" className="w-7 h-7 rounded-full border border-line object-cover" />
                : <div className="w-7 h-7 rounded-full bg-panelup border border-line flex items-center justify-center text-[11px] text-brass">{(user.username || '?').slice(0, 1).toUpperCase()}</div>}
              <span className="hidden sm:inline text-sm text-bone max-w-[10rem] truncate">{user.username}</span>
              <button onClick={logout} title="Sign out" aria-label="Sign out" className="p-2 rounded-md text-ash hover:text-oxblood hover:bg-panel transition-colors">
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function NavDropdown({ label, links }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const { pathname } = useLocation();
  const active = links.some((l) => pathname === l.to || pathname.startsWith(l.to + '/'));

  useEffect(() => { setOpen(false); }, [pathname]); // close on navigate
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true" aria-expanded={open}
        className={`inline-flex items-center gap-1 px-4 py-2 rounded-md font-medium tracking-wide transition-colors ${active ? 'text-brassbright bg-panel' : 'text-ash hover:text-bone'}`}
      >
        {label} <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-44 panel rounded-sm shadow-xl py-1 z-50">
          {links.map((l) => (
            <NavLink
              key={l.to} to={l.to} end={l.end}
              className={({ isActive }) =>
                `block px-4 py-2 text-sm transition-colors ${isActive ? 'text-brassbright bg-panelup' : 'text-ash hover:text-bone hover:bg-panelup'}`}
            >
              {l.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
