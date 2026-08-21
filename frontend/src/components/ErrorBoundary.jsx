import { Component } from 'react';
import { useLocation } from 'react-router-dom';

// ── THE LAST LINE BETWEEN A BAD RENDER AND A WHITE SCREEN ───────────────────
// React unmounts the whole tree when a render throws and nothing catches it.
// Without this the site went blank — no message, no nav, no way back except
// knowing to reload — and a member couldn't tell whether it was them, their
// connection, or the site.
//
// Must be a class. There is still no hook equivalent of componentDidCatch.
//
// Deliberately dependency-light: no Button, no icon package, no formatters. The
// one component whose job is to render when something else broke should import
// as little as possible, because anything it pulls in is something that can
// take the fallback down with it.
//
// It catches RENDER errors only. Rejected promises from axios calls are not
// errors React can see, which is why every page keeps its own catch and its own
// ErrorState — this is the floor under those, not a replacement for them.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, attempts: 0 };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Console is the whole reporting story — there is no error-collection
    // endpoint, and inventing one here would be a silent new network call from
    // the code path that runs when things are already going wrong.
    console.error('Render error caught by boundary:', error, info?.componentStack);
  }

  // Clearing on navigation is what stops the fallback becoming a dead end.
  // A boundary holds its error state forever otherwise, so clicking a sidebar
  // link would change the route and still show the crash from the old page.
  //
  // Driven by a prop rather than a `key` on purpose: keying the boundary on the
  // pathname would remount it — and its children — on every navigation,
  // including between two routes that render the same component (/roster/:name
  // to another name, /dashboard and /match-stats). That would quietly turn
  // re-renders into remounts across the app to fix a case that only matters
  // while an error is on screen.
  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null, attempts: 0 });
    }
  }

  retry = () => {
    this.setState((s) => ({ error: null, attempts: s.attempts + 1 }));
  };

  render() {
    const { error, attempts } = this.state;
    if (!error) return this.props.children;

    // A retry that has already failed once won't fix itself — the render is
    // deterministic. Say so rather than offering the same button a third time.
    const retryFailed = attempts >= 2;

    return (
      <div className={this.props.fullscreen ? 'min-h-screen bg-ink flex items-center justify-center p-6' : 'p-6'}>
        <div className="max-w-lg mx-auto panel rounded-lg border border-oxblood/40 p-8">
          <div className="flex items-center gap-2.5 mb-4">
            <svg viewBox="0 0 24 24" className="w-5 h-5 text-oxblood shrink-0" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="eyebrow text-[10px] text-oxblood">This page broke</span>
          </div>

          <h2 className="font-display text-2xl text-bone tracking-[0.06em] mb-3">
            Something went wrong here
          </h2>
          <p className="text-ash text-sm mb-6">
            {retryFailed
              ? 'Retrying hasn\'t helped, so this will need fixing rather than waiting out. Nothing you did caused it, and nothing has been lost — the rest of the site still works.'
              : 'The rest of the site still works — the sidebar is live, so you can head somewhere else. Nothing has been lost.'}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            {!retryFailed && (
              <button
                onClick={this.retry}
                className="px-5 py-2.5 bg-brass hover:bg-brassbright text-ink font-semibold rounded-lg transition-colors"
              >
                Try again
              </button>
            )}
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-2.5 border border-brass/50 text-brassbright hover:bg-panelup rounded-lg transition-colors"
            >
              Reload the page
            </button>
          </div>

          {/* Collapsed by default: a stack trace on screen reads as the site
              being broken open. Available, because "it says X" is the single
              most useful thing a member can pass on. */}
          <details className="mt-6 group">
            <summary className="text-ash/60 text-xs cursor-pointer hover:text-ash select-none">
              Details to pass on
            </summary>
            <pre className="mt-2 p-3 bg-hall border border-line rounded-lg text-[11px] text-ash overflow-auto max-h-40 whitespace-pre-wrap break-words">
              {String(error?.message || error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}

// Supplies the reset signal. A hook can't live in the class, so the pathname is
// read here and handed down. Only for boundaries mounted inside the Router.
export function RouteErrorBoundary({ children }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}

export default ErrorBoundary;
