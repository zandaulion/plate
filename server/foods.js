// Food database lookups: Open Food Facts by barcode, and text search across
// Open Food Facts plus USDA FoodData Central when a key is configured.
//
// Both are proxied through the server rather than called from the browser:
// Open Food Facts asks for an identifying User-Agent, the USDA key must not
// reach the client, and proxying lets barcode hits be cached.

import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso, PRODUCT_DIR, addColumnIfMissing } from './db.js';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { fromOpenFoodFacts, rankResults, tokenise } from '../core/foods.js';

const UA = 'Plate/0.1 (self-hosted personal food log)';
// product_name_ro is requested alongside the generic name rather than instead
// of it: most imported products have only the generic one.
const OFF_FIELDS = 'code,product_name,product_name_ro,brands,quantity,serving_size,nutriments,'
  + 'image_front_small_url,image_small_url';

/** Bounded on purpose: this is a thumbnail, and the URL comes from a third party. */
const MAX_IMAGE_BYTES = 512 * 1024;

export const productImagePath = (barcode) =>
  path.join(PRODUCT_DIR, `${String(barcode).replace(/\D/g, '')}.jpg`);

export const hasProductImage = (barcode) => {
  if (!barcode) return false;
  try { return fs.statSync(productImagePath(barcode)).size > 0; } catch { return false; }
};

/**
 * Fetches a product shot once and keeps it, keyed by barcode.
 *
 * Never fatal: a missing picture is a missing picture, and an entry without
 * one is still a perfectly good entry. Failures are swallowed so a slow image
 * host cannot turn a working barcode scan into an error.
 */
