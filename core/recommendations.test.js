import test from 'node:test';
import assert from 'node:assert/strict';
import { getMacroRecommendation, LEAN_PROTEIN_FOODS } from './recommendations.js';

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
  assert.match(rec.text, /Fats are high today.*protein is lagging/);
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
  assert.match(rec.text, /Carb check/);
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
  assert.match(rec.text, /Awesome macro balance/);
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
  assert.match(rec.text, /vegetarian/i);
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
  assert.match(rec.text, /Fiber check/);
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
  assert.match(rec.text, /fiber intake/i);
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
  assert.match(rec.text, /98g/);
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
  assert.match(rec.text, /crushed/i);
});
