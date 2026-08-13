// backend/guildSettings.js — the writable half of guild_config.
//
// Until migrations/014 none of this was writable at all: it was environment
// variables and a JSON file in the repo, so renaming the house or moving a
// channel meant a redeploy. This module is the one place those values can be
// changed from the app, which makes it also the one place the two ways that
// change can go badly have to be handled.
//
// ── WHAT IS DELIBERATELY NOT EDITABLE ───────────────────────────────────────
//   DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID — secrets, still environment.
//   DISCORD_GUILD_ID — which Discord server this hall *is*. Repointing it is
//     not a setting, it is a different installation.
//   guild_config.id — there is one row and it is row 1.
// Only the fields listed in EDITABLE below are ever written, so a column added
// to guild_config later cannot become writable by accident.
const guildConfig = require('./guildConfig');
const { fetchMember, invalidateCaches, botConfigured } = require('./discord');

const SNOWFLAKE = /^\d{17,20}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// The complete write allow-list. Nothing outside this set reaches the update.
const EDITABLE = [
  'house', 'tag', 'aliases', 'motto', 'creed',
  'timezone', 'day_start',
  'admin_role_ids', 'allowed_role_ids', 'member_role_ids',
  'roster_channel_id', 'loa_channel_id', 'announce_channel_id', 'signup_channel_id',
  'attendance_voice_channel_id',
];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const nullable = (v, max) => str(v, max) || null;

function roleList(v, label) {
  const list = (Array.isArray(v) ? v : [])
    .map((x) => String(x ?? '').trim()).filter(Boolean);
  const bad = list.filter((id) => !SNOWFLAKE.test(id));
  if (bad.length) throw httpError(400, `${label}: not Discord role ids — ${bad.join(', ')}`);
  return [...new Set(list)];
}

// Blank is legal and means "this feature posts nowhere" — an LOA channel that
// isn't set simply doesn't announce, which is a real choice.
function channelId(v, label) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!SNOWFLAKE.test(s)) throw httpError(400, `${label}: not a Discord channel id — ${s}`);
  return s;
}

