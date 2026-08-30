import test from 'node:test';
import assert from 'node:assert/strict';
import { fromOpenFoodFacts, fromUsda, parseServing, rankResults, toItem, isPlausible, summariseRecent } from './foods.js';

const OFF_PRODUCT = {
  code: '3017624010701',
  product_name: 'Nutella',
  brands: 'Ferrero',
  serving_size: '15 g',
  nutriments: {
    'energy-kcal_100g': 539, proteins_100g: 6.3, fat_100g: 30.9, carbohydrates_100g: 57.5
  }
};

test('an Open Food Facts product normalises to per-100g', () => {
  const f = fromOpenFoodFacts(OFF_PRODUCT);
  assert.equal(f.name, 'Nutella (Ferrero)');
  assert.equal(f.per100.calories, 539);
  assert.equal(f.per100.protein, 6.3);
  assert.equal(f.barcode, '3017624010701');
  assert.equal(f.servingG, 15);
});

test('the pluralised protein field is read correctly', () => {
  // proteins_100g, not protein_100g. Getting this wrong reports every
  // packaged food as protein-free, silently.
  const f = fromOpenFoodFacts(OFF_PRODUCT);
  assert.notEqual(f.per100.protein, 0);
});

test('a kJ-only record is converted to kcal', () => {
  const f = fromOpenFoodFacts({
    code: '1', product_name: 'Old record',
    nutriments: { energy_100g: 2227.9, proteins_100g: 6, fat_100g: 30, carbohydrates_100g: 57 }
  });
  assert.ok(Math.abs(f.per100.calories - 532.5) < 1, `got ${f.per100.calories}`);
});

test('a product with no usable energy is rejected, not returned empty', () => {
  assert.equal(fromOpenFoodFacts({ code: '1', product_name: 'Mystery', nutriments: {} }), null);
  assert.equal(fromOpenFoodFacts({ code: '1', nutriments: { 'energy-kcal_100g': 100 } }), null);
  assert.equal(fromOpenFoodFacts(null), null);
});

test('serving sizes parse, preferring the gram figure in brackets', () => {
  assert.equal(parseServing('30 g'), 30);
  assert.equal(parseServing('250ml'), 250);
  assert.equal(parseServing('1 bar (21 g)'), 21);
  assert.equal(parseServing('2,5 g'), 3);
  assert.equal(parseServing('one biscuit'), null);
  assert.equal(parseServing(''), null);
  assert.equal(parseServing('99999 g'), null);
});

test('a USDA record normalises from its nutrient ids', () => {
  const f = fromUsda({
    fdcId: 2709224, description: 'Banana, raw',
    foodNutrients: [
      { nutrientId: 1008, value: 89 }, { nutrientId: 1003, value: 1.09 },
      { nutrientId: 1004, value: 0.33 }, { nutrientId: 1005, value: 22.8 },
      { nutrientId: 1093, value: 1 }
    ]
  });
  assert.equal(f.name, 'Banana, raw');
  assert.equal(f.per100.calories, 89);
  assert.equal(f.per100.carbs, 22.8);
  assert.equal(f.source, 'usda');
});

test('a USDA record without energy is rejected', () => {
  assert.equal(fromUsda({ fdcId: 1, description: 'X', foodNutrients: [{ nutrientId: 1003, value: 5 }] }), null);
});

test('ranking puts the generic food above the branded one', () => {
  const results = [
    { name: 'Banana flavoured yoghurt (Jaouda)', source: 'openfoodfacts', per100: {} },
    { name: 'Banana, raw', source: 'usda', per100: {} }
  ];
  assert.equal(rankResults(results, 'banana')[0].name, 'Banana, raw',
    'searching "banana" must not return yoghurt first');
});

test('an exact name match wins', () => {
  const results = [
    { name: 'Banana bread', source: 'usda', per100: {} },
    { name: 'Banana', source: 'usda', per100: {} }
  ];
  assert.equal(rankResults(results, 'banana')[0].name, 'Banana');
});

test('toItem produces what addManualItem accepts', () => {
  const item = toItem(fromOpenFoodFacts(OFF_PRODUCT), 30);
  assert.equal(item.grams, 30);
  assert.equal(item.per100.calories, 539);
  assert.equal(toItem(null, 30), null);
  assert.equal(toItem(fromOpenFoodFacts(OFF_PRODUCT), 0), null);
});

