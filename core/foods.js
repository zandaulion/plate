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
  if (per100.fiber !== undefined && per100.fiber !== null) {
    if (!Number.isFinite(per100.fiber) || per100.fiber < 0 || per100.fiber > 100) return false;
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
    carbs: num(n.carbohydrates_100g) ?? 0,
    fiber: num(n.fiber_100g) ?? num(n.fiber) ?? 0
  };
  if (!isPlausible(per100)) return null;

  return {
    id: `off:${product.code || ''}`,
    source: 'openfoodfacts',
    barcode: product.code ? String(product.code) : null,
    name,
    per100,
    servingG: parseServing(product.serving_size),
    // Where the product photo lives upstream. Only the server ever follows it:
    // fetching it from the browser would hand Open Food Facts the user's
    // address and a list of what they eat, which proxying the lookups exists
    // to prevent.
    imageUrl: product.image_front_small_url || product.image_small_url || null
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

const USDA_NUTRIENTS = { 1008: 'calories', 1003: 'protein', 1004: 'fat', 1005: 'carbs', 1079: 'fiber' };

/**
 * USDA FoodData Central record -> common shape.
 * Its values are already per 100 g for every data type we query.
 */
export function fromUsda(food) {
  if (!food || typeof food !== 'object') return null;

  const per100 = { calories: null, protein: 0, fat: 0, carbs: 0, fiber: 0 };
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
    carbs: per100.carbs,
    fiber: per100.fiber
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

/** Query and food names alike, reduced to comparable words. */
export const tokenise = (s) => String(s || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * Orders search hits so the useful one is first.
 *
 * Scored per word rather than on the phrase, because USDA writes names back to
 * front: "olive oil" has to find "Oil, olive, salad or cooking" and "chicken
 * breast" has to find "Chicken, broilers or fryers, breast, meat only, raw".
 * A phrase match finds neither.
 *
 * A whole word beats a word that merely starts the same way, which is what
 * keeps "Eggplant" below "Egg, whole, raw" for the query "egg" without
 * excluding it — "chick" should still reach chicken.
 *
 * Shorter names win ties, since the generic entry is nearly always the terse
 * one, and unbranded records outrank branded ones: someone typing "banana"
 * wants the fruit, not a banana-flavoured drink, and Open Food Facts alone
 * ranks it the other way.
 */
export function rankResults(results, query) {
  const wanted = tokenise(query);
  if (!wanted.length) return results;

  const score = (r) => {
    const name = String(r.name || '').toLowerCase();
    const words = tokenise(name);
    let s = 0;

    if (name === wanted.join(' ')) s += 120;

    const matched = new Set();

    for (const [i, token] of wanted.entries()) {
      // Plurals are the same food. Without this, "banana" scores "banana
      // powder" above "Bananas, raw", because only the former contains the
      // word exactly as typed.
      const wholeAt = words.findIndex((w) => w === token || w === `${token}s` || `${w}s` === token);
      const prefixAt = words.findIndex((w) => w.startsWith(token));

      // Only whole words count towards coverage. A name that merely starts
      // the same way should not be credited as being about the thing:
      // "Eggnog" is one word entirely matched by "egg" on a prefix test, and
      // would otherwise outrank "Egg, whole, raw".
      if (wholeAt !== -1) { s += 24; matched.add(wholeAt); }
      else if (prefixAt !== -1) s += 8;
      else s -= 20;                       // a word the name does not have at all

      // The first word of a name carries most of its meaning: "Oil, olive"
      // is oil, "Mayonnaise ... with olive oil" is mayonnaise.
      if (prefixAt === 0 && i === 0) s += 18;
    }

    // How much of the name the query accounts for. A terse entry that is
    // entirely about what was asked for beats a long one that merely mentions
    // it, without hard-coding a preference for short names.
    s += 40 * (matched.size / Math.max(1, words.length));

    // The leading word is the head noun. "Flour, rice, white" is flour and
    // "Rice, white, long-grain" is rice, and someone asking for white rice
    // wants the second.
    const headMatched = words.length
      && wanted.some((t) => words[0] === t || words[0] === `${t}s` || words[0].startsWith(t));
    if (!headMatched) s -= 22;

    if (!(/\(/.test(r.name) || r.source === 'openfoodfacts')) s += 14;
    return s;
  };

  return [...results]
    .map((r) => ({ r, s: score(r) }))
    .sort((a, b) => b.s - a.s)
    .map(({ r }) => r);
}

/**
 * A search hit at a chosen weight, ready for estimate.addManualItem.
 *
 * The barcode travels with the item so the server can find the product shot it
 * already cached, without the client ever handling an upstream image URL.
 */
export function toItem(food, grams) {
  const g = Number(grams);
  if (!food || !Number.isFinite(g) || g <= 0) return null;
  return { name: food.name, grams: g, per100: food.per100, barcode: food.barcode || null };
}

/**
 * Collapses recently logged items into a short list of foods worth offering
 * again.
 *
 * Eating is repetitive -- the same breakfast, the same yoghurt -- so without
 * this every repeat meal costs a fresh search. Input is one row per logged
 * item, newest first: { item, loggedAt }.
 *
 * Ranking blends how often a food is eaten with how recently, so a daily
 * staple outranks last Tuesday's restaurant dish even when the dish is newer.
 * That is what makes a separate "favourites" feature unnecessary: the foods
 * someone would star are exactly the ones they log most.
 */
export function summariseRecent(rows, { now = Date.now(), limit = 12 } = {}) {
  const byName = new Map();

  for (const row of rows || []) {
    const item = row?.item;
    const name = String(item?.name || '').trim();
    const grams = Number(item?.grams);
    if (!name || !Number.isFinite(grams) || grams <= 0) continue;

    const key = name.toLowerCase();
    const loggedAt = Date.parse(row.loggedAt);
    const existing = byName.get(key);

    if (!existing) {
      byName.set(key, {
        name,
        // The newest occurrence supplies the rates and the default weight:
        // if a food was corrected last time, that correction is the better
        // starting point than an older one.
        per: item.per || null,
        grams: Math.round(grams),
        barcode: item.barcode || null,
        uses: 1,
        lastUsed: Number.isFinite(loggedAt) ? loggedAt : 0
      });
      continue;
    }

    existing.uses += 1;
    if (Number.isFinite(loggedAt) && loggedAt > existing.lastUsed) {
      existing.lastUsed = loggedAt;
      existing.per = item.per || existing.per;
      existing.grams = Math.round(grams);
      existing.barcode = item.barcode || existing.barcode;
    }
  }

  const DAY = 86400000;
  const scored = [...byName.values()]
    .filter((f) => f.per)
    .map((f) => {
      const ageDays = Math.max(0, (now - f.lastUsed) / DAY);
      // Halving every fortnight: recent enough to stay current, slow enough
      // that a weekday staple survives a weekend away.
      return { ...f, score: f.uses * Math.pow(0.5, ageDays / 14) };
    });

  scored.sort((a, b) => b.score - a.score || b.lastUsed - a.lastUsed);
  return scored.slice(0, limit).map(({ score, ...rest }) => rest);
}

/**
 * Standard generic presets for micro-intake / grazing when the exact food
 * item or portion is unknown.
 *
 * Uses an honest standard snack macro split (~15% protein, 40% fat, 45% carbs)
 * so calories and macros are captured for energy expenditure calculation.
 */
export const QUICK_BITES = [
  { id: 'bite-50', name: 'Bite (~50 kcal)', label: 'Bite', icon: '🍏', calories: 50, grams: 15, protein: 1.9, fat: 2.2, carbs: 5.6, fiber: 0.5 },
  { id: 'bite-100', name: 'Handful (~100 kcal)', label: 'Handful', icon: '🥜', calories: 100, grams: 30, protein: 3.8, fat: 4.4, carbs: 11.3, fiber: 1.0 },
  { id: 'bite-200', name: 'Snack (~200 kcal)', label: 'Snack', icon: '🥐', calories: 200, grams: 60, protein: 7.5, fat: 8.9, carbs: 22.5, fiber: 2.0 }
];

/**
 * Creates a manual food item from a calorie figure or quick bite preset.
 */
export function createQuickBiteItem({ name, calories, grams = 30, protein, fat, carbs, fiber, barcode = null }) {
  const cal = Math.max(1, Number(calories) || 50);
  const g = Math.max(1, Number(grams) || 30);

  // Balanced default macro split if not supplied: 15% P, 40% F, 45% C
  const p = protein !== undefined ? Number(protein) : (cal * 0.15) / 4;
  const f = fat !== undefined ? Number(fat) : (cal * 0.40) / 9;
  const c = carbs !== undefined ? Number(carbs) : (cal * 0.45) / 4;
  const fib = fiber !== undefined ? Number(fiber) : Math.round((g * 0.02) * 10) / 10;

  const per100 = {
    calories: Math.round((cal / g) * 100 * 10) / 10,
    protein: Math.round((p / g) * 100 * 10) / 10,
    fat: Math.round((f / g) * 100 * 10) / 10,
    carbs: Math.round((c / g) * 100 * 10) / 10,
    fiber: Math.round((fib / g) * 100 * 10) / 10
  };

  return {
    name: String(name || `Bite (~${Math.round(cal)} kcal)`).trim(),
    grams: Math.round(g),
    per100,
    barcode: barcode ? String(barcode) : null
  };
}

/**
 * Filters recent foods to surface items suitable for grazing (e.g. snacks,
 * bite-sized items, or small portions under 400 kcal).
 */
export function getGrazingSuggestions(recentFoods, { limit = 3 } = {}) {
  if (!Array.isArray(recentFoods)) return [];
  return recentFoods
    .filter((f) => {
      const cal = (f.per?.calories || 0) * (f.grams || 0);
      return cal > 0 && cal <= 400;
    })
    .slice(0, limit);
}
