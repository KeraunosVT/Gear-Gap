import SHARDS from '../../shared/shards.json';

// Lucent plus the archboss shards, defined once. The Lucent & Shards ledger,
// Lucent Requests, and Loot History all render the same set and each used to
// rebuild this list locally.
//
// Icons are public URLs in our own storage bucket, mirrored rather than
// hotlinked — see backend/scripts/mirrorCurrencyIcons.js for the reasoning and
// for how to add more. Same bucket the item icons in loot_items.image_url come
// from, so the origin is already public to the client either way. Nothing has
// an icon until it's been mirrored; the shards don't have one yet, and
// CurrencyIcon falls back to a coin glyph for anything missing.
const ICON_BASE = 'https://yukrxjxaedioymfpaseu.supabase.co/storage/v1/object/public/assets/currency-icons';
const ICONS = {
  lucent: `${ICON_BASE}/lucent.webp`,
};

export const CURRENCY_TYPES = [{ key: 'lucent', label: 'Lucent' }, ...SHARDS.types]
  .map((c) => ({ ...c, icon: ICONS[c.key] || null }));

export const CURRENCY_LABEL = Object.fromEntries(CURRENCY_TYPES.map((c) => [c.key, c.label]));
export const CURRENCY_ICON = Object.fromEntries(CURRENCY_TYPES.map((c) => [c.key, c.icon]));
