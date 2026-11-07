// backend/transferCooldowns.js — each member's server transfer cooldown.
//
// Members type what the game shows as left (days and hours); this turns it
// into the moment it ends, so the page can count down by itself rather than
// going stale the day after someone entered it. Everyone sees the whole list —
// it's for planning a move together — but each member only ever writes their
// own row (the routes take no member id; see server.js).

const MAX_DAYS = 30;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// How long a finished cooldown stays on the list as "Ready" before it drops off.
const READY_LISTED_DAYS = 7;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Whole numbers only, blank as 0. Anything else is null, which the caller refuses.
const wholeNumber = (v) => {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

// The instant a cooldown entered as days + hours left ends. Refuses anything
// that isn't a whole number, an empty cooldown, and anything over 30 days —
// the game's own maximum, so more than that is a typo.
function cooldownEnd({ days, hours } = {}, now = Date.now()) {
  const d = wholeNumber(days);
  const h = wholeNumber(hours);
  if (d === null || h === null) throw httpError(400, 'Days and hours must be whole numbers.');
  if (h > 23) throw httpError(400, 'Hours must be 23 or less — put whole days in Days.');
  const total = d * DAY + h * HOUR;
  if (total <= 0) throw httpError(400, 'Enter how long is left on your cooldown.');
  if (total > MAX_DAYS * DAY) throw httpError(400, `A transfer cooldown can't be more than ${MAX_DAYS} days.`);
  return new Date(now + total);
}

module.exports = function createTransferCooldowns(supabase, identities = null) {
  return {
    // Everyone's, soonest-ending first, including ones that ended in the last
    // week (shown as Ready). Names resolve to the site alias when there is one.
    async list(now = Date.now()) {
      const { data, error } = await supabase.from('transfer_cooldowns')
        .select('discord_id, display_name, ends_at, updated_at')
        .gte('ends_at', new Date(now - READY_LISTED_DAYS * DAY).toISOString())
        .order('ends_at', { ascending: true });
      if (error) {
        console.error('transferCooldowns.list error:', error.message);
        throw httpError(500, 'Failed to load transfer cooldowns — has migration 14 been run?');
      }
      const ids = identities ? await identities.load().catch(() => null) : null;
      return (data || []).map((r) => ({
        ...r,
        display_name: ids ? ids.displayNameFor(r.discord_id, r.display_name) : r.display_name,
      }));
    },

    // Replaces the member's cooldown. Only ever called with the signed-in
    // member's own id.
    async setMine(discordId, displayName, { days, hours } = {}, now = Date.now()) {
      if (!discordId) throw httpError(401, 'Sign in first.');
      const endsAt = cooldownEnd({ days, hours }, now);
      const { data, error } = await supabase.from('transfer_cooldowns').upsert({
        discord_id: String(discordId),
        display_name: String(displayName || '').slice(0, 120),
        ends_at: endsAt.toISOString(),
        updated_at: new Date(now).toISOString(),
      }, { onConflict: 'discord_id' }).select('discord_id, display_name, ends_at, updated_at').single();
      if (error || !data) {
        console.error('transferCooldowns.setMine error:', error?.message);
        throw httpError(500, 'Failed to save your cooldown — has migration 14 been run?');
      }
      return data;
    },

    async clearMine(discordId) {
      if (!discordId) throw httpError(401, 'Sign in first.');
      const { error } = await supabase.from('transfer_cooldowns').delete().eq('discord_id', String(discordId));
      if (error) {
        console.error('transferCooldowns.clearMine error:', error.message);
        throw httpError(500, 'Failed to clear your cooldown.');
      }
    },
  };
};

module.exports.cooldownEnd = cooldownEnd;
module.exports.MAX_DAYS = MAX_DAYS;
