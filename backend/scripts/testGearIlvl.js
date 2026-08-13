// backend/scripts/testGearIlvl.js — standalone CLI test for reading gear out of
// a Throne & Liberty screenshot.
//
// Calls the exact same extraction functions the real website endpoints use
// (backend/gearIlvl.js), so a good result here is a good result in production.
// Nothing is written: no database, no storage, no member row. This is the way
// to tune a prompt against real screenshots without uploading anything.
//
// Usage:
//   node scripts/testGearIlvl.js path/to/popup.png             # Equipment Level popup
//   node scripts/testGearIlvl.js --window path/to/window.png   # full equipment window
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { parseGearScreenshot, parseGearWindow, EXCLUDED_TIERS } = require('../gearIlvl');

async function main() {
  const args = process.argv.slice(2);
  const windowMode = args.includes('--window');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node scripts/testGearIlvl.js [--window] path/to/screenshot.png');
    process.exit(1);
  }

  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp' : 'image/png';

  if (!windowMode) {
    const result = await parseGearScreenshot(buffer, mimeType);
    console.log('\nParsed equipment level (popup — Heroic items INCLUDED):');
    console.table([{
      weapon: result.weapon,
      armor: result.armor,
      accessory: result.accessory,
      average: result.average,
    }]);
    return;
  }

  const result = await parseGearWindow(buffer, mimeType);

  // Every item, with the excluded ones marked rather than dropped. The point of
  // running this by hand is to see whether the model read the TIERS correctly —
  // a wrong level is one member's number, a tier the model doesn't recognise
  // silently changes the rule for everyone.
  console.log('\nItems read:');
  console.table(result.items.map((i) => ({
    slot: i.slot,
    item: i.name,
    category: i.category,
    tier: i.tier,
    level: i.level,
    counted: i.excluded ? 'no' : 'yes',
  })));

  console.log(`\nExcluded tiers: ${[...EXCLUDED_TIERS].join(', ')}`);
  console.log(`Excluded items: ${result.excludedCount}`);

  // A category showing null had nothing left after exclusion — worth seeing as
  // null rather than 0, which is what it would be stored as if this ever
  // started coercing.
  console.log('\nComputed levels (Heroic items EXCLUDED):');
  console.table([{
    weapon: result.weapon,
    armor: result.armor,
    accessory: result.accessory,
    average: result.average,
  }]);

  const unknown = result.items.filter((i) => i.category === 'other');
  if (unknown.length) {
    console.log(`\n⚠️  ${unknown.length} item(s) came back with an unrecognised category and count toward nothing:`);
    unknown.forEach((i) => console.log(`   ${i.slot} — ${i.name}`));
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
