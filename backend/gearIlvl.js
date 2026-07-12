// backend/gearIlvl.js — extracts weapon/armor/accessory item levels from a
// Throne & Liberty character-equipment screenshot (Gemini vision), and persists
// one entry per member (a new submission replaces their previous one).
const { GoogleGenAI, Type } = require('@google/genai');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const PROMPT = `This is a screenshot of a Throne and Liberty character equipment screen.

IMPORTANT: some of these screenshots also show an "Equippable Items" or similar
inventory-browser panel, which lists many OWNED items (not just worn ones) for
swapping gear. If any such panel is visible, IGNORE IT COMPLETELY — every item
below comes only from the character's currently-worn equipment, shown as small
circular badges near the character portrait and in a compact equipped-items grid.

There are three categories of currently-worn item level ("ilvl") numbers:

1. "weapon": Characters dual-wield TWO weapon types at once, so expect exactly
   TWO circular weapon badges near the character portrait (not in the grid, and
   not in any inventory panel) — e.g. one badge with a sword/greatsword icon and
   one with a dagger/blade icon, each with its own ilvl number. Report both.
2. "armor": body-worn pieces in the compact equipped-items grid (small circular
   icons, NOT the inventory panel) — helmet, chest/top, pants/legs, gloves,
   boots, cloak. Humanoid-silhouette icons.
3. "accessory": jewelry-style icons in that same compact grid — necklace,
   bracelet, belt, ring, earring, brooch/pendant.

Ignore any toggle switches below the grid (e.g. "Show Headgear", "Show Cloak") —
those are display options, not items. Ignore currency/character-level/combat-power
numbers elsewhere on screen; only worn weapon badges and the equipped-items grid count.

Return ONLY a JSON object with this shape:
{
  "items": [ { "category": "weapon" | "armor" | "accessory", "ilvl": <number> }, ... ]
}
List every worn weapon badge and every circular icon in the equipped-items grid
as one entry each, even if you're unsure of its exact slot name — category is
what matters, not the slot name.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          category: { type: Type.STRING },
          ilvl: { type: Type.NUMBER },
        },
        required: ['category', 'ilvl'],
      },
    },
  },
  required: ['items'],
};

// Read a screenshot and return { weapon, armor, accessory, average, items }.
// weapon/armor/accessory are each the highest ilvl found in that category;
// average is the mean of those three maxes, rounded to the nearest whole number.
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

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  const byCategory = (cat) => items.filter((i) => i.category === cat).map((i) => Number(i.ilvl) || 0);
  const weapon = Math.max(0, ...byCategory('weapon'));
  const armor = Math.max(0, ...byCategory('armor'));
  const accessory = Math.max(0, ...byCategory('accessory'));
  const maxes = [weapon, armor, accessory].filter(Boolean);
  const average = maxes.length ? Math.round(maxes.reduce((a, b) => a + b, 0) / maxes.length) : 0;

  return { weapon, armor, accessory, average, items };
}

module.exports = function createGearIlvl(supabase) {
  return {
    parseGearScreenshot,

    // A new submission replaces whatever this member had on file before.
    async submit(discordId, displayName, extracted) {
      const row = {
        discord_id: discordId,
        display_name: displayName || null,
        weapon: extracted.weapon,
        armor: extracted.armor,
        accessory: extracted.accessory,
        average: extracted.average,
        submitted_at: new Date().toISOString(),
      };
      const { error } = await supabase.from('gear_levels').upsert(row, { onConflict: 'discord_id' });
      if (error) throw new Error(error.message);
      return row;
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
