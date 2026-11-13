import { useAuth } from '../auth';
import { visibleEventTabs } from './Sidebar';
import SectionTabs from './SectionTabs';

// The tab bar across Event Calendar, Signups, LOA and (for officers)
// Attendance.
export default function EventsNav() {
  const { can } = useAuth();
  return <SectionTabs tabs={visibleEventTabs(can)} label="Events" />;
}
