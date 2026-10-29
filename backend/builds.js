// backend/builds.js — members' PvE and PvP stat builds.
//
// A build is the character stats window, read out of seven screenshots by the
// vision model (see vision.js) and stored as { stat_id: number }. Each member
// has at most one PvE and one PvP build; a new scan replaces the old one and the
// difference goes into build_history, which is what "Last updated" reads.
//
// The stat list itself lives in shared/buildStats.json, shared with the page,
// so the prompt, the validation here and the layout there can't disagree about
// which stats exist or what unit they're in.
const STATS = require('../shared/buildStats.json');
const WEAPON_CLASSES = require('../shared/weaponClasses.json');
const EXTRA_CLASSES = require('../shared/extraClasses.json');
const vision = require('./vision');

const KINDS = ['pve', 'pvp'];
// The class a build is for, picked by the member — the same list the Classes
// page offers, so a build and a member's class picks use one vocabulary.
const CLASSES = new Set([...Object.values(WEAPON_CLASSES), ...EXTRA_CLASSES]);
const BY_ID = Object.fromEntries(STATS.map((s) => [s.id, s]));
// A history row keeps at most this many changes. A full rescan touches ~110
// stats; anything past that is a malformed request, not a build.
const MAX_CHANGES = 200;
const MAX_FLAG_CHARS = 200;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const isKind = (k) => KINDS.includes(k);

// Six decimal places is beyond anything the game prints (two at most) and
// keeps float noise like 0.30000000000000004 out of stored builds and diffs.
const round = (n) => Math.round(n * 1e6) / 1e6;

// Known stats with finite numbers, nothing else. Unknown ids are dropped rather
// than refused: a page built against an older stat list shouldn't fail to save.
function cleanStats(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [id, raw] of Object.entries(input)) {
    if (!BY_ID[id]) continue;
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, ''));
    if (Number.isFinite(n)) out[id] = round(n);
  }
  return out;
}

// Flags only for stats the build actually has, as short strings.
function cleanFlags(input, stats) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [id, note] of Object.entries(input)) {
    if (id in stats && typeof note === 'string' && note.trim()) out[id] = note.trim().slice(0, MAX_FLAG_CHARS);
  }
  return out;
}

// [{ id, from, to }] in catalog order, null on whichever side is missing.
function diffStats(before = {}, after = {}) {
  const changes = [];
  for (const { id } of STATS) {
    const a = id in before ? before[id] : null;
    const b = id in after ? after[id] : null;
    if (a !== b) changes.push({ id, from: a, to: b });
  }
  return changes;
}

const sameFlags = (a = {}, b = {}) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

// ── READING SCREENSHOTS ─────────────────────────────────────────────────────
const PANEL_TITLES = {
  weapon: 'Weapons panel (under "Main")',
  combat: 'Defense / Attack / Protection panels (the combat stats, scrolled across two screenshots)',
  status: 'Status effects tab (Chance on the left, Resistance on the right)',
  basic: 'Basic tab (health, mana, healing, cooldown…)',
  boss: 'Boss tab',
  pvp: 'PvP tab',
};

const UNIT_NOTE = { '%': ' (percent)', s: ' (seconds)', m: ' (metres)' };

function buildPrompt() {
  const lines = Object.entries(PANEL_TITLES).map(([panel, title]) => {
    const rows = STATS.filter((s) => s.panel === panel)
      .map((s) => `  - ${s.id}: "${s.label}"${UNIT_NOTE[s.unit] || ''}`);
    return `${title}:\n${rows.join('\n')}`;
  });
  return [
    'These screenshots are the character stats window from the game Throne and Liberty, taken one tab or scroll position at a time.',
    'Report every stat you can read, using the ids listed below. Leave out any stat that is not visible. Never guess a value.',
    '',
    'How to read values:',
    '- Give the number exactly as shown, as a plain number: drop thousands separators, a leading "+", and the "%", "s" or "m" unit. "2,123.4" is 2123.4, "+96.5%" is 96.5, "0.392s" is 0.392, "19.15m" is 19.15.',
    '- Keep minus signs: "-31.81%" is -31.81.',
    '- "Base Damage 386 ~ 732" in the Weapons panel is two stats: min_damage 386 and max_damage 732.',
    '- Two stats share the name "Attack Speed": the Weapons panel one is in seconds (attack_interval_main_hand); the Basic tab one is a "+%" bonus (attack_speed_modifier).',
    '- Two stats share the name "Range": the Weapons panel one is in metres (attack_range_main_hand); the Basic tab one is a "+%" bonus (attack_range_modifier).',
    '- Labels are often cut off at a panel edge ("Boss Ranged Heavy Attack Chanc", "\'argeted Skill Healing over Time"). Match them to the closest label in the same panel.',
    '- Ignore icons next to labels, such as an arrow after "PvP Damage".',
    '- The combat panel screenshots overlap: a row at the bottom of one can reappear at the top of the next. Report each stat once.',
    '- Set unsure to true when the number itself is partly cut off, blurry, or could be a misread digit or sign. Otherwise false.',
    '',
    'Stat ids by where they appear:',
    ...lines,
  ].join('\n');
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stats'],
  properties: {
    stats: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'value', 'unsure'],
        properties: {
          id: { type: 'string', enum: STATS.map((s) => s.id) },
          value: { type: 'number' },
          unsure: { type: 'boolean' },
        },
      },
    },
  },
};

