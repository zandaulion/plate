// Energy arithmetic. No I/O, no framework -- this file has to run unchanged
// inside the Android app later, so it stays free of Node and browser APIs.

/** Atwater factors: kcal per gram of each macronutrient. */
export const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

/**
 * Activity multipliers applied to BMR. The labels matter more than the
 * numbers: users pick badly when the options are abstract, so each one is
 * phrased as a week rather than as a category.
 */
export const ACTIVITY_LEVELS = [
  { id: 'sedentary', factor: 1.2,   label: 'Desk job, little or no exercise' },
  { id: 'light',     factor: 1.375, label: 'Light exercise, 1-3 days a week' },
  { id: 'moderate',  factor: 1.55,  label: 'Moderate exercise, 3-5 days a week' },
  { id: 'active',    factor: 1.725, label: 'Hard exercise, 6-7 days a week' },
  { id: 'very',      factor: 1.9,   label: 'Physical job, or training twice a day' }
];

export function activityFactor(id) {
  return ACTIVITY_LEVELS.find((l) => l.id === id)?.factor ?? null;
}

/**
 * Mifflin-St Jeor resting metabolic rate, in kcal/day.
 *
 * `sex` may be null: some people will not want to state it, and refusing to
 * compute anything is a worse answer than computing the midpoint and saying so.
 * The equations differ by a constant (+5 against -161), so the midpoint is
 * exactly the average of the two and is off by at most 83 kcal either way --
 * smaller than the equation's own error on an individual.
 */
export function basalRate(profile) {
  const { weightKg, heightCm, ageYears, sex } = profile || {};
  if (![weightKg, heightCm, ageYears].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (weightKg > 400 || heightCm > 260 || ageYears > 120) return null;

  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  if (sex === 'male') return base + 5;
  if (sex === 'female') return base - 161;
  return base - 78;
}

/**
 * Total daily energy expenditure: what this person burns on an average day.
 *
 * Returned as a range, not a number. Mifflin-St Jeor is fitted to population
 * means and lands within about 10% of measured RMR for most people, so a
 * single figure claims a precision the equation does not have. The product
 * shows this as a band on the day view for exactly that reason.
 */
export function maintenanceEnergy(profile) {
  const bmr = basalRate(profile);
  const factor = activityFactor(profile?.activity);
  if (bmr === null || factor === null) return null;

  const point = bmr * factor;
  // Widened when sex is unstated, because the midpoint carries the extra
  // ambiguity described in basalRate().
  const spread = profile?.sex === 'male' || profile?.sex === 'female' ? 0.10 : 0.14;

  return {
    bmr: Math.round(bmr),
    kcal: Math.round(point),
    low: Math.round(point * (1 - spread)),
    high: Math.round(point * (1 + spread)),
    estimated: true
  };
}

/** Sum a list of {calories, protein, fat, carbs} into one total. */
export function sumMacros(rows) {
  const t = { calories: 0, protein: 0, fat: 0, carbs: 0 };
  for (const r of rows || []) {
    for (const k of Object.keys(t)) {
      const v = Number(r?.[k]);
      if (Number.isFinite(v)) t[k] += v;
    }
  }
  return t;
}

/**
 * Calories implied by the macros, for cross-checking a model's answer against
 * itself. A vision model can return macros that do not add up to the calorie
 * figure it also returned; when they disagree badly the estimate is shakier
 * than either number suggests, and the UI says so.
 */
export function caloriesFromMacros({ protein = 0, fat = 0, carbs = 0 } = {}) {
  return protein * KCAL_PER_G.protein + fat * KCAL_PER_G.fat + carbs * KCAL_PER_G.carbs;
}

export function macroAgreement(entry) {
  const stated = Number(entry?.calories);
  const implied = caloriesFromMacros(entry || {});
  if (!Number.isFinite(stated) || stated <= 0 || implied <= 0) return null;
  return Math.abs(stated - implied) / stated;
}
