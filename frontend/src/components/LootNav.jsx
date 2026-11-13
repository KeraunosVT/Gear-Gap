import { useAuth } from '../auth';
import { visibleLootTabs } from './Sidebar';
import SectionTabs from './SectionTabs';

// The tab bar across every Loot Council page.
export default function LootNav() {
  const { can } = useAuth();
  return <SectionTabs tabs={visibleLootTabs(can)} label="Loot Council" />;
}
