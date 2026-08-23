// backend/feudRoster.js — one enemy guild's roster, and who on it is a problem.
//
// Pulled out of the route so it can be tested: server.js calls app.listen() at
// require time, which puts everything defined in it out of reach. This is the
// arithmetic that decides who gets marked, so it is the part that needs a test.
//
// ── WHY MEDIAN, AND WHY PER GUILD ───────────────────────────────────────────
// Crowning the top of each column marks somebody in EVERY guild, including one
// where five players are indistinguishable — the badge then means "sorted
// first" rather than "dangerous". Comparing each player against their own
// guild's median marks three players in a guild with three carries, and NOBODY
// in a guild that is uniformly average, which is itself the useful answer.
//
// Median rather than mean throughout: one monster drags a mean up until nobody
// else clears the bar, which is exactly backwards.

// A rate this many times the guild's median gets marked. Rendered as a number
// on the page too, so the reader judges rather than trusting a badge.
const STANDOUT_RATIO = 2;

// Below this, a player is listed but never marked. One good night makes anyone
// a large multiple of a median.
const DEFAULT_MIN_APPEARANCES = 3;

// The metrics ranked on. Kills and damage find threats; healing finds healers
// empirically, which matters because only 11 of the game's 45 classes have a
// role mapping anywhere in this app.
const METRICS = ['kills', 'damage_dealt', 'healing'];

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const commonest = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

/**
 * @param {object[]} rows      get_guild_feud_roster output — one row per
 *   (player, own_guild, weapon pair), already scoped to this guild's matches.
 * @param {string} enemyGuild  The guild the page is about. A row whose
 *   own_guild differs is a borrowed player.
 * @param {(w1: string, w2: string) => string} classify  Weapon pair -> class.
 */
function foldRoster(rows, { enemyGuild, classify, minAppearances = DEFAULT_MIN_APPEARANCES } = {}) {
  const byPlayer = new Map();
  const classMix = {};

  (rows || []).forEach((r) => {
    const seen = Number(r.appearances) || 0;
    const cls = classify(r.weapon_1, r.weapon_2);
    classMix[cls] = (classMix[cls] || 0) + seen;

    const p = byPlayer.get(r.player_name) || {
      player_name: r.player_name,
      appearances: 0,
      kills: 0,
      damage_dealt: 0,
      damage_taken: 0,
      healing: 0,
      classes: {},
      guilds: {},
    };
    p.appearances += seen;
    p.kills += Number(r.kills) || 0;
    p.damage_dealt += Number(r.damage_dealt) || 0;
    p.damage_taken += Number(r.damage_taken) || 0;
    p.healing += Number(r.healing) || 0;
    p.classes[cls] = (p.classes[cls] || 0) + seen;
    if (r.own_guild) p.guilds[r.own_guild] = (p.guilds[r.own_guild] || 0) + seen;
    byPlayer.set(r.player_name, p);
  });

  const players = [...byPlayer.values()].map(({ classes, guilds, ...p }) => {
    const own = commonest(guilds);
    const per = (n) => (p.appearances > 0 ? n / p.appearances : 0);
    return {
      ...p,
      // Rates, not totals. Totals reward whoever turned up most; rates say who
      // is dangerous, which is the question a scouting sheet answers.
      per_match: {
        kills: per(p.kills),
        damage_dealt: per(p.damage_dealt),
        healing: per(p.healing),
      },
      // What they turn up as most often. Someone who has switched weapons has
      // more than one; naming the commonest beats listing all of them.
      main_class: commonest(classes) || 'Unknown',
      // Null when they're one of this guild's own.
      sub_for: own && own !== enemyGuild ? own : null,
    };
  });

  // ── THE POPULATION THE MEDIAN DESCRIBES ───────────────────────────────────
  // Regulars of THIS guild only, on two counts:
  //
  //   - one-match subs would drag the median toward zero and turn every
  //     regular into an "outlier";
  //   - borrowed players aren't this guild's standard, so they shouldn't set
  //     it. They can still EXCEED it and be marked — "they borrowed someone who
  //     wrecked us" is worth knowing, and the sub tag is right there.
  const population = players.filter((p) => p.appearances >= minAppearances && !p.sub_for);

  const medians = {};
  METRICS.forEach((m) => { medians[m] = median(population.map((p) => p.per_match[m])); });

  players.forEach((p) => {
    const standout = {};
    // A player under the floor is listed and never marked, however extreme.
    if (p.appearances >= minAppearances) {
      METRICS.forEach((m) => {
        // A median of zero means the whole guild does none of this — every
        // healer in a guild with no healing would otherwise divide by zero and
        // come out Infinity. No median, no mark.
        if (medians[m] > 0 && p.per_match[m] >= medians[m] * STANDOUT_RATIO) {
          standout[m] = Number((p.per_match[m] / medians[m]).toFixed(1));
        }
      });
    }
    if (Object.keys(standout).length) p.standout = standout;
  });

  players.sort((a, b) => b.appearances - a.appearances || a.player_name.localeCompare(b.player_name));

  return {
    players,
    class_mix: Object.entries(classMix)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    medians,
    // What the medians were computed over, so the page can say so rather than
    // presenting a threshold out of nowhere.
    eligible_count: population.length,
    min_appearances: minAppearances,
    standout_ratio: STANDOUT_RATIO,
  };
}

module.exports = { foldRoster, median, STANDOUT_RATIO, DEFAULT_MIN_APPEARANCES, METRICS };
