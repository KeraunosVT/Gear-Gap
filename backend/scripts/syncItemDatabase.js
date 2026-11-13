// backend/scripts/syncItemDatabase.js — run the Sync Item Database button's
// import from your own machine instead of the server.
//
// questlog.gg answers 403 to the deployed server: its API refuses requests from
// the host's datacenter IP range, while the same requests from a home
// connection go through. The import only reads questlog and writes Supabase, so
// running it here fills the same questlog_items table the live site reads. The
// app needs no redeploy and nothing changes for members.
//
// Writes to questlog_items and the `assets` storage bucket, exactly as the
// button does. Safe to re-run: items already stored are skipped.
//
// Usage (needs SUPABASE_URL and SUPABASE_SERVICE_KEY in backend/.env):
//   node scripts/syncItemDatabase.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const runImport = require('../questlogImport');

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing from backend/.env');
    process.exit(1);
  }

  console.log('Syncing from questlog.gg. This takes a few minutes…');
  const r = await runImport(createClient(url, key));

  console.log(`Items:       ${r.imported} new, ${r.skipped} existing`);
  console.log(`Potentials:  ${r.potentials.imported} new, ${r.potentials.skipped} existing`);
  console.log(`Rebuilt:     ${r.rebuilt.updated} of ${r.rebuilt.scanned} descriptions`);
  console.log(`Currency:    ${r.currencyIcons.mirrored} icons mirrored`);
  console.log(`Took ${(r.duration_ms / 1000).toFixed(0)}s`);

  if (r.errors.length) {
    console.error(`\n${r.errors.length} error(s):`);
    r.errors.forEach((e) => console.error('  ' + e));
    process.exit(1);
  }
}

main().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
