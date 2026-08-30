// What someone actually burns, derived from evidence rather than a formula.
//
// Mifflin-St Jeor estimates expenditure from height, weight, age and sex, then
// multiplies by an activity factor the user picks from a list. It is a
// population average with an arbitrary coefficient bolted on, and it cannot
// notice that a particular person runs cold, fidgets, or has adapted to months
// of dieting.
//
// The energy balance identity gives a better answer when there is enough data:
//
//     expenditure = intake - (change in stored energy)
//
// Stored energy shows up as body mass. So over a window, with mean daily
// intake and the trend in weight:
//
//     expenditure = mean_intake - slope_kg_per_day * KCAL_PER_KG
//
// This is a *measurement*, not a prescription. It says what someone is
// burning; it does not say what they should eat. That distinction is why the
// approach belongs in this app at all.

import { weightTrend } from './weight.js';
import { maintenanceEnergy } from './nutrition.js';
import { ERROR_BANDS, portionSourceOf } from './analysis/estimate.js';

/**
 * Energy per kilogram of body mass change. The classic 7,700 kcal/kg figure.
 *
 * It is an approximation: fat carries roughly 9,400 kcal/kg and lean tissue far
 * less, because it is mostly water, so the true value depends on what is being
 * gained or lost. `KCAL_PER_KG_UNCERTAINTY` carries that into the band rather
 * than pretending the constant is exact.
 */
export const KCAL_PER_KG = 7700;
export const KCAL_PER_KG_UNCERTAINTY = 0.08;

/** A day below this is a partly-logged day, not a day of near-fasting. */
export const MIN_PLAUSIBLE_KCAL = 400;

export const REQUIREMENTS = {
  windowDays: 28,
  minLoggedDays: 14,
  // Unlogged days are the real hazard. Weight change reflects every day in the
  // window, but mean intake can only be taken over the days that were logged,
  // so using it assumes the missing days resembled the logged ones. Missed
  // days are rarely typical -- they are disproportionately the unusual meals --
  // so the estimate is refused rather than issued with a caveat nobody reads.
  minCoverage: 0.75,
  minWeighings: 6,
  minWeightSpanDays: 14
};

const DAY_MS = 86400000;
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

/** Blended error band for a day's calories, from how its portions were set. */
function dayBand(entries) {
  const rows = entries || [];
  if (!rows.length) return ERROR_BANDS.model.calories;

  let weighted = 0;
  let total = 0;
  for (const e of rows) {
    const kcal = Number(e?.totals?.calories) || 0;
    if (kcal <= 0) continue;
    const band = ERROR_BANDS[portionSourceOf(e)]?.calories ?? ERROR_BANDS.model.calories;
    weighted += band * kcal;
    total += kcal;
  }
  return total > 0 ? weighted / total : ERROR_BANDS.model.calories;
}

/** Collapses entries into one row per day, with that day's uncertainty. */
export function dailyIntake(entries) {
  const byDay = new Map();
  for (const e of entries || []) {
    if (!e?.day) continue;
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day).push(e);
  }

  return [...byDay.entries()].map(([day, rows]) => ({
    day,
    calories: rows.reduce((a, r) => a + (Number(r?.totals?.calories) || 0), 0),
    band: dayBand(rows)
  })).sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * Expenditure from evidence, or an explanation of what is missing.
 *
 * Always returns an object with `method`, so callers never have to guess
 * whether they are holding a measurement or a formula.
 */
export function adaptiveExpenditure({ entries = [], weights = [], profile = null, now = Date.now() } = {}) {
  const windowStart = now - REQUIREMENTS.windowDays * DAY_MS;
  const fromDay = dayKey(windowStart);

  const intake = dailyIntake(entries).filter((d) => d.day >= fromDay);
  const logged = intake.filter((d) => d.calories >= MIN_PLAUSIBLE_KCAL);
  const recentWeights = (weights || []).filter((w) => {
    const t = Date.parse(w.at ?? w.measured_at ?? w.date);
    return Number.isFinite(t) && t >= windowStart;
  });

  const coverage = logged.length / REQUIREMENTS.windowDays;
  const trend = weightTrend(recentWeights, {
    minReadings: REQUIREMENTS.minWeighings,
    minSpanDays: REQUIREMENTS.minWeightSpanDays
  });

  // Everything that is missing is reported at once, so the UI can tell someone
  // what to do rather than repeating "not enough data" as each gap clears.
  const missing = [];
  if (logged.length < REQUIREMENTS.minLoggedDays) {
    missing.push({ what: 'logged_days', have: logged.length, need: REQUIREMENTS.minLoggedDays });
  }
  if (coverage < REQUIREMENTS.minCoverage) {
    missing.push({
      what: 'coverage',
      have: Math.round(coverage * 100),
      need: Math.round(REQUIREMENTS.minCoverage * 100)
    });
  }
  if (!trend) {
    missing.push({
      what: 'weighings',
      have: recentWeights.length,
      need: REQUIREMENTS.minWeighings
    });
  }

  if (missing.length || !trend?.slopeSeKgPerDay) {
    const formula = maintenanceEnergy(profile);
    return {
      method: 'formula',
      ...(formula || {}),
      available: Boolean(formula),
      missing,
      progress: {
        loggedDays: logged.length,
        neededDays: REQUIREMENTS.minLoggedDays,
        weighings: recentWeights.length,
        neededWeighings: REQUIREMENTS.minWeighings,
        coveragePct: Math.round(coverage * 100)
      }
    };
  }

  const meanIntake = logged.reduce((a, d) => a + d.calories, 0) / logged.length;
  const meanBand = logged.reduce((a, d) => a + d.band * d.calories, 0)
    / logged.reduce((a, d) => a + d.calories, 0);

  const kcal = meanIntake - trend.slopeKgPerDay * KCAL_PER_KG;

  // Three independent sources of error, combined in quadrature:
  //   the mean of a noisy intake estimate, which shrinks with more days;
  //   the slope of the weight trend;
  //   the energy density of the tissue being gained or lost.
  const intakeSe = (meanIntake * meanBand) / Math.sqrt(logged.length);
  const slopeSe = trend.slopeSeKgPerDay * KCAL_PER_KG;
  const densitySe = Math.abs(trend.slopeKgPerDay) * KCAL_PER_KG * KCAL_PER_KG_UNCERTAINTY;
  const se = Math.sqrt(intakeSe ** 2 + slopeSe ** 2 + densitySe ** 2);

  // The t-multiplier comes from the weight fit, which is the smallest sample
  // in play and therefore the binding constraint.
  const t = tMultiplier(trend.df);

  return {
    method: 'measured',
    available: true,
    kcal: Math.round(kcal),
    low: Math.round(kcal - t * se),
    high: Math.round(kcal + t * se),
    estimated: true,
    basis: {
      windowDays: REQUIREMENTS.windowDays,
      loggedDays: logged.length,
      coveragePct: Math.round(coverage * 100),
      meanIntake: Math.round(meanIntake),
      weighings: trend.readings,
      weightSpanDays: trend.spanDays,
      slopeKgPerWeek: Math.round(trend.slopeKgPerWeek * 1000) / 1000,
      assumedKcalPerKg: KCAL_PER_KG
    },
    // The formula estimate alongside, because a large disagreement between the
    // two is itself information -- usually that intake is being under-logged.
    formula: maintenanceEnergy(profile)
  };
}

function tMultiplier(df) {
  const table = { 1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 12: 2.18, 15: 2.13, 20: 2.09, 25: 2.06, 30: 2.04, 40: 2.02 };
  const keys = Object.keys(table).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (df <= k) return table[k];
  return 1.96;
}
