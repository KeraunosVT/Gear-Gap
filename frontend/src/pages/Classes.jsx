import { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import weaponToClass from '../../../shared/weaponClasses.json';
import { Check, Loader2 } from 'lucide-react';

const EXTRA_CLASSES = ['Oracle (DPS)'];
const CLASS_LIST = [...new Set([...Object.values(weaponToClass), ...EXTRA_CLASSES])].sort();

export default function Classes() {
  const { user } = useAuth();
  const [pvpClass, setPvpClass] = useState('');
  const [pveClass, setPveClass] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    axios.get('/api/my-classes')
      .then((res) => { setPvpClass(res.data.pvp_class || ''); setPveClass(res.data.pve_class || ''); })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true); setSaved(false);
    try {
      await axios.put('/api/my-classes', { pvp_class: pvpClass, pve_class: pveClass });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">Members Area</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">My Classes</h1>
      <p className="text-ash mt-2">Set the classes you run so officers can plan parties around your build.</p>
      <div className="rule-fade my-8" />

      {loading ? (
        <div className="py-20 text-center text-ash">Loading…</div>
      ) : (
        <div className="space-y-8">
          <div className="panel rounded-sm p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="eyebrow text-[10px] text-ash block mb-2">PvP Class</label>
                <select value={pvpClass} onChange={(e) => setPvpClass(e.target.value)}
                  className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass">
                  <option value="">— not set —</option>
                  {CLASS_LIST.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <p className="text-ash text-xs mt-2">The class you run in wargames and PvP content.</p>
              </div>
              <div>
                <label className="eyebrow text-[10px] text-ash block mb-2">PvE Class</label>
                <select value={pveClass} onChange={(e) => setPveClass(e.target.value)}
                  className="w-full bg-hall border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass">
                  <option value="">— not set —</option>
                  {CLASS_LIST.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <p className="text-ash text-xs mt-2">The class you run in dungeons and PvE content.</p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <button onClick={save} disabled={saving}
              className="px-6 py-3 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm transition-colors disabled:opacity-40">
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && (
              <span className="text-emerald-400 inline-flex items-center gap-1 text-sm">
                <Check className="w-4 h-4" /> Saved
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
