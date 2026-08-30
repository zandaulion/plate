import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseDay, macroSplit, localDayKey, MEALS } from './day.js';

const ENTRIES = [
  { meal: 'breakfast', totals: { calories: 400, protein: 20, fat: 15, carbs: 45 } },
  { meal: 'lunch', totals: { calories: 700, protein: 45, fat: 25, carbs: 70 } },
  { meal: 'lunch', totals: { calories: 150, protein: 2, fat: 8, carbs: 18 } }
];

test('totals sum across every entry', () => {
  const d = summariseDay(ENTRIES);
  assert.equal(d.totals.calories, 1250);
  assert.equal(d.totals.protein, 67);
  assert.equal(d.entries, 3);
});

test('entries group by meal, and empty meals are omitted', () => {
  const d = summariseDay(ENTRIES);
  assert.equal(d.byMeal.lunch.count, 2);
  assert.equal(d.byMeal.lunch.totals.calories, 850);
  assert.ok(!('dinner' in d.byMeal), 'a meal with no entries should not appear');
});

test('no maintenance estimate means no balance, rather than an invented target', () => {
  const d = summariseDay(ENTRIES);
  assert.equal(d.maintenance, null);
  assert.ok(!('balance' in d), 'the app must not imply a target it was not given');
});

test('balance is signed against the midpoint and flagged against the band', () => {
  const m = { kcal: 2400, low: 2160, high: 2640 };
  assert.equal(summariseDay(ENTRIES, m).balance.kcal, -1150);
  assert.equal(summariseDay(ENTRIES, m).balance.withinBand, false);

  const big = [{ totals: { calories: 2300, protein: 0, fat: 0, carbs: 0 } }];
  assert.equal(summariseDay(big, m).balance.withinBand, true,
    'intake inside the estimate band is not distinguishable from maintenance');
});

test('an empty day is a real day, not a crash', () => {
  const d = summariseDay([], { kcal: 2000, low: 1800, high: 2200 });
  assert.equal(d.totals.calories, 0);
  assert.equal(d.entries, 0);
  assert.equal(summariseDay(null).totals.calories, 0);
});

test('macroSplit reports percentage of energy, not of weight', () => {
  // 25 g protein (100 kcal), 25 g carbs (100 kcal), 100/9 g fat (100 kcal)
  const s = macroSplit({ protein: 25, carbs: 25, fat: 100 / 9 });
  assert.deepEqual(s, { protein: 33, carbs: 33, fat: 33 });
});

test('macroSplit is null for an empty day rather than 0/0/0', () => {
  assert.equal(macroSplit({ protein: 0, carbs: 0, fat: 0 }), null);
  assert.equal(macroSplit(null), null);
});

test('localDayKey uses local calendar date', () => {
  assert.equal(localDayKey(new Date(2026, 7, 30, 23, 45)), '2026-08-30');
  assert.equal(localDayKey(new Date(2026, 0, 1, 0, 5)), '2026-01-01');
});

test('MEALS covers what the UI offers', () => {
  assert.deepEqual(MEALS, ['breakfast', 'lunch', 'dinner', 'snack']);
});
