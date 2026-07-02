import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import SHARDS from '../../../shared/shards.json';
import WEAPONS from '../../../shared/weapons.json';
import { Check, Loader2, AlertCircle, RefreshCw } from 'lucide-react';

const MAX = SHARDS.max;
const TYPES = SHARDS.types;
const BUILDS = ['PvP', 'PvE'];

const normalizeShards = (s) => {
  const out = {};
  TYPES.forEach((t) => { out[t.key] = Math.max(0, Math.min(MAX, Number(s?.[t.key]) || 0)); });
  out.weapon = WEAPONS.includes(s?.weapon) ? s.weapon : '';
  out.build = BUILDS.includes(s?.build) ? s.build : '';
  return out;
};
const rowTotal = (s) => TYPES.reduce((a, t) => a + (Number(s[t.key]) || 0), 0);

export default function Shards() {
  const { user } = useAuth();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState({}); // memberId -> 'saving'|'saved'|'error'
  const [dirty, setDirty] = useState({});   // memberId -> bool

  const canEdit = (id) => user && (user.isAdmin || user.id === id);

  const load = () => {
    setLoading(true); setError('');
    axios.get('/api/members')
      .then((res) => setMembers((res.data.members || []).map((m) => ({ ...m, shards: normalizeShards(m.shards) }))))
      .catch((err) => setError(err.response?.data?.error || 'Could not load members.'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const updateShard = (id, key, raw) => {
    const v = Math.max(0, Math.min(MAX, parseInt(raw, 10) || 0));
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, shards: { ...m.shards, [key]: v } } : m)));
    setDirty((d) => ({ ...d, [id]: true }));
  };

  const persist = (member) => {
    setDirty((d) => ({ ...d, [member.id]: false }));
    setStatus((s) => ({ ...s, [member.id]: 'saving' }));
    axios.put(`/api/shards/${member.id}`, { shards: member.shards, display_name: member.name })
      .then(() => {
        setStatus((s) => ({ ...s, [member.id]: 'saved' }));
        setTimeout(() => setStatus((s) => ({ ...s, [member.id]: undefined })), 1800);
      })
      .catch((err) => {
        setStatus((s) => ({ ...s, [member.id]: 'error' }));
        setError(err.response?.data?.error || 'Save failed.');
      });
  };

  const saveRow = (member) => {
    if (!dirty[member.id]) return;
    persist(member);
  };

  // Weapon/build are selects — save immediately on change rather than waiting for blur.
  const updateMeta = (id, key, value) => {
    setMembers((prev) => {
      const next = prev.map((m) => (m.id === id ? { ...m, shards: { ...m.shards, [key]: value } } : m));
      persist(next.find((m) => m.id === id));
      return next;
    });
  };

  // Self pinned to top, then alphabetical; then filtered.
  const ordered = useMemo(() => {
    const sorted = [...members].sort((a, b) => {
      if (user && a.id === user.id) return -1;
      if (user && b.id === user.id) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    const f = filter.toLowerCase();
    return sorted.filter((m) => (m.name || '').toLowerCase().includes(f));
  }, [members, filter, user]);

  const totals = useMemo(() => {
    const t = {};
    TYPES.forEach((ty) => { t[ty.key] = members.reduce((a, m) => a + (Number(m.shards[ty.key]) || 0), 0); });
    return t;
  }, [members]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">Members Area</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Archboss Shards</h1>
      <p className="text-ash mt-2">
        {user?.isAdmin
          ? 'Track every member\u2019s shard requests. You can edit any row.'
          : 'Track your shard requests. You can edit your own row; others are read-only.'} Max {MAX} of each.
      </p>
      <p className="text-bone font-bold uppercase mt-2">Put how many shard you need</p>
      <div className="rule-fade my-8" />

      <div className="flex items-center justify-between mb-5 gap-4">
        <input
          value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search members…"
          className="bg-panel border border-line rounded-sm px-4 py-2.5 text-bone focus:outline-none focus:border-brass w-full max-w-xs"
        />
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass shrink-0"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>

      {error && (
        <div className="mb-6 px-5 py-3 rounded-sm border border-oxblood/50 bg-oxblooddeep/20 text-bone text-sm">{error}</div>
      )}

      {loading ? (
        <div className="py-20 text-center text-ash">Reading the vault…</div>
      ) : ordered.length === 0 ? (
        <div className="py-20 text-center text-ash">No members found.</div>
      ) : (
        <div className="panel rounded-sm overflow-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="border-b border-line">
              <tr className="eyebrow text-[10px] text-ash">
                <th className="p-4 text-left font-normal">Member</th>
                <th className="p-4 text-center font-normal">Weapon</th>
                <th className="p-4 text-center font-normal">Build</th>
                {TYPES.map((t) => <th key={t.key} className="p-4 text-center font-normal">{t.label}</th>)}
                <th className="p-4 text-center font-normal">Total</th>
                <th className="p-3 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((m) => {
                const mine = user && m.id === user.id;
                const editable = canEdit(m.id);
                return (
                  <tr key={m.id} className={`border-b border-line/60 ${mine ? 'bg-brass/5' : ''}`}>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        {m.avatar
                          ? <img src={m.avatar} alt="" className="w-6 h-6 rounded-full border border-line shrink-0" />
                          : <span className="w-6 h-6 rounded-full bg-panelup border border-line shrink-0 flex items-center justify-center text-[10px] text-brass">{(m.name || '?').slice(0, 1).toUpperCase()}</span>}
                        <span className="text-bone truncate max-w-[160px]">{m.name}</span>
                        {mine && <span className="text-[9px] eyebrow text-brass border border-brass/40 rounded-full px-1.5 py-0.5">You</span>}
                      </div>
                    </td>
                    <td className="p-3 text-center">
                      {editable ? (
                        <select
                          value={m.shards.weapon || ''}
                          onChange={(e) => updateMeta(m.id, 'weapon', e.target.value)}
                          className="bg-hall border border-line rounded px-2 py-1.5 text-bone text-xs focus:outline-none focus:border-brass"
                        >
                          <option value="">— none —</option>
                          {WEAPONS.map((w) => <option key={w} value={w}>{w}</option>)}
                        </select>
                      ) : (
                        <span className="text-ash">{m.shards.weapon || '—'}</span>
                      )}
                    </td>
                    <td className="p-3 text-center">
                      {editable ? (
                        <div className="inline-flex items-center gap-0 rounded-full border border-line bg-hall p-0.5">
                          {BUILDS.map((b) => (
                            <button
                              key={b} type="button" onClick={() => updateMeta(m.id, 'build', m.shards.build === b ? '' : b)}
                              className={`px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wide transition-colors ${
                                m.shards.build === b
                                  ? (b === 'PvP' ? 'bg-oxblood text-bone' : 'bg-emerald-500 text-ink')
                                  : 'text-ash hover:text-bone'
                              }`}
                            >
                              {b.toUpperCase()}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <span className="text-ash">{m.shards.build || '—'}</span>
                      )}
                    </td>
                    {TYPES.map((t) => (
                      <td key={t.key} className="p-3 text-center">
                        {editable ? (
                          <input
                            type="number" min={0} max={MAX} value={m.shards[t.key]}
                            onChange={(e) => updateShard(m.id, t.key, e.target.value)}
                            onBlur={() => saveRow(m)}
                            className="w-16 bg-hall border border-line rounded px-2 py-1.5 text-center font-mono text-bone focus:outline-none focus:border-brass"
                          />
                        ) : (
                          <span className="font-mono text-ash">{m.shards[t.key]}</span>
                        )}
                      </td>
                    ))}
                    <td className="p-3 text-center font-mono text-brassbright">{rowTotal(m.shards)}</td>
                    <td className="p-3 text-center">
                      {status[m.id] === 'saving' && <Loader2 className="w-4 h-4 text-ash animate-spin inline" />}
                      {status[m.id] === 'saved' && <Check className="w-4 h-4 text-emerald-400 inline" />}
                      {status[m.id] === 'error' && <AlertCircle className="w-4 h-4 text-oxblood inline" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-line bg-panelup/60">
                <td className="p-4 eyebrow text-[10px] text-brass">Guild Total</td>
                <td></td>
                <td></td>
                {TYPES.map((t) => <td key={t.key} className="p-4 text-center font-mono text-brassbright">{totals[t.key]}</td>)}
                <td className="p-4 text-center font-mono text-brassbright">{TYPES.reduce((a, t) => a + totals[t.key], 0)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
