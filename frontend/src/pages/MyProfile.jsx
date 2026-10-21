import { useState, useEffect } from 'react';
import { Navigate, Link } from 'react-router-dom';
import axios from 'axios';
import { UserSearch } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import { useT } from '../i18n';

// /me is a resolver, not a page: a session knows a Discord id, but profiles are
// addressed by in-game name. Redirecting means the nav link can be a plain
// static entry and the profile itself stays a single component addressed one
// way — and a shared /roster/<name> link still works for everyone else.
export default function MyProfile() {
  const { t, rich } = useT();
  const [state, setState] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get('/api/my-profile')
      .then((res) => setState(res.data))
      .catch((err) => setError(err.response?.data?.error || t('profile.loadFailed')));
  }, []);

  if (error) return <PageShell maxWidth="max-w-2xl"><EmptyState>{error}</EmptyState></PageShell>;
  if (!state) return <PageShell maxWidth="max-w-2xl"><EmptyState>{t('profile.finding')}</EmptyState></PageShell>;

  if (state.mapped && state.hasRecord) {
    return <Navigate to={`/roster/${encodeURIComponent(state.name)}`} replace />;
  }

  // Both failure modes are fixable, so say which one it is and by whom.
  return (
    <PageShell maxWidth="max-w-2xl">
      <div className="panel rounded-lg p-8 text-center">
        <UserSearch className="w-8 h-8 text-brass mx-auto mb-4" />
        <h2 className="font-display text-xl text-bone tracking-[0.06em] mb-3">{t('profile.none')}</h2>
        {!state.mapped ? (
          <p className="text-ash text-sm leading-relaxed">
            {rich('profile.notLinked', {}, { b: (x) => <span className="text-bone">{x}</span> })}
          </p>
        ) : (
          <p className="text-ash text-sm leading-relaxed">
            {rich('profile.noRecords', { name: state.name }, { b: (x) => <span className="text-brassbright">{x}</span> })}
          </p>
        )}
        <Link to="/roster" className="inline-block mt-5 text-sm text-brass hover:text-brassbright transition-colors">
          {t('profile.browse')}
        </Link>
      </div>
    </PageShell>
  );
}
