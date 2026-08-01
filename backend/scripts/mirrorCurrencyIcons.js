// backend/scripts/mirrorCurrencyIcons.js — copy currency icons into our own
// Supabase storage bucket instead of hotlinking questlog's CDN.
//
// Same reasoning as questlogImport.js, which downloads item icons and re-uploads
// them rather than pointing at the source: a hotlinked asset breaks silently
// whenever the other side reorganises, and every stored image_url in loot_items
// already lives in our bucket. Currency icons should match.
//
// Usage:
//   node scripts/mirrorCurrencyIcons.js               # mirror the known set
//   node scripts/mirrorCurrencyIcons.js <key> <url>    # mirror one more
//
// Re-runnable: uploads use upsert, so the same key overwrites in place and the
// public URL never changes.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'assets';
const ICON_PREFIX = 'currency-icons/';

// Shard icons can be added here as their source URLs turn up, or passed on the
// command line — the shard keys are in shared/shards.json.
const KNOWN = {
  lucent: 'https://cdn.questlog.gg/throne-and-liberty/assets/Game/Image/Icon/BM_Large/ICO_BMCoin_Gold_BM.webp',
};

async function mirror(supabase, key, url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(res.data);
  const contentType = res.headers['content-type'] || 'image/webp';
  const ext = contentType.includes('png') ? 'png' : 'webp';
  const storagePath = `${ICON_PREFIX}${key}.${ext}`;

  const { error } = await supabase.storage.from(BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: true });
  if (error) throw new Error(error.message);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return { publicUrl: data.publicUrl, bytes: buffer.length, contentType };
}

async function main() {
  const [argKey, argUrl] = process.argv.slice(2);
  if (argKey && !argUrl) {
    console.error('Usage: node scripts/mirrorCurrencyIcons.js [<key> <url>]');
    process.exit(1);
  }
  const jobs = argKey ? { [argKey]: argUrl } : KNOWN;

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  for (const [key, url] of Object.entries(jobs)) {
    try {
      const { publicUrl, bytes, contentType } = await mirror(supabase, key, url);
      console.log(`\n${key}`);
      console.log(`  source: ${url}`);
      console.log(`  stored: ${publicUrl}`);
      console.log(`  ${bytes} bytes, ${contentType}`);

      // Prove the uploaded copy is actually reachable, not just accepted.
      const check = await axios.get(publicUrl, { responseType: 'arraybuffer', validateStatus: () => true });
      console.log(`  verify: HTTP ${check.status}${check.status === 200 ? ` (${check.data.byteLength} bytes back)` : ''}`);
    } catch (err) {
      console.error(`\n${key}: FAILED — ${err.message}`);
    }
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
