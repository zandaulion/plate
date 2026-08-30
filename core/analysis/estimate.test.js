import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fromModelResponse, totalsOf, rangesOf, setItemGrams, setTotalGrams,
  removeItem, addManualItem, itemMacros, ERROR_BANDS
} from './estimate.js';

const RESPONSE = {
  is_food: true,
  note: '',
  items: [
    { name: 'chicken breast', grams: 150, calories: 248, protein_g: 46.5, fat_g: 5.4, carbs_g: 0 },
    { name: 'white rice', grams: 200, calories: 260, protein_g: 5.4, fat_g: 0.6, carbs_g: 56 }
  ]
};

test('builds items from a model response', () => {
  const e = fromModelResponse(RESPONSE);
  assert.equal(e.items.length, 2);
  assert.equal(e.items[0].name, 'chicken breast');
  assert.equal(e.items[0].grams, 150);
  assert.equal(e.portionConfirmed, false);
});

test('totals match the model response before any edit', () => {
  const t = totalsOf(fromModelResponse(RESPONSE));
  assert.equal(t.calories, 508);
  assert.equal(t.grams, 350);
  assert.equal(t.protein, 51.9);
});

test('editing one weight rescales only that item', () => {
  const e = fromModelResponse(RESPONSE);
  const rice = e.items[1].id;
  const after = setItemGrams(e, rice, 100);

  assert.equal(after.items[1].grams, 100);
  assert.equal(after.items[0].grams, 150, 'the other item is untouched');
  // rice halved: 260 -> 130, so 248 + 130
  assert.equal(totalsOf(after).calories, 378);
});

test('correcting the total weight distributes proportionally', () => {
  const e = fromModelResponse(RESPONSE);
  const after = setTotalGrams(e, 175); // half of 350

  assert.equal(totalsOf(after).grams, 175);
  assert.equal(after.items[0].grams, 75);
  assert.equal(after.items[1].grams, 100);
  assert.equal(totalsOf(after).calories, 254, 'nutrition halves with the weight');
});

test('any portion edit marks the estimate as corrected', () => {
  const e = fromModelResponse(RESPONSE);
  assert.equal(setTotalGrams(e, 400).portionConfirmed, true);
  assert.equal(setItemGrams(e, e.items[0].id, 10).portionConfirmed, true);
});

test('the range narrows once the portion is confirmed', () => {
  const raw = fromModelResponse(RESPONSE);
  const corrected = setTotalGrams(raw, 350); // same weight, but now confirmed

  const width = (r) => (r.calories.high - r.calories.low) / r.calories.value;
  assert.ok(width(rangesOf(corrected)) < width(rangesOf(raw)),
    'confirming the weight must visibly tighten the estimate');

  assert.equal(rangesOf(raw).calories.low, Math.round(508 * (1 - ERROR_BANDS.raw.calories)));
});

test('fat is always carried at lower confidence than calories', () => {
  const r = rangesOf(fromModelResponse(RESPONSE));
  assert.equal(r.fat.confidence, 'low');
  assert.equal(r.calories.confidence, 'medium');
  assert.ok(ERROR_BANDS.corrected.fat > ERROR_BANDS.corrected.calories);
});

test('items with no weight are dropped, not kept at zero', () => {
  const e = fromModelResponse({
    items: [
      { name: 'lettuce', grams: 0, calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
      { name: 'salt', calories: 0, protein_g: 0, fat_g: 0, carbs_g: 0 },
      ...RESPONSE.items
    ]
  });
  assert.equal(e.items.length, 2);
});

test('an item with missing macros survives with zero rates', () => {
  const e = fromModelResponse({ items: [{ name: 'mystery sauce', grams: 30 }] });
  assert.equal(e.items.length, 1);
  assert.equal(itemMacros(e.items[0]).calories, 0);
});

test('malformed responses produce an empty estimate rather than throwing', () => {
  for (const bad of [null, undefined, {}, { items: 'nope' }, { items: [null, {}] }]) {
    assert.equal(fromModelResponse(bad).items.length, 0);
  }
});

test('a negative or non-numeric weight edit is ignored', () => {
  const e = fromModelResponse(RESPONSE);
  assert.equal(setItemGrams(e, e.items[0].id, -5).items[0].grams, 150);
  assert.equal(setTotalGrams(e, 0), e);
  assert.equal(setTotalGrams(e, 'heavy'), e);
});

test('manual items take per-100g rates, as labels state them', () => {
  const e = addManualItem(fromModelResponse({ items: [] }), {
    name: 'olive oil', grams: 15,
    per100: { calories: 884, protein: 0, fat: 100, carbs: 0 }
  });
  const t = totalsOf(e);
  assert.equal(t.calories, 133); // 884 * 0.15
  assert.equal(t.fat, 15);
});

test('removeItem drops exactly one item', () => {
  const e = fromModelResponse(RESPONSE);
  const after = removeItem(e, e.items[0].id);
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].name, 'white rice');
});
