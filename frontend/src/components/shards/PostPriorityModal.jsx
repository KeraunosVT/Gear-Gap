import { useEffect, useState } from 'react';
import axios from 'axios';
import { Loader2, Send, X } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';

const FIELD = 'w-full bg-hall border border-line rounded-lg px-3 py-2 text-bone focus:outline-none focus:border-brass';

// Post the combined priority list to a Discord channel. The preview and the
// post are both built server-side from the SAVED list by one function
// (backend/shardPriority.js buildPost), so what's shown is what goes out.
// The channel starts on wherever the list was posted last.
export default function PostPriorityModal({ onClose, onPosted }) {
  const [channels, setChannels] = useState([]);
  const [channelId, setChannelId] = useState('');
  const [mention, setMention] = useState(false);
  const [preview, setPreview] = useState(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    axios.get('/api/admin/shard-priority/channels')
      .then((res) => {
        const list = res.data.channels || [];
        setChannels(list);
        const preferred = res.data.default_channel_id;
        setChannelId(list.some((c) => c.id === preferred) ? preferred : list[0]?.id || '');
      })
      .catch(() => setError('Could not load Discord channels.'));
    axios.get('/api/admin/shard-priority/preview')
      .then((res) => setPreview(res.data))
      .catch((err) => setError(err.response?.data?.error || 'Could not build the preview.'));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!channelId) { setError('Pick a channel to post to.'); return; }
    setPosting(true); setError('');
    try {
      const res = await axios.post('/api/admin/shard-priority/post', { channel_id: channelId, mention });
      onPosted(res.data.posted, channels.find((c) => c.id === channelId)?.name, res.data.count);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to post.');
      setPosting(false);
    }
  };

  const count = preview?.count || 0;

  return (
    <Modal onClose={onClose} maxWidth="max-w-xl" scrollable>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <div className="eyebrow text-brass text-[11px] mb-1">Post to Loot Council</div>
            <h2 className="font-display text-xl text-bone tracking-[0.06em]">Share the priority list</h2>
          </div>
          <button type="button" onClick={onClose} className="text-ash hover:text-bone" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>

        <div>
          <label htmlFor="sp-channel" className="eyebrow text-[10px] text-ash block mb-2">Channel</label>
          <select id="sp-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)} className={FIELD}>
            {channels.length === 0 && <option value="">—</option>}
            {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </div>

        <label className="flex items-center gap-2.5 text-sm text-bone cursor-pointer">
          <input type="checkbox" checked={mention} onChange={(e) => setMention(e.target.checked)} className="accent-brass" />
          @mention the members on the list
        </label>

        <div>
          <div className="eyebrow text-[10px] text-ash mb-2">Preview</div>
          <div className="bg-hall border border-line rounded-lg px-4 py-3 text-sm max-h-80 overflow-y-auto">
            {!preview ? (
              <span className="text-ash">Building the preview…</span>
            ) : count === 0 ? (
              <span className="text-ash">Nothing is ranked yet, so there&apos;s nothing to post.</span>
            ) : (
              <div className="space-y-0.5">
                {preview.lines.map((line, i) => (
                  <div key={i} className={i === 0 ? 'font-semibold text-bone mb-1.5' : 'text-bone/90'}>
                    {/* Discord markdown, shown plainly: bold markers and escapes dropped. */}
                    {line.replace(/\*\*/g, '').replace(/\\([\\*_~`|>])/g, '$1')}
                  </div>
                ))}
              </div>
            )}
          </div>
          {mention && count > 0 && <p className="text-xs text-ash mt-1.5">Names are posted as @mentions, which ping each member.</p>}
        </div>

        {error && <div className="text-sm text-oxblood">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="neutral" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={posting || !channelId || !count}>
            {posting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Post {count === 1 ? '1 entry' : `${count} entries`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
