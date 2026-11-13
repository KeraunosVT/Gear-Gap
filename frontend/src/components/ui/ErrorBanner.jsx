// The inline red banner for something that went wrong while the page itself is
// fine: a failed save, a failed load of one panel, a warning to act on.
// ErrorState is the other case — the page couldn't load — and takes over the
// whole panel with a retry, which would be wrong here.
//
// `className` replaces the default bottom margin and can add layout (an
// icon-and-button row, an entrance animation). `compact` is the tighter size
// used inside modals and side panels.
export default function ErrorBanner({ children, className = 'mb-6', compact = false }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      className={`${className} ${compact ? 'px-4 py-2.5' : 'px-5 py-3'} rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm`}
    >
      {children}
    </div>
  );
}
