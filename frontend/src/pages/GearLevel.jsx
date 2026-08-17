import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  UploadCloud, Loader2, Check, Sword, Shield, Gem, BarChart3, Image as ImageIcon,
} from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import StatTile from '../components/ui/StatTile';
import Tabs from '../components/ui/Tabs';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';

// ── TWO UPLOADS, ONE OF WHICH IS READ ───────────────────────────────────────
// The Equipment Level popup is four numbers the game has already worked out.
// Reading it is the only thing that sets a gear level.
//
// The full equipment window is filed, not read. It used to be parsed item by
// item so the maxima could be recomputed with Heroic gear excluded, and that
// result overwrote the member's level — which meant the same column meant two
// different things depending on which upload came last, off a per-item parse
// too unreliable to trust without opening the image anyway. Now the image is
// simply kept, for an officer to look at.

const SOURCE_LABEL = {
  popup: 'Equipment Level popup — includes Heroic items',
  // Only on rows written before the equipment window stopped setting levels.
  window: 'An older equipment-window upload — Heroic items excluded',
};

function Dropzone({ onFile, busy, busyLabel, children }) {
  return (
    <label className={`block panel rounded-lg border-dashed border-2 border-line hover:border-brass/50 transition-colors p-8 text-center ${busy ? 'opacity-60 pointer-events-none' : 'cursor-pointer'}`}>
      <input type="file" accept="image/*" className="hidden" disabled={busy}
        onChange={(e) => { onFile(e.target.files[0]); e.target.value = ''; }} />
      {busy ? (
        <span className="inline-flex items-center gap-2 text-ash"><Loader2 className="w-5 h-5 animate-spin" /> {busyLabel}</span>
      ) : (
        <>
          <UploadCloud className="w-8 h-8 text-brass mx-auto mb-3" />
          <div className="text-ash text-sm">{children}</div>
        </>
      )}
    </label>
  );
}

