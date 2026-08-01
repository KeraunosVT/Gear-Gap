import { Coins } from 'lucide-react';
import { CURRENCY_ICON, CURRENCY_LABEL } from '../../currencies';

// The real in-game icon where one has been mirrored into our bucket, falling
// back to a generic coin glyph otherwise — the shards have no icon yet, and a
// half-iconed list reads worse than a consistently plain one.
export default function CurrencyIcon({ currency, className = 'w-4 h-4' }) {
  const label = CURRENCY_LABEL[currency] || currency;
  const src = CURRENCY_ICON[currency];
  if (!src) return <Coins className={`${className} text-brass shrink-0`} aria-label={label} />;
  return (
    <img
      src={src} alt={label} title={label} loading="lazy" draggable="false"
      className={`${className} shrink-0 object-contain`}
    />
  );
}
