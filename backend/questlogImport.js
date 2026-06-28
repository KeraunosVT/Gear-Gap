const axios = require('axios');

const BASE = 'https://questlog.gg/throne-and-liberty/api/trpc';
const DELAY = 300;
const MIN_GRADE = 41;

const CATEGORIES_TO_FETCH = [
  { main: 'weapons', subs: [] },
  { main: 'armor', subs: [] },
  { main: 'accessories', subs: [] },
];

const SUB_TO_LABEL = {
  sword_shield: 'SnS', sword2h: 'Greatswords', dagger: 'Daggers', bow: 'Longbows',
  crossbow: 'Crossbows', staff: 'Staffs', wand: 'Wands', spear: 'Spears',
  orb: 'Orbs', gauntlet: 'Gauntlets',
  helmet: 'Helmets', chest: 'Chest', pants: 'Pants', gloves: 'Gloves', shoes: 'Boots',
  necklace: 'Necklaces', ring: 'Rings', bracelet: 'Bracelets', belt: 'Belts',
  earring: 'Earrings', brooch: 'Brooches', cloak: 'Cloaks',
};

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
  for (const cat of CATEGORIES_TO_FETCH) {
    try {
      const items = await fetchList(cat.main);
      allListItems.push(...items);
    } catch (err) {
      errors.push(`Failed to list ${cat.main}: ${err.message}`);
    }
  }

  const bySub = {};
  allListItems.forEach((it) => {
    const sub = it.subCategory || 'unknown';
    (bySub[sub] = bySub[sub] || []).push(it);
  });

  await supabase.from('loot_items').delete().neq('key', '');
  await supabase.from('loot_categories').delete().neq('key', '');

  const subKeys = Object.keys(bySub).sort((a, b) => {
    const la = SUB_TO_LABEL[a] || a;
    const lb = SUB_TO_LABEL[b] || b;
    return la.localeCompare(lb);
  });

  for (let ci = 0; ci < subKeys.length; ci++) {
    const sub = subKeys[ci];
    const label = SUB_TO_LABEL[sub] || sub;
    const catKey = sub.replace(/\s+/g, '_').toLowerCase();

    await supabase.from('loot_categories').insert({ key: catKey, label, sort_order: ci });

    const items = bySub[sub];
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];
      try {
        await sleep(DELAY);
        const detail = await fetchDetail(it.id);
        const icon = it.icon ? `https://questlog.gg${it.icon}.webp` : null;
        const itemKey = `${catKey}__${it.id}`;

        await supabase.from('loot_items').insert({
          key: itemKey,
          category_key: catKey,
          name: it.name,
          sort_order: ii,
          image_url: icon,
          description: detail?.description || null,
          questlog_id: it.id,
          grade: it.grade,
          questlog_data: trimDetail(detail),
        });
        imported++;
      } catch (err) {
        errors.push(`${it.name}: ${err.message}`);
      }
    }
  }

  return { imported, errors, duration_ms: Date.now() - start };
};
