// The inline red banner for an action that failed (a save, an award) while the
// page itself is fine. ErrorState is the other case — the page couldn't load —
// and takes over the whole panel with a retry, which would be wrong here.
export default function ErrorBanner({ children, className = 'mb-6' }) {
  if (!children) return null;
  return (
    <div role="alert" className={`${className} px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm`}>
      {children}
    </div>
  );
}
