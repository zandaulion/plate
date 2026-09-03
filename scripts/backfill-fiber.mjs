#!/usr/bin/env node
// Retroactively populates fiber in historical meal entries.
// Backs up the SQLite database before making any changes.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = process.argv[2]
  || '/home/opc/.local/share/containers/storage/volumes/plate-data/_data/plate.db';

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  process.exit(1);
}

// 1. Create a safe timestamped backup
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${dbPath}.bak.${timestamp}`;
fs.copyFileSync(dbPath, backupPath);
console.log(`Backed up database to: ${backupPath}`);

const db = new DatabaseSync(dbPath);

// Known barcode fiber per 100g
const BARCODE_FIBER = {
  '4000504210024': 0.0, // Dorblu classic (cheese)
  '5949065004637': 0.0, // Branza slaba vaca 2% (cheese)
  '5941238014863': 0.0, // Hochland margele branza (cheese)
  '20815400': 5.4,      // Noix de cajou & cranberries (Alesto)
  '20383879': 4.2,      // zacuscă (Lidl)
  '5949065004668': 0.0  // Brânzá Fágárás 35% (cheese)
};

// Standard USDA / whole food fiber per 100g
const FIBER_PATTERNS = [
  { test: /avocado/i, per100: 6.7 },
  { test: /apple/i, per100: 2.4 },
  { test: /banana/i, per100: 2.6 },
  { test: /grape/i, per100: 0.9 },
  { test: /afine|blueberr/i, per100: 2.4 },
  { test: /peanut|cashew|cajou|nut/i, per100: 8.0 },
  { test: /bun|bread|wrap|focaccia/i, per100: 2.5 },
  { test: /fries|potato/i, per100: 3.0 },
  { test: /tomato.*arugula|salad|vegetable/i, per100: 1.8 },
  { test: /macaroni|pasta/i, per100: 1.8 },
  { test: /shawarma|chicken/i, per100: 0.5 },
  { test: /cheese|branza|dorblu|halloumi/i, per100: 0.0 },
  { test: /pesto/i, per100: 1.6 },
  { test: /puff/i, per100: 3.2 },
  { test: /tea/i, per100: 0.0 },
  { test: /curry/i, per100: 1.5 },
  { test: /zacusca|zacuscă/i, per100: 4.2 },
  { test: /edamame/i, per100: 5.2 },
  { test: /skyr/i, per100: 0.0 },
  { test: /seitan/i, per100: 1.5 },
  { test: /tofu/i, per100: 1.2 },
  { test: /chia/i, per100: 34.4 },
  { test: /lentil/i, per100: 7.9 },
  { test: /oat/i, per100: 10.0 },
  { test: /bite/i, per100: 1.0 }
];

function resolveFiberPer100(item) {
  if (item.barcode && BARCODE_FIBER[item.barcode] !== undefined) {
    return BARCODE_FIBER[item.barcode];
  }
  const match = FIBER_PATTERNS.find((p) => p.test.test(item.name || ''));
  if (match) return match.per100;
  return 0.0;
}

const entries = db.prepare('SELECT id, day, meal, items_json, totals_json FROM entries ORDER BY created_at ASC').all();
console.log(`Found ${entries.length} entries to inspect.`);

const updateStmt = db.prepare('UPDATE entries SET items_json = ?, totals_json = ? WHERE id = ?');

db.exec('BEGIN TRANSACTION');
try {
  let updatedCount = 0;

  for (const entry of entries) {
    const items = JSON.parse(entry.items_json || '[]');
    const totals = JSON.parse(entry.totals_json || '{}');

    let totalFiber = 0;
    let modifiedItems = false;

    for (const item of items) {
      if (!item.per) item.per = {};
      
      let fiberRate = item.per.fiber;
      if (fiberRate === undefined || fiberRate === null) {
        const f100 = resolveFiberPer100(item);
        fiberRate = Math.round((f100 / 100) * 1000) / 1000;
        item.per.fiber = fiberRate;
        modifiedItems = true;
      }

      const itemGrams = Number(item.grams) || 0;
      totalFiber += fiberRate * itemGrams;
    }

    const roundedFiber = Math.round(totalFiber * 10) / 10;
    if (totals.fiber !== roundedFiber || modifiedItems) {
      totals.fiber = roundedFiber;
      updateStmt.run(JSON.stringify(items), JSON.stringify(totals), entry.id);
      updatedCount++;
      console.log(`[${entry.day} ${entry.meal}] Fiber: ${roundedFiber}g (items: ${items.map((i) => i.name).join(', ')})`);
    }
  }

  db.exec('COMMIT');
  console.log(`Successfully updated ${updatedCount} entries with fiber data.`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Migration failed, rolled back changes:', err);
  process.exit(1);
}
