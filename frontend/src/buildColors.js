// How PvP, Second Build and PvE look, everywhere: loot wishlists and awards,
// Shards, character builds, the Parties toggle. These are fixed Tailwind
// colours rather than palette tokens on purpose: in the default palette
// `oxblood` and `brass` are both reds, so PvP and Second Build were two
// near-identical chips. Red / gold / green stays distinct on every palette.
// Text shades step down in light mode, where the -400s fail contrast on white.
// The order is the catalog's priority order (shared/loot.json); the server
// sends it too, but rows need a stable sort before the catalog has loaded.
export const BUILDS = ['PvP', 'Second Build', 'PvE'];

export const BUILD_SHORT = { 'PvP': 'PvP', 'Second Build': '2nd', 'PvE': 'PvE' };

export const BUILD_TEXT = {
  'PvP': 'text-rose-600 dark:text-rose-400',
  'Second Build': 'text-amber-700 dark:text-amber-400',
  'PvE': 'text-emerald-700 dark:text-emerald-400',
};

export const BUILD_DOT = {
  'PvP': 'bg-rose-500',
  'Second Build': 'bg-amber-500',
  'PvE': 'bg-emerald-500',
};

export const BUILD_BORDER = {
  'PvP': 'border-rose-500/40',
  'Second Build': 'border-amber-500/40',
  'PvE': 'border-emerald-500/40',
};

// A selected build chip. Dark text on the -400 fill reads in both themes.
export const BUILD_CHIP_ON = {
  'PvP': 'bg-rose-400 text-neutral-950 border-transparent',
  'Second Build': 'bg-amber-400 text-neutral-950 border-transparent',
  'PvE': 'bg-emerald-400 text-neutral-950 border-transparent',
};
export const BUILD_CHIP_OFF = 'border-line text-ash hover:text-bone';

// The character-build pages key builds by lowercase kind.
export const KIND_BUILD = { pvp: 'PvP', pve: 'PvE' };

export const buildIndex = (b) => {
  const i = BUILDS.indexOf(b);
  return i === -1 ? BUILDS.length : i;
};
