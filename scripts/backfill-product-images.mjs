#!/usr/bin/env node
// One-off: give older barcode entries the product picture they predate.
//
// Entries logged before product images existed carry no barcode on their
// items, because the field did not exist yet. What they do have is a name that
// came verbatim from Open Food Facts, and food_cache still holds the barcode
// that name was looked up under -- so the two can be matched back together.
//
// Deliberately conservative:
//   * only entries with no photo at all are touched
//   * only an exact (case-folded) name match counts; nothing is guessed
//   * a name that matches more than one barcode is skipped, not picked between
//   * --apply is required; without it this only reports
//
// Run inside the container, where DATA_DIR and the network both are:
//   podman exec plate node scripts/backfill-product-images.mjs [--apply]
//
// Take a backup with `VACUUM INTO` first, not `cp`. The database runs in WAL
// mode, so a plain file copy silently omits everything still in the
// write-ahead log -- which is exactly the most recent entries, the ones a
// backup is for.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, PHOTO_DIR } from '../server/db.js';
import { productImagePath, hasProductImage } from '../server/foods.js';

const apply = process.argv.includes('--apply');
const UA = 'Plate/0.1 (self-hosted personal food log)';

const norm = (s) => String(s || '').trim().toLowerCase();

// name -> barcode, dropping any name that has been seen under two codes.
const byName = new Map();
for (const row of db.prepare('SELECT barcode, name FROM food_cache WHERE barcode IS NOT NULL').all()) {
  const key = norm(row.name);
  if (byName.has(key) && byName.get(key) !== row.barcode) byName.set(key, null);
  else if (!byName.has(key)) byName.set(key, row.barcode);
}

async function fetchImage(barcode) {
  if (hasProductImage(barcode)) return true;
  const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json`
    + '?fields=image_front_small_url,image_small_url';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return false;
    const p = (await res.json())?.product || {};
    const src = p.image_front_small_url || p.image_small_url;
    if (!src) return false;

    const img = await fetch(src, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
    if (!img.ok || !/^image\//.test(img.headers.get('content-type') || '')) return false;
    const buf = Buffer.from(await img.arrayBuffer());
    if (!buf.length || buf.length > 512 * 1024) return false;
    if (apply) fs.writeFileSync(productImagePath(barcode), buf);
    return true;
  } catch {
    return false;
  }
}

const rows = db.prepare(
  'SELECT id, day, meal, items_json FROM entries WHERE photo_id IS NULL ORDER BY day'
).all();

console.log(`${rows.length} entries without a picture${apply ? '' : '   (dry run — pass --apply to write)'}\n`);

let filled = 0, skipped = 0;
for (const row of rows) {
  const items = JSON.parse(row.items_json);
  const named = items.map((i) => ({ item: i, barcode: i.barcode || byName.get(norm(i.name)) || null }));
  const hit = named.find((n) => n.barcode);

  if (!hit) {
    skipped++;
    console.log(`  skip   ${row.day}  ${items.map((i) => i.name).join(' + ').slice(0, 46)}`);
    console.log(`         no barcode on the item and no name match in food_cache`);
    continue;
  }

  const got = await fetchImage(hit.barcode);
  if (!got) {
    skipped++;
    console.log(`  skip   ${row.day}  ${hit.item.name.slice(0, 46)}  (${hit.barcode}: no image upstream)`);
    continue;
  }

  if (apply) {
    // Write the recovered barcode back onto the items too, so the entry
    // behaves like a freshly scanned one from here on.
    const updated = items.map((i) => {
      const found = named.find((n) => n.item === i);
      return found?.barcode ? { ...i, barcode: found.barcode } : i;
    });

    const name = `${crypto.randomUUID()}.jpg`;
    fs.copyFileSync(productImagePath(hit.barcode), path.join(PHOTO_DIR, name));
    db.prepare('UPDATE entries SET photo_id = ?, items_json = ? WHERE id = ? AND photo_id IS NULL')
      .run(name, JSON.stringify(updated), row.id);
  }

  filled++;
  console.log(`  ${apply ? 'filled' : 'would'} ${row.day}  ${hit.item.name.slice(0, 46)}  (${hit.barcode})`);
}

console.log(`\n${filled} ${apply ? 'filled' : 'would be filled'}, ${skipped} left alone`);