async function cacheProductImage(barcode, url) {
  if (!url || !barcode || hasProductImage(barcode)) return;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return;
    if (!/^image\//.test(res.headers.get('content-type') || '')) return;

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return;
    fs.writeFileSync(productImagePath(barcode), buf);
  } catch {
    // Deliberately silent.
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS food_cache (
    id          TEXT PRIMARY KEY,
    barcode     TEXT,
    name        TEXT NOT NULL,
    source      TEXT NOT NULL,
    per100_json TEXT NOT NULL,
    serving_g   INTEGER,
    fetched_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_food_barcode ON food_cache(barcode);
`);

// The cached name is in whatever language it was fetched in, so the language
// is part of what identifies the row. Without it, a barcode first scanned in
// English kept serving its English name to a Romanian reader until the entry
// went stale on its own.
addColumnIfMissing('food_cache', 'locale', "TEXT NOT NULL DEFAULT 'en'");

export class LookupError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function cache(food, locale = 'en') {
  if (!food) return food;
  db.prepare(`
    INSERT INTO food_cache (id, barcode, name, source, per100_json, serving_g, fetched_at, locale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, per100_json = excluded.per100_json,
      serving_g = excluded.serving_g, fetched_at = excluded.fetched_at,
      locale = excluded.locale
  `).run(food.id, food.barcode, food.name, food.source,
    JSON.stringify(food.per100), food.servingG, nowIso(), locale);
  return food;
}

/**
 * How long a cached product is trusted before it is looked up again.
 *
 * Packaged food is reformulated, relabelled and corrected upstream. Caching a
 * barcode forever means a yoghurt scanned today is still reported with today's
 * recipe years from now, silently. Ninety days is short enough to catch a
 * reformulation within a season and long enough that a daily scan still costs
 * one request a quarter.
 */
const CACHE_TTL_DAYS = 90;

function cachedBarcode(code, locale = 'en') {
  const row = db.prepare(
    'SELECT * FROM food_cache WHERE barcode = ? AND locale = ? ORDER BY fetched_at DESC LIMIT 1')
    .get(code, locale);
  if (!row) return null;

  const fetchedAt = Date.parse(row.fetched_at);
  const ageDays = Number.isFinite(fetchedAt)
    ? (Date.now() - fetchedAt) / 86400000
    : Infinity;

  return {
    id: row.id, source: row.source, barcode: row.barcode, name: row.name,
    per100: JSON.parse(row.per100_json), servingG: row.serving_g, cached: true,
    hasImage: hasProductImage(row.barcode),
    stale: ageDays > CACHE_TTL_DAYS
  };
}

async function getJson(url, timeoutMs = 12000) {
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new LookupError('unreachable', 'Could not reach the food database.', 503);
  }
  if (!res.ok) {
    // The status is carried so a caller can tell "no such product" from "the
    // service is unwell". Open Food Facts answers 404 for a barcode it does
    // not know, which is a normal outcome of scanning, not a fault.
    const err = new LookupError('upstream', `Food database returned ${res.status}.`, 502);
    err.upstreamStatus = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Barcode lookup. Cached hits are returned without a network call: the same
 * few products get scanned over and over, and a barcode's nutrition does not
 * change between scans.
 */
export async function lookupBarcode(rawCode, locale = 'en') {
  const code = String(rawCode || '').replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) {
    throw new LookupError('bad_barcode', 'That does not look like a barcode.', 400);
  }

  const hit = cachedBarcode(code, locale);
  if (hit && !hit.stale) return hit;

  let json;
  try {
    json = await getJson(
      `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`);
  } catch (err) {
    // A refresh that fails must not take away an answer we already had. Stale
    // figures for a yoghurt beat an error message in a supermarket aisle.
    if (hit) return { ...hit, refreshFailed: true };
    if (err.upstreamStatus === 404) {
      throw new LookupError('not_found', 'That barcode is not in the database yet.', 404);
    }
    throw err;
  }

  if (json?.status === 0 || !json?.product) {
    if (hit) return { ...hit, refreshFailed: true };
    throw new LookupError('not_found', 'That barcode is not in the database yet.', 404);
  }

  const food = fromOpenFoodFacts({ ...json.product, code }, locale);
  // The row id carries the language too, or ON CONFLICT(id) would have one
  // language overwrite the other on every alternating lookup.
  if (food && locale !== 'en') food.id = `${food.id}:${locale}`;
  if (food?.imageUrl) await cacheProductImage(code, food.imageUrl);
  if (!food && hit) return { ...hit, refreshFailed: true };
  if (!food) {
    // The product exists but carries no usable nutrition. Saying so is more
    // useful than "not found", because the remedy is different: enter it by
    // hand rather than try a different barcode.
    throw new LookupError('no_nutrition',
      'That product is listed but has no nutrition information. Add it by hand.', 422);
  }
  return { ...cache(food, locale), hasImage: hasProductImage(code) };
}

async function searchOpenFoodFacts(query, locale = 'en') {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl'
    + `?search_terms=${encodeURIComponent(query)}`
    + `&search_simple=1&action=process&json=1&page_size=12&fields=${OFF_FIELDS}`;
  const json = await getJson(url);
  return (json?.products || []).map((p) => fromOpenFoodFacts(p, locale)).filter(Boolean);
}

/**
 * Generic foods come from a table shipped with the app, not from USDA's API.
 *
 * The API needs a key, and a key cannot travel inside an Android build where
 * anyone can extract it. A bundled table needs no key, no network and no rate
 * limit -- the demo key we were using was capped at about thirty requests an
 * hour, which a single evening of searching exhausts. It also means generic
 * search keeps working with no connection at all.
 *
 * Composition of a generic food does not drift, so this is rebuilt when
 * convenient rather than on a schedule. See scripts/build-food-table.mjs.
 */
const FOODS_DB = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'foods.sqlite');

let generic = null;
try {
  generic = new DatabaseSync(FOODS_DB, { readOnly: true });
  const n = generic.prepare('SELECT COUNT(*) AS n FROM foods').get().n;
  console.log(`generic food table: ${n} foods`);
} catch (err) {
  // Not fatal. Barcodes and packaged search still work; generic search does
  // not, and genericSearch() reports that rather than failing silently.
  console.warn('generic food table unavailable:', err.message);
  generic = null;
}

export function genericSearchAvailable() {
  return generic !== null;
}

/**
 * Every query word must appear, as a word or the start of one, in any order.
 *
 * Order-independence is the point: USDA writes names back to front, so
 * "olive oil" has to reach "Oil, olive, salad or cooking" and "chicken breast"
 * has to reach "Chicken, broilers or fryers, breast, meat only, raw".
 */
function searchGeneric(query) {
  if (!generic) return [];
  const tokens = tokenise(query).slice(0, 6);
  if (!tokens.length) return [];

  const where = tokens.map(() => '(search LIKE ? OR search LIKE ?)').join(' AND ');
  const args = tokens.flatMap((t) => [`${t}%`, `% ${t}%`]);

  return generic.prepare(
    `SELECT name, kcal, protein, fat, carbs FROM foods WHERE ${where} LIMIT 200`
  ).all(...args).map((r) => ({
    id: `usda:${r.name}`,
    source: 'usda',
    barcode: null,
    name: r.name,
    per100: { calories: r.kcal, protein: r.protein, fat: r.fat, carbs: r.carbs },
    servingG: null
  }));
}

/** Kept for the API shape the client already reads. */
export function usdaConfigured() {
  return genericSearchAvailable();
}

export async function searchFoods(rawQuery, locale = 'en') {
  const query = String(rawQuery || '').trim().slice(0, 80);
  if (query.length < 2) {
    throw new LookupError('short_query', 'Type at least two characters.', 400);
  }

  // The local table cannot fail or be slow, so it is not raced with anything.
  const local = searchGeneric(query);
  const off = await Promise.allSettled([searchOpenFoodFacts(query, locale)]).then((r) => r[0]);

  const results = [
    ...local,
    ...(off.status === 'fulfilled' ? off.value : [])
  ];

  if (!results.length && off.status === 'rejected' && !generic) {
    throw off.reason instanceof LookupError
      ? off.reason
      : new LookupError('unreachable', 'Could not reach the food database.', 503);
  }

  // De-duplicate on name: the same product often appears more than once.
  const seen = new Set();
  const unique = results.filter((f) => {
    const key = f.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return rankResults(unique, query).slice(0, 15);
}