export default function GearLevel() {
  const [entry, setEntry] = useState(null);
  const [shot, setShot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState('');
  const [error, setError] = useState('');
  const [msg, flash] = useFlash();
  // The popup leads: it is the upload that sets your gear level, so it is the
  // one someone landing here needs. The equipment window is a second, optional
  // thing you send afterwards.
  const [tab, setTab] = useState('popup');

  const load = () => {
    setLoading(true);
    Promise.all([
      axios.get('/api/gear-ilvl/mine').then((r) => r.data.entry).catch(() => null),
      axios.get('/api/gear-screenshot/mine').then((r) => r.data.screenshot).catch(() => null),
    ])
      .then(([e, s]) => { setEntry(e); setShot(s); })
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const post = (url, file, kind, done) => {
    if (!file) return;
    setUploading(kind); setError('');
    const form = new FormData();
    form.append('image', file);
    axios.post(url, form)
      .then(() => { flash(done); load(); })
      .catch((err) => setError(err.response?.data?.error || 'Could not read that screenshot.'))
      .finally(() => setUploading(''));
  };

  const cards = entry ? [
    { label: 'Weapon', value: entry.weapon, icon: <Sword className="w-4 h-4" /> },
    { label: 'Armor', value: entry.armor, icon: <Shield className="w-4 h-4" /> },
    { label: 'Accessory', value: entry.accessory, icon: <Gem className="w-4 h-4" /> },
    { label: 'Average', value: entry.average, icon: <BarChart3 className="w-4 h-4" /> },
  ] : [];

  return (
    <PageShell maxWidth="max-w-3xl">
      <p className="text-sm text-ash mb-5">
        Upload the <span className="text-bone">Equipment Level popup</span> to record your levels — that&apos;s the one
        that gets read. You can also file a shot of your full equipment window so officers can see the gear
        behind the numbers; nothing is read out of it.
      </p>

      <Toast msg={msg} />
      {error && <div className="mb-6 px-5 py-3 rounded-lg border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {loading ? (
        <div className="py-16 text-center text-ash">Loading…</div>
      ) : (
        <>
          {/* ── UPLOAD, FIRST ──────────────────────────────────────────────
              Uploading is the only thing anyone comes to this page to DO;
              the levels underneath are the result of having done it. The
              tabs govern which upload, not which record — the record below
              is the same either way. Popup first: it is the one that sets a
              level, and the tab order is the only thing on the page that says
              which of the two matters more. */}
          <Tabs
            variant="flat" active={tab} onChange={setTab}
            items={[
              { key: 'popup', label: 'Equipment Level popup' },
              { key: 'window', label: 'Equipment window' },
            ]}
          />

          {tab === 'popup' && (
            <div className="space-y-3">
              <Dropzone onFile={(f) => post('/api/gear-ilvl', f, 'popup', 'Gear level updated.')}
                busy={uploading === 'popup'} busyLabel="Reading screenshot…">
                Click to upload the Equipment Level popup
              </Dropzone>
              <p className="text-ash/60 text-xs">
                The small in-game popup showing Equipment Lv. / Max Weapon / Max Armor / Max Accessory. The four numbers
                on it become your gear level, Heroic items and all — the game counts them and there is no way to read
                the popup without them.
              </p>
            </div>
          )}

          {tab === 'window' && (
            <div className="space-y-3">
              <Dropzone onFile={(f) => post('/api/gear-screenshot', f, 'window', 'Equipment screenshot saved.')}
                busy={uploading === 'window'} busyLabel="Saving screenshot…">
                Click to file a shot of your full equipment window
              </Dropzone>
              <p className="text-ash/60 text-xs">
                Kept on file for officers to look at — <span className="text-ash">nothing is read out of it and it
                won&apos;t change your gear level</span>. Open your equipment window with every slot and item level
                visible and screenshot the whole thing. Visible to you and to officers.
              </p>
            </div>
          )}

          <div className="rule-fade my-8" />

          {/* ── WHAT IS ON FILE ────────────────────────────────────────────
              Not tab-scoped. A member's gear level is one record however it
              was produced, and hiding their stored screenshot because they
              happened to click the other tab would read as having lost it. */}
          {entry ? (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {cards.map((c) => (
                  <StatTile key={c.label} icon={c.icon} value={c.value ?? '—'} label={c.label} />
                ))}
              </div>
              {/* Which screenshot produced the numbers above. Two members can
                  sit next to each other on the leaderboard measured by
                  different rules, and this is the only place that says so. */}
              <p className="text-ash/60 text-xs mt-3 text-center">
                {SOURCE_LABEL[entry.source] || SOURCE_LABEL.popup}
                {entry.submitted_at && (
                  <> · updated {new Date(entry.submitted_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</>
                )}
              </p>
            </>
          ) : (
            // Specific about WHICH upload, because filing an equipment window
            // no longer produces a level — "upload a screenshot" to someone who
            // just uploaded one reads as their upload having failed.
            <div className="panel rounded-lg p-8 text-center text-ash">
              No gear level on file yet — upload the Equipment Level popup above.
            </div>
          )}

          {shot && (
            <div className="mt-8 space-y-3">
              {/* Just the image. The per-item breakdown that used to sit here
                  went first — item names and slots came back subtly wrong often
                  enough that it read as a list of mistakes — and the parse
                  behind it has now gone too. The screenshot is the record. */}
              {shot.image_url && (
                <div>
                  <div className="eyebrow text-[10px] text-brass mb-2 flex items-center gap-2">
                    <ImageIcon className="w-3 h-3" /> Your stored screenshot
                  </div>
                  <a href={shot.image_url} target="_blank" rel="noreferrer">
                    <img src={shot.image_url} alt="Your stored equipment window"
                      className="max-w-full rounded-lg border border-line hover:border-brass/50 transition-colors" />
                  </a>
                </div>
              )}
            </div>
          )}

          {(entry?.submitted_at || shot) && (
            <p className="text-ash/60 text-xs mt-8 text-center inline-flex items-center gap-1.5 justify-center w-full">
              <Check className="w-3.5 h-3.5" /> Re-uploading replaces what you had — the two are kept separately, so
              sending one doesn&apos;t clear the other.
            </p>
          )}
        </>
      )}
    </PageShell>
  );
}
