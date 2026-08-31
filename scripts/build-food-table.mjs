#!/usr/bin/env node
// Builds the bundled generic-food table from USDA FoodData Central.
//
// Why bundle at all: Open Food Facts is excellent by barcode and poor by name
// -- searching "banana" there returns banana chips and banana yoghurt before
// fruit. USDA fixes that, but its API needs a key, and a key cannot ship
// inside an APK where anyone can extract it. A table shipped with the app
// needs no key, no network and no rate limit, and it makes the free tier
// genuinely offline rather than merely serverless.
//
// Composition of a generic food does not drift -- chicken breast has the
// protein it had in 2018 -- so this is rebuilt when convenient, not on a
// schedule.
//
//   node scripts/build-food-table.mjs <out.sqlite> <input.json> [more.json...]
//
// Parsed as a stream. The SR Legacy file is 201 MB and JSON.parse would want
// well over a gigabyte for it; this build should not be the reason a laptop
// starts swapping.

import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isPlausible } from '../core/foods.js';

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) {
  console.error('usage: build-food-table.mjs <out.sqlite> <input.json...>');
  process.exit(1);
}

/**
 * Yields each element of the first top-level JSON array in the file, as text.
 *
 * Scans with an index and only compacts the buffer once per chunk, rather than
 * re-slicing it after every object. The first version sliced on each yield and
 * lost objects across chunk boundaries -- it read 340 foods as 32 -- so this
 * one is checked against a known count in the tests.
 *
 * String and escape state are tracked so a brace inside a food name cannot be
 * mistaken for structure.
 */
async function* streamArray(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let buf = '';
  let pos = 0;          // where the scan has reached
  let objStart = -1;    // start of the object being read, if any
  let started = false, depth = 0, inString = false, escaped = false;

  for await (const chunk of stream) {
    buf += chunk;

    while (pos < buf.length) {
      const c = buf[pos];

      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (!started) {
        if (c === '[') started = true;
      } else if (c === '{') {
        if (depth === 0) objStart = pos;
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
          yield buf.slice(objStart, pos + 1);
          objStart = -1;
        }
      }
      pos++;
    }

    // Drop what has been consumed. Anything belonging to an object still being
    // read has to survive into the next chunk, so compaction starts there.
    const keepFrom = objStart >= 0 ? objStart : pos;
    if (keepFrom > 0) {
      buf = buf.slice(keepFrom);
      pos -= keepFrom;
      if (objStart >= 0) objStart = 0;
    }
  }
}

const NUTRIENT = { 1008: 'calories', 1003: 'protein', 1004: 'fat', 1005: 'carbs' };
const KJ = 1062;

function extract(food) {
  const name = String(food.description || '').trim();
  if (!name) return null;

  const per100 = { calories: null, protein: 0, fat: 0, carbs: 0 };
  let kj = null;

  for (const row of food.foodNutrients || []) {
    const id = row?.nutrient?.id;
    const amount = Number(row?.amount);
    if (!Number.isFinite(amount)) continue;
    if (id === KJ) { kj = amount; continue; }
    const key = NUTRIENT[id];
    if (key) per100[key] = amount;
  }

  if (per100.calories === null && kj !== null) per100.calories = kj / 4.184;
  if (per100.calories === null) return null;

  const rounded = {
    calories: Math.round(per100.calories * 10) / 10,
    protein: Math.round(per100.protein * 10) / 10,
    fat: Math.round(per100.fat * 10) / 10,
    carbs: Math.round(per100.carbs * 10) / 10
  };
  // The same physical check the live lookups use, so a broken row cannot reach
  // the bundled table either.
  if (!isPlausible(rounded)) return null;

  return { name, per100: rounded, dataType: food.dataType || 'unknown' };
}

const searchKey = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

fs.rmSync(out, { force: true });
const db = new DatabaseSync(out);
db.exec(`
  CREATE TABLE foods (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    search   TEXT NOT NULL,
    kcal     REAL NOT NULL,
    protein  REAL NOT NULL,
    fat      REAL NOT NULL,
    carbs    REAL NOT NULL,
    source   TEXT NOT NULL
  );
  CREATE INDEX idx_foods_search ON foods(search);
`);

const insert = db.prepare(
  'INSERT INTO foods (name, search, kcal, protein, fat, carbs, source) VALUES (?, ?, ?, ?, ?, ?, ?)');

const seen = new Set();
let read = 0, kept = 0, rejected = 0, duplicate = 0;

db.exec('BEGIN');
for (const file of inputs) {
  let fileKept = 0;
  for await (const text of streamArray(file)) {
    read++;
    let food;
    try { food = JSON.parse(text); } catch { rejected++; continue; }

    const row = extract(food);
    if (!row) { rejected++; continue; }

    // The same food appears in more than one dataset; the first file listed
    // wins, so pass the better-curated one first.
    const key = searchKey(row.name);
    if (seen.has(key)) { duplicate++; continue; }
    seen.add(key);

    insert.run(row.name, key, row.per100.calories, row.per100.protein,
      row.per100.fat, row.per100.carbs, row.dataType);
    kept++; fileKept++;
  }
  console.log(`  ${file.split('/').pop()}: kept ${fileKept}`);
}
db.exec('COMMIT');
db.exec('VACUUM');

const size = fs.statSync(out).size;
console.log(`\nread ${read}, kept ${kept}, dropped ${rejected} implausible or empty, ${duplicate} duplicates`);
console.log(`${out} — ${(size / 1024).toFixed(0)} KB`);
