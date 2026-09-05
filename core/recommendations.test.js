import test from 'node:test';
import assert from 'node:assert/strict';
import { getMacroRecommendation, LEAN_PROTEIN_FOODS } from './recommendations.js';

/**
 * The English sentence a caller would show.
 *
 * `text` is now a template and `textArgs` the numbers for it, so the front end
 * can translate. These assertions are about the wording and the figures in it,
 * which is exactly what filling the template back in preserves.
 */
const say = (rec) =>
  String(rec.text).replace(/\{(\d+)\}/g, (_, i) => String(rec.textArgs?.[Number(i)] ?? ''));

test('recommends lean vegetable protein for vegetarian with high fat and low protein', () => {
  const rec = getMacroRecommendation({
    totals: { calories: 800, protein: 20, fat: 42, carbs: 80 },
    split: { protein: 10, carbs: 43, fat: 47 },
    diet: 'vegetarian',
    dietaryGoal: 'balanced',
    entriesCount: 2
  });

  assert.ok(rec, 'Expected a recommendation');
  assert.equal(rec.type, 'veg_high_fat_low_protein');
  assert.equal(rec.mood, 'thinking');
  assert.match(say(rec), /Fats are high today/);
  // The target is the point of the message: "20g" alone says nothing about
  // whether the day went well.
  assert.match(say(rec), /20g of your 83g target/);
  assert.ok(rec.suggestions.length > 0);
  assert.ok(rec.suggestions.some((s) => s.name.toLowerCase().includes('edamame') || s.name.toLowerCase().includes('skyr')));
});

test('recommends plant protein for vegan with low protein', () => {
  const rec = getMacroRecommendation({
    totals: { calories: 900, protein: 25, fat: 20, carbs: 150 },
    split: { protein: 11, carbs: 69, fat: 20 },
    diet: 'vegan',
    dietaryGoal: 'balanced',
    entriesCount: 2
  });

  assert.ok(rec);
  assert.equal(rec.type, 'vegan_low_protein');
  assert.ok(rec.suggestions.some((s) => s.name.toLowerCase().includes('seitan') || s.name.toLowerCase().includes('lentils')));
});

test('alerts when keto carbs exceed threshold', () => {
  const rec = getMacroRecommendation({
    totals: { calories: 600, protein: 30, fat: 40, carbs: 36 },
    split: { protein: 20, carbs: 24, fat: 56 },
    diet: 'keto',
    entriesCount: 2
  });

  assert.ok(rec);
  assert.equal(rec.type, 'keto_carbs_high');
  assert.match(say(rec), /Carb check/);
  assert.ok(rec.suggestions.some((s) => s.name.toLowerCase().includes('avocado')));
});

test('celebrates balanced macros when in target range', () => {
  const rec = getMacroRecommendation({
    totals: { calories: 1200, protein: 75, fat: 40, carbs: 135, fiber: 20 },
    split: { protein: 25, carbs: 45, fat: 30 },
    diet: 'omnivore',
    dietaryGoal: 'balanced',
    entriesCount: 3
  });

  assert.ok(rec);
  assert.equal(rec.type, 'balanced');
  assert.equal(rec.mood, 'happy');
  assert.match(say(rec), /Awesome macro balance/);
});

test('returns gentle start message for fresh day', () => {
  const rec = getMacroRecommendation({
    totals: { calories: 0, protein: 0, fat: 0, carbs: 0 },
    split: { protein: 0, carbs: 0, fat: 0 },
    diet: 'vegetarian',
    entriesCount: 0
  });

  assert.ok(rec);
  assert.equal(rec.type, 'start');
  assert.match(say(rec), /vegetarian/i);
});

test('alerts when daily fiber is low for logged food', () => {
  const rec = getMacroRecommendation({
    totals: { calories: 900, protein: 50, fat: 35, carbs: 90, fiber: 4 },
    split: { protein: 23, carbs: 41, fat: 36 },
    diet: 'omnivore',
    dietaryGoal: 'balanced',
    entriesCount: 2
  });

  assert.ok(rec);
  assert.equal(rec.type, 'fiber_low');
  assert.equal(rec.mood, 'thinking');
  assert.match(say(rec), /Fiber check/);
  assert.ok(rec.suggestions.some((s) => s.name.toLowerCase().includes('chia') || s.name.toLowerCase().includes('raspberries')));
});

