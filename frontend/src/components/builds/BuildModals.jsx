import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { UploadCloud, Loader2, X, AlertTriangle } from 'lucide-react';
import Modal from '../ui/Modal';
import BuildReview, { toInputs, fromInputs } from './BuildReview';
import { KINDS, KIND_LABEL, KIND_CHIP, uploadWarnings } from '../../buildStats';
import { fmtWhen } from './BuildHistory';

const MAX_IMAGES = 10;

// Shared state for editing a set of numbers: the inputs, the flags, and what
// typing into a flagged one does (clears it — the person has looked at it).
function useEditable(initialStats, initialFlags) {
  const [inputs, setInputs] = useState(() => toInputs(initialStats));
  const [flags, setFlags] = useState(() => ({ ...(initialFlags || {}) }));
  const reset = (stats, f) => { setInputs(toInputs(stats)); setFlags({ ...(f || {}) }); };
  const onInput = (id, s) => {
    setInputs((prev) => ({ ...prev, [id]: s }));
    setFlags((prev) => { if (!prev[id]) return prev; const next = { ...prev }; delete next[id]; return next; });
  };
  const onConfirm = (id) => setFlags((prev) => { const next = { ...prev }; delete next[id]; return next; });
  return { inputs, flags, reset, onInput, onConfirm };
}

function Header({ title, onClose }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-5">
      <h2 className="font-display text-xl text-bone tracking-[0.06em]">{title}</h2>
      <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded text-ash hover:text-bone hover:bg-panelup">
        <X className="w-5 h-5" />
      </button>
    </div>
  );
}

