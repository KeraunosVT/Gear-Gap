import { useState, useEffect } from 'react';
import axios from 'axios';
import {
  UploadCloud, Loader2, Check, Sword, Shield, Gem, BarChart3, Image as ImageIcon, EyeOff,
} from 'lucide-react';
import { PageShell } from '../components/ui/PageShell';
import StatTile from '../components/ui/StatTile';
import Tabs from '../components/ui/Tabs';
import { useFlash } from '../components/ui/useFlash';
import Toast from '../components/ui/Toast';

// ── TWO SCREENSHOTS, TWO DIFFERENT ANSWERS ──────────────────────────────────
// The Equipment Level popup is four numbers the game has already worked out. It
// is quick, and for anyone with no Heroic gear it is correct.
//
// The full equipment window is every item, read individually, so the maxima can
// be recomputed with Heroic-tier items left out. The popup cannot do that — its
// "Max Weapon Lv." counts the Heroic weapon and never says which item produced
// the number, so there is nothing to subtract afterwards.
//
// Both write the same gear level, and the page says which one produced the
// figure currently on file, because they do not mean the same thing.

const SOURCE_LABEL = {
  popup: 'Equipment Level popup — includes Heroic items',
  window: 'Equipment window — Heroic items excluded',
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
  const [tab, setTab] = useState('window');

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
        Upload a gear screenshot to record your levels. The full equipment window is the one to use if you
        have Heroic gear — it reads each item and leaves Heroic-tier pieces out of the total.
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
              is the same either way. */}
          <Tabs
            variant="flat" active={tab} onChange={setTab}
            items={[
              { key: 'window', label: 'Equipment window' },
              { key: 'popup', label: 'Equipment Level popup' },
            ]}
          />

          {tab === 'window' && (
            <div className="space-y-3">
              <Dropzone onFile={(f) => post('/api/gear-screenshot', f, 'window', 'Gear screenshot read and saved.')}
                busy={uploading === 'window'} busyLabel="Reading every item…">
                Click to upload your full equipment window
              </Dropzone>
              <p className="text-ash/60 text-xs">
                Open your character&apos;s equipment window with every slot and item level visible, then screenshot the
                whole thing. Heroic-tier items are skipped when working out your levels. Your screenshot is visible to
                you and to officers.
              </p>
            </div>
          )}

          {tab === 'popup' && (
            <div className="space-y-3">
              <Dropzone onFile={(f) => post('/api/gear-ilvl', f, 'popup', 'Gear level updated.')}
                busy={uploading === 'popup'} busyLabel="Reading screenshot…">
                Click to upload the Equipment Level popup
              </Dropzone>
              <p className="text-ash/60 text-xs">
                The small in-game popup showing Equipment Lv. / Max Weapon / Max Armor / Max Accessory. Faster, but it
                counts Heroic items — use the equipment window if you have any.
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
            <div className="panel rounded-lg p-8 text-center text-ash">Nothing on file yet — upload a screenshot above.</div>
          )}

          {shot && (
            <div className="mt-8 space-y-3">
              {/* The per-item breakdown used to sit here and is deliberately
                  gone. Item names and slots come back subtly wrong often
                  enough — there are far too many of them — that the table read
                  as a list of mistakes rather than as an explanation, and a
                  wrong detail beside a right number makes people doubt the
                  number.

                  The screenshot itself is the ground truth. The only parsed
                  fact kept is the count of excluded items, which doesn't depend
                  on reading any name correctly. (The full parse is still
                  stored — worth having when diagnosing a number that looks
                  wrong.) */}
              {shot.excluded_count > 0 && (
                <p className="text-xs text-brass inline-flex items-center gap-1.5">
                  <EyeOff className="w-3 h-3" />
                  {shot.excluded_count} Heroic item{shot.excluded_count === 1 ? '' : 's'} not counted toward these levels
                </p>
              )}

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

          {entry?.submitted_at && (
            <p className="text-ash/60 text-xs mt-8 text-center inline-flex items-center gap-1.5 justify-center w-full">
              <Check className="w-3.5 h-3.5" /> A new upload of either kind replaces what you had on file.
            </p>
          )}
        </>
      )}
    </PageShell>
  );
}
