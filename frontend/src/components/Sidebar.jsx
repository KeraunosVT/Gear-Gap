import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Swords, Users, Gem, Package, CalendarOff, Layers, Gauge,
  Upload, LayoutGrid, Tag, Gavel, ClipboardCheck, ScrollText, LogOut,
} from 'lucide-react';
import Sigil from './Sigil';
import { GUILD } from '../guild';
import { useAuth } from '../auth';

export const guildLinks = [
  { to: '/', label: 'Dashboard', end: true, icon: LayoutDashboard },
  { to: '/war-record', label: 'War Record', icon: Swords },
  { to: '/roster', label: 'Roster', icon: Users },
];

export const memberLinks = [
  { to: '/shards', label: 'Shards', icon: Gem },
  { to: '/loot', label: 'Loot', icon: Package },
  { to: '/loa', label: 'LOA', icon: CalendarOff },
  { to: '/classes', label: 'Classes', icon: Layers },
  { to: '/gear', label: 'Gear Level', icon: Gauge },
];

export const adminLinks = [
  { to: '/admin', label: 'Upload Match', end: true, icon: Upload },
  { to: '/admin/parties', label: 'Parties', icon: LayoutGrid },
  { to: '/admin/names', label: 'Names', icon: Tag },
  { to: '/admin/loot', label: 'Loot Council', icon: Gavel },
  { to: '/admin/attendance', label: 'Attendance', icon: ClipboardCheck },
  { to: '/admin/gear-levels', label: 'Gear Levels', icon: Gauge },
  { to: '/admin/audit-log', label: 'Audit Log', icon: ScrollText },
];

export const SIDEBAR_COLLAPSE_KEY = 'sidebarCollapsed';

// No stored preference yet → start collapsed on phone/small-tablet widths,
// matching today's Masthead losing the username below `sm`.
export function getInitialSidebarCollapsed() {
  const stored = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return window.matchMedia('(max-width: 767px)').matches;
}

export default function Sidebar({ collapsed }) {
  const { user, logout } = useAuth();

  const linkClass = ({ isActive }) =>
    `flex items-center gap-3 rounded-md font-medium tracking-wide transition-colors ${
      collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'
    } ${isActive ? 'text-brassbright bg-panel' : 'text-ash hover:text-bone'}`;

  return (
    <aside className={`shrink-0 border-r border-line bg-ink flex flex-col transition-[width] duration-150 ${collapsed ? 'w-16' : 'w-60'}`}>
      <NavLink to="/" className="flex items-center gap-3 px-4 h-16 border-b border-line shrink-0">
        <Sigil className="w-7 h-9 text-brass shrink-0" />
        {!collapsed && (
          <div className="leading-none min-w-0">
            <div className="font-display text-bone text-sm tracking-[0.18em] truncate">{GUILD.house.toUpperCase()}</div>
            <div className="text-[10px] text-ash tracking-[0.25em] mt-1">⟨ {GUILD.tag} ⟩</div>
          </div>
        )}
      </NavLink>

      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        <NavSection title="Guild" links={guildLinks} linkClass={linkClass} collapsed={collapsed} />
        {user && <NavSection title="Member" links={memberLinks} linkClass={linkClass} collapsed={collapsed} />}
        {user?.isAdmin && <NavSection title="Admin" links={adminLinks} linkClass={linkClass} collapsed={collapsed} />}
      </nav>

      {user && (
        <div className="border-t border-line p-3 flex items-center gap-2.5">
          {user.avatar
            ? <img src={user.avatar} alt="" className="w-7 h-7 rounded-full border border-line object-cover shrink-0" />
            : <div className="w-7 h-7 rounded-full bg-panelup border border-line flex items-center justify-center text-[11px] text-brass shrink-0">{(user.username || '?').slice(0, 1).toUpperCase()}</div>}
          {!collapsed && (
            <>
              <span className="text-sm text-bone truncate flex-1 min-w-0">{user.username}</span>
              <button onClick={logout} title="Sign out" aria-label="Sign out" className="p-1.5 rounded-md text-ash hover:text-oxblood hover:bg-panel transition-colors shrink-0">
                <LogOut className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

function NavSection({ title, links, linkClass, collapsed }) {
  return (
    <div>
      {!collapsed && <div className="eyebrow text-[10px] text-ash/75 px-3 mb-1.5">{title}</div>}
      <div className="space-y-0.5">
        {links.map(({ to, label, end, icon: Icon }) => (
          <NavLink key={to} to={to} end={end} className={linkClass} title={collapsed ? label : undefined}>
            <Icon className="w-4 h-4 shrink-0" />
            {!collapsed && <span className="truncate">{label}</span>}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
