import { CATEGORIES, OTHER, categoryOf } from '../eventCategories';
import { useT } from '../i18n';

// The event type picker, for the calendar's New Event form and the schedule
// manager. "Auto" stores nothing and keeps reading the type off the name, and
// says what that currently comes to, so leaving it is a choice made knowing the
// answer. The dot is the colour the calendar will use.
export default function CategorySelect({ value, onChange, title = '', className = '' }) {
  const { t } = useT();
  const resolved = categoryOf(title, value || null);
  return (
    <div className="flex items-center gap-2">
      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: resolved.color }} />
      <select value={value} onChange={(e) => onChange(e.target.value)} className={className} title={t('cal.type')}>
        <option value="">{t('cal.typeAuto', { type: t(`cat.${categoryOf(title).key}`) })}</option>
        {[...CATEGORIES, OTHER].map((c) => <option key={c.key} value={c.key}>{t(`cat.${c.key}`)}</option>)}
      </select>
    </div>
  );
}
