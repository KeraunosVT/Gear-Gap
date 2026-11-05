import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, Send } from 'lucide-react';
import Modal from './ui/Modal';
import Button from './ui/Button';
import { useT } from '../i18n';

const FIELD = 'w-full bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass';

// ── POST A SCOUTING REPORT TO DISCORD ───────────────────────────────────────
// One enemy guild's current roster and standouts, as a Discord post. Opened
// from the Feuds roster page (`guild`) or from a signup with an opponent
// (`signupId`, which adds the event's name and start time to the post and
// stops the automatic one going out as well).
//
// The post is built server-side from the same read the roster page uses
// (backend/scouting.js), so what's posted matches what the officer is looking at.
export default function ScoutPostModal({ guild, signupId = null, onClose, onPosted }) {
  const { t } = useT();
  const [channels, setChannels] = useState([]);
  const [channelId, setChannelId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get('/api/admin/scouting/channels')
      .then((res) => {
        const list = res.data.channels || [];
        setChannels(list);
        // Starts on the Scouting channel from Guild Settings (else the
        // calendar's); picking another here only changes this one post.
        const preferred = res.data.default_channel_id;
        setChannelId(list.some((c) => c.id === preferred) ? preferred : list[0]?.id || '');
      })
      .catch(() => setError(t('cal.channelsFailed')));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!channelId) { setError(t('cal.needChannel')); return; }
    setSaving(true); setError('');
    try {
      const body = signupId ? { signup_id: signupId, channel_id: channelId, note } : { guild, channel_id: channelId, note };
      const res = await axios.post('/api/admin/scouting/post', body);
      const ch = channels.find((c) => c.id === channelId);
      onPosted(t(ch ? 'scout.postedTo' : 'scout.posted', { guild: res.data.enemy || guild, channel: ch?.name }));
    } catch (err) {
      setError(err.response?.data?.error || t('cal.postFailed'));
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth="max-w-md">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <div className="eyebrow text-brass text-[11px] mb-2">{t('scout.eyebrow')}</div>
          <h2 className="font-display text-xl text-bone tracking-[0.06em]">{guild}</h2>
          <p className="text-ash text-sm mt-1">{t('scout.explain')}</p>
        </div>

        <div>
          <label className="eyebrow text-[10px] text-ash block mb-2">{t('cal.channel')}</label>
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)} className={FIELD}>
            {channels.length === 0 && <option value="">—</option>}
            {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </div>

        <div>
          <label className="eyebrow text-[10px] text-ash block mb-2">{t('cal.messageOptional')}</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            placeholder={t('scout.notePlaceholder')} className={FIELD} />
        </div>

        {signupId && <p className="text-xs text-ash/70">{t('scout.claimsAuto')}</p>}

        {error && <div className="text-sm text-oxblood">{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="neutral" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={saving || !channelId}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} {t('cal.post')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
