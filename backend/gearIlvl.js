// backend/gearIlvl.js — extracts weapon/armor/accessory item levels from a
// Throne & Liberty "Equipment Level" info window screenshot (Gemini vision),
// and persists one entry per member (a new submission replaces their previous one).
const { GoogleGenAI, Type } = require('@google/genai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const PROMPT = `This is a screenshot of the "Equipment Level" info window from
Throne and Liberty. It's a small popup/tooltip with the title "Equipment Level",
a short description below it, and then four labeled lines, each ending in a
number, e.g.:

Equipment Lv. 74
Max Weapon Lv. 74
Max Armor Lv. 74
Max Accessory Lv. 75

Read the number at the end of each of those four lines:
- "Equipment Lv." — the overall equipment level
- "Max Weapon Lv." — highest weapon item level
- "Max Armor Lv." — highest armor item level
- "Max Accessory Lv." — highest accessory item level

Return ONLY a JSON object with this shape:
{ "equipmentLevel": <number>, "weapon": <number>, "armor": <number>, "accessory": <number> }`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    equipmentLevel: { type: Type.NUMBER },
    weapon: { type: Type.NUMBER },
    armor: { type: Type.NUMBER },
    accessory: { type: Type.NUMBER },
  },
  required: ['equipmentLevel', 'weapon', 'armor', 'accessory'],
};

// ── THE FULL EQUIPMENT WINDOW ───────────────────────────────────────────────
// A different screenshot and a different job. The popup above prints four
// numbers the game has already computed; this reads every equipped item so the
// three maxima can be recomputed with Heroic-tier items left out — which the
// popup's own "Max Weapon Lv." line cannot be talked out of including.
//
// The model is asked for the tier VERBATIM and for a category per item, rather
// than being asked to do the filtering or the arithmetic itself. Two reasons:
// a model that returns one wrong number gives no way to see where it went
// wrong, and the exclusion rule is a guild policy that will change without the
// screenshot format changing. Both live in JS below, where they can be read.
const WINDOW_PROMPT = `This is a screenshot of the character equipment window from
Throne and Liberty, showing every item the character has equipped.

For EACH equipped item visible in the window, report:
- "slot": the equipment slot label as shown (e.g. "Main Weapon", "Head", "Necklace").
  If the slot isn't labelled, describe it briefly.
- "name": the item's name as printed.
- "category": exactly one of "weapon", "armor", "accessory".
    weapon    = held weapons (main hand, off hand, secondary weapon sets)
    armor     = worn body pieces (head, chest, legs, hands, feet, cloak, and similar)
    accessory = jewellery and trinkets (necklace, earrings, rings, belts, bracelets, and similar)
- "tier": the item's rarity/grade EXACTLY as the game labels or colours it —
  for example "Common", "Uncommon", "Rare", "Epic", "Heroic", "Legendary".
  Report what you actually see. Do not translate it into another word, do not
  guess from the item name, and do not normalise the capitalisation.
- "level": the item's level as a number. This is the per-item level shown on or
  beside the item, NOT the character level and NOT any combat-power total.

Rules:
- Report every equipped item once. Skip empty slots entirely.
- If an item's level is not legible, omit that item rather than guessing a number.
- Do not compute any averages or maximums. Return only the items.

Return ONLY a JSON object of the shape:
{ "items": [ { "slot": "...", "name": "...", "category": "...", "tier": "...", "level": <number> } ] }`;

const WINDOW_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          slot: { type: Type.STRING },
          name: { type: Type.STRING },
          category: { type: Type.STRING },
          tier: { type: Type.STRING },
          level: { type: Type.NUMBER },
        },
        required: ['slot', 'name', 'category', 'tier', 'level'],
      },
    },
  },
  required: ['items'],
};

// The tiers that don't count toward a gear level, lowercased for comparison.
//
// "Heroic" is the guild's rule; "orange" is here because that is what people
// call it in chat and a model asked to report what it sees will sometimes
// answer with the colour rather than the grade. Matching both means the rule
// survives that without anyone noticing a gap.
//
// Anything NOT in this set counts, so a tier the model words unexpectedly is
// included rather than silently dropped — the failure that leaves a member's
// level too low is louder than the one that leaves it too high, and both are
// visible in the item list either way.
const EXCLUDED_TIERS = new Set(['heroic', 'orange']);

const CATEGORIES = ['weapon', 'armor', 'accessory'];

const isExcluded = (tier) => EXCLUDED_TIERS.has(String(tier || '').trim().toLowerCase());

// Normalise one parsed item, or null if it isn't usable. A row with no legible
// level is dropped here rather than counted as zero, which would drag a
// category's maximum down only if every other item were also missing — the kind
// of bug that shows up as one member being mysteriously low.
function normaliseItem(raw) {
  const level = Number(raw?.level);
  if (!Number.isFinite(level) || level <= 0) return null;
  const category = String(raw?.category || '').trim().toLowerCase();
  return {
    slot: String(raw?.slot || '').slice(0, 60) || 'Unknown',
    name: String(raw?.name || '').slice(0, 120) || 'Unknown item',
    category: CATEGORIES.includes(category) ? category : 'other',
    tier: String(raw?.tier || '').slice(0, 40) || 'Unknown',
    level: Math.round(level),
    excluded: isExcluded(raw?.tier),
  };
}

// Highest non-excluded level per category, plus the average of the three.
//
// A category with nothing left after exclusion comes back NULL, not 0. Zero
// would render as a real level and average in as one; null says "there is no
// countable item here", which is the truth and is what the page reports.
//
// The average is the mean of whichever categories have a value, matching how
// the game's own Equipment Lv. relates to its three maxima. Rounded, because
// every level on screen is an integer and a 71.67 would invite the question of
// which item produced the fraction.
function summarise(items) {
  const out = { weapon: null, armor: null, accessory: null, average: null };
  CATEGORIES.forEach((cat) => {
    const levels = items.filter((i) => i.category === cat && !i.excluded).map((i) => i.level);
    if (levels.length) out[cat] = Math.max(...levels);
  });
  const present = CATEGORIES.map((c) => out[c]).filter((v) => v !== null);
  if (present.length) out.average = Math.round(present.reduce((a, b) => a + b, 0) / present.length);
  return out;
}

async function parseGearWindow(buffer, mimeType) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set — gear reading is unavailable.');
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { text: WINDOW_PROMPT },
        { inlineData: { mimeType, data: buffer.toString('base64') } },
      ],
    }],
    config: { responseMimeType: 'application/json', responseSchema: WINDOW_SCHEMA, temperature: 0 },
  });

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error('Gemini did not return valid JSON. Try a clearer screenshot.');
  }

  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .map(normaliseItem)
    .filter(Boolean)
    .sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || b.level - a.level);

  if (!items.length) {
    throw new Error("Couldn't read any equipped items from that screenshot. Make sure the whole equipment window is visible, including each item's level.");
  }

  const summary = summarise(items);
  if (summary.average === null) {
    // Every item read was excluded. Refusing is better than storing a member's
    // gear level as "nothing" — far more likely they screenshotted a Heroic
    // loadout page than that they genuinely have no countable gear.
    throw new Error(`Every item read from that screenshot was ${[...EXCLUDED_TIERS].join('/')} tier, so there is no gear level to record.`);
  }

  return {
    items,
    ...summary,
    excludedCount: items.filter((i) => i.excluded).length,
  };
}

// Read a screenshot and return { weapon, armor, accessory, average }. weapon/
// armor/accessory are each read directly off the window's "Max ___ Lv." line;
// average is its "Equipment Lv." line — the game itself defines that as the
// mean of the other three, so there's no need to recompute it here.
async function parseGearScreenshot(buffer, mimeType) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set — gear reading is unavailable.');
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{
      role: 'user',
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: buffer.toString('base64') } },
      ],
    }],
    config: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
  });

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new Error('Gemini did not return valid JSON. Try a clearer screenshot.');
  }

  const weapon = Number(parsed.weapon) || 0;
  const armor = Number(parsed.armor) || 0;
  const accessory = Number(parsed.accessory) || 0;
  const average = Number(parsed.equipmentLevel) || 0;

  return { weapon, armor, accessory, average };
}

const MAX_LEVEL = 80;

// Private bucket — see migrations/016. Nothing here ever calls getPublicUrl();
// reads go through a short-lived signed URL minted by a gated route.
const BUCKET = 'gear';
const SIGNED_URL_SECONDS = 300;

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

module.exports = function createGearIlvl(supabase) {
  return {
    parseGearScreenshot,
    parseGearWindow,

    // A new submission replaces whatever this member had on file before —
    // except maxed_at, which is set once (the first time weapon/armor/
    // accessory all hit MAX_LEVEL) and then left alone on every later
    // resubmission, so members at the cap keep the order they actually
    // achieved it in rather than being reshuffled by later screenshots.
    // `source` records WHICH screenshot produced these numbers — 'popup'
    // includes Heroic items, 'window' excludes them. Both write here so the
    // leaderboard and the profile keep reading one row, but they are not the
    // same measurement and the column is what stops them being compared as if
    // they were.
    async submit(discordId, displayName, extracted, source = 'popup') {
      const isMaxed = extracted.weapon === MAX_LEVEL && extracted.armor === MAX_LEVEL && extracted.accessory === MAX_LEVEL;
      const row = {
        discord_id: discordId,
        display_name: displayName || null,
        weapon: extracted.weapon,
        armor: extracted.armor,
        accessory: extracted.accessory,
        average: extracted.average,
        source,
        submitted_at: new Date().toISOString(),
      };
      if (isMaxed) {
        const { data: existing } = await supabase.from('gear_levels').select('maxed_at').eq('discord_id', discordId).single();
        row.maxed_at = existing?.maxed_at || new Date().toISOString();
      }
      const { error } = await supabase.from('gear_levels').upsert(row, { onConflict: 'discord_id' });
      if (error) throw new Error(error.message);

      // Append-only log, separate from the upserted "current" row above — this
      // is what lets a member's gear progression be viewed over time instead
      // of only ever showing their latest submission.
      const { maxed_at, ...historyRow } = row;
      await supabase.from('gear_level_history').insert(historyRow).then(({ error: histErr }) => {
        if (histErr) console.error('gear_level_history insert failed:', histErr.message);
      });

      return row;
    },

    // ── THE FULL EQUIPMENT WINDOW ─────────────────────────────────────────────
    // Store the image, record what was read out of it, and update the member's
    // gear level from the non-Heroic items.
    //
    // Ordering is deliberate: the image goes up FIRST, and a failure there
    // aborts before anything is written. The alternative — record the numbers,
    // then try to store the picture — produces rows claiming to be backed by a
    // screenshot that isn't there, and the whole point of this path is that the
    // number can be checked against the image.
    async submitWindow(discordId, displayName, buffer, mimeType, extracted) {
      const ext = EXT_BY_MIME[mimeType] || 'png';
      // Keyed on discord_id alone, with upsert: one screenshot per member,
      // replaced each time. A timestamped path would accumulate a copy per
      // submission forever, and nothing ever asks for the older ones.
      //
      // The extension is part of the name, so switching format leaves the old
      // file orphaned — removed explicitly below rather than left to rot.
      const storagePath = `${discordId}.${ext}`;

      const { error: upErr } = await supabase.storage.from(BUCKET)
        .upload(storagePath, buffer, { contentType: mimeType, upsert: true });
      if (upErr) {
        console.error('gear screenshot upload failed:', upErr.message);
        throw new Error('Could not store that screenshot. Nothing was changed.');
      }

      // Clear any copy left behind by a previous upload in a different format.
      // Best-effort: an orphaned image is untidy, not wrong, and failing the
      // submission over it would be the worse trade.
      const stale = Object.values(EXT_BY_MIME)
        .filter((e) => e !== ext).map((e) => `${discordId}.${e}`);
      await supabase.storage.from(BUCKET).remove(stale).catch(() => {});

      const { error } = await supabase.from('gear_screenshots').upsert({
        discord_id: discordId,
        display_name: displayName || null,
        storage_path: storagePath,
        items: extracted.items,
        weapon: extracted.weapon,
        armor: extracted.armor,
        accessory: extracted.accessory,
        average: extracted.average,
        excluded_count: extracted.excludedCount,
        submitted_at: new Date().toISOString(),
      }, { onConflict: 'discord_id' });
      if (error) {
        console.error('gear_screenshots upsert failed:', error.message);
        throw new Error('Could not save what was read from that screenshot.');
      }

      const entry = await this.submit(discordId, displayName, extracted, 'window');
      return { entry, items: extracted.items, excludedCount: extracted.excludedCount };
    },

    // The parsed record plus a short-lived signed URL for the image itself.
    //
    // Signed rather than public, and minted per request rather than stored: the
    // bucket is private (migrations/016), so this URL is the only way to see the
    // file, and it expires. Callers must have already checked that the viewer is
    // the member or an officer — this function does no gating of its own, which
    // is exactly why it is never called from a route that hasn't.
    async screenshotFor(discordId) {
      const { data, error } = await supabase.from('gear_screenshots')
        .select('*').eq('discord_id', discordId).maybeSingle();
      if (error || !data) return null;

      const { data: signed } = await supabase.storage.from(BUCKET)
        .createSignedUrl(data.storage_path, SIGNED_URL_SECONDS);
      // A missing file is worth returning the parse for anyway — the numbers
      // and the item list are still the answer to most questions.
      return { ...data, image_url: signed?.signedUrl || null };
    },

    async historyForMember(discordId) {
      const { data, error } = await supabase.from('gear_level_history')
        .select('*').eq('discord_id', discordId).order('submitted_at', { ascending: false });
      if (error) { console.error('gearIlvl.historyForMember error:', error.message); return []; }
      return data || [];
    },

    async forMember(discordId) {
      const { data, error } = await supabase.from('gear_levels').select('*').eq('discord_id', discordId).single();
      if (error) return null;
      return data;
    },

    async all() {
      const { data, error } = await supabase.from('gear_levels').select('*');
      if (error) { console.error('gearIlvl.all error:', error.message); return []; }
      return data || [];
    },
  };
};

// Exposed directly too, for the standalone CLI test script (no supabase needed).
module.exports.parseGearScreenshot = parseGearScreenshot;
module.exports.parseGearWindow = parseGearWindow;
// The exclusion rule, exported so the CLI test and the page can name the same
// tiers rather than each hardcoding a list that drifts from this one.
module.exports.EXCLUDED_TIERS = EXCLUDED_TIERS;
