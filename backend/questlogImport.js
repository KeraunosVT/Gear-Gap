const axios = require('axios');
const STATS = require('../shared/stats.json');

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

// ── Stat values are stored in fixed-point, not in display units ─────────────
//
// questlog serves the game's internal numbers and publishes no formatting for
// them, so a few stats come back scaled by a constant. `skill_cooldown_modifier
// 250` is 2.5% Cooldown Speed; `hp_regen 40000` is 40 Health Regen. Printed
// raw, both are wrong by two or three orders of magnitude — and wrong in the
// direction that makes an item look far better than it is.
//
// Labels and divisors both live in shared/stats.json so this file and
// ItemTooltip can't drift apart: this one writes stat names and numbers into a
// stored description, the other renders the same stats live from item data, and
// either fixed in only one place would show two different figures — or two
// different names — for one stat.
//
// A stat with no divisor is flat and prints as-is — Hit Chance, Max Health and
// the defenses are genuinely the numbers they say. Deliberately an explicit id
// list rather than a "_modifier means percent" rule: an unmapped stat printing
// raw is a visibly odd number someone reports, whereas a pattern that guesses
// wrong is a plausible-looking number nobody catches.
//
// Not mapped, for want of a confirmed divisor: block chance (no such key
// appears anywhere in questlog's item data — if it surfaces, it is /100 like
// its siblings), move_speed_modifier, and stamina_regen.
function statLabel(statId) {
  return STATS[statId]?.label || String(statId || '').replace(/_/g, ' ');
}

function fmtStatValue(statId, value) {
  // Guarded before coercion: Number(null) is 0, and an item described as "+0%"
  // reads as a real, useless roll rather than as data we failed to read.
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const scale = STATS[statId];
  if (!scale || !scale.divisor) return n.toLocaleString('en-US');
  return (n / scale.divisor).toLocaleString('en-US', { maximumFractionDigits: 2 }) + (scale.suffix || '');
}

// questlog's item descriptions carry inline markup — the equip rule on a Heroic
// weapon arrives as `<span style="color: #F54451">Up to 1 Heroic weapon can be
// equipped.</span>`. Nothing downstream renders HTML (the tooltip puts the
// description in a <p> as text, which is the right call for third-party
// content), so the tags were being shown to members verbatim.
function stripHtml(text) {
  if (!text) return null;
  return String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim() || null;
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
// reads as a tautology. A stat potential's `id` IS the stat id, which is what
// makes the scale lookup below a direct hit rather than a name match.
function potentialEffect(detail) {
  if (!detail) return null;
  const text = String(detail.description || '').trim();
  if (detail.kind !== 'stat') return text || null;
  if (detail.value === null || detail.value === undefined) return text || null;
  const sign = Number(detail.value) < 0 ? '' : '+';
  return `${text || detail.name} ${sign}${fmtStatValue(detail.id, detail.value)}`;
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
    // The next three are vestigial: questlog serves an empty array for
    // itemTraits and nothing at all for the two abilities. What they were meant
    // to hold now lives inside itemStats as .traits, .uniqueTraits and
    // .resonance. Kept so the shape of already-imported rows doesn't change.
    itemTraits: d.itemTraits || null,
    resonance: d.resonance || null,
    passiveAbility: d.passiveAbility || null,
    activeAbility: d.activeAbility || null,
    // The flavour text, kept apart from the description we build. Without it a
    // rebuild would have to recover the flavour by unpicking it from the
    // description it was already folded into, and would double the stat summary
    // every time it ran.
    flavour: stripHtml(d.description),
  };
}

// The highest level present. Epic gear is keyed 21..50 and Legendary gear is
// keyed 75 — questlog's levels are enhancement levels, not one fixed pair, so
// the max has to be read off the data. Assuming a pair is what made the tooltip
// show no stats at all for every Legendary item.
function topLevel(byLevel) {
  const levels = Object.keys(byLevel || {}).map(Number).filter(Number.isFinite);
  return levels.length ? String(Math.max(...levels)) : null;
}

