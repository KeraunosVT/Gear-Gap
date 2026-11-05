// backend/scouting.js — one enemy guild's scouting report, as a Discord post.
//
// The Feuds roster page (/war-record/feuds/:guild) already answers "who do they
// field now, and which of them is the problem". This puts that answer in the
// channel before a fight, when people are actually looking — either by hand
// (the Post to Discord button on that page, or on a signup with an opponent) or
// automatically, a fixed lead before a signup whose opponent is set.
//
// The page and the post read through the same loadRoster(), so they can't
// disagree about who is marked. The marking rule itself lives in feudRoster.js.
//
// Knows nothing about the gateway: posting goes over REST (discord.js's
// postToChannel), so the admin route and the gateway's sweep share one path.
const { foldRoster, RECENT_GAMES, METRICS } = require('./feudRoster');
const { className } = require('./weaponClass');
const { postToChannel } = require('./discord');
const guildConfig = require('./guildConfig');

// How long before a signup's start its report goes out automatically. Long
// enough to read and plan around, short enough that the roster it describes is
// still the one they'll bring.
const SCOUTING_LEAD_MINUTES = 60;

// Discord's embed limits, minus a margin for the "…and N more" line.
const FIELD_MAX = 1024;
const MAX_WATCH = 10;
const MAX_LAPSED = 6;

const METRIC_LABEL = { kills: 'kills', damage_dealt: 'damage', healing: 'healing' };

// Same fold as the page: whitespace collapsed, case ignored. A canonical name
// typed with different spacing still finds its record.
const sameGuild = (a, b) => String(a || '').trim().replace(/\s+/g, ' ').toLowerCase()
  === String(b || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function loadRoster(supabase, enemy) {
  const { data, error } = await supabase.rpc('get_guild_feud_roster', {
    p_guild_names: Object.keys(guildConfig.aliasMap()),
    p_enemy: enemy,
    p_recent: RECENT_GAMES,
  });
  if (error) throw error;
  // Rows arrive grouped by player AND weapon pair. classify is passed in rather
  // than imported by feudRoster, so shared/weaponClasses.json stays the only
  // class vocabulary.
  return foldRoster(data || [], { enemyGuild: enemy, classify: className });
}

// The head-to-head line (met, W/L/D, kills). Null when there's no record yet —
// a guild you've never fought still gets a post, it just says so.
async function loadRecord(supabase, enemy) {
  const { data, error } = await supabase.rpc('get_guild_feuds', {
    p_guild_names: Object.keys(guildConfig.aliasMap()),
  });
  if (error) throw error;
  return (data || []).find((f) => sameGuild(f.enemy_guild, enemy)) || null;
}

async function loadScouting(supabase, enemy) {
  const [roster, record] = await Promise.all([loadRoster(supabase, enemy), loadRecord(supabase, enemy)]);
  // The record carries the canonical spelling; prefer it for the title.
  return { enemy: record?.enemy_guild || enemy, roster, record };
}

// Up to `limit` whole lines that fit in `max` characters, then one line saying
// how many were left out. Whole lines only — cutting mid-line would halve a
// name. Room for the "…and N more" line is reserved before it's needed.
function fitLines(lines, { max = FIELD_MAX, limit = Infinity } = {}) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    const leftAfter = lines.length - out.length - 1;
    const reserve = leftAfter > 0 ? `\n…and ${leftAfter} more`.length : 0;
    const sep = out.length ? 1 : 0;
    if (out.length >= limit || used + sep + line.length + reserve > max) break;
    out.push(line);
    used += sep + line.length;
  }
  const dropped = lines.length - out.length;
  if (dropped > 0) out.push(`…and ${dropped} more`);
  return out.join('\n');
}

