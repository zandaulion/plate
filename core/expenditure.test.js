import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveExpenditure, dailyIntake, KCAL_PER_KG, REQUIREMENTS, MIN_PLAUSIBLE_KCAL } from './expenditure.js';

const DAY = 86400000;
const NOW = Date.parse('2026-08-30T12:00:00Z');
const dayKey = (offset) => new Date(NOW - offset * DAY).toISOString().slice(0, 10);

const PROFILE = { weightKg: 80, heightCm: 180, ageYears: 30, sex: 'male', activity: 'moderate' };

/**
 * Builds a person whose true expenditure is known, so the estimate can be
 * checked against the right answer rather than against itself.
 *
 * Eating `intake` against a true expenditure of `tdee` puts them in a deficit
 * of (tdee - intake) kcal/day, which the identity says must show up as
 * (deficit / KCAL_PER_KG) kg/day of weight change.
 */
function simulate({ tdee, intake, days = 28, startKg = 80, noiseKg = 0, weighEvery = 1, logEvery = 1 }) {
  const slope = (intake - tdee) / KCAL_PER_KG; // negative when in deficit
  const entries = [];
  const weights = [];

  // Deterministic pseudo-noise, so a failure is reproducible.
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let i = days; i >= 0; i--) {
    const at = new Date(NOW - i * DAY).toISOString();
    if (i % logEvery === 0) {
      entries.push({
        day: dayKey(i),
        portionSource: 'weighed',
        totals: { calories: intake, protein: 0, fat: 0, carbs: 0 }
      });
    }
    if (i % weighEvery === 0) {
      const trueKg = startKg + slope * (days - i);
      weights.push({ at, kg: trueKg + (rand() - 0.5) * 2 * noiseKg });
    }
  }
  return { entries, weights };
}

test('recovers a known expenditure from intake and weight change', () => {
  // 2,000 kcal/day against a true 2,500 is a 500 kcal deficit: about
  // 0.065 kg/day, or 0.45 kg a week.
  const { entries, weights } = simulate({ tdee: 2500, intake: 2000 });
  const out = adaptiveExpenditure({ entries, weights, profile: PROFILE, now: NOW });

  assert.equal(out.method, 'measured');
  assert.ok(Math.abs(out.kcal - 2500) < 25, `expected ~2500, got ${out.kcal}`);
  assert.ok(out.low < 2500 && 2500 < out.high, 'the band must contain the truth');
  assert.ok(Math.abs(out.basis.slopeKgPerWeek + 0.455) < 0.02, `slope ${out.basis.slopeKgPerWeek}`);
});

test('recovers expenditure for someone gaining weight too', () => {
  const { entries, weights } = simulate({ tdee: 2200, intake: 2700 });
  const out = adaptiveExpenditure({ entries, weights, profile: PROFILE, now: NOW });
  assert.ok(Math.abs(out.kcal - 2200) < 25, `expected ~2200, got ${out.kcal}`);
  assert.ok(out.basis.slopeKgPerWeek > 0, 'gaining weight must show a positive slope');
});

test('weight noise widens the band without moving the estimate much', () => {
  const clean = adaptiveExpenditure({ ...simulate({ tdee: 2500, intake: 2000 }), profile: PROFILE, now: NOW });
  const noisy = adaptiveExpenditure({
    ...simulate({ tdee: 2500, intake: 2000, noiseKg: 1.2 }), profile: PROFILE, now: NOW
  });

  const width = (o) => o.high - o.low;
  assert.ok(width(noisy) > width(clean) * 1.5,
    `a noisy weigher must get a visibly wider band (${width(clean)} -> ${width(noisy)})`);
  assert.ok(noisy.low < 2500 && 2500 < noisy.high, 'and it must still contain the truth');
});

test('refuses when too few days are logged, and says what is missing', () => {
  const { entries, weights } = simulate({ tdee: 2500, intake: 2000, logEvery: 4 });
  const out = adaptiveExpenditure({ entries, weights, profile: PROFILE, now: NOW });

  assert.equal(out.method, 'formula');
  const gaps = out.missing.map((m) => m.what);
  assert.ok(gaps.includes('logged_days') || gaps.includes('coverage'));
  assert.ok(out.progress.neededDays >= REQUIREMENTS.minLoggedDays);
});

