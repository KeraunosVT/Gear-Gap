import { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import { useAuth } from '../auth';
import Sigil from '../components/Sigil';
import { RefreshCw, UserPlus, Check, X } from 'lucide-react';

const NEW = '__new__';

export default function Names() {
  const { user } = useAuth();
  const [unmapped, setUnmapped] = useState([]);
  const [identities, setIdentities] = useState([]);
  const [members, setMembers] = useState([]);
  const [choice, setChoice] = useState({});       // name -> identityId | '__new__'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState('');

  const load = () => {
    setLoading(true); setError('');
    Promise.all([
      axios.get('/api/admin/unmapped-names'),
      axios.get('/api/admin/members'),
    ])
      .then(([namesRes, membersRes]) => {
        const um = (namesRes.data.unmapped || []).sort((a, b) => a.name.localeCompare(b.name));
        setUnmapped(um);
        setIdentities(namesRes.data.identities || []);
        setMembers(membersRes.data.members || []);
        const c = {};
        um.forEach((u) => { c[u.name] = u.suggestion ? u.suggestion.id : NEW; });
        setChoice(c);
      })
      .catch((err) => setError(err.response?.data?.error || 'Could not load names.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (!user?.isAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-24 text-center">
        <Sigil className="w-12 h-16 text-oxblood mx-auto mb-6" />
        <h1 className="font-display text-2xl text-bone tracking-[0.08em] mb-3">Restricted</h1>
        <p className="text-ash">The war table is open to officers of the house alone.</p>
      </div>
    );
  }

  const flash = (text, ok = true) => { setMsg({ text, ok }); setTimeout(() => setMsg(null), 3500); };
  const removeRow = (name) => setUnmapped((prev) => prev.filter((u) => u.name !== name));

  const assign = async (u) => {
    const sel = choice[u.name];
    setBusy(u.name);
    try {
      if (sel === NEW) {
        const res = await axios.post('/api/admin/identities', { display_name: u.name, ingame_names: [u.name] });
        setIdentities((prev) => [...prev, { id: res.data.id, display_name: u.name, ingame_names: [u.name] }]
          .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')));
        flash(`Created "${u.name}".`);
      } else {
        await axios.post(`/api/admin/identities/${sel}/aliases`, { name: u.name });
        const tgt = identities.find((i) => i.id === sel);
        setIdentities((prev) => prev.map((i) => i.id === sel
          ? { ...i, ingame_names: [...(i.ingame_names || []), u.name] } : i));
        flash(`"${u.name}" → ${tgt?.display_name}.`);
      }
      removeRow(u.name);
    } catch (err) { flash(err.response?.data?.error || 'Failed.', false); }
    finally { setBusy(''); }
  };

  const removeAlias = async (identity, name) => {
    try {
      await axios.delete(`/api/admin/identities/${identity.id}/aliases`, { data: { name } });
      setIdentities((prev) => prev.map((i) => i.id === identity.id
        ? { ...i, ingame_names: (i.ingame_names || []).filter((n) => n !== name) } : i));
      flash(`Removed "${name}".`);
    } catch (err) { flash(err.response?.data?.error || 'Failed.', false); }
  };

  const linkDiscord = async (identity, discordId) => {
    try {
      await axios.put(`/api/admin/identities/${identity.id}/discord`, { discord_id: discordId || null });
      setIdentities((prev) => prev.map((i) => i.id === identity.id ? { ...i, discord_id: discordId || null } : i));
      const member = members.find((m) => m.id === discordId);
      flash(discordId ? `Linked to ${member?.name || discordId}.` : 'Discord link removed.');
    } catch (err) { flash(err.response?.data?.error || 'Failed.', false); }
  };

  const linkedDiscordIds = useMemo(() => new Set(identities.map((i) => i.discord_id).filter(Boolean)), [identities]);

  const sortedIdentities = useMemo(
    () => [...identities].sort((a, b) => (a.display_name || '').localeCompare(b.display_name || '')),
    [identities]
  );

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="eyebrow text-brass text-[11px] mb-3">War Table</div>
      <h1 className="font-display text-4xl md:text-5xl text-bone tracking-[0.08em]">Merge Names</h1>
      <p className="text-ash mt-2">Assign misread in-game names to the right player. Mapped names roll up automatically across all stats.</p>
      <div className="rule-fade my-8" />

      {msg && (
        <div className={`mb-6 px-5 py-3 rounded-sm border text-sm ${msg.ok ? 'border-brass/40 bg-panel text-bone' : 'border-oxblood/50 bg-oxblooddeep/20 text-bone'}`}>{msg.text}</div>
      )}

      <div className="flex items-center justify-between mb-5">
        <h2 className="font-display text-2xl text-bone tracking-[0.08em]">
          Unmapped {!loading && !error && <span className="text-ash text-base">({unmapped.length})</span>}
        </h2>
        <button onClick={load} className="inline-flex items-center gap-2 text-sm text-ash hover:text-brass"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>

      {error ? (
        <div className="panel rounded-sm p-8 text-center">
          <p className="text-ash mb-6">{error}</p>
          <button onClick={load} className="px-6 py-2.5 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm">Try again</button>
        </div>
      ) : loading ? (
        <div className="py-16 text-center text-ash">Reading the rolls…</div>
      ) : unmapped.length === 0 ? (
        <div className="panel rounded-sm p-10 text-center">
          <div className="font-display text-brassbright text-lg tracking-[0.06em] mb-1">All names are mapped</div>
          <p className="text-ash">Every in-game name in the record belongs to a known player.</p>
        </div>
      ) : (
        <div className="panel rounded-sm divide-y divide-line">
          {unmapped.map((u) => (
            <div key={u.name} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0">
                <span className="font-medium text-bone">{u.name}</span>
                <span className="font-mono text-xs text-ash ml-2">{u.matches} match{u.matches === 1 ? '' : 'es'}</span>
                {u.suggestion && (
                  <span className="text-xs text-brass ml-2">· looks like {u.suggestion.display_name}</span>
                )}
              </div>
              <div className="flex-1" />
              <select
                value={choice[u.name] ?? NEW}
                onChange={(e) => setChoice((c) => ({ ...c, [u.name]: e.target.value }))}
                className="bg-hall border border-line rounded px-3 py-2 text-sm text-bone focus:outline-none focus:border-brass max-w-[220px]"
              >
                <option value={NEW}>➕ New player ({u.name})</option>
                {sortedIdentities.map((i) => <option key={i.id} value={i.id}>{i.display_name}</option>)}
              </select>
              <button
                onClick={() => assign(u)} disabled={busy === u.name}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-brass hover:bg-brassbright text-ink font-semibold rounded-sm text-sm transition-colors disabled:opacity-40"
              >
                {choice[u.name] === NEW ? <UserPlus className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                {choice[u.name] === NEW ? 'Create' : 'Assign'}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Existing identities */}
      {!loading && sortedIdentities.length > 0 && (
        <div className="mt-14">
          <h2 className="font-display text-2xl text-bone tracking-[0.08em] mb-5">Players ({sortedIdentities.length})</h2>
          <div className="panel rounded-sm divide-y divide-line">
            {sortedIdentities.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="font-semibold text-bone w-40 truncate">{i.display_name}</span>
                <div className="flex flex-wrap gap-2 flex-1">
                  {(i.ingame_names || []).length === 0
                    ? <span className="text-xs text-ash/60">no aliases</span>
                    : (i.ingame_names || []).map((n) => (
                      <span key={n} className="inline-flex items-center gap-1 text-xs bg-hall border border-line rounded-full pl-3 pr-1.5 py-1 text-ash">
                        {n}
                        <button onClick={() => removeAlias(i, n)} className="text-ash hover:text-oxblood" aria-label={`Remove ${n}`}><X className="w-3 h-3" /></button>
                      </span>
                    ))}
                </div>
                <select
                  value={i.discord_id || ''}
                  onChange={(e) => linkDiscord(i, e.target.value)}
                  className={`bg-hall border rounded px-2 py-1 text-xs focus:outline-none focus:border-brass w-40 shrink-0 ${i.discord_id ? 'border-brass/40 text-brass' : 'border-line text-ash'}`}
                >
                  <option value="">No Discord link</option>
                  {members
                    .filter((m) => m.id === i.discord_id || !linkedDiscordIds.has(m.id))
                    .map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