// Names come off OCR'd scoreboards; one with an underscore or asterisk would
// otherwise italicise half the post.
const md = (s) => String(s ?? '').replace(/([\\*_`~|>])/g, '\\$1');

const markText = (standout) => METRICS
  .filter((m) => standout?.[m])
  .map((m) => `${METRIC_LABEL[m]} ${standout[m]}×`)
  .join(' · ');

const bestRatio = (p) => Math.max(0, ...Object.values(p.standout || {}));

function classMixLine(players) {
  const counts = {};
  players.forEach((p) => { counts[p.main_class] = (counts[p.main_class] || 0) + 1; });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n} ${md(name)}`)
    .join(' · ');
}

/**
 * The post itself. Pure — no I/O — so the wording is testable.
 *
 * @param {string} enemy
 * @param {object} roster  loadRoster() output (foldRoster's shape).
 * @param {object|null} record  A get_guild_feuds row, or null.
 * @param {{ title: string, startsAt: string|Date|null }} [event]  The signup
 *   this is for, when there is one.
 * @param {string} [note]  The officer's own line, posted as message text.
 * @param {string} [house]  Footer branding.
 * @param {string} [pageUrl]  Absolute link to the roster page, if known.
 */
function buildScoutingPost({ enemy, roster, record = null, event = null, note = '', house = '', pageUrl = null }) {
  const players = roster?.players || [];
  const recentGames = roster?.recent_games || RECENT_GAMES;
  const current = players.filter((p) => p.recent_appearances > 0);

  const desc = [];
  if (event?.title) {
    const unix = event.startsAt ? Math.floor(new Date(event.startsAt).getTime() / 1000) : null;
    desc.push(unix ? `**${md(event.title)}** · <t:${unix}:F> · <t:${unix}:R>` : `**${md(event.title)}**`);
  }
  if (record && Number(record.met) > 0) {
    desc.push(`Head-to-head: **${record.wins}W ${record.losses}L ${record.draws}D** over ${record.met} `
      + `match${Number(record.met) === 1 ? '' : 'es'} · kills ${record.kills_for}–${record.kills_against}`
      + (record.last_met ? ` · last met ${record.last_met}` : ''));
  } else {
    desc.push('No matches against them on record yet.');
  }

  const fields = [];
  if (players.length) {
    fields.push({
      name: `Fielding now — last ${recentGames} games`,
      value: current.length
        ? `**${current.length}** players · ${classMixLine(current)}`.slice(0, FIELD_MAX)
        : `Nobody seen in the last ${recentGames} games.`,
    });

    // Standouts on the CURRENT roster lead: those are the ones you'll meet.
    const watch = current.filter((p) => p.standout).sort((a, b) => bestRatio(b) - bestRatio(a));
    fields.push({
      name: '▲ Watch for',
      value: watch.length
        ? fitLines(watch.map((p) => `**${md(p.player_name)}** (${md(p.main_class)}) — ${markText(p.standout)}`
          + (p.sub_for ? ` · subbing from ${md(p.sub_for)}` : '')), { limit: MAX_WATCH })
        // Said outright: an even guild marking nobody is the answer, not a gap.
        : 'Nobody on their current roster stands out — an even guild.',
    });

    // Marked players who haven't turned up lately. Short, because they may
    // never come back — but a guild that rests its carries is worth knowing.
    const lapsed = players.filter((p) => p.standout && !(p.recent_appearances > 0))
      .sort((a, b) => bestRatio(b) - bestRatio(a));
    if (lapsed.length) {
      const names = lapsed.slice(0, MAX_LAPSED).map((p) => `${md(p.player_name)} (${md(p.main_class)})`).join(', ');
      fields.push({
        name: 'Marked, but not seen lately',
        value: (names + (lapsed.length > MAX_LAPSED ? `, and ${lapsed.length - MAX_LAPSED} more` : '')).slice(0, FIELD_MAX),
      });
    }
  } else {
    desc.push('No players on record for them.');
  }

  const ratio = roster?.standout_ratio || 2;
  const floor = roster?.min_appearances || 5;
  const embed = {
    title: `🔭 Scouting: ${enemy}`.slice(0, 256),
    description: desc.join('\n').slice(0, 4096),
    color: 0xc9973a,
    fields,
    footer: { text: `▲ = ${ratio}× their guild's median per match, over ${floor}+ matches${house ? ` · ${house}` : ''}`.slice(0, 2048) },
    timestamp: new Date().toISOString(),
  };
  if (pageUrl) embed.url = pageUrl;

  const content = String(note || '').trim().slice(0, 1500);
  return { content: content || undefined, embeds: [embed] };
}

// An absolute link to the roster page, or null. APP_URL defaults to '/' for
// the login redirect, and a relative link means nothing inside Discord.
function rosterPageUrl(enemy) {
  const base = process.env.APP_URL || '';
  if (!/^https?:\/\//i.test(base)) return null;
  return `${base.replace(/\/+$/, '')}/war-record/feuds/${encodeURIComponent(enemy)}`;
}

// Load, build, post. Throws on a bad channel or Discord refusing; the caller
// decides whether that is a 502 (the button) or a log line (the sweep).
async function postScouting(supabase, { enemy, channelId, event = null, note = '' }) {
  const name = String(enemy || '').trim();
  if (!name) throw Object.assign(new Error('Name the guild to scout.'), { status: 400 });
  const { enemy: canonical, roster, record } = await loadScouting(supabase, name);
  const payload = buildScoutingPost({
    enemy: canonical, roster, record, event, note,
    house: guildConfig.get().house,
    pageUrl: rosterPageUrl(canonical),
  });
  await postToChannel(channelId, payload);
  return { enemy: canonical };
}

module.exports = {
  SCOUTING_LEAD_MINUTES,
  loadRoster,
  loadScouting,
  buildScoutingPost,
  postScouting,
  fitLines,
};
