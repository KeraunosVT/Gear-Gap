import { NavLink } from 'react-router-dom';
import { useT } from '../i18n';
import { navLabel } from './Sidebar';

// The tab bar across the top of every page in a sidebar group (Loot Council,
// Events). The sidebar holds one link for the group; this is how you move
// between its pages. Each tab is a real route, so bookmarks and links into a
// single page keep working. `tabs` comes from the sidebar's own permission
// rules, and someone who can open only one page gets no bar at all.
export default function SectionTabs({ tabs, label }) {
  const { t } = useT();
  if (tabs.length < 2) return null;
  return (
    <nav aria-label={navLabel(t, label)} className="flex flex-wrap gap-1 mb-6 pb-3 border-b border-line">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to} to={tab.to} end
          className={({ isActive }) => `px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            isActive ? 'bg-panel text-brassbright' : 'text-ash hover:text-bone'}`}
        >
          {navLabel(t, tab.label)}
        </NavLink>
      ))}
    </nav>
  );
}
