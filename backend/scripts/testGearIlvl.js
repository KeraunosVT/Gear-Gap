// backend/scripts/testGearIlvl.js — standalone CLI test for reading gear out of
// a Throne & Liberty screenshot.
//
// Calls the exact same extraction function the real website endpoint uses
// (backend/gearIlvl.js), so a good result here is a good result in production.
// Nothing is written: no database, no storage, no member row. This is the way
// to tune the prompt against real screenshots without uploading anything.
//
// Only the Equipment Level popup is read at all now — the full-equipment-window
// upload stores the image and parses nothing, so there is nothing to test on
// that path. `--window` is still accepted, and says so rather than failing with
// a stack trace for anyone with the old command in their shell history.
//
// Usage:
//   node scripts/testGearIlvl.js path/to/popup.png
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { parseGearScreenshot } = require('../gearIlvl');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--window')) {
    console.error('--window is gone: the equipment-window upload no longer reads the image,');
    console.error('it only stores it. Test the Equipment Level popup instead:');
    console.error('  node scripts/testGearIlvl.js path/to/popup.png');
    process.exit(1);
  }
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node scripts/testGearIlvl.js path/to/screenshot.png');
    process.exit(1);
  }

  const buffer = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp' : 'image/png';

  const result = await parseGearScreenshot(buffer, mimeType);
  console.log('\nParsed equipment level (popup — Heroic items INCLUDED):');
  console.table([{
    weapon: result.weapon,
    armor: result.armor,
    accessory: result.accessory,
    average: result.average,
  }]);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
