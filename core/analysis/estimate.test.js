import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fromModelResponse, totalsOf, rangesOf, setItemGrams, setTotalGrams,
  removeItem, addManualItem, itemMacros, ERROR_BANDS, hasPhotoItems,
  markWeighed, portionSourceOf
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

test('any portion edit records a user estimate, never a weighing', () => {
  const e = fromModelResponse(RESPONSE);
  assert.equal(portionSourceOf(e), 'model');
  // The app cannot tell a glance from a scale, so an edit must claim the
  // weaker of the two.
  assert.equal(portionSourceOf(setTotalGrams(e, 400)), 'estimated');
  assert.equal(portionSourceOf(setItemGrams(e, e.items[0].id, 10)), 'estimated');
});

test('a declared weighing survives later nudges', () => {
  const weighed = markWeighed(fromModelResponse(RESPONSE));
  assert.equal(portionSourceOf(weighed), 'weighed');
  assert.equal(portionSourceOf(setTotalGrams(weighed, 400)), 'weighed',
    'someone who weighed the plate then adjusted is still working from a scale');
  assert.equal(portionSourceOf(markWeighed(weighed, false)), 'estimated');
});

test('the range narrows in three measured steps', () => {
  const raw = fromModelResponse(RESPONSE);
  const estimated = setTotalGrams(raw, 350);   // same weight, now user-set
  const weighed = markWeighed(estimated);

  const width = (e) => {
    const r = rangesOf(e);
    return (r.calories.high - r.calories.low) / r.calories.value;
  };
  assert.ok(width(raw) > width(estimated), 'a user estimate beats the model guess');
  assert.ok(width(estimated) > width(weighed), 'a scale beats a user estimate');

  assert.equal(rangesOf(raw).calories.low, Math.round(508 * (1 - ERROR_BANDS.model.calories)));
  assert.equal(rangesOf(estimated).calories.low, Math.round(508 * (1 - ERROR_BANDS.estimated.calories)));
});

test('an eyeballed correction does not claim a scale accuracy', () => {
  // The bug this replaced: any slider touch reported the 16% weighed band.
  const estimated = setTotalGrams(fromModelResponse(RESPONSE), 350);
  assert.notEqual(rangesOf(estimated).calories.low,
    Math.round(508 * (1 - ERROR_BANDS.weighed.calories)));
  assert.ok(ERROR_BANDS.estimated.calories > ERROR_BANDS.weighed.calories);
});

test('entries saved before portionSource existed are read conservatively', () => {
  // Legacy rows carry only a boolean, which cannot distinguish the two.
  assert.equal(portionSourceOf({ items: [], portionConfirmed: true }), 'estimated');
  assert.equal(portionSourceOf({ items: [], portionConfirmed: false }), 'model');
  assert.equal(portionSourceOf({ items: [], portionSource: 'nonsense' }), 'model');
});

test('fat is always carried at lower confidence than calories', () => {
  const r = rangesOf(fromModelResponse(RESPONSE));
  assert.equal(r.fat.confidence, 'low');
  assert.equal(r.calories.confidence, 'medium');
  for (const level of ['model', 'estimated', 'weighed']) {
    assert.ok(ERROR_BANDS[level].fat > ERROR_BANDS[level].calories, level);
  }
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

test('a database item carries no photo-error band', () => {
  const e = addManualItem({ items: [], portionConfirmed: false }, {
    name: 'Greek yoghurt', grams: 200,
    per100: { calories: 97, protein: 9, fat: 5, carbs: 3.6 }
  });
  const r = rangesOf(e);
  assert.equal(r.calories.value, 194);
  assert.equal(r.calories.low, 194, 'a scanned food must not be widened by photo error');
  assert.equal(r.calories.high, 194);
  assert.equal(r.calories.confidence, 'exact');
});

test('a mixed meal bands only the photographed part', () => {
  const photo = fromModelResponse(RESPONSE);            // 508 kcal, from a photo
  const mixed = addManualItem(photo, {
    name: 'Greek yoghurt', grams: 200,
    per100: { calories: 100, protein: 9, fat: 5, carbs: 4 }
  });                                                    // +200 kcal, exact

  const r = rangesOf(mixed);
  assert.equal(r.calories.value, 708);
  // The 200 exact kcal sit outside the band; only the 508 are widened.
  assert.equal(r.calories.low, Math.round(200 + 508 * (1 - ERROR_BANDS.model.calories)));
  assert.equal(r.calories.high, Math.round(200 + 508 * (1 + ERROR_BANDS.model.calories)));
});

test('hasPhotoItems distinguishes the two kinds of estimate', () => {
  assert.equal(hasPhotoItems(fromModelResponse(RESPONSE)), true);
  const manual = addManualItem({ items: [] }, {
    name: 'apple', grams: 150, per100: { calories: 52, protein: 0, fat: 0, carbs: 14 }
  });
  assert.equal(hasPhotoItems(manual), false);
  assert.equal(hasPhotoItems({ items: [] }), false);
});
