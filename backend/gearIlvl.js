// backend/gearIlvl.js — extracts weapon/armor/accessory item levels from a
// Throne & Liberty "Equipment Level" info window screenshot (see vision.js),
// and persists one entry per member (a new submission replaces their previous one).
const vision = require('./vision');

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

// Strict-mode structured output: every property listed in `required`, and
// `additionalProperties: false`. Both are mandatory, not stylistic.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    equipmentLevel: { type: 'number' },
    weapon: { type: 'number' },
    armor: { type: 'number' },
    accessory: { type: 'number' },
  },
  required: ['equipmentLevel', 'weapon', 'armor', 'accessory'],
  additionalProperties: false,
};

// ── THE FULL EQUIPMENT WINDOW ───────────────────────────────────────────────
// Stored, not read. This used to run its own Gemini pass over every equipped
// item and recompute the three maxima with Heroic-tier gear excluded, then
// overwrite the member's gear level with the result.
//
// It no longer reads anything. Two measurements writing one gear level meant
// the number changed meaning depending on which upload a member happened to do
// last, and the per-item parse — dozens of names, tiers and levels off one
// image — was wrong often enough that the number it produced couldn't be
// trusted without opening the screenshot anyway. So the screenshot is now the
// whole point of this path: it is kept as evidence, and the Equipment Level
// popup is the single thing that sets a gear level.
//
// The parse columns on gear_screenshots (items/weapon/armor/accessory/average/
// excluded_count) are left in place for rows written before this change, and
// are explicitly cleared on re-upload — see submitWindow.

// Read a screenshot and return { weapon, armor, accessory, average }. weapon/
// armor/accessory are each read directly off the window's "Max ___ Lv." line;
// average is its "Equipment Lv." line — the game itself defines that as the
// mean of the other three, so there's no need to recompute it here.
async function parseGearScreenshot(buffer, mimeType) {
  const parsed = await vision.readImages({
    prompt: PROMPT,
    images: [{ buffer, mimeType }],
    schema: RESPONSE_SCHEMA,
    schemaName: 'equipment_level',
    unavailable: 'gear reading',
  });

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

    // A new submission replaces whatever this member had on file before —
    // except maxed_at, which is set once (the first time weapon/armor/
    // accessory all hit MAX_LEVEL) and then left alone on every later
    // resubmission, so members at the cap keep the order they actually
    // achieved it in rather than being reshuffled by later screenshots.
    // The Equipment Level popup is now the ONLY caller — the equipment-window
    // upload stopped writing gear levels. `source` stays because rows written
    // before that change are still marked 'window', and they were measured by a
    // different rule (Heroic excluded); the leaderboard would otherwise compare
    // them as if they weren't. Nothing writes 'window' any more.
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
    // Store the image. That is the entire job — nothing here reads the picture,
    // and nothing here touches the member's gear level.
    //
    // Ordering is deliberate: the image goes up FIRST, and a failure there
    // aborts before the row is written, so no row ever claims to be backed by a
    // screenshot that isn't in the bucket.
    async submitWindow(discordId, displayName, buffer, mimeType) {
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
        submitted_at: new Date().toISOString(),
        // Cleared, not omitted. An upsert leaves columns it doesn't mention
        // alone on the conflict branch, so a member who uploaded back when this
        // path still parsed would keep the OLD parse sitting beside their NEW
        // image — numbers describing a screenshot that is no longer there.
        items: [],
        weapon: null,
        armor: null,
        accessory: null,
        average: null,
        excluded_count: 0,
      }, { onConflict: 'discord_id' });
      if (error) {
        console.error('gear_screenshots upsert failed:', error.message);
        throw new Error('Could not save that screenshot.');
      }

      return { storagePath };
    },

    // The stored screenshot row plus a short-lived signed URL for the image.
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
      // A missing file still returns the row — when it was submitted is worth
      // knowing, and a null image_url is what tells the page to say so.
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