// The model's rows → { stats, flags, missing }. Pure, so the checks are tested
// without a model: duplicates that disagree, negatives where the game never
// shows one, and the reader's own "unsure".
function interpretReading(rows) {
  const stats = {};
  const flags = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const def = BY_ID[row?.id];
    const value = Number(row?.value);
    if (!def || !Number.isFinite(value)) continue;
    const v = round(value);
    if (row.id in stats) {
      // The overlap between the two combat screenshots is the usual way to see
      // a stat twice. Agreeing is fine; disagreeing means one is misread.
      if (stats[row.id] !== v) flags[row.id] = `Read as ${stats[row.id]} and ${v} in different screenshots. Check in game.`;
      continue;
    }
    stats[row.id] = v;
    if (v < 0 && !def.signed) flags[row.id] = `Read as ${v}, but this stat isn't normally negative. Check in game.`;
    else if (row.unsure) flags[row.id] = 'The reader wasn\'t sure about this one. Check in game.';
  }
  const missing = STATS.filter((s) => !(s.id in stats)).map((s) => s.id);
  return { stats, flags, missing };
}

module.exports = function createBuilds(supabase, identities = null) {
  const nameFor = async (discordId, fallback) => {
    if (!identities) return fallback || null;
    const ids = await identities.load();
    return ids.displayNameFor(discordId, fallback) || fallback || null;
  };

  return {
    // Reads the screenshots. Saves nothing: the member reviews and corrects
    // the numbers first, and only then does save() store them.
    async scan(images) {
      if (!images.length) throw httpError(400, 'Add your stats screenshots.');
      const parsed = await vision.readImages({
        prompt: buildPrompt(),
        images,
        schema: SCHEMA,
        schemaName: 'character_stats',
        unavailable: 'build reading',
      });
      const result = interpretReading(parsed?.stats);
      if (!Object.keys(result.stats).length) {
        throw httpError(422, 'No stats could be read from those screenshots. Make sure they show the character stats window.');
      }
      return result;
    },

    // Everyone's builds, one entry per member who has at least one.
    async list() {
      const { data, error } = await supabase.from('builds')
        .select('discord_id, kind, display_name, class, updated_at');
      if (error) { console.error('builds.list error:', error.message); throw httpError(500, 'Failed to load builds.'); }
      const byMember = new Map();
      for (const r of data || []) {
        if (!byMember.has(r.discord_id)) {
          byMember.set(r.discord_id, { discord_id: r.discord_id, display_name: r.display_name, pve: null, pvp: null, classes: { pve: null, pvp: null } });
        }
        const m = byMember.get(r.discord_id);
        m[r.kind] = r.updated_at;
        m.classes[r.kind] = r.class || null;
      }
      const out = [...byMember.values()];
      if (identities) {
        const ids = await identities.load();
        out.forEach((m) => { m.display_name = ids.displayNameFor(m.discord_id, m.display_name); });
      }
      return out;
    },

    // One member's builds and the recent history of each.
    async forMember(discordId) {
      const [{ data: rows, error }, { data: hist, error: hErr }] = await Promise.all([
        supabase.from('builds').select('*').eq('discord_id', discordId),
        supabase.from('build_history').select('*').eq('discord_id', discordId)
          .order('changed_at', { ascending: false }).limit(60),
      ]);
      if (error || hErr) {
        console.error('builds.forMember error:', (error || hErr).message);
        throw httpError(500, 'Failed to load builds.');
      }
      const builds = { pve: null, pvp: null };
      const history = { pve: [], pvp: [] };
      // Key stats lose any id the stat list no longer has, so a retired stat
      // can't leave an empty card pinned.
      (rows || []).forEach((r) => { builds[r.kind] = { ...r, key_stats: (r.key_stats || []).filter((id) => BY_ID[id]) }; });
      (hist || []).forEach((h) => { if (history[h.kind].length < 30) history[h.kind].push(h); });
      const fallback = rows?.[0]?.display_name || null;
      return { display_name: await nameFor(discordId, fallback), builds, history };
    },

    // Stores a build and records what changed. `how` is 'scan' or 'edit' from
    // the caller; the first build of a kind is always recorded as 'upload'.
    // Returns { build, changed } — a save that changes nothing writes nothing.
    // Every save names the class, so a build from before classes picks one up
    // the next time anyone touches it.
    async save({ discordId, displayName, kind, buildClass, stats, flags, how, actor }) {
      if (!isKind(kind)) throw httpError(400, 'Build type must be "pve" or "pvp".');
      if (!['scan', 'edit'].includes(how)) throw httpError(400, 'Unknown kind of update.');
      if (!buildClass) throw httpError(400, 'Pick the class this build is for.');
      if (!CLASSES.has(buildClass)) throw httpError(400, 'Unknown class.');
      const cleanS = cleanStats(stats);
      if (!Object.keys(cleanS).length) throw httpError(400, 'A build needs at least one stat.');
      const cleanF = cleanFlags(flags, cleanS);

      const { data: existing, error: readErr } = await supabase.from('builds')
        .select('*').eq('discord_id', discordId).eq('kind', kind).maybeSingle();
      if (readErr) { console.error('builds.save read error:', readErr.message); throw httpError(500, 'Failed to save build.'); }

      const changes = diffStats(existing?.stats || {}, cleanS);
      if (existing && !changes.length && sameFlags(existing.flags || {}, cleanF) && existing.class === buildClass) {
        return { build: existing, changed: false };
      }

      const now = new Date().toISOString();
      const name = await nameFor(discordId, displayName || existing?.display_name);
      const row = {
        discord_id: discordId,
        kind,
        display_name: name ? String(name).slice(0, 120) : null,
        class: buildClass,
        stats: cleanS,
        flags: cleanF,
        updated_at: now,
        updated_by: actor?.id || null,
      };
      const { error } = await supabase.from('builds').upsert(row, { onConflict: 'discord_id,kind' });
      if (error) { console.error('builds.save error:', error.message); throw httpError(500, 'Failed to save build.'); }

      // Only when a number moved. Clearing a flag alone ("yes, that's right")
      // or relabelling the class updates the build but isn't a change anyone
      // needs in the stat history.
      if (changes.length) {
        const first = !existing;
        const { error: hErr } = await supabase.from('build_history').insert({
          discord_id: discordId,
          kind,
          how: first ? 'upload' : how,
          changes: first ? [] : changes.slice(0, MAX_CHANGES),
          changed_count: changes.length,
          changed_by: actor?.id || null,
          changed_by_name: actor?.name ? String(actor.name).slice(0, 120) : null,
          changed_at: now,
        });
        // The build is saved; a lost history row costs the list one line, not
        // the member their build.
        if (hErr) console.error('builds.save history error:', hErr.message);
      }
      return { build: row, changed: true };
    },

    // One build's whole ordered key stats list, replacing the last one. Order
    // is the officers' drag order and is kept exactly; duplicates and unknown
    // ids are dropped. Lives on the build row, so there's nothing to pin to
    // until the build exists. Doesn't touch updated_at: that's when the
    // numbers last changed, which pinning one of them doesn't.
    async setKeyStats(discordId, kind, statIds) {
      if (!isKind(kind)) throw httpError(400, 'Build type must be "pve" or "pvp".');
      if (!Array.isArray(statIds)) throw httpError(400, 'stat_ids must be a list.');
      const clean = [...new Set(statIds.filter((id) => BY_ID[id]))].slice(0, STATS.length);
      const { data, error } = await supabase.from('builds').update({ key_stats: clean })
        .eq('discord_id', discordId).eq('kind', kind).select('discord_id');
      if (error) { console.error('builds.setKeyStats error:', error.message); throw httpError(500, 'Failed to save key stats.'); }
      if (!data?.length) throw httpError(404, 'There\'s no build of that type to pin stats on yet.');
      return clean;
    },
  };
};

module.exports.KINDS = KINDS;
module.exports.CLASSES = CLASSES;
module.exports.cleanStats = cleanStats;
module.exports.cleanFlags = cleanFlags;
module.exports.diffStats = diffStats;
module.exports.interpretReading = interpretReading;
module.exports.buildPrompt = buildPrompt;
module.exports.SCHEMA = SCHEMA;
