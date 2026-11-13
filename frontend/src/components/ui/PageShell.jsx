// The max-w mx-auto px-6 py-12 wrapper at the top of nearly every page.
//
// Three widths, named for what's on the page rather than a size, so pages of
// the same kind line up as you move between them:
//   narrow   — forms, settings, short single-column lists
//   standard — lists and profiles (the default)
//   full     — boards and wide tables that use every pixel (loot, parties)
const WIDTHS = {
  narrow: 'max-w-3xl',
  standard: 'max-w-6xl',
  full: 'max-w-none',
};

export function PageShell({ width = 'standard', paddingX = 'px-6', className = '', children }) {
  return <div className={`${WIDTHS[width] || WIDTHS.standard} mx-auto ${paddingX} py-12 ${className}`}>{children}</div>;
}
