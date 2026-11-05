// backend/admin/names.js — Name reconciliation: enemy guild and enemy player aliases, and our own player identities.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const crypto = require('crypto');
const guildConfig = require('../guildConfig');
const { listMembers } = require('../discord');
const { norm } = require('./helpers');

// Levenshtein edit distance — used to suggest the closest known player for an
// unmapped (likely OCR-misread) name.
function lev(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

// Same shape loa.js and eventSignups.js use, so a validation failure carries
// its own status instead of every caller inventing one. Routes here mostly
// return res.status(...) inline; this is for the handful with real validation
// worth doing in a helper.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = function registerNames(router, ctx) {
  const { supabase, identities } = ctx;

  // ── Enemy guild aliases ─────────────────────────────────────────────────────
  // The same job the Names page does for players — reconcile an OCR-misread
  // name to the right thing — applied to enemy guilds, which is why it takes
  // the 'names' capability rather than a new key nobody has been granted.
  //
  // Whitespace is collapsed by the SQL already, so a row here is only ever
  // needed for a genuine misread ("HighIy Regarded") or a rebrand.
  const normaliseGuild = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

  // The two rules that keep the enemy list from corrupting the guild's own
  // record, checked here where the error message can explain them.
  async function assertEnemyAliasSafe(alias, canonical) {
    // 1. Neither side may name US. guild_config.aliases is the list of names
    //    the guild has gone by, and every reader of it treats a match as us —
    //    so an entry here pointing at one of our names would either fold a
    //    rival's matches into our record or push ours out of it. Preventing
    //    exactly that is why the two lists are separate tables.
    const ours = new Set(Object.keys(guildConfig.aliasMap()).map(normaliseGuild));
    if (ours.has(alias)) {
      throw httpError(400, `"${alias}" is one of this guild's own names — enemy aliases can't point at us.`);
    }
    if (ours.has(canonical)) {
      throw httpError(400, `"${canonical}" is one of this guild's own names. To record a name we used to go by, add it to the aliases in Guild Settings instead.`);
    }

    // 2. No chains. If the target is itself an alias, the result would depend
    //    on which join ran first, so A→B→C is refused rather than flattened.
    const { data: chain } = await supabase.from('enemy_guild_aliases')
      .select('canonical').eq('alias', canonical).maybeSingle();
    if (chain) {
      throw httpError(400, `"${canonical}" is already mapped to "${chain.canonical}". Point this one there instead.`);
    }
  }

  router.get('/enemy-guilds', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const p_guild_names = Object.keys(guildConfig.aliasMap());
      const [{ data: aliases, error: aErr }, feuds] = await Promise.all([
        supabase.from('enemy_guild_aliases').select('*').order('canonical').order('alias'),
        supabase.rpc('get_guild_feuds', { p_guild_names }),
      ]);
      if (aErr) throw aErr;
      if (feuds.error) throw feuds.error;

      // Suggestions use the same Levenshtein helper and the same length-scaled
      // threshold as /unmapped-names, so the two merge tools behave alike. It
      // only ever SUGGESTS — auto-merging on edit distance would eventually
      // fold two genuinely different guilds together with nothing saying so.
      const names = (feuds.data || []).map((f) => f.enemy_guild);
      const suggestions = [];
      names.forEach((a, i) => {
        names.slice(i + 1).forEach((b) => {
          const d = lev(norm(a), norm(b));
          const threshold = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.25));
          if (d > 0 && d <= threshold) {
            const [from, to] = (feuds.data.find((f) => f.enemy_guild === a).met
              <= feuds.data.find((f) => f.enemy_guild === b).met) ? [a, b] : [b, a];
            // Merge the rarer spelling INTO the commoner one — the one seen
            // more often is far likelier to be the correct reading.
            suggestions.push({ alias: from, canonical: to, distance: d });
          }
        });
      });

      res.json({ aliases: aliases || [], guilds: feuds.data || [], suggestions });
    } catch (err) {
      console.error('Enemy guilds error:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Failed to load enemy guilds.' });
    }
  });

  router.post('/enemy-guilds', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const alias = normaliseGuild(req.body?.alias);
    const canonical = normaliseGuild(req.body?.canonical);
    try {
      if (!alias || !canonical) throw httpError(400, 'Both names are required.');
      if (alias === canonical) throw httpError(400, 'That maps a name to itself.');
      await assertEnemyAliasSafe(alias, canonical);

      const { error } = await supabase.from('enemy_guild_aliases').upsert({
        alias, canonical, created_by: req.user.username || req.user.id, created_at: new Date().toISOString(),
      }, { onConflict: 'alias' });
      if (error) throw error;

      // Flatten, rather than refuse. A guild that renames twice is the normal
      // case: A→B is recorded, then B renames to C. Left alone that leaves
      // A→B and B→C, and the lookup is a single join — so A would resolve to
      // B, a name nothing else uses, and its matches would split off on their
      // own again.
      //
      // Re-pointing every alias that named B at C keeps the table one level
      // deep by construction, which is what makes the single join correct.
      const { data: repointed, error: rErr } = await supabase.from('enemy_guild_aliases')
        .update({ canonical })
        .eq('canonical', alias)
        .select('alias');
      if (rErr) console.error('Enemy alias re-point failed:', rErr.message);

      res.json({ ok: true, alias, canonical, repointed: (repointed || []).map((r) => r.alias) });
    } catch (err) {
      console.error('Enemy guild merge error:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Failed to save that merge.' });
    }
  });

  router.delete('/enemy-guilds/:alias', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('enemy_guild_aliases')
      .delete().eq('alias', normaliseGuild(decodeURIComponent(req.params.alias)));
    if (error) return res.status(500).json({ error: 'Failed to undo that merge.' });
    res.json({ ok: true });
  });

  // ── Enemy player aliases ────────────────────────────────────────────────────
  // The same job one level down from enemy guilds: OCR turns one person into
  // three rows of a roster, each with a third of their matches — which also
  // puts all three under the standout floor, so the misread hides exactly the
  // player it fragments.
  //
  // Its own table rather than player_identities: that one maps names to OUR
  // members and their Discord ids, and every reader treats a name in it as
  // somebody in this guild. Same call as enemy_guild_aliases in 019.
  async function assertEnemyPlayerSafe(alias, canonical) {
    // CURRENT members only. Someone who left and now plays for a rival is
    // exactly the case this table is for — their old name genuinely belongs to
    // an enemy player now, and refusing it would leave them fragmented on every
    // roster they appear on.
    //
    // "Current" is membership of the Discord guild, not merely having an
    // identity row: those are never deleted (deliberately — they keep old match
    // rows readable), so an identity alone says "we knew this name once", which
    // is not a reason to block anything.
    const ids = await identities.load();
    const hits = [alias, canonical].map((n) => ids.identityForName(n)).filter(Boolean);

    if (hits.length) {
      let current;
      try {
        current = new Set((await listMembers()).map((m) => String(m.id)));
      } catch (err) {
        // Fail closed, and say so. The same call assertAliasesSafe makes when
        // it can't check the war record: refusing a merge that might be wrong
        // beats making one nobody verified, and this is transient.
        console.error('enemy player guard: member list unavailable:', err.message);
        throw httpError(503, "Couldn't check the member list just now, so nothing was merged. Try again in a moment.");
      }

      // No discord_id means nobody is attached to that name — it can't be a
      // current member however it got into the identities table.
      const isCurrent = (it) => Boolean(it?.discord_id) && current.has(String(it.discord_id));

      const aliasHit = ids.identityForName(alias);
      if (isCurrent(aliasHit)) {
        throw httpError(400, `"${alias}" belongs to ${aliasHit.display_name}, who is in the guild. Merge it on the Names page instead.`);
      }
      const canonHit = ids.identityForName(canonical);
      if (isCurrent(canonHit)) {
        throw httpError(400, `"${canonical}" belongs to ${canonHit.display_name}, who is in the guild — enemy aliases can't point at a current member.`);
      }
    }

    // No chains. A→B, B→C would make the result depend on join order, and the
    // lookup is a single join.
    const { data: chain } = await supabase.from('enemy_player_aliases')
      .select('canonical').ilike('alias', canonical).maybeSingle();
    if (chain) {
      throw httpError(400, `"${canonical}" is already mapped to "${chain.canonical}". Point this one there instead.`);
    }
  }

  router.get('/enemy-players', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const enemy = String(req.query.guild || '').trim();
      if (!enemy) throw httpError(400, 'Which guild?');

      const [{ data: aliases, error: aErr }, roster] = await Promise.all([
        supabase.from('enemy_player_aliases').select('*').order('canonical').order('alias'),
        supabase.rpc('get_guild_feud_roster', {
          p_guild_names: Object.keys(guildConfig.aliasMap()),
          p_enemy: enemy,
        }),
      ]);
      if (aErr) throw aErr;
      if (roster.error) throw roster.error;

      // Appearances per already-resolved name, so the commoner spelling is the
      // one a suggestion merges INTO.
      const seen = new Map();
      (roster.data || []).forEach((r) => {
        seen.set(r.player_name, (seen.get(r.player_name) || 0) + (Number(r.appearances) || 0));
      });
      const names = [...seen.keys()];

      // Scoped to ONE guild's roster, deliberately. Across the whole record,
      // two unrelated players in different guilds with similar names would be
      // proposed constantly; within a guild, a near-match is nearly always the
      // same person read twice.
      const suggestions = [];
      names.forEach((a, i) => {
        names.slice(i + 1).forEach((b) => {
          const d = lev(norm(a), norm(b));
          const threshold = Math.max(1, Math.floor(Math.min(a.length, b.length) * 0.25));
          if (d > 0 && d <= threshold) {
            const [from, to] = seen.get(a) <= seen.get(b) ? [a, b] : [b, a];
            suggestions.push({ alias: from, canonical: to, distance: d });
          }
        });
      });

      res.json({
        guild: enemy,
        aliases: aliases || [],
        players: names.map((n) => ({ player_name: n, appearances: seen.get(n) })),
        suggestions,
      });
    } catch (err) {
      console.error('Enemy players error:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Failed to load enemy players.' });
    }
  });

  router.post('/enemy-players', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const alias = normaliseGuild(req.body?.alias);
    const canonical = normaliseGuild(req.body?.canonical);
    try {
      if (!alias || !canonical) throw httpError(400, 'Both names are required.');
      if (alias.toLowerCase() === canonical.toLowerCase()) throw httpError(400, 'That maps a name to itself.');
      await assertEnemyPlayerSafe(alias, canonical);

      const { error } = await supabase.from('enemy_player_aliases').upsert({
        alias, canonical, created_by: req.user.username || req.user.id, created_at: new Date().toISOString(),
      }, { onConflict: 'alias' });
      if (error) throw error;

      // Flatten rather than refuse, as with guild renames: if others already
      // pointed at this alias, re-point them at the new target so the table
      // stays one level deep — which is what makes the single join correct.
      const { data: repointed, error: rErr } = await supabase.from('enemy_player_aliases')
        .update({ canonical }).ilike('canonical', alias).select('alias');
      if (rErr) console.error('Enemy player re-point failed:', rErr.message);

      res.json({ ok: true, alias, canonical, repointed: (repointed || []).map((r) => r.alias) });
    } catch (err) {
      console.error('Enemy player merge error:', err.message);
      res.status(err.status || 500).json({ error: err.message || 'Failed to save that merge.' });
    }
  });

  router.delete('/enemy-players/:alias', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('enemy_player_aliases')
      .delete().ilike('alias', normaliseGuild(decodeURIComponent(req.params.alias)));
    if (error) return res.status(500).json({ error: 'Failed to undo that merge.' });
    res.json({ ok: true });
  });

  // ── Player identities / name merging ────────────────────────────────────────
  router.get('/identities', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data, error } = await supabase.from('player_identities')
      .select('id, display_name, ingame_names, discord_id').order('display_name');
    if (error) return res.status(500).json({ error: 'Failed to load identities.' });
    res.json({ identities: data || [] });
  });

  // In-game names from match data that aren't yet mapped to any identity.
  //
  // The alias list is passed in, never assumed by the function — see 023. The
  // zero-argument version this replaced had our guild names hardcoded, so a
  // rename made every player since invisible to the Unmapped list.
  router.get('/unmapped-names', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    try {
      const [counts, ids] = await Promise.all([
        supabase.rpc('get_guild_player_counts', { p_guild_names: Object.keys(guildConfig.aliasMap()) }),
        identities.load(),
      ]);
      if (counts.error) throw counts.error;
      const identityRows = ids.rows;

      const unmapped = (counts.data || [])
        .filter((c) => !ids.identityForName(c.player_name))
        .map((c) => {
          let best = null;
          identityRows.forEach((it) => {
            [it.display_name, ...(Array.isArray(it.ingame_names) ? it.ingame_names : [])]
              .filter(Boolean)
              .forEach((cand) => {
                const d = lev(norm(c.player_name), norm(cand));
                if (best === null || d < best.distance) best = { id: it.id, display_name: it.display_name, distance: d };
              });
          });
          const threshold = Math.max(2, Math.floor((c.player_name || '').length * 0.34));
          return { name: c.player_name, matches: c.matches, suggestion: best && best.distance <= threshold ? best : null };
        })
        .sort((a, b) => b.matches - a.matches);

      res.json({ unmapped, identities: identityRows });
    } catch (err) {
      console.error('Unmapped names error:', err.message);
      res.status(500).json({ error: 'Failed to load unmapped names.' });
    }
  });

  // Attach an in-game name to an existing identity.
  router.post('/identities/:id/aliases', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Name required.' });
    const { data: it, error: gErr } = await supabase
      .from('player_identities').select('ingame_names').eq('id', req.params.id).single();
    if (gErr) return res.status(404).json({ error: 'Identity not found.' });
    const arr = Array.isArray(it.ingame_names) ? it.ingame_names : [];
    if (!arr.some((n) => norm(n) === norm(name))) arr.push(name);
    const { error } = await supabase.from('player_identities')
      .update({ ingame_names: arr, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to add alias.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Remove an in-game name from an identity (un-merge a mistake).
  router.delete('/identities/:id/aliases', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name } = req.body || {};
    const { data: it, error: gErr } = await supabase
      .from('player_identities').select('ingame_names').eq('id', req.params.id).single();
    if (gErr) return res.status(404).json({ error: 'Identity not found.' });
    const arr = (Array.isArray(it.ingame_names) ? it.ingame_names : []).filter((n) => norm(n) !== norm(name));
    const { error } = await supabase.from('player_identities')
      .update({ ingame_names: arr, updated_at: new Date().toISOString() }).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to remove alias.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Link a Discord ID to an identity.
  router.put('/identities/:id/discord', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { discord_id } = req.body || {};
    const { error } = await supabase.from('player_identities')
      .update({ discord_id: discord_id || null, updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to link Discord account.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Rename an identity's display name.
  router.put('/identities/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { display_name } = req.body || {};
    if (!display_name || !display_name.trim()) return res.status(400).json({ error: 'Display name required.' });
    const { error } = await supabase.from('player_identities')
      .update({ display_name: String(display_name).trim().slice(0, 120), updated_at: new Date().toISOString() })
      .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to rename identity.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Delete an identity entirely (its in-game names fall back to unmapped).
  router.delete('/identities/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('player_identities').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete identity.' });
    identities.invalidate();
    res.json({ ok: true });
  });

  // Create a new identity (optionally seeded with a first in-game name).
  router.post('/identities', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { display_name, ingame_names } = req.body || {};
    if (!display_name) return res.status(400).json({ error: 'Display name required.' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const aliases = Array.isArray(ingame_names) ? ingame_names : ingame_names ? [ingame_names] : [];
    const { error } = await supabase.from('player_identities')
      .insert({ id, display_name: String(display_name).slice(0, 120), ingame_names: aliases, created_at: now, updated_at: now });
    if (error) return res.status(500).json({ error: 'Failed to create identity.' });
    identities.invalidate();
    res.json({ id });
  });
};