// New screenshots → read → review → save. Nothing is stored until the last
// step, so a bad read costs a retry, not a wrong build on file.
export function UploadBuildModal({ discordId, initialKind, builds, onClose, onSaved }) {
  const [kind, setKind] = useState(initialKind);
  const [files, setFiles] = useState([]);
  const [step, setStep] = useState('pick');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const edit = useEditable({}, {});

  const previews = useMemo(() => files.map((f) => ({ name: f.name, url: URL.createObjectURL(f) })), [files]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  const otherKind = kind === 'pve' ? 'pvp' : 'pve';
  const { stats, invalid } = fromInputs(edit.inputs);
  const warnings = step === 'review' ? uploadWarnings(kind, stats, builds[otherKind]) : [];

  const addFiles = (list) => {
    const images = [...list].filter((f) => f.type.startsWith('image/'));
    setFiles((prev) => [...prev, ...images].slice(0, MAX_IMAGES));
  };

  const read = async () => {
    setBusy(true); setError('');
    const form = new FormData();
    files.forEach((f) => form.append('images', f));
    try {
      const { data } = await axios.post('/api/builds/scan', form);
      edit.reset(data.stats, data.flags);
      setStep('review');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not read those screenshots.');
    } finally {
      setBusy(false);
    }
  };

  const save = async (asKind = kind) => {
    setBusy(true); setError('');
    try {
      await axios.put(`/api/builds/${discordId}/${asKind}`, { stats, flags: edit.flags, how: 'scan' });
      onSaved(asKind, `${KIND_LABEL[asKind]} build saved.`);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that build.');
      setBusy(false);
    }
  };

  return (
    <Modal onClose={busy ? () => {} : onClose} maxWidth="max-w-2xl" scrollable>
      <Header title={step === 'pick' ? 'Upload build screenshots' : `Check your ${KIND_LABEL[kind]} build`} onClose={busy ? () => {} : onClose} />

      {step === 'pick' && (
        <div className="space-y-5">
          <div>
            <div className="eyebrow text-[10px] text-ash mb-2">Which build is this?</div>
            <div className="grid grid-cols-2 gap-2">
              {KINDS.map((k) => (
                <label key={k} className={`flex items-center gap-3 rounded-lg border px-4 py-3 cursor-pointer transition-colors ${kind === k ? 'border-brass bg-panelup' : 'border-line hover:border-ash/50'}`}>
                  <input type="radio" name="build-kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="accent-current" />
                  <span className={`text-[10px] font-bold tracking-wide rounded-full px-2 py-0.5 border ${KIND_CHIP[k]}`}>{KIND_LABEL[k]}</span>
                  <span className="text-sm text-bone">{KIND_LABEL[k]} build</span>
                </label>
              ))}
            </div>
            <p className="text-xs text-ash mt-2">
              {builds[kind]
                ? `Replaces your ${KIND_LABEL[kind]} build from ${fmtWhen(builds[kind].updated_at)}. It stays in the build's history. Your ${KIND_LABEL[otherKind]} build isn't touched.`
                : `This will be your first ${KIND_LABEL[kind]} build.`}
            </p>
          </div>

          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); addFiles(e.dataTransfer.files); }}
            className="block rounded-lg border-2 border-dashed border-line hover:border-brass/50 transition-colors p-6 text-center cursor-pointer"
          >
            <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            <UploadCloud className="w-7 h-7 text-brass mx-auto mb-2" />
            <div className="text-sm text-bone">Click or drop your stats screenshots here</div>
            <div className="text-xs text-ash mt-1">
              Open the character stats window and take one screenshot of each: the Defense/Attack/Protection panel
              (scroll down for the second half), Weapons, and the Basic, Status, Boss and PvP tabs. Seven in all.
            </div>
          </label>

          {previews.length > 0 && (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {previews.map((p, i) => (
                <div key={p.url} className="relative group">
                  <img src={p.url} alt={p.name} className="w-full aspect-video object-cover rounded border border-line" />
                  <button type="button" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={`Remove ${p.name}`}
                    className="absolute top-1 right-1 p-0.5 rounded bg-ink/80 text-bone opacity-0 group-hover:opacity-100 focus:opacity-100">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {error && <div className="px-4 py-2.5 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-xs text-ash">{files.length} of {MAX_IMAGES} screenshots{files.length > 0 && files.length < 7 ? ' · seven covers every stat' : ''}</span>
            <div className="flex gap-2">
              <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-sm text-ash hover:text-bone">Cancel</button>
              <button type="button" onClick={read} disabled={busy || !files.length}
                className="inline-flex items-center gap-2 px-5 py-2 bg-brass hover:bg-brassbright text-ink text-sm font-semibold rounded-lg transition-colors disabled:opacity-40">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} {busy ? 'Reading screenshots…' : 'Read screenshots'}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-5">
          {warnings.map((w) => (
            <div key={w.type} className="rounded-lg border border-amber-400/50 bg-amber-400/10 px-4 py-3 space-y-2">
              <div className="flex items-start gap-2 text-sm text-bone"><AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" /> {w.text}</div>
              <div className="flex flex-wrap gap-2 pl-6">
                {w.type === 'same' ? (
                  <button type="button" onClick={() => { setStep('pick'); setFiles([]); }} className="px-3 py-1.5 text-xs rounded-md border border-line text-bone hover:border-ash">Choose different screenshots</button>
                ) : (
                  <button type="button" onClick={() => save(otherKind)} disabled={busy || invalid.length > 0} className="px-3 py-1.5 text-xs rounded-md border border-line text-bone hover:border-ash">
                    Save as {KIND_LABEL[otherKind]} build instead
                  </button>
                )}
              </div>
            </div>
          ))}

          <BuildReview inputs={edit.inputs} flags={edit.flags} onInput={edit.onInput} onConfirm={edit.onConfirm} />

          {error && <div className="px-4 py-2.5 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

          <div className="flex items-center justify-between gap-3 flex-wrap sticky bottom-0 bg-panel pt-3 border-t border-line">
            <button type="button" onClick={() => setStep('pick')} disabled={busy} className="text-sm text-ash hover:text-bone">Back</button>
            <div className="flex items-center gap-3">
              {invalid.length > 0 && <span className="text-xs text-oxblood">{invalid.length} value{invalid.length === 1 ? ' isn\'t a number' : 's aren\'t numbers'}</span>}
              <button type="button" onClick={() => save()} disabled={busy || invalid.length > 0 || !Object.keys(stats).length}
                className="inline-flex items-center gap-2 px-5 py-2 bg-brass hover:bg-brassbright text-ink text-sm font-semibold rounded-lg transition-colors disabled:opacity-40">
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save as {KIND_LABEL[kind]} build
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Typing values in by hand: an officer fixing a misread, or a member who'd
// rather correct one number than rescan. Recorded as a manual fix.
export function FixBuildModal({ discordId, kind, build, memberName, onClose, onSaved }) {
  const edit = useEditable(build.stats, build.flags);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { stats, invalid } = fromInputs(edit.inputs);

  const save = async () => {
    setBusy(true); setError('');
    try {
      const { data } = await axios.put(`/api/builds/${discordId}/${kind}`, { stats, flags: edit.flags, how: 'edit' });
      onSaved(kind, data.changed ? `${KIND_LABEL[kind]} build updated.` : 'Nothing changed.');
    } catch (err) {
      setError(err.response?.data?.error || 'Could not save that build.');
      setBusy(false);
    }
  };

  return (
    <Modal onClose={busy ? () => {} : onClose} maxWidth="max-w-2xl" scrollable>
      <Header title={`Fix values · ${memberName}'s ${KIND_LABEL[kind]} build`} onClose={busy ? () => {} : onClose} />
      <BuildReview inputs={edit.inputs} flags={edit.flags} onInput={edit.onInput} onConfirm={edit.onConfirm} />
      {error && <div className="mt-4 px-4 py-2.5 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}
      <div className="flex items-center justify-end gap-3 flex-wrap sticky bottom-0 bg-panel pt-3 mt-5 border-t border-line">
        {invalid.length > 0 && <span className="text-xs text-oxblood">{invalid.length} value{invalid.length === 1 ? ' isn\'t a number' : 's aren\'t numbers'}</span>}
        <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-sm text-ash hover:text-bone">Cancel</button>
        <button type="button" onClick={save} disabled={busy || invalid.length > 0 || !Object.keys(stats).length}
          className="inline-flex items-center gap-2 px-5 py-2 bg-brass hover:bg-brassbright text-ink text-sm font-semibold rounded-lg transition-colors disabled:opacity-40">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save changes
        </button>
      </div>
    </Modal>
  );
}
