// backend/memberTimezones.js — each member's own timezone (migration 17).
//
// The website saves it from the member's browser; the /loa Discord command
// reads it, because Discord never tells a bot where a user is. Without a row a
// member's times are read on the guild's clock, which is how /loa always
// behaved — so every failure here degrades to that rather than erroring.
const { isValidTimeZone } = require('./loa');

module.exports = function createMemberTimezones(supabase) {
  return {
    // The member's saved IANA zone, or null. Never throws: a missing table
    // (migration 17 not run yet) or a failed read just means "unknown".
    async get(discordId) {
      if (!discordId) return null;
      const { data, error } = await supabase.from('member_timezones')
        .select('timezone').eq('discord_id', String(discordId)).maybeSingle();
      if (error) { console.error('memberTimezones.get error:', error.message); return null; }
      return isValidTimeZone(data?.timezone) ? data.timezone : null;
    },

    // Saves the member's zone. Throws a 400 on an unusable name; the caller
    // decides whether a failed write matters (for /loa it doesn't — the LOA
    // itself is what they asked for).
    async set(discordId, timezone) {
      if (!isValidTimeZone(timezone)) {
        const err = new Error('Unknown timezone.');
        err.status = 400;
        throw err;
      }
      const { error } = await supabase.from('member_timezones').upsert({
        discord_id: String(discordId),
        timezone,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'discord_id' });
      if (error) {
        console.error('memberTimezones.set error:', error.message);
        const err = new Error('Failed to save timezone.');
        err.status = 500;
        throw err;
      }
      return timezone;
    },
  };
};
