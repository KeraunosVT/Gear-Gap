import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { ArrowLeft, Upload, History, Pencil } from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import EmptyState from '../components/ui/EmptyState';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';
import { useAuth } from '../auth';
import { KINDS, KIND_LABEL, KIND_CHIP } from '../buildStats';
import BuildSheet from '../components/builds/BuildSheet';
import KeyStats from '../components/builds/KeyStats';
import CompareTable from '../components/builds/CompareTable';
import BuildHistory, { HOW_LABEL, fmtWhen, summarise } from '../components/builds/BuildHistory';
import { UploadBuildModal, FixBuildModal } from '../components/builds/BuildModals';

const daysAgo = (iso) => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
const ago = (iso) => { const d = daysAgo(iso); return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// One member's PvE and PvP builds. Anyone can look; the member and officers
// with 'builds' can upload or fix values, and those officers also pick and
// order the key stats at the top of each build — this member's, this build's.
export default function MemberBuild() {
  const { discordId } = useParams();
  const { user, can } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [view, setView] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [modal, setModal] = useState(null);
  const [msg, flash] = useFlash();

  const isOwner = user?.id === discordId;
  const officer = can('builds');
  const canEdit = isOwner || officer;

  const load = useCallback(() => axios.get(`/api/builds/${discordId}`).then((b) => {
    setData(b.data);
    // Open on whichever build exists, PvE first.
    setView((v) => v || (b.data.builds.pve ? 'pve' : b.data.builds.pvp ? 'pvp' : 'pve'));
  }).catch((err) => setError(err.response?.data?.error || 'Could not load builds.')), [discordId]);

  useEffect(() => { setData(null); setView(null); load(); }, [load]);

  const keyStatsOf = (kind) => data?.builds[kind]?.key_stats || [];
  const setKeyStatsOf = (kind, ids) => setData((prev) => (prev?.builds[kind]
    ? { ...prev, builds: { ...prev.builds, [kind]: { ...prev.builds[kind], key_stats: ids } } }
    : prev));

  // Optimistic: the cards move as soon as they're dropped, and go back if the
  // save fails.
  const saveKeyStats = async (kind, ids) => {
    const before = keyStatsOf(kind);
    setKeyStatsOf(kind, ids);
    try {
      const { data: res } = await axios.put(`/api/builds/${discordId}/${kind}/key-stats`, { stat_ids: ids });
      setKeyStatsOf(kind, res.stat_ids);
    } catch (err) {
      setKeyStatsOf(kind, before);
      flash(err.response?.data?.error || 'Could not save key stats.', false);
    }
  };
  const togglePick = (kind) => (id) => {
    const list = keyStatsOf(kind);
    saveKeyStats(kind, list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  const onSaved = (kind, text) => {
    setModal(null);
    setView(kind);
    flash(text);
    load();
  };

  if (error) return <PageShell maxWidth="max-w-6xl"><EmptyState>{error}</EmptyState></PageShell>;
  if (!data || !view) return <PageShell maxWidth="max-w-6xl"><EmptyState>Loading…</EmptyState></PageShell>;

  const { builds, history } = data;
  const name = data.display_name || (isOwner ? user.username : 'Member');
  const build = view !== 'compare' ? builds[view] : null;
  const last = (k) => history[k]?.[0];
  const flaggedCount = (k) => Object.keys(builds[k]?.flags || {}).length;

  const switcher = [
    ...KINDS.map((k) => ({
      key: k,
      title: `${KIND_LABEL[k]} build`,
      chip: <span className={`text-[10px] font-bold tracking-wide rounded-full px-2 py-0.5 border ${KIND_CHIP[k]}`}>{KIND_LABEL[k]}</span>,
      detail: builds[k]
        ? `${builds[k].class ? `${builds[k].class} · ` : ''}Updated ${shortDate(builds[k].updated_at)} · ${ago(builds[k].updated_at)}${flaggedCount(k) ? ` · ${flaggedCount(k)} to check` : ''}`
        : 'Not uploaded yet',
    })),
    {
      key: 'compare',
      title: 'Compare',
      chip: <span className="text-[10px] font-bold tracking-wide rounded-full px-2 py-0.5 border border-line text-bone">vs</span>,
      detail: builds.pve && builds.pvp ? 'PvE and PvP side by side' : 'Needs both builds',
    },
  ];

  return (
    <PageShell maxWidth="max-w-6xl">
      <Link to="/builds" className="inline-flex items-center gap-1.5 text-sm text-ash hover:text-bone mb-4">
        <ArrowLeft className="w-4 h-4" /> All builds
      </Link>
      <div className="flex items-end justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="font-display text-3xl text-bone tracking-[0.06em]">{name}</h1>
          <p className="text-sm text-ash mt-1">
            {isOwner ? 'Your builds' : 'Builds'} · {KINDS.filter((k) => builds[k]).length} of 2 uploaded
          </p>
        </div>
      </div>

      <Toast msg={msg} />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5" role="group" aria-label="Which build">
        {switcher.map((s) => (
          <button
            key={s.key} type="button" onClick={() => setView(s.key)} aria-pressed={view === s.key}
            className={`text-left panel rounded-lg px-4 py-3 transition-colors ${view === s.key ? 'border-brass ring-1 ring-brass' : 'hover:border-ash/50'}`}
          >
            <span className="flex items-center gap-2 font-display text-bone">{s.chip} {s.title}</span>
            <span className="block text-xs text-ash mt-1">{s.detail}</span>
          </button>
        ))}
      </div>

      {view === 'compare' ? (
        builds.pve && builds.pvp ? (
          <>
            <p className="text-xs text-ash mb-4 flex flex-wrap gap-x-5 gap-y-1">
              <span><span className="text-emerald-400">PvE</span> updated {shortDate(builds.pve.updated_at)}</span>
              <span><span className="text-oxblood">PvP</span> updated {shortDate(builds.pvp.updated_at)}</span>
              <span>Differences are PvP minus PvE. PvP stats compare their totals.</span>
            </p>
            <CompareTable pve={builds.pve} pvp={builds.pvp} />
          </>
        ) : (
          <div className="panel rounded-lg p-10 text-center text-ash">
            Comparing needs both a PvE and a PvP build. {isOwner && `Upload your ${KIND_LABEL[builds.pve ? 'pvp' : 'pve']} build to see the difference.`}
          </div>
        )
      ) : !build ? (
        <div className="panel rounded-lg p-10 text-center">
          <p className="text-ash mb-4">{isOwner ? `You haven't uploaded a ${KIND_LABEL[view]} build yet.` : `No ${KIND_LABEL[view]} build on file.`}</p>
          {canEdit && (
            <button type="button" onClick={() => setModal({ type: 'upload', kind: view })}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-brass hover:bg-brassbright text-ink text-sm font-semibold rounded-lg transition-colors">
              <Upload className="w-4 h-4" /> Upload {KIND_LABEL[view]} screenshots
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Last updated: when, who, how and what changed. */}
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <p className="text-sm text-ash">
              {build.class && <><span className="text-brass font-medium">{build.class}</span> · </>}
              <span className="text-bone font-medium">Last updated {fmtWhen(build.updated_at)}</span>
              {last(view) && <> by {last(view).changed_by_name || 'someone'} · {HOW_LABEL[last(view).how]} · {summarise(last(view))}</>}
            </p>
            <div className="flex gap-2 flex-wrap">
              <button type="button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-line text-bone hover:border-ash">
                <History className="w-4 h-4" /> {showHistory ? 'Hide' : 'Show'} history ({history[view].length})
              </button>
              {canEdit && (
                <button type="button" onClick={() => setModal({ type: 'fix', kind: view })}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-line text-bone hover:border-ash">
                  <Pencil className="w-4 h-4" /> Fix values
                </button>
              )}
              {canEdit && (
                <button type="button" onClick={() => setModal({ type: 'upload', kind: view })}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-brass hover:bg-brassbright text-ink font-semibold transition-colors">
                  <Upload className="w-4 h-4" /> Upload new {KIND_LABEL[view]} scan
                </button>
              )}
            </div>
          </div>
          {showHistory && <div className="mb-6"><BuildHistory history={history[view]} /></div>}

          {/* Saved before builds had a class. Any save now needs one, so this
              is fixed by the next upload or Fix values. */}
          {!build.class && (
            <div className="mb-6 px-4 py-2.5 rounded-lg border border-amber-400/40 bg-amber-400/5 text-sm text-bone">
              This build doesn&apos;t say which class it&apos;s for.
              {canEdit && <> Use <span className="text-brass">Fix values</span> to pick one.</>}
            </div>
          )}

          {flaggedCount(view) > 0 && (
            <div className="mb-6 px-4 py-2.5 rounded-lg border border-amber-400/40 bg-amber-400/5 text-sm text-bone">
              {flaggedCount(view)} value{flaggedCount(view) === 1 ? '' : 's'} on this build may have been misread — marked with a dot below.
              {canEdit && <> Use <span className="text-brass">Fix values</span> to correct or confirm {flaggedCount(view) === 1 ? 'it' : 'them'}.</>}
            </div>
          )}

          <div className="mb-8">
            <KeyStats kind={view} ids={keyStatsOf(view)} build={build} editable={officer} onChange={(ids) => saveKeyStats(view, ids)} />
          </div>
          <BuildSheet kind={view} build={build} picked={keyStatsOf(view)} onToggle={officer ? togglePick(view) : null} />
        </>
      )}

      {modal?.type === 'upload' && (
        <UploadBuildModal discordId={discordId} initialKind={modal.kind} builds={builds} onClose={() => setModal(null)} onSaved={onSaved} />
      )}
      {modal?.type === 'fix' && builds[modal.kind] && (
        <FixBuildModal discordId={discordId} kind={modal.kind} build={builds[modal.kind]} memberName={name} onClose={() => setModal(null)} onSaved={onSaved} />
      )}
    </PageShell>
  );
}
