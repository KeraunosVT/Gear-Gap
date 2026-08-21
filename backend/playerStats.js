// backend/playerStats.js — turning one player's match rows into their profile.
//
// Pulled out of the /api/player/:name route so it can be tested: server.js
// calls app.listen() at require time, which makes everything defined in it
// unreachable from a test. This is the part that was actually wrong, and it is
// pure, so it is the part worth having under test.
//
// ── THE GUILD SPLIT IS THE WHOLE POINT ──────────────────────────────────────
// The route used to filter `.in('guild_name', ourNames)` in SQL, so a row
// recorded under a spelling the alias list doesn't carry — a misread
// scoreboard, an old guild name, a night spent subbing elsewhere — simply
// wasn't there. The profile came back short and nothing said why.
//
// Splitting in JS instead means the excluded rows can be counted and named, so
// a short history explains itself and an officer can recognise one of the
// spellings as theirs and fix it in Guild Settings.

/**
 * @param {object[]} allRows  Every player_match_stats row for this player's
 *   names, ANY guild, each with an embedded `wargame_matches`.
 * @param {Set<string>} guildSet  The guild names that count as ours.
 * @param {(w1: string, w2: string) => string} classify  Weapon pair -> class name.
 */
function aggregatePlayerRows(allRows, guildSet, classify) {
  const totals = { kills: 0, assists: 0, damage_dealt: 0, damage_taken: 0, healing: 0 };
  const classCount = {};
  const matches = [];
  const otherGuilds = {};
  let orphaned = 0;

  allRows.forEach((r) => {
    if (!guildSet.has(r.guild_name)) {
      // Tallied by the name AS RECORDED — recognising it is what lets an
      // officer decide whether it's really us.
      const g = r.guild_name || 'Unknown';
      otherGuilds[g] = (otherGuilds[g] || 0) + 1;
      return;
    }

    // The match embed is a LEFT join, so a row whose match is gone arrives with
    // null here rather than being absent. Reading `.id` off it threw, and one
    // orphaned row 500'd the entire profile.
    const m = r.wargame_matches;
    if (!m) { orphaned += 1; return; }

    totals.kills += Number(r.kills) || 0;
    totals.assists += Number(r.assists) || 0;
    totals.damage_dealt += Number(r.damage_dealt) || 0;
    totals.damage_taken += Number(r.damage_taken) || 0;
    totals.healing += Number(r.healing) || 0;

    const cls = classify(r.weapon_1, r.weapon_2);
    classCount[cls] = (classCount[cls] || 0) + 1;

    matches.push({
      match_id: m.id,
      title: m.title,
      match_date: m.match_date,
      rank: r.rank,
      weapon_1: r.weapon_1,
      weapon_2: r.weapon_2,
      kills: Number(r.kills) || 0,
      assists: Number(r.assists) || 0,
      damage_dealt: Number(r.damage_dealt) || 0,
      damage_taken: Number(r.damage_taken) || 0,
      healing: Number(r.healing) || 0,
    });
  });

  matches.sort((a, b) => new Date(b.match_date || 0) - new Date(a.match_date || 0));

  const total = matches.length;
  return {
    ...totals,
    matches: total,
    matchHistory: matches,
    avg_kills: total ? totals.kills / total : 0,
    avg_assists: total ? totals.assists / total : 0,
    avg_damage: total ? totals.damage_dealt / total : 0,
    avg_healing: total ? totals.healing / total : 0,
    classBreakdown: Object.entries(classCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    excluded: {
      other_guilds: Object.entries(otherGuilds)
        .map(([guild_name, count]) => ({ guild_name, matches: count }))
        .sort((a, b) => b.matches - a.matches || a.guild_name.localeCompare(b.guild_name)),
      orphaned,
    },
  };
}

module.exports = { aggregatePlayerRows };
