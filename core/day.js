// Turning a list of logged entries into a day.
//
// Days are keyed by the user's local calendar date, computed on the client and
// stored with the entry. Deriving it server-side from a UTC timestamp would
// put a 23:30 dinner on tomorrow's total for anyone east of London, which is
// the sort of bug that makes a log untrustworthy without ever looking wrong.

import { sumMacros } from './nutrition.js';

/** YYYY-MM-DD in the *local* timezone of the device that logged it. */
export function localDayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];

/**
 * Summarises one day's entries against the maintenance band.
 *
 * `remaining` is deliberately absent when there is no maintenance estimate:
 * showing "remaining" without a target invites the app to invent one, and the
 * product deliberately does not prescribe intake.
 */
export function summariseDay(entries, maintenance = null) {
  const list = Array.isArray(entries) ? entries : [];
  const totals = sumMacros(list.map((e) => e.totals || e));

  const byMeal = {};
  for (const meal of MEALS) {
    const rows = list.filter((e) => e.meal === meal);
    if (rows.length) byMeal[meal] = { count: rows.length, totals: sumMacros(rows.map((e) => e.totals || e)) };
  }

  const summary = {
    entries: list.length,
    totals: {
      calories: Math.round(totals.calories),
      protein: Math.round(totals.protein * 10) / 10,
      fat: Math.round(totals.fat * 10) / 10,
      carbs: Math.round(totals.carbs * 10) / 10
    },
    byMeal,
    maintenance: maintenance || null
  };

  if (maintenance?.kcal) {
    summary.balance = {
      // Signed: positive means eaten above the midpoint of the band.
      kcal: Math.round(totals.calories - maintenance.kcal),
      // Whether the day's intake is distinguishable from maintenance at all,
      // given how wide the estimate's own band is.
      withinBand: totals.calories >= maintenance.low && totals.calories <= maintenance.high
    };
  }

  return summary;
}

/** Share of calories from each macro, for the day view's composition bar. */
export function macroSplit(totals) {
  const p = (totals?.protein || 0) * 4;
  const c = (totals?.carbs || 0) * 4;
  const f = (totals?.fat || 0) * 9;
  const sum = p + c + f;
  if (sum <= 0) return null;
  return {
    protein: Math.round((p / sum) * 100),
    carbs: Math.round((c / sum) * 100),
    fat: Math.round((f / sum) * 100)
  };
}