// What a piece of gear actually does, as one line for the description box.
//
// Gear needs the opposite treatment to potentials. A potential's description
// was a tautology and its effect was one number; an item's description is
// flavour ("A longbow made with Shaikal's intense darkness…") or an equip rule
// ("Identical rings cannot be equipped at the same time.") and never mentions a
// single stat. So the summary is built from itemStats and the flavour is kept
// underneath it — the equip rules in particular are the sort of thing an
// officer needs and nothing else in the app records.
//
// Fully-enhanced values, because that is the number people compare gear on.
//
// Deliberately NOT included: traits, uniqueTraits and resonance. Those are the
// pool of things an item *might* roll, four tiers deep and ten stats wide —
// listing them would read as a description of what the item has, which is the
// one thing they aren't.
function itemEffect(detail) {
  if (!detail) return null;
  const stats = detail.itemStats || {};
  const parts = [];

  const mainLevel = topLevel(stats.main);
  const main = mainLevel ? stats.main[mainLevel] : null;
  if (main) {
    // Weapon damage arrives as a min/max pair under the hand that swings it.
    ['mainhand', 'offhand', 'shield'].forEach((slot) => {
      const dmg = main[slot];
      if (!dmg || (dmg.min == null && dmg.max == null)) return;
      const id = dmg.statId || slot;
      parts.push(dmg.min != null && dmg.max != null && dmg.min !== dmg.max
        ? `${statLabel(id)} ${fmtStatValue(id, dmg.min)}–${fmtStatValue(id, dmg.max)}`
        : `${statLabel(id)} ${fmtStatValue(id, dmg.max ?? dmg.min)}`);
    });
    // Armor values, and the weapon's own range/speed, are plain stat maps.
    [main.armor, main.extra].forEach((group) => {
      Object.entries(group || {}).forEach(([id, v]) => {
        if (typeof v === 'number') parts.push(`${statLabel(id)} ${fmtStatValue(id, v)}`);
      });
    });
  }

  const extraLevel = topLevel(stats.extra);
  Object.entries(stats.extra?.[extraLevel] || {}).forEach(([id, v]) => {
    if (typeof v === 'number') parts.push(`${statLabel(id)} +${fmtStatValue(id, v)}`);
  });

  const flavour = detail.flavour === undefined ? stripHtml(detail.description) : detail.flavour;
  return [parts.join(' · ') || null, flavour].filter(Boolean).join('\n\n') || null;
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

// Rebuild descriptions for gear already in the table, from the itemStats each
// row already carries. No network at all — the sync skips items it has, so
// without this the effect summaries would only ever appear on gear questlog
// added after today, and a catalog built over the past year would keep its
// flavour text forever.
//
// Idempotent by way of data.flavour: the first pass moves the stored flavour
// text there and writes `summary + flavour` to the description; every pass
// after that rebuilds from the same two inputs and finds nothing to change, so
// only genuine changes cost a write.
//
// It does NOT touch loot_items. Those descriptions are hand-editable on the
// Loot Items page and an officer's wording is not ours to overwrite; re-linking
// an item to questlog is the deliberate way to pull a fresh one.
async function rebuildItemDescriptions(supabase, errors) {
  let updated = 0;
  let scanned = 0;
  const PAGE = 500;

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('questlog_items')
      .select('id, description, data')
      .neq('main_category', POTENTIAL_CATEGORY)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read items: ${error.message}`);

    for (const row of data || []) {
      scanned++;
      try {
        const stored = row.data || {};
        if (!stored.itemStats) continue;

        // Rows imported before this change have no data.flavour, and their
        // description IS the flavour — that is the one and only chance to
        // recover it, so it gets written back on this pass.
        const flavour = stored.flavour === undefined ? stripHtml(row.description) : stored.flavour;
        const next = itemEffect({ itemStats: stored.itemStats, flavour });
        if (next === row.description && stored.flavour !== undefined) continue;

        const { error: upErr } = await supabase.from('questlog_items')
          .update({ description: next, data: { ...stored, flavour } })
          .eq('id', row.id);
        if (upErr) throw new Error(upErr.message);
        updated++;
      } catch (err) {
        errors.push(`Rebuild ${row.id}: ${err.message}`);
      }
    }

    if (!data || data.length < PAGE) break;
  }

  return { scanned, updated };
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
        description: itemEffect(detail),
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

  let rebuilt = { scanned: 0, updated: 0 };
  try {
    rebuilt = await rebuildItemDescriptions(supabase, errors);
  } catch (err) {
    errors.push(`Failed to rebuild descriptions: ${err.message}`);
  }

  let potentials = { imported: 0, skipped: 0 };
  try {
    potentials = await importPotentials(supabase, errors);
  } catch (err) {
    errors.push(`Failed to import potentials: ${err.message}`);
  }

  return { imported, skipped, rebuilt, potentials, errors, duration_ms: Date.now() - start };
};

// Exported so the potentials pass can be run on its own. The item sync takes
// minutes and re-reads four paginated endpoints; there is no reason to sit
// through it to check 192 rows of effect text.
module.exports.importPotentials = importPotentials;
