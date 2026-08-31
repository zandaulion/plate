// Food database lookups: Open Food Facts by barcode, and text search across
// Open Food Facts plus USDA FoodData Central when a key is configured.
//
// Both are proxied through the server rather than called from the browser:
// Open Food Facts asks for an identifying User-Agent, the USDA key must not
// reach the client, and proxying lets barcode hits be cached.

import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso, PRODUCT_DIR } from './db.js';
import { fromOpenFoodFacts, fromUsda, rankResults } from '../core/foods.js';

const UA = 'Plate/0.1 (self-hosted personal food log)';
const OFF_FIELDS = 'code,product_name,brands,quantity,serving_size,nutriments,'
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

export class LookupError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function cache(food) {
  if (!food) return food;
  db.prepare(`
    INSERT INTO food_cache (id, barcode, name, source, per100_json, serving_g, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, per100_json = excluded.per100_json,
      serving_g = excluded.serving_g, fetched_at = excluded.fetched_at
  `).run(food.id, food.barcode, food.name, food.source,
    JSON.stringify(food.per100), food.servingG, nowIso());
  return food;
}

function cachedBarcode(code) {
  const row = db.prepare('SELECT * FROM food_cache WHERE barcode = ? ORDER BY fetched_at DESC LIMIT 1')
    .get(code);
  if (!row) return null;
  return {
    id: row.id, source: row.source, barcode: row.barcode, name: row.name,
    per100: JSON.parse(row.per100_json), servingG: row.serving_g, cached: true,
    hasImage: hasProductImage(row.barcode)
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
  if (!res.ok) throw new LookupError('upstream', `Food database returned ${res.status}.`, 502);
  return res.json();
}

/**
 * Barcode lookup. Cached hits are returned without a network call: the same
 * few products get scanned over and over, and a barcode's nutrition does not
 * change between scans.
 */
export async function lookupBarcode(rawCode) {
  const code = String(rawCode || '').replace(/\D/g, '');
  if (code.length < 6 || code.length > 14) {
    throw new LookupError('bad_barcode', 'That does not look like a barcode.', 400);
  }

  const hit = cachedBarcode(code);
  if (hit) return hit;

  const json = await getJson(
    `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=${OFF_FIELDS}`);

  if (json?.status === 0 || !json?.product) {
    throw new LookupError('not_found', 'That barcode is not in the database yet.', 404);
  }

  const food = fromOpenFoodFacts({ ...json.product, code });
  if (food?.imageUrl) await cacheProductImage(code, food.imageUrl);
  if (!food) {
    // The product exists but carries no usable nutrition. Saying so is more
    // useful than "not found", because the remedy is different: enter it by
    // hand rather than try a different barcode.
    throw new LookupError('no_nutrition',
      'That product is listed but has no nutrition information. Add it by hand.', 422);
  }
  return { ...cache(food), hasImage: hasProductImage(code) };
}

async function searchOpenFoodFacts(query) {
  const url = 'https://world.openfoodfacts.org/cgi/search.pl'
    + `?search_terms=${encodeURIComponent(query)}`
    + `&search_simple=1&action=process&json=1&page_size=12&fields=${OFF_FIELDS}`;
  const json = await getJson(url);
  return (json?.products || []).map(fromOpenFoodFacts).filter(Boolean);
}

/**
 * USDA's own DEMO_KEY works without signup but is capped at roughly 30
 * requests an hour per IP. That is enough for the app to be useful out of the
 * box, and running dry degrades to packaged-food results rather than failing,
 * so it is a reasonable default -- but a free key removes the cap entirely and
 * should be set.
 */
const DEMO_KEY = 'DEMO_KEY';

async function searchUsda(query) {
  const key = (process.env.USDA_API_KEY || '').trim() || DEMO_KEY;
  if (!key) return [];

  // Foundation and SR Legacy are the generic whole-food tables; Branded is
  // excluded because Open Food Facts already covers packaged goods and does
  // it better.
  const url = 'https://api.nal.usda.gov/fdc/v1/foods/search'
    + `?query=${encodeURIComponent(query)}&pageSize=12`
    + '&dataType=Foundation,SR%20Legacy,Survey%20(FNDDS)'
    + `&api_key=${encodeURIComponent(key)}`;

  try {
    const json = await getJson(url);
    return (json?.foods || []).map(fromUsda).filter(Boolean);
  } catch {
    // USDA is the optional half. If it fails, packaged results are still
    // worth returning rather than failing the whole search.
    return [];
  }
}

/**
 * True when a dedicated key is set. The demo key still gives generic results,
 * but only until its hourly cap is reached, so the two are worth telling
 * apart when reporting capability.
 */
export function usdaConfigured() {
  return Boolean((process.env.USDA_API_KEY || '').trim());
}

export async function searchFoods(rawQuery) {
  const query = String(rawQuery || '').trim().slice(0, 80);
  if (query.length < 2) {
    throw new LookupError('short_query', 'Type at least two characters.', 400);
  }

  const [off, usda] = await Promise.allSettled([
    searchOpenFoodFacts(query),
    searchUsda(query)
  ]);

  const results = [
    ...(usda.status === 'fulfilled' ? usda.value : []),
    ...(off.status === 'fulfilled' ? off.value : [])
  ];

  if (!results.length && off.status === 'rejected') {
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
