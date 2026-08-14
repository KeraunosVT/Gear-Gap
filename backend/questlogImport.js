const axios = require('axios');

const BASE = 'https://questlog.gg/throne-and-liberty/api/trpc';
const DELAY = 300;
const MIN_GRADE = 41;
const BUCKET = 'assets';
const ICON_PREFIX = 'loot-icons/';

const CATEGORIES = [
  { main: 'weapons', sub: '' },
  { main: 'armor', sub: '' },
  { main: 'accessories', sub: '' },
  { main: 'misc', sub: 'perk', filter: (it) => it.id.startsWith('Perk_EA') },
];

// Potentials share the questlog_items table rather than getting one of their
// own: everything downstream — search, add-to-catalog, the tooltip — already
// reads that table, and a potential is a named, described, iconed thing that
// members request exactly like an item. main_category tells them apart.
const POTENTIAL_CATEGORY = 'potential';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchList(mainCategory, subCategory = '') {
  const all = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount) {
    const input = JSON.stringify({ language: 'en', page, mainCategory, subCategory });
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

async function fetchPotentialList() {
  const all = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount) {
    const input = JSON.stringify({ language: 'en', page });
    const { data } = await axios.get(`${BASE}/database.getPotentialAbilities`, { params: { input } });
    const result = data?.result?.data;
    pageCount = result?.pageCount || 1;
    // No grade filter — potentials have no grade at all, so MIN_GRADE would
    // discard every one of them.
    all.push(...(result?.pageData || []).filter((p) => !p.isDisabled));
    page++;
    await sleep(DELAY);
  }
  return all;
}

async function fetchPotentialDetail(id) {
  const input = JSON.stringify({ language: 'en', id });
  const { data } = await axios.get(`${BASE}/database.getPotentialAbility`, { params: { input } });
  return data?.result?.data || null;
}

// The effect, as one line of prose for the description box.
//
// The two kinds need different handling. For skill potentials (180 of the 192)
// questlog's `description` already IS the effect — "Ensnaring Arrow's skill
// level increases by 1.", "Increases damage by 0.7% per 1m distance of Zephyr's
// Nock." — so it goes through untouched.
//
// For the 12 stat potentials the description is just the stat's display name
// repeated ("Hit Chance", "Max Health"), which says nothing the name didn't; the
// number in `value` is the entire effect and has to be appended or the box
// reads as a tautology.
//
// Those numbers are questlog's raw game values, printed unscaled. questlog
// exposes no display formatting for them, and picking a divisor would be
// guessing at a number officers will make decisions on — the same raw figures
// already appear in ItemTooltip's stat rows, so this is at least consistent
// with what the app shows elsewhere.
function potentialEffect(detail) {
  if (!detail) return null;
  const text = String(detail.description || '').trim();
  if (detail.kind !== 'stat') return text || null;
  if (detail.value === null || detail.value === undefined) return text || null;
  const sign = Number(detail.value) < 0 ? '' : '+';
  return `${text || detail.name} ${sign}${Number(detail.value).toLocaleString('en-US')}`;
}

// Small on purpose, like trimDetail: rolledBy lists every item that can roll the
// potential — 54 to 125 rows each, ~20k rows across the set — and it is item
// data we already store item-side. Everything kept here is something the
// tooltip or a future filter can use.
function trimPotential(detail, listRow) {
  return {
    kind: detail.kind || null,
    value: detail.value ?? null,
    gearTypes: detail.gearTypes || null,
    weapons: detail.weapons || null,
    weaponClass: detail.subCategory || listRow.subCategory || null,
  };
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

// Paged deliberately. PostgREST caps an unbounded select at 1000 rows, and the
// catalog is past that — a single select('id') silently returns the first
// thousand, every id beyond it reads as "new", and the sync re-fetches and
// re-uploads icons for items it already has on every run.
async function existingIdSet(supabase) {
  const ids = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('questlog_items')
      .select('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read existing items: ${error.message}`);
    (data || []).forEach((r) => ids.add(r.id));
    if (!data || data.length < PAGE) return ids;
  }
}

// Potentials, into the same table. Kept in its own function and its own
// try/catch at the call site so that a questlog change to this endpoint can
// never take down the item sync, which has been working for a year.
async function importPotentials(supabase, errors) {
  let imported = 0;

  const list = await fetchPotentialList();

  // Re-fetch a potential we already have only when its description is missing.
  // The whole point of pulling these is the effect text, so a row that never
  // got one should heal itself on the next sync rather than stay blank forever;
  // a row that has one costs nothing and is left alone.
  const { data: existing } = await supabase.from('questlog_items')
    .select('id, description').eq('main_category', POTENTIAL_CATEGORY);
  const described = new Set((existing || []).filter((r) => r.description).map((r) => r.id));

  // compoundId, not id: questlog's own namespaced key ("potential-ability-
  // all_accuracy"). Bare potential ids are short lowercase words like
  // "hp_max", and this table is keyed by item id — namespacing removes any
  // chance of a potential and an item colliding on one primary key.
  const pending = list.filter((p) => !described.has(p.compoundId));
  const skipped = list.length - pending.length;

  for (const p of pending) {
    try {
      await sleep(DELAY);
      const detail = await fetchPotentialDetail(p.id);
      if (!detail) { errors.push(`${p.name}: no detail returned`); continue; }

      const icon = await downloadAndUploadIcon(supabase, p.compoundId, detail.icon || p.icon);

      const { error } = await supabase.from('questlog_items').upsert({
        id: p.compoundId,
        name: detail.name || p.name,
        icon,
        description: potentialEffect(detail),
        grade: null,
        main_category: POTENTIAL_CATEGORY,
        // The gear type it rolls on — weapon / armor / accessory / universal.
        // That is the facet anyone filtering potentials actually wants; the
        // weapon it belongs to (bow, greatsword) is in data.weaponClass.
        sub_category: detail.mainCategory || p.mainCategory || null,
        data: trimPotential(detail, p),
      });
      if (error) throw new Error(error.message);
      imported++;
    } catch (err) {
      errors.push(`${p.name}: ${err.message}`);
    }
  }

  return { imported, skipped };
}

module.exports = async function runImport(supabase) {
  const start = Date.now();
  const errors = [];
  let imported = 0;

  const existingIds = await existingIdSet(supabase);

  const allListItems = [];
  for (const cat of CATEGORIES) {
    try {
      let items = await fetchList(cat.main, cat.sub);
      if (cat.filter) items = items.filter(cat.filter);
      items.forEach((it) => { it._mainCategory = cat.main; });
      allListItems.push(...items);
    } catch (err) {
      errors.push(`Failed to list ${cat.main}/${cat.sub}: ${err.message}`);
    }
  }

  const newItems = allListItems.filter((it) => !existingIds.has(it.id));
  let skipped = allListItems.length - newItems.length;

  for (const it of newItems) {
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

  let potentials = { imported: 0, skipped: 0 };
  try {
    potentials = await importPotentials(supabase, errors);
  } catch (err) {
    errors.push(`Failed to import potentials: ${err.message}`);
  }

  return { imported, skipped, potentials, errors, duration_ms: Date.now() - start };
};

// Exported so the potentials pass can be run on its own. The item sync takes
// minutes and re-reads four paginated endpoints; there is no reason to sit
// through it to check 192 rows of effect text.
module.exports.importPotentials = importPotentials;
