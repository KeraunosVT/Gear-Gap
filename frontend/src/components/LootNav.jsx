import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth';
import { useT } from '../i18n';
import { visibleLootTabs, navLabel } from './Sidebar';

// The tab bar across the top of every Loot Council page. The sidebar holds one
// link for the whole group; this is how you move between its pages. Each tab
// is a real route, so bookmarks and links into a single page keep working.
// Tabs follow the same permission rules as the sidebar (visibleLootTabs), and
// an officer who can open only one page gets no bar at all.
export default function LootNav() {
  const { can } = useAuth();
  const { t } = useT();
  const tabs = visibleLootTabs(can);
  if (tabs.length < 2) return null;
  return (
    <nav aria-label={navLabel(t, 'Loot Council')} className="flex flex-wrap gap-1 mb-6 pb-3 border-b border-line">
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