test('a physically impossible energy figure is rejected', () => {
  // Seen in the wild: an Open Food Facts "olive oil" record claiming 6209
  // kcal/100g, which would have added six thousand phantom calories to a day.
  assert.equal(fromOpenFoodFacts({
    code: '1', product_name: 'Olive oil',
    nutriments: { 'energy-kcal_100g': 6209, proteins_100g: 0, fat_100g: 92, carbohydrates_100g: 0 }
  }), null);

  // Real olive oil is fine.
  assert.ok(fromOpenFoodFacts({
    code: '2', product_name: 'Olive oil',
    nutriments: { 'energy-kcal_100g': 884, proteins_100g: 0, fat_100g: 100, carbohydrates_100g: 0 }
  }));
});

test('macros that cannot fit in 100 g are rejected', () => {
  assert.equal(fromOpenFoodFacts({
    code: '1', product_name: 'Impossible',
    nutriments: { 'energy-kcal_100g': 400, proteins_100g: 60, fat_100g: 60, carbohydrates_100g: 60 }
  }), null);
});

test('macros implying impossible energy are rejected even when kcal looks sane', () => {
  // 95 g fat + 5 g carbs = 875 kcal, but stated as 200: one of the two is
  // wrong, and neither can be trusted.
  assert.equal(isPlausible({ calories: 200, protein: 0, fat: 95, carbs: 5 }), true);
  assert.equal(isPlausible({ calories: 200, protein: 30, fat: 95, carbs: 30 }), false);
});

test('a USDA record with a broken figure is rejected too', () => {
  assert.equal(fromUsda({
    fdcId: 1, description: 'Broken',
    foodNutrients: [{ nutrientId: 1008, value: 9999 }, { nutrientId: 1004, value: 10 }]
  }), null);
});

test('plausibility accepts ordinary foods across the range', () => {
  for (const per100 of [
    { calories: 0, protein: 0, fat: 0, carbs: 0 },        // water
    { calories: 52, protein: 0.3, fat: 0.2, carbs: 14 },  // apple
    { calories: 884, protein: 0, fat: 100, carbs: 0 },    // oil
    { calories: 400, protein: 25, fat: 33, carbs: 1.3 }   // cheddar
  ]) {
    assert.equal(isPlausible(per100), true, JSON.stringify(per100));
  }
});

test('recent foods collapse by name and count uses', () => {
  const now = Date.parse('2026-08-30T12:00:00Z');
  const per = { calories: 1, protein: 0.1, fat: 0, carbs: 0.2 };
  const rows = [
    { item: { name: 'Greek yoghurt', grams: 170, per }, loggedAt: '2026-08-30T08:00:00Z' },
    { item: { name: 'greek yoghurt', grams: 150, per }, loggedAt: '2026-08-29T08:00:00Z' },
    { item: { name: 'Steak', grams: 220, per }, loggedAt: '2026-08-29T19:00:00Z' }
  ];
  const out = summariseRecent(rows, { now });
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Greek yoghurt', 'the twice-eaten food ranks first');
  assert.equal(out[0].uses, 2);
  assert.equal(out[0].grams, 170, 'the newest occurrence supplies the default weight');
});

test('a daily staple outranks a newer one-off', () => {
  const now = Date.parse('2026-08-30T12:00:00Z');
  const per = { calories: 1, protein: 0, fat: 0, carbs: 0 };
  const rows = [{ item: { name: 'Restaurant curry', grams: 400, per }, loggedAt: '2026-08-30T11:00:00Z' }];
  for (let d = 1; d <= 8; d++) {
    rows.push({ item: { name: 'Porridge', grams: 250, per }, loggedAt: `2026-08-${22 + (d % 8)}T07:00:00Z` });
  }
  const out = summariseRecent(rows, { now });
  assert.equal(out[0].name, 'Porridge', 'the staple must beat the newer one-off');
});

test('recents ignore items with no rates or no weight', () => {
  const now = Date.now();
  assert.equal(summariseRecent([
    { item: { name: 'no rates', grams: 100 }, loggedAt: new Date().toISOString() },
    { item: { name: 'no weight', per: { calories: 1 } }, loggedAt: new Date().toISOString() },
    { item: { grams: 100, per: { calories: 1 } }, loggedAt: new Date().toISOString() }
  ], { now }).length, 0);
  assert.deepEqual(summariseRecent(null), []);
});

test('recents respect the limit', () => {
  const per = { calories: 1, protein: 0, fat: 0, carbs: 0 };
  const rows = Array.from({ length: 30 }, (_, i) => ({
    item: { name: `food ${i}`, grams: 100, per }, loggedAt: '2026-08-30T08:00:00Z'
  }));
  assert.equal(summariseRecent(rows, { limit: 5 }).length, 5);
});
