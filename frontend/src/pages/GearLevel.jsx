import { useState, useEffect } from 'react';
import axios from 'axios';
import { UploadCloud, Loader2, Check, Sword, Shield, Gem, BarChart3 } from 'lucide-react';

export default function GearLevel() {
  const [entry, setEntry] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);

  const load = () => {
    setLoading(true);
    axios.get('/api/gear-ilvl/mine')
      .then((res) => setEntry(res.data.entry))
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 4000); };

  const upload = (file) => {
    if (!file) return;
    setUploading(true); setError('');
    const form = new FormData();
    form.append('image', file);
    axios.post('/api/gear-ilvl', form)
      .then((res) => { setEntry(res.data.entry); flash('Gear level updated.'); })
      .catch((err) => setError(err.response?.data?.error || 'Could not read that screenshot.'))
      .finally(() => setUploading(false));
  };

  const cards = entry ? [
    { label: 'Weapon', value: entry.weapon, icon: <Sword className="w-4 h-4" /> },
    { label: 'Armor', value: entry.armor, icon: <Shield className="w-4 h-4" /> },
    { label: 'Accessory', value: entry.accessory, icon: <Gem className="w-4 h-4" /> },
    { label: 'Average', value: entry.average, icon: <BarChart3 className="w-4 h-4" /> },
  ] : [];

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">Members Area</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Gear Level</h1>
      <p className="text-ash mt-2">Upload a screenshot of the in-game "Equipment Level" window (the popup showing Equipment Lv. / Max Weapon / Max Armor / Max Accessory). A new upload replaces whatever you had on file.</p>
      <div className="rule-fade my-8" />

      {msg && (
        <div className={`mb-6 px-5 py-3 rounded-sm border text-sm ${msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'}`}>{msg.text}</div>
      )}
      {error && <div className="mb-6 px-5 py-3 rounded-sm border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>}

      {loading ? (
        <div className="py-16 text-center text-ash">Loading…</div>
      ) : (
        <>
          {entry ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              {cards.map((c) => (
                <div key={c.label} className="panel rounded-sm p-5 text-center">
                  <div className="flex items-center justify-center gap-2 text-brass mb-3">{c.icon}</div>
                  <div className="font-mono text-3xl text-brassbright tabular-nums">{c.value || '—'}</div>
                  <div className="eyebrow text-[10px] text-ash mt-2">{c.label}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel rounded-sm p-8 text-center text-ash mb-8">Nothing on file yet — upload a screenshot below.</div>
          )}

          <label className={`block panel rounded-sm border-dashed border-2 border-line hover:border-brass/50 transition-colors p-10 text-center ${uploading ? 'opacity-60 pointer-events-none' : 'cursor-pointer'}`}>
            <input type="file" accept="image/*" className="hidden" disabled={uploading}
              onChange={(e) => upload(e.target.files[0])} />
            {uploading ? (
              <span className="inline-flex items-center gap-2 text-ash"><Loader2 className="w-5 h-5 animate-spin" /> Reading screenshot…</span>
            ) : (
              <>
                <UploadCloud className="w-8 h-8 text-brass mx-auto mb-4" />
                <div className="text-ash">Click to choose a gear screenshot</div>
              </>
            )}
          </label>
          {entry?.submitted_at && (
            <p className="text-ash/60 text-xs mt-4 text-center inline-flex items-center gap-1.5 justify-center w-full">
              <Check className="w-3.5 h-3.5" /> Last updated {new Date(entry.submitted_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