test('celebrates when fiber goal is achieved', () => {
  const rec = getMacroRecommendation({
    totals: { calories: 1200, protein: 70, fat: 40, carbs: 140, fiber: 28 },
    split: { protein: 23, carbs: 47, fat: 30 },
    diet: 'omnivore',
    dietaryGoal: 'balanced',
    entriesCount: 3
  });

  assert.ok(rec);
  assert.equal(rec.type, 'fiber_goal_met');
  assert.equal(rec.mood, 'happy');
  assert.match(say(rec), /fiber intake/i);
});

test('does not flag 98g protein as lagging even if percentage is under 20%', () => {
  const rec = getMacroRecommendation({
    totals: { calories: 2400, protein: 98, fat: 120, carbs: 232, fiber: 20 },
    split: { protein: 16, carbs: 39, fat: 45 },
    diet: 'vegetarian',
    dietaryGoal: 'high_protein',
    entriesCount: 3,
    weightKg: 82.7
  });

  assert.ok(rec);
  assert.notEqual(rec.type, 'veg_high_fat_low_protein');
  assert.notEqual(rec.type, 'goal_protein_behind');
  assert.match(say(rec), /98g/);
});

test('celebrates when protein target is met for body weight', () => {
  const rec = getMacroRecommendation({
    totals: { calories: 2200, protein: 120, fat: 80, carbs: 250, fiber: 22 },
    split: { protein: 22, carbs: 45, fat: 33 },
    diet: 'omnivore',
    dietaryGoal: 'high_protein',
    entriesCount: 3,
    weightKg: 80
  });

  assert.ok(rec);
  assert.equal(rec.type, 'protein_target_met');
  assert.match(say(rec), /crushed/i);
});

test('the day that prompted this: 75g protein names the target it is short of', () => {
  // Real numbers from a logged day: 2337 kcal, 74.8g protein, 93.7g fat.
  // The old message said "protein is lagging (15%, 75g)" and left the reader
  // no way to tell whether 75g was a good day or a bad one.
  const rec = getMacroRecommendation({
    totals: { calories: 2337, protein: 74.8, fat: 93.7, carbs: 197.9, fiber: 10.6 },
    split: { protein: 15, carbs: 41, fat: 44 },
    diet: 'vegetarian',
    dietaryGoal: 'high_protein',
    entriesCount: 6,
    weightKg: 82.7
  });

  assert.ok(rec);
  assert.equal(rec.type, 'veg_high_fat_low_protein');
  assert.match(say(rec), /75g of your 116g target/);
  assert.doesNotMatch(say(rec), /lagging/);
});

test('every low-protein message states the target, whatever the diet', () => {
  // A protein figure without its target is the defect being guarded against,
  // and there is one of these messages per diet -- so the rule is checked
  // across all of them rather than on the one that happened to be reported.
  const cases = [
    ['vegetarian', 'veg_high_fat_low_protein'],
    ['pescatarian', 'pesc_high_fat_low_protein'],
    ['omnivore', 'omni_high_fat_low_protein']
  ];
  for (const [diet, type] of cases) {
    const rec = getMacroRecommendation({
      totals: { calories: 2000, protein: 45, fat: 110, carbs: 180 },
      split: { protein: 9, carbs: 41, fat: 50 },
      diet,
      dietaryGoal: 'balanced',
      entriesCount: 4,
      weightKg: 80
    });
    assert.equal(rec.type, type, diet);
    assert.match(say(rec), /45g of your 88g target/, diet);
  }

  const vegan = getMacroRecommendation({
    totals: { calories: 1800, protein: 40, fat: 60, carbs: 250 },
    split: { protein: 9, carbs: 61, fat: 30 },
    diet: 'vegan',
    dietaryGoal: 'balanced',
    entriesCount: 4,
    weightKg: 80
  });
  assert.equal(vegan.type, 'vegan_low_protein');
  assert.match(say(vegan), /40g of your 88g target/);
});

test('a plentiful day is not dressed up as "on track" when the goal is higher', () => {
  // 85g clears the do-not-nag threshold, but it is 73% of a 116g target and
  // the message used to claim the intake was "well on track".
  const rec = getMacroRecommendation({
    totals: { calories: 2000, protein: 85, fat: 70, carbs: 220, fiber: 20 },
    split: { protein: 17, carbs: 45, fat: 32 },
    diet: 'omnivore',
    dietaryGoal: 'high_protein',
    entriesCount: 4,
    weightKg: 82.7
  });

  assert.ok(rec);
  assert.match(say(rec), /85g of your 116g target/);
  assert.doesNotMatch(say(rec), /well on track/);
});
