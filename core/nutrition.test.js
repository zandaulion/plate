import test from 'node:test';
import assert from 'node:assert/strict';
import {
  basalRate, maintenanceEnergy, activityFactor,
  sumMacros, caloriesFromMacros, macroAgreement, KCAL_PER_G
} from './nutrition.js';

test('basalRate matches Mifflin-St Jeor worked examples', () => {
  // 80 kg, 180 cm, 30 y: 10*80 + 6.25*180 - 5*30 = 1775
  assert.equal(basalRate({ weightKg: 80, heightCm: 180, ageYears: 30, sex: 'male' }), 1780);
  assert.equal(basalRate({ weightKg: 80, heightCm: 180, ageYears: 30, sex: 'female' }), 1614);
});

test('unstated sex takes the midpoint of the two equations', () => {
  const p = { weightKg: 70, heightCm: 170, ageYears: 40 };
  const male = basalRate({ ...p, sex: 'male' });
  const female = basalRate({ ...p, sex: 'female' });
  assert.equal(basalRate({ ...p, sex: null }), (male + female) / 2);
});

test('basalRate refuses impossible or missing inputs rather than guessing', () => {
  assert.equal(basalRate({ weightKg: 0, heightCm: 180, ageYears: 30, sex: 'male' }), null);
  assert.equal(basalRate({ weightKg: 80, heightCm: 180, sex: 'male' }), null);
  assert.equal(basalRate({ weightKg: 900, heightCm: 180, ageYears: 30, sex: 'male' }), null);
});

test('maintenanceEnergy returns a band, not a point', () => {
  const e = maintenanceEnergy({ weightKg: 80, heightCm: 180, ageYears: 30, sex: 'male', activity: 'moderate' });
  assert.equal(e.kcal, Math.round(1780 * 1.55));
  assert.ok(e.low < e.kcal && e.kcal < e.high, 'band brackets the point estimate');
  assert.equal(e.estimated, true);
});

test('the band widens when sex is unstated', () => {
  const base = { weightKg: 80, heightCm: 180, ageYears: 30, activity: 'moderate' };
  const known = maintenanceEnergy({ ...base, sex: 'male' });
  const unknown = maintenanceEnergy({ ...base, sex: null });
  const width = (e) => (e.high - e.low) / e.kcal;
  assert.ok(width(unknown) > width(known), 'unstated sex must not look as precise');
});

test('maintenanceEnergy is null when the profile is incomplete', () => {
  assert.equal(maintenanceEnergy({ weightKg: 80, heightCm: 180, ageYears: 30, sex: 'male' }), null);
  assert.equal(maintenanceEnergy(null), null);
});

test('activityFactor rejects unknown levels', () => {
  assert.equal(activityFactor('moderate'), 1.55);
  assert.equal(activityFactor('extremely-very-active'), null);
});

test('sumMacros ignores non-numeric fields instead of producing NaN', () => {
  const t = sumMacros([
    { calories: 100, protein: 10, fat: 2, carbs: 5 },
    { calories: '50', protein: null, fat: undefined, carbs: 5 }
  ]);
  assert.equal(t.calories, 150);
  assert.equal(t.protein, 10);
  assert.equal(t.carbs, 10);
  assert.equal(t.fat, 2);
});

test('caloriesFromMacros uses Atwater factors', () => {
  assert.equal(caloriesFromMacros({ protein: 10, fat: 10, carbs: 10 }),
    10 * KCAL_PER_G.protein + 10 * KCAL_PER_G.fat + 10 * KCAL_PER_G.carbs);
});

test('macroAgreement flags a model contradicting itself', () => {
  // 20p + 10f + 30c = 80 + 90 + 120 = 290 kcal
  assert.ok(macroAgreement({ calories: 290, protein: 20, fat: 10, carbs: 30 }) < 0.01);
  assert.ok(macroAgreement({ calories: 150, protein: 20, fat: 10, carbs: 30 }) > 0.5);
  assert.equal(macroAgreement({ calories: 0, protein: 1, fat: 1, carbs: 1 }), null);
});