module.exports = function createGuildSettings(supabase) {
  // What the form loads. An explicit projection of EDITABLE rather than the
  // whole row, so a column added later doesn't start arriving in the browser
  // just because it exists.
  function current(row) {
    const out = {};
    EDITABLE.forEach((k) => {
      const v = row[k];
      out[k] = Array.isArray(v) ? v : (v ?? (k.endsWith('_ids') ? [] : null));
    });
    return out;
  }

  // ── GUARD 1: don't let anyone lock the house out of its own hall ──────────
  //
  // admin_role_ids and allowed_role_ids are the gate on the page editing them,
  // and the damage is DELAYED: capabilities live in the signed session cookie
  // and only refresh on the hourly re-verify, so whoever breaks this keeps
  // working for up to an hour and finds out when nobody can sign in — by which
  // point they can't get back in to undo it either. The way back would be the
  // Supabase SQL editor, which is exactly what this page exists to avoid
  // needing.
  //
  // There is no override flag. A confirmation dialog is the wrong shape for a
  // mistake whose consequence arrives an hour later and can't be reversed from
  // inside the app.
  //
  // The actor's roles come from Discord, not the session: the session stores
  // resolved capabilities, not role snowflakes, and Discord is the authority
  // anyway.
  async function assertNotSelfLockout(actorId, next) {
    if (!next.admin_role_ids.length) {
      throw httpError(400, 'At least one officer role is required — clearing them all would leave nobody able to reach this page.');
    }
    if (!botConfigured) {
      throw httpError(503, 'Role changes need the Discord bot to verify your own roles first, and it is not configured.');
    }

    let member = null;
    try {
      ({ member } = await fetchMember(actorId));
    } catch (err) {
      console.error('guildSettings role check failed:', err.message);
    }
    if (!member) {
      // Fail CLOSED. Not being able to prove the actor keeps access is not the
      // same as proving they do, and this is the one write where guessing
      // wrong is unrecoverable from inside the app.
      throw httpError(502, "Couldn't check your own roles with Discord just now — nothing was saved. Try again in a moment.");
    }

    const held = new Set((member.roles || []).map(String));
    if (!next.admin_role_ids.some((r) => held.has(r))) {
      throw httpError(400, 'You must keep at least one officer role that you hold yourself — otherwise this save would lock you out of this page.');
    }
    // Login checks the allow-list BEFORE any capability, so an officer role
    // that isn't also allowed still can't sign in. An EMPTY allow-list means
    // "any member", which locks nobody out.
    if (next.allowed_role_ids.length && !next.allowed_role_ids.some((r) => held.has(r))) {
      throw httpError(400, 'The member allow-list must include a role you hold, or you would not be able to sign in again.');
    }
  }

  // ── GUARD 2: aliases are append-only in practice ──────────────────────────
  //
  // Match rows record whatever the guild was CALLED the day the scoreboard was
  // uploaded, and canonicalGuild() collapses any listed alias onto the current
  // tag. Drop an alias that history still uses and those rows stop being ours
  // — they are silently re-read as an enemy guild's, taking their kills and
  // damage out of the war record with no error anywhere.
  //
  // So removal is refused only when it would actually orphan something. An
  // alias nobody ever played under is a typo and can go.
  async function assertAliasesSafe(removed) {
    if (!removed.length) return;
    const { data, error } = await supabase
      .from('player_match_stats').select('guild_name').in('guild_name', removed);
    if (error) {
      console.error('guildSettings alias check failed:', error.message);
      throw httpError(500, 'Could not check the war record against those names, so nothing was saved.');
    }
    const inUse = [...new Set((data || []).map((r) => r.guild_name))];
    if (inUse.length) {
      throw httpError(400,
        `${inUse.join(', ')} still appears in the war record — removing it would orphan those matches out of the guild. `
        + 'Past names have to stay listed forever; add new ones instead.');
    }
  }

  return {
    EDITABLE,
    current,

    // The form's initial state. Reads through ensure() rather than get() so
    // opening the page right after another officer saved never shows the old
    // values — which would be saved straight back over the new ones.
    async load() {
      const row = await guildConfig.ensure();
      return current(row);
    },

    async save(body, actor) {
      const b = body || {};
      const before = await guildConfig.ensure();

      const house = str(b.house, 120);
      if (!house) throw httpError(400, 'House name is required.');
      const tag = str(b.tag, 32);
      if (!tag) throw httpError(400, 'Guild tag is required.');

      const timezone = str(b.timezone, 60) || 'America/New_York';
      // Intl is the only validator that agrees with what the app will actually
      // do with this string — a typo'd zone throws at format() time, which
      // would surface as every date on the site breaking rather than as a
      // rejected save.
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch {
        throw httpError(400, `"${timezone}" is not an IANA timezone.`);
      }
      const dayStart = str(b.day_start, 5);
      if (!TIME_RE.test(dayStart)) throw httpError(400, 'Guild-night rollover must be a time like 01:00.');

      // The tag is force-added rather than merely required. Renaming the guild
      // and forgetting to list the NEW name is the same orphaning bug as
      // dropping an old one, just pointed at the future: every scoreboard
      // uploaded from that day on would read as an enemy guild's.
      const aliases = [...new Set([
        ...(Array.isArray(b.aliases) ? b.aliases : []).map((a) => str(a, 32)).filter(Boolean),
        tag,
      ])];

      const next = {
        house,
        tag,
        aliases,
        motto: nullable(b.motto, 200),
        creed: nullable(b.creed, 2000),
        timezone,
        day_start: dayStart,
        admin_role_ids: roleList(b.admin_role_ids, 'Officer roles'),
        allowed_role_ids: roleList(b.allowed_role_ids, 'Member allow-list'),
        member_role_ids: roleList(b.member_role_ids, 'Roster roles'),
        roster_channel_id: channelId(b.roster_channel_id, 'Roster channel'),
        loa_channel_id: channelId(b.loa_channel_id, 'LOA channel'),
        announce_channel_id: channelId(b.announce_channel_id, 'Announce channel'),
        signup_channel_id: channelId(b.signup_channel_id, 'Signup channel'),
        // A VOICE channel — the only one here that is. Same snowflake shape, so
        // the same validator; the difference is which list the picker offers,
        // which is the route's job, not this one's.
        attendance_voice_channel_id: channelId(b.attendance_voice_channel_id, 'Attendance voice channel'),
      };

      const priorAliases = Array.isArray(before.aliases) ? before.aliases.filter(Boolean) : [];
      await assertAliasesSafe(priorAliases.filter((a) => !aliases.includes(a)));
      await assertNotSelfLockout(actor && actor.id, next);

      // `.eq('id', 1)` on a table whose primary key is checked to equal 1 is
      // belt and braces, and stays anyway: an UPDATE with no WHERE is one
      // deleted character away, and this row is the one that decides who can
      // sign in.
      const { error } = await supabase.from('guild_config')
        .update({ ...next, updated_at: new Date().toISOString() })
        .eq('id', 1);
      if (error) {
        console.error('guildSettings save error:', error.message);
        throw httpError(500, 'Could not save these settings.');
      }

      // Both caches, or the change appears to do nothing for up to a minute and
      // people press save again. guildConfig holds the row every getter in the
      // codebase reads; discord.js holds the member and role lists, whose
      // contents member_role_ids decides.
      guildConfig.invalidate();
      invalidateCaches();

      return { settings: current({ ...before, ...next }) };
    },
  };
};