test('refuses on poor coverage even when the day count is met', () => {
  // 15 logged days is over the count, but spread across a 60-day history the
  // window is only half covered and the unlogged days are unaccounted for.
  const { weights } = simulate({ tdee: 2500, intake: 2000 });
  const entries = [];
  for (let i = 0; i < 28; i += 2) {
    entries.push({ day: dayKey(i), portionSource: 'weighed', totals: { calories: 2000 } });
  }
  const out = adaptiveExpenditure({ entries, weights, profile: PROFILE, now: NOW });
  assert.equal(out.method, 'formula');
  assert.ok(out.missing.some((m) => m.what === 'coverage'));
});

test('refuses without enough weighings', () => {
  const { entries } = simulate({ tdee: 2500, intake: 2000 });
  const out = adaptiveExpenditure({ entries, weights: [], profile: PROFILE, now: NOW });
  assert.equal(out.method, 'formula');
  assert.ok(out.missing.some((m) => m.what === 'weighings'));
});

test('a barely-logged day is not counted as a day of fasting', () => {
  const { weights } = simulate({ tdee: 2500, intake: 2000 });
  const entries = [];
  for (let i = 0; i < 28; i++) {
    // Every fourth day only a coffee got logged.
    const calories = i % 4 === 0 ? 90 : 2000;
    entries.push({ day: dayKey(i), portionSource: 'weighed', totals: { calories } });
  }
  const out = adaptiveExpenditure({ entries, weights, profile: PROFILE, now: NOW });
  assert.ok(MIN_PLAUSIBLE_KCAL > 90);
  // Those days are dropped, not averaged in -- averaging them would drag mean
  // intake down and inflate expenditure by hundreds of kcal.
  assert.ok(out.basis === undefined || out.basis.meanIntake >= 1900,
    'partly-logged days must not drag the mean down');
});

test('falls back to the formula, labelled, and still reports progress', () => {
  const out = adaptiveExpenditure({ entries: [], weights: [], profile: PROFILE, now: NOW });
  assert.equal(out.method, 'formula');
  assert.equal(out.available, true);
  assert.equal(out.kcal, Math.round(1780 * 1.55), 'the Mifflin-St Jeor answer');
  assert.equal(out.progress.loggedDays, 0);
});

test('with no profile and no data it reports unavailable rather than guessing', () => {
  const out = adaptiveExpenditure({ entries: [], weights: [], profile: null, now: NOW });
  assert.equal(out.method, 'formula');
  assert.equal(out.available, false);
  assert.equal(out.kcal, undefined);
});

test('the measured answer carries the formula alongside it', () => {
  const { entries, weights } = simulate({ tdee: 2500, intake: 2000 });
  const out = adaptiveExpenditure({ entries, weights, profile: PROFILE, now: NOW });
  // A large gap between the two usually means intake is being under-logged,
  // which is worth being able to see.
  assert.ok(out.formula.kcal > 0);
  assert.notEqual(out.kcal, out.formula.kcal);
});

test('dailyIntake sums a day and blends its uncertainty by calories', () => {
  const rows = dailyIntake([
    { day: '2026-08-20', portionSource: 'weighed', totals: { calories: 800 } },
    { day: '2026-08-20', portionSource: 'model', totals: { calories: 200 } },
    { day: '2026-08-21', portionSource: 'model', totals: { calories: 500 } }
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].calories, 1000);
  // Weighted towards the weighed 800 kcal, so between the two bands and nearer
  // the tighter one.
  assert.ok(rows[0].band > 0.16 && rows[0].band < 0.30);
  assert.ok(rows[0].band < rows[1].band);
});

test('history older than the window is ignored', () => {
  const { entries, weights } = simulate({ tdee: 2500, intake: 2000 });
  const stale = [{ day: '2020-01-01', portionSource: 'weighed', totals: { calories: 9000 } }];
  const out = adaptiveExpenditure({
    entries: [...stale, ...entries], weights, profile: PROFILE, now: NOW
  });
  assert.ok(Math.abs(out.kcal - 2500) < 25, 'an old outlier must not reach the mean');
});
