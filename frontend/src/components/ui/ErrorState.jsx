import Button from './Button';
import { useT } from '../../i18n';

// Consolidates Home.jsx's HallError, MatchStats.jsx's RecordError, and
// GearLevels.jsx's inline error block — the first two always show a title
// (hardcoded or passed in), the third shows only the message, so title stays
// optional rather than defaulting to text that wouldn't apply everywhere.
export default function ErrorState({ title, message, onRetry }) {
  const { t } = useT();
  return (
    <div className="panel rounded-lg p-8 text-center">
      {title && <div className="font-display text-oxblood tracking-wide text-lg mb-2">{title}</div>}
      <p className="text-ash mb-6">{message}</p>
      <Button onClick={onRetry}>{t('common.tryAgain')}</Button>
    </div>
  );
}
