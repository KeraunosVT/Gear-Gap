import { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import weaponToClass from '../../../shared/weaponClasses.json';
import { Check } from 'lucide-react';

const EXTRA_CLASSES = ['Oracle (DPS)'];
const CLASS_LIST = [...new Set([...Object.values(weaponToClass), ...EXTRA_CLASSES])].sort();
const RANK_LABELS = ['Primary', 'Secondary', 'Tertiary'];

function ClassPicker({ title, hint, picks, setPicks }) {
  const update = (i, value) => {
    setPicks((prev) => {
      const next = [...prev];
      next[i] = value;
      return next;
    });
  };

  return (
    <div>
      <label className="eyebrow text-[10px] text-ash block mb-2">{title}</label>
      <div className="space-y-2">
        {RANK_LABELS.map((label, i) => {
          const taken = picks.filter((p, idx) => idx !== i && p);
          return (
            <div key={label} className="flex items-center gap-2">
              <span className="text-ash text-xs w-20 shrink-0">{label}</span>
              <select value={picks[i] || ''} onChange={(e) => update(i, e.target.value)}
                className="w-full bg-hall border border-line rounded-sm px-4 py-2 text-bone focus:outline-none focus:border-brass">
                <option value="">— not set —</option>
                {CLASS_LIST.filter((c) => !taken.includes(c)).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          );
        })}
      </div>
      <p className="text-ash text-xs mt-2">{hint}</p>
    </div>
  );
}

export default function Classes() {
  const { user } = useAuth();
  const [pvpClasses, setPvpClasses] = useState(['', '', '']);
  const [pveClasses, setPveClasses] = useState(['', '', '']);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    axios.get('/api/my-classes')
      .then((res) => {
        const pad = (arr) => [arr?.[0] || '', arr?.[1] || '', arr?.[2] || ''];
        setPvpClasses(pad(res.data.pvp_classes));
        setPveClasses(pad(res.data.pve_classes));
      })
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true); setSaved(false);
    try {
      await axios.put('/api/my-classes', {
        pvp_classes: pvpClasses.filter(Boolean),
        pve_classes: pveClasses.filter(Boolean),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">Members Area</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">My Classes</h1>
      <p className="text-ash mt-2">Rank up to 3 classes per mode so officers can plan parties around your build.</p>
      <div className="rule-fade my-8" />

      {loading ? (
        <div className="py-20 text-center text-ash">Loading…</div>
      ) : (
        <div className="space-y-8">
          <div className="panel rounded-sm p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <ClassPicker title="PvP Classes" hint="Ranked classes you run in wargames and PvP content."
                picks={pvpClasses} setPicks={setPvpClasses} />
              <ClassPicker title="PvE Classes" hint="Ranked classes you run in dungeons and PvE content."
                picks={pveClasses} setPicks={setPveClasses} />
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
