// backend/admin/warRecord.js — Match ingest (parse, review, commit, edit, delete) and wargame maps.
// Registered onto the one admin router by ../admin.js; access is gated by
// route prefix in ../permissions.js, not by which file a route lives in.
const crypto = require('crypto');
const { parseScreenshot, parseCsv, WEAPONS } = require('../ingest');
const { upload, clean } = require('./helpers');

// Merge parsed rows from one or more screenshots/CSVs into a single reviewed set:
// de-duplicate by player name (fallback rank), sort by rank, and recompute the
// data-quality warnings. Shared by the batch and per-file parse paths.
function mergePlayers(all, fileCount) {
  const warnings = [];
  const seen = new Map();
  let duplicates = 0;
  for (const p of all) {
    const key = p.player_name ? `n:${p.player_name.toLowerCase()}` : `r:${p.rank}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.set(key, p);
  }
  const players = [...seen.values()].sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
  if (fileCount > 1) warnings.unshift(`Merged ${fileCount} files into ${players.length} players${duplicates ? `, ${duplicates} duplicate row(s) removed` : ''}.`);
  if (players.length === 0) {
    warnings.push('No player rows were detected — check the files and try again.');
  } else {
    const missingTeam = players.filter((p) => !p.team_color).length;
    if (missingTeam) warnings.push(`${missingTeam} row(s) have no team color set.`);
    const badWeapon = players.filter((p) => !WEAPONS.includes(p.weapon_1) || !WEAPONS.includes(p.weapon_2)).length;
    if (badWeapon) warnings.push(`${badWeapon} row(s) have a class to confirm.`);
  }
  return { players, warnings };
}

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(String(v).replace(/[, ]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

const team = (v) => {
  const s = String(v || '').trim().toLowerCase();
  if (s.startsWith('r')) return 'Red';
  if (s.startsWith('y')) return 'Yellow';
  return null;
};

module.exports = function registerWarRecord(router, ctx) {
  const { supabase } = ctx;

  // ── Parse a SINGLE upload (per-file, so the UI can show progress + retry) ────
  router.post('/match/parse-one', upload.single('file'), async (req, res) => {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No file uploaded.' });
    try {
      let players = [];
      if (f.mimetype.startsWith('image/')) {
        players = (await parseScreenshot(f.buffer, f.mimetype)).players;
      } else if (f.mimetype === 'text/csv' || /\.csv$/i.test(f.originalname)) {
        players = parseCsv(f.buffer.toString('utf8')).players;
      } else {
        return res.status(415).json({ error: 'Unsupported file type.' });
      }
      res.json({ players: players || [] });
    } catch (err) {
      const msg = err.message || 'Could not read that file.';
      console.error('Parse-one error:', msg);
      const busy = /overload|rate.?limit|429|503|busy|unavailable|timeout|temporar/i.test(msg);
      res.status(busy ? 503 : 502).json({ error: busy ? `The reader is busy — ${msg}` : msg, retryable: busy });
    }
  });

  // ── Merge already-parsed rows into the reviewed set ─────────────────────────
  router.post('/match/merge', (req, res) => {
    const all = Array.isArray(req.body?.players) ? req.body.players : [];
    const fileCount = Number(req.body?.fileCount) || 0;
    res.json(mergePlayers(all, fileCount));
  });

  // ── Parse one or more uploads into merged draft rows (batch; no DB writes) ──
  router.post('/match/parse', upload.array('files', 20), async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });

    const results = await Promise.all(files.map(async (f) => {
      try {
        if (f.mimetype.startsWith('image/')) return { players: (await parseScreenshot(f.buffer, f.mimetype)).players };
        if (f.mimetype === 'text/csv' || /\.csv$/i.test(f.originalname)) return { players: parseCsv(f.buffer.toString('utf8')).players };
        return { players: [], error: `${f.originalname}: unsupported type, skipped.` };
      } catch (err) {
        return { players: [], error: `${f.originalname}: ${err.message}` };
      }
    }));

    const fileWarnings = [];
    const all = [];
    for (const r of results) { if (r.error) fileWarnings.push(r.error); all.push(...r.players); }
    const merged = mergePlayers(all, files.length);
    res.json({ players: merged.players, warnings: [...fileWarnings, ...merged.warnings] });
  });

  // Shape one reviewed player row for the save_match RPC. The SQL function
  // stamps ids/created_at itself, so only the stat fields travel.
  const playerRow = (p) => ({
    rank: toInt(p.rank),
    weapon_1: clean(p.weapon_1),
    weapon_2: clean(p.weapon_2),
    guild_name: clean(p.guild_name),
    player_name: clean(p.player_name),
    team_color: team(p.team_color),
    kills: toInt(p.kills),
    assists: toInt(p.assists),
    damage_dealt: toInt(p.damage_dealt),
    damage_taken: toInt(p.damage_taken),
    healing: toInt(p.healing),
  });

  // Create-or-replace a match and all its player rows in ONE transaction via
  // the save_match Postgres function (see migrations/001_atomic_match_save.sql).
  // A failure anywhere rolls back everything — no orphan matches, no lost rows.
  async function saveMatch(matchId, { title, match_date, result, map, players }) {
    const { data, error } = await supabase.rpc('save_match', {
      p_id: matchId,
      p_title: clean(title) || 'Wargame',
      p_match_date: clean(match_date),
      p_result: clean(result),
      p_map: clean(map),
      p_players: players.map(playerRow),
    });
    if (error) {
      // Most likely cause on first deploy: the migration hasn't been run yet.
      if (/function .*save_match.* does not exist/i.test(error.message)) {
        throw new Error('save_match() is missing — run migrations/001_atomic_match_save.sql in Supabase.');
      }
      throw new Error(error.message);
    }
    return data; // number of player rows written
  }

  // Notes ride on a separate UPDATE because save_match()'s body isn't in this
  // repo to extend (see migrations/06_war_record.sql). Runs only after the
  // match is saved, so a failure here must not read as a failed save — the
  // officer would upload it again and the war record would hold it twice.
  // Returns an error message for the response, or null.
  async function saveNotes(matchId, notes) {
    const value = typeof notes === 'string' && notes.trim() ? notes.trim() : null;
    const { error } = await supabase.from('wargame_matches').update({ notes: value }).eq('id', matchId);
    if (!error) return null;
    // Column missing = 026 not run. Nothing to lose when there was no note.
    const missing = error.code === 'PGRST204' || error.code === '42703' || /column .*notes/i.test(error.message);
    if (missing && value === null) return null;
    console.error('Match notes error:', error.code, error.message);
    return missing
      ? 'The match was saved, but its notes were not — migration 026 (match notes) needs to be applied.'
      : 'The match was saved, but its notes were not. Edit the match to try again.';
  }

  // ── Commit reviewed rows: create match + insert players (atomic) ────────────
  router.post('/match/commit', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const { players } = req.body || {};
    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'No players to save.' });
    }

    const matchId = crypto.randomUUID();
    try {
      const inserted = await saveMatch(matchId, req.body);
      const notes_error = await saveNotes(matchId, req.body.notes);
      res.json({ match_id: matchId, inserted, notes_error });
    } catch (err) {
      console.error('Match commit error:', err.message);
      res.status(500).json({ error: 'Failed to save the match. ' + err.message });
    }
  });

  // ── Load an existing match for editing ───────────────────────────────────────
  router.get('/match/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { data: match, error: mErr } = await supabase
      .from('wargame_matches').select('*').eq('id', req.params.id).single();
    if (mErr) return res.status(404).json({ error: 'Match not found.' });
    const { data: players, error: pErr } = await supabase
      .from('player_match_stats').select('*').eq('match_id', req.params.id)
      .order('rank', { ascending: true });
    if (pErr) return res.status(500).json({ error: 'Failed to load players.' });
    res.json({ match, players: players || [] });
  });

  // ── Update an existing match (metadata + replace all player rows, atomic) ──
  // save_match() is create-or-replace, so a wrong id would silently create a new
  // match — the existence check keeps PUT semantics honest (404 on unknown id).
  router.put('/match/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });

    const { players } = req.body || {};
    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'No players to save.' });
    }

    const matchId = req.params.id;
    const { data: existing, error: chk } = await supabase
      .from('wargame_matches').select('id').eq('id', matchId).single();
    if (chk || !existing) return res.status(404).json({ error: 'Match not found.' });

    try {
      const updated = await saveMatch(matchId, req.body);
      const notes_error = await saveNotes(matchId, req.body.notes);
      res.json({ match_id: matchId, updated, notes_error });
    } catch (err) {
      console.error('Match update error:', err.message);
      res.status(500).json({ error: 'Failed to update the match. ' + err.message });
    }
  });

  // ── Delete a match (player_match_stats rows follow via ON DELETE CASCADE) ───
  // The cascade only holds once migration 005 has run: player_match_stats used
  // to carry a second, non-cascading foreign key on match_id, which blocked
  // every delete here with a 23503. Report that case specifically rather than
  // as a bare 500 — it's a schema problem no amount of retrying will fix.
  router.delete('/match/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('wargame_matches').delete().eq('id', req.params.id);
    if (error) {
      console.error('Match delete error:', error.code, error.message, error.details || '');
      if (error.code === '23503') {
        return res.status(409).json({
          error: 'Player records still reference this match, so it can\'t be deleted. '
            + 'Migration 005 (fix match stats FK) needs to be applied.',
        });
      }
      return res.status(500).json({ error: 'Failed to delete match.', detail: error.message });
    }
    res.json({ ok: true });
  });

  // ── Wargame map management ───────────────────────────────────────────────────
  router.post('/maps', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Map name required.' });
    const { data, error } = await supabase.from('wargame_maps')
      .insert({ name: name.trim().slice(0, 60) }).select('id, name').single();
    if (error) return res.status(409).json({ error: 'That map already exists.' });
    res.json(data);
  });

  router.delete('/maps/:id', async (req, res) => {
    if (!supabase) return res.status(503).json({ error: 'Database not configured.' });
    const { error } = await supabase.from('wargame_maps').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: 'Failed to delete map.' });
    res.json({ ok: true });
  });
};
