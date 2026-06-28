const axios = require('axios');

const BASE = 'https://questlog.gg/throne-and-liberty/api/trpc';
const DELAY = 300;
const MIN_GRADE = 41;
const BUCKET = 'assets';
const ICON_PREFIX = 'loot-icons/';

const CATEGORIES = ['weapons', 'armor', 'accessories'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchList(mainCategory) {
  const all = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount) {
    const input = JSON.stringify({ language: 'en', page, mainCategory, subCategory: '' });
    const { data } = await axios.get(`${BASE}/database.getItems`, { params: { input } });
    const result = data?.result?.data;
    pageCount = result?.pageCount || 1;
    const items = (result?.pageData || []).filter((it) => it.grade >= MIN_GRADE);
    all.push(...items);
    page++;
    await sleep(DELAY);
  }
  return all;
}

async function fetchDetail(id) {
  const input = JSON.stringify({ language: 'en', id });
  const { data } = await axios.get(`${BASE}/database.getItem`, { params: { input } });
  return data?.result?.data || null;
}

async function downloadAndUploadIcon(supabase, itemId, iconPath) {
  if (!iconPath) return null;
  try {
    const cleanPath = iconPath.replace(/\.([^/]+)$/, '');
    const url = `https://cdn.questlog.gg/throne-and-liberty${cleanPath}.webp`;
    const res = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);
    const storagePath = `${ICON_PREFIX}${itemId}.webp`;

    await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
      contentType: 'image/webp', upsert: true,
    });

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    return data.publicUrl;
  } catch (err) {
    console.error(`Icon download failed for ${itemId}:`, err.message);
    return null;
  }
}

function trimDetail(d) {
  if (!d) return null;
  return {
    itemStats: d.itemStats || null,
    itemTraits: d.itemTraits || null,
    resonance: d.resonance || null,
    passiveAbility: d.passiveAbility || null,
    activeAbility: d.activeAbility || null,
  };
}

module.exports = async function runImport(supabase) {
  const start = Date.now();
  const errors = [];
  let imported = 0;

  const allListItems = [];
  for (const main of CATEGORIES) {
    try {
      const items = await fetchList(main);
      items.forEach((it) => { it._mainCategory = main; });
      allListItems.push(...items);
    } catch (err) {
      errors.push(`Failed to list ${main}: ${err.message}`);
    }
  }

  await supabase.from('questlog_items').delete().neq('id', '');

  for (const it of allListItems) {
    try {
      await sleep(DELAY);
      const detail = await fetchDetail(it.id);
      const icon = await downloadAndUploadIcon(supabase, it.id, it.icon);

      await supabase.from('questlog_items').upsert({
        id: it.id,
        name: it.name,
        icon,
        description: detail?.description || null,
        grade: it.grade,
        main_category: it._mainCategory,
        sub_category: it.subCategory,
        data: trimDetail(detail),
      });
      imported++;
    } catch (err) {
      errors.push(`${it.name}: ${err.message}`);
    }
  }

  return { imported, errors, duration_ms: Date.now() - start };
};
