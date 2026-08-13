// backend/scripts/seedConfigFromEnv.js — copy the current environment and
// shared/guild.json into guild_config row 1, once, before the code that stops
// reading them ships.
//
// ── RUN THIS IN THE DEPLOYMENT'S OWN ENVIRONMENT ────────────────────────────
// It reads the same DISCORD_* variables the server reads, so running it from a
// laptop with a different .env writes that laptop's channel ids into
// production. The whole point is that row 1 ends up matching what the running
// server sees TODAY, so the deploy that switches over is a no-op behaviourally.
//
// Usage:
//   node scripts/seedConfigFromEnv.js            # dry run — prints, writes nothing
//   node scripts/seedConfigFromEnv.js --write    # writes row 1
//
// Safe to re-run. Blank env values never overwrite a set column (see keep()
// below), so a second run after someone has edited settings in the app won't
// wipe their work back to whatever the environment happens to still hold.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const blank = (v) => String(v || '').trim() || null;

// ── THE VALUES THAT USED TO LIVE IN FILES ───────────────────────────────────
// house/tag/aliases were shared/guild.json; motto/creed were literals in
// frontend/src/guild.js. Both files are deleted in the same change that added
// this script, so the values are carried here — a seed script is exactly the
// right place for "what the old hardcoded configuration was".
//
// After the first successful --write these are history. Edit the settings page,
// not this file: re-running the script would then push these stale values back
// over whatever an officer has since saved.
//
// The alias list is the one that matters. Every name here has match rows
// recorded under it; dropping one orphans those matches out of the war record.
// Note "Highly Regarded" is a *different* guild and must not be added.
const IDENTITY = {
  house: 'Gear Gap',
  tag: 'Gear Gap',
  aliases: ['Gear Gap', 'FTP', 'PUSH', 'House Regard', 'Best Regards'],
};

const MOTTO = 'Clump. Collide. Conquer.';
const CREED = 'We do not wait for the fight to come to us — we bring the fight, and we bring all of it at once. '
  + 'No lone blades, no scattered lines: we stack as one mass and move as one weight, so that when we land, '
  + 'nothing standing there is still standing after. Momentum is our weapon before the first hit ever lands. '
  + 'We are not the guild that reacts. We are the one that arrives.';

async function main() {
  const write = process.argv.includes('--write');

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set — nothing to write to.');
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: existing, error: readErr } = await supabase
    .from('guild_config').select('*').eq('id', 1).maybeSingle();
  if (readErr) {
    console.error('Could not read guild_config:', readErr.message);
    console.error('Has migrations/014_guild_config.sql been run?');
    process.exit(1);
  }
  if (!existing) {
    console.error('guild_config has no row 1 — run migrations/014_guild_config.sql first.');
    process.exit(1);
  }

  // The member-role list has the same two-variable fallback discord.js uses, or
  // a hall that only ever set DISCORD_ALLOWED_ROLE_IDS would seed an empty
  // roster and every party, snapshot and reminder would come back blank.
  const memberRoles = list(process.env.DISCORD_MEMBER_ROLE_IDS || process.env.DISCORD_ALLOWED_ROLE_IDS);

  const fromEnv = {
    house: IDENTITY.house,
    tag: IDENTITY.tag,
    aliases: IDENTITY.aliases,
    motto: MOTTO,
    creed: CREED,
    admin_role_ids: list(process.env.DISCORD_ADMIN_ROLE_IDS),
    allowed_role_ids: list(process.env.DISCORD_ALLOWED_ROLE_IDS),
    member_role_ids: memberRoles,
    roster_channel_id: blank(process.env.DISCORD_ROSTER_CHANNEL_ID),
    loa_channel_id: blank(process.env.DISCORD_LOA_CHANNEL_ID),
    announce_channel_id: blank(process.env.DISCORD_ANNOUNCE_CHANNEL_ID),
    signup_channel_id: blank(process.env.DISCORD_SIGNUP_CHANNEL_ID),
  };

  // Never overwrite something real with nothing. An unset env var means "this
  // deployment never configured it", not "clear whatever is there" — and on a
  // re-run it would mean "throw away what the officer just saved".
  const next = {};
  Object.entries(fromEnv).forEach(([k, v]) => {
    const empty = v === null || v === undefined || (Array.isArray(v) && !v.length);
    if (!empty) next[k] = v;
  });

  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changes = Object.entries(next).filter(([k, v]) => !same(existing[k], v));

  console.log(`\nguild_config row 1 — ${changes.length} field(s) would change:\n`);
  if (!changes.length) console.log('  (already in sync)');
  changes.forEach(([k, v]) => {
    console.log(`  ${k}`);
    console.log(`    now:  ${JSON.stringify(existing[k] ?? null)}`);
    console.log(`    next: ${JSON.stringify(v)}`);
  });

  // The two that lock people out if they land empty. Worth an explicit line
  // rather than leaving it to be noticed in the diff above.
  const finalAdmin = next.admin_role_ids || existing.admin_role_ids || [];
  const finalMember = next.member_role_ids || existing.member_role_ids || [];
  console.log('');
  if (!finalAdmin.length) {
    console.log('  !! admin_role_ids would be EMPTY — nobody would be an officer, and');
    console.log('     nobody could open the settings page to fix it. Set');
    console.log('     DISCORD_ADMIN_ROLE_IDS in this environment before writing.');
  }
  if (!finalMember.length) {
    console.log('  !! member_role_ids would be EMPTY — the roster would come back empty');
    console.log('     everywhere (parties, attendance, reminders).');
  }

  if (!write) {
    console.log('\nDry run. Re-run with --write to apply.\n');
    return;
  }
  if (!changes.length) {
    console.log('Nothing to write.\n');
    return;
  }

  const { error } = await supabase.from('guild_config')
    .update({ ...next, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) {
    console.error('Write failed:', error.message);
    process.exit(1);
  }
  console.log('Written. Verify the row, then deploy the code that stops reading env.\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
