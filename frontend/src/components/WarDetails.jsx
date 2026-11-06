// frontend/src/components/WarDetails.jsx — a War Games night's maps and
// rules, as members see them: on the signup card and in the calendar's
// detail panel. Officers set them on the Signups page.
import { Map as MapIcon, ScrollText } from 'lucide-react';
import { useT } from '../i18n';

// What members see of a War Games night's maps and rules — on the signup card
// and in the calendar's detail panel. Nothing when neither is set.
export default function WarDetails({ row, className = '' }) {
  const { t } = useT();
  if (!row?.war_maps && !row?.war_rules) return null;
  return (
    <div className={`space-y-1.5 text-sm ${className}`}>
      {row.war_maps && (
        <div className="flex items-start gap-1.5 text-bone">
          <MapIcon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-brass" />
          <span><span className="text-ash">{t('signups.maps')}:</span> {row.war_maps}</span>
        </div>
      )}
      {row.war_rules && (
        <div className="flex items-start gap-1.5 text-bone">
          <ScrollText className="w-3.5 h-3.5 mt-0.5 shrink-0 text-brass" />
          <div>
            <div className="text-ash">{t('signups.rules')}</div>
            <div className="whitespace-pre-line">{row.war_rules}</div>
          </div>
        </div>
      )}
    </div>
  );
}
