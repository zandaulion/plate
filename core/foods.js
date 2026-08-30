// Normalising food-database records into one shape.
//
// Two sources, deliberately used for different jobs:
//
//   Open Food Facts  packaged food, looked up by barcode. Exact, free, no key,
//                    and the barcode makes it unambiguous. Its *text search*
//                    is heavily branded -- searching "banana" returns banana
//                    yoghurt before fruit -- so it is a poor generic index.
//   USDA FoodData    generic whole foods ("chicken breast, raw"), which is
//                    exactly where Open Food Facts is weakest. Needs a free
//                    key, so it is optional: without one the app still works,
//                    it just searches packaged food only.
//
// Everything downstream sees `per100`, matching how labels and databases both
// express nutrition, and how core/analysis/estimate.js accepts manual items.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Kilojoules per kilocalorie, for records that carry only kJ. */
const KJ_PER_KCAL = 4.184;

/**
 * Nothing edible exceeds about 900 kcal per 100 g -- that is pure fat, at
 * 9 kcal/g. Anything above this is a broken record: crowd-sourced databases
 * contain entries where kilojoules were typed into the kcal field, or a
 * per-package figure into a per-100 g one.
 *
 * These slip through silently and are far worse than a missing result,
 * because they land in the log looking like data. One search for "olive oil"
 * returned a record claiming 6,209 kcal per 100 g, which would have added
 * six thousand phantom calories to a day.
 */
const MAX_KCAL_PER_100G = 950;
const MACRO_TOLERANCE = 105; // grams per 100 g, allowing for rounding

export function isPlausible(per100) {
  if (!per100) return false;

  const { calories, protein, fat, carbs } = per100;
  if (!Number.isFinite(calories) || calories < 0 || calories > MAX_KCAL_PER_100G) return false;

  for (const macro of [protein, fat, carbs]) {
    if (!Number.isFinite(macro) || macro < 0 || macro > 100) return false;
  }
  if (protein + fat + carbs > MACRO_TOLERANCE) return false;

  // A record whose macros imply an impossible energy is broken even when the
  // stated calorie figure looks fine.
  if (protein * 4 + carbs * 4 + fat * 9 > MAX_KCAL_PER_100G) return false;

  return true;
}

function cleanName(...parts) {
  return parts
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 90);
}

/**
 * Open Food Facts product -> common shape.
 *
 * Returns null when there is no usable energy figure. A product with a name
 * and no nutrition is worse than no result: it looks like a hit, adds zero
 * calories, and quietly under-reports the day.
 */
export function fromOpenFoodFacts(product) {
  if (!product || typeof product !== 'object') return null;

  const n = product.nutriments || {};
  let calories = num(n['energy-kcal_100g']);
  if (calories === null && num(n.energy_100g) !== null) {
    // Older records store only kJ.
    calories = num(n.energy_100g) / KJ_PER_KCAL;
  }
  if (calories === null) return null;

  const name = cleanName(product.product_name, product.brands ? `(${product.brands})` : '');
  if (!name) return null;

  const per100 = {
    calories: Math.round(calories * 10) / 10,
    // Open Food Facts pluralises this one field; getting it wrong silently
    // reports every packaged food as containing no protein.
    protein: num(n.proteins_100g) ?? 0,
    fat: num(n.fat_100g) ?? 0,
    carbs: num(n.carbohydrates_100g) ?? 0
  };
  if (!isPlausible(per100)) return null;

  return {
    id: `off:${product.code || ''}`,
    source: 'openfoodfacts',
    barcode: product.code ? String(product.code) : null,
    name,
    per100,
    servingG: parseServing(product.serving_size)
  };
}

/** "30 g", "250ml", "1 bar (21 g)" -> grams, or null when unparseable. */
export function parseServing(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  // Prefer a parenthesised gram figure: "1 bar (21 g)" means 21 g, not 1.
  const paren = s.match(/\((\d+(?:[.,]\d+)?)\s*(?:g|ml)\)/);
  const plain = s.match(/(\d+(?:[.,]\d+)?)\s*(?:g|ml)\b/);
  const hit = paren || plain;
  if (!hit) return null;
  const grams = Number(hit[1].replace(',', '.'));
  return Number.isFinite(grams) && grams > 0 && grams < 5000 ? Math.round(grams) : null;
}

const USDA_NUTRIENTS = { 1008: 'calories', 1003: 'protein', 1004: 'fat', 1005: 'carbs' };

/**
 * USDA FoodData Central record -> common shape.
 * Its values are already per 100 g for every data type we query.
 */
export function fromUsda(food) {
  if (!food || typeof food !== 'object') return null;

  const per100 = { calories: null, protein: 0, fat: 0, carbs: 0 };
  for (const row of food.foodNutrients || []) {
    const key = USDA_NUTRIENTS[row.nutrientId ?? row.nutrient?.id];
    if (!key) continue;
    const value = num(row.value ?? row.amount);
    if (value !== null) per100[key] = value;
  }
  if (per100.calories === null) return null;

  const name = cleanName(food.description, food.brandOwner ? `(${food.brandOwner})` : '');
  if (!name) return null;

  const rounded = {
    calories: Math.round(per100.calories * 10) / 10,
    protein: per100.protein,
    fat: per100.fat,
    carbs: per100.carbs
  };
  if (!isPlausible(rounded)) return null;

  return {
    id: `usda:${food.fdcId}`,
    source: 'usda',
    barcode: null,
    name,
    per100: rounded,
    servingG: null
  };
}

/**
 * Orders search hits so the useful one is first.
 *
 * Exact and prefix name matches outrank substring matches, and unbranded
 * records outrank branded ones -- someone typing "banana" wants the fruit, not
 * a banana-flavoured drink, and Open Food Facts alone ranks it the other way.
 */
export function rankResults(results, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return results;

  const score = (r) => {
    const name = r.name.toLowerCase();
    const branded = /\(/.test(r.name) || r.source === 'openfoodfacts';
    let s = 0;
    if (name === q) s += 100;
    else if (name.startsWith(q)) s += 60;
    else if (name.includes(q)) s += 30;
    // A shorter name is usually the more generic record.
    s += Math.max(0, 30 - name.length / 3);
    if (!branded) s += 25;
    return s;
  };

  return [...results].sort((a, b) => score(b) - score(a));
}

/** A search hit at a chosen weight, ready for estimate.addManualItem. */
export function toItem(food, grams) {
  const g = Number(grams);
  if (!food || !Number.isFinite(g) || g <= 0) return null;
  return { name: food.name, grams: g, per100: food.per100 };
}
