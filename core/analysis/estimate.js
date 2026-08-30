// The estimate a photo produces, and what happens when the user corrects it.
//
// Shaped directly by the measurement run of 30 Aug 2026 (145 weighed plates,
// gemini-3.7-flash, see the macro-probe harness):
//
//   * Portion is the dominant error term. A weighed plate took median calorie
//     error from 30% to 16%, and the share within 25% of truth from 44% to
//     66%. Nothing else came close. But a follow-up run showed the benefit
//     depends on how the weight was obtained: an eyeballed correction recovers
//     about half of that, and a guess worse than +/-30% is no better than
//     leaving the model's own estimate alone. See ERROR_BANDS.
//   * Grounding the per-gram nutrition in a food database changed nothing
//     (34.8% -> 34.0% MAPE), because the model already knows what rice
//     contains. So the model's own per-gram figures are kept, and the editing
//     effort is spent on grams instead.
//   * Fat is the worst nutrient in every arm and the only one that got worse
//     when the weight was corrected. Absorbed oil and dressing are invisible
//     from above. It is carried at lower confidence throughout.
//
// Items therefore store a *per-gram rate*, not a fixed macro block: changing
// grams has to rescale the nutrition, and that only works if the rate is what
// is persisted.

const NUTRIENTS = ['calories', 'protein', 'fat', 'carbs'];

/**
 * Median absolute percentage error, measured. Used to draw the range shown
 * next to every number.
 *
 * Three levels, not two, because a follow-up run (30 Aug 2026, same 145
 * plates, with the user's weight simulated at a range of error levels) showed
 * that *how* the weight was arrived at matters as much as whether it was
 * corrected at all:
 *
 *   weight source          kcal median   within 25%
 *   model's own guess          30.0%        44%
 *   user guessed, +/-20%       22.6%        54%
 *   user guessed, +/-30%       28.4%        45%   <- barely better than none
 *   user guessed, +/-40%       34.0%        38%   <- worse than none
 *   weighed on a scale         16.0%        66%
 *
 * So correcting by eye helps, but only about half as much as a scale, and it
 * stops helping once the guess is worse than about 30%. Reporting a 16% band
 * for an eyeballed adjustment -- as this originally did -- claims an accuracy
 * only a scale delivers.
 */
export const ERROR_BANDS = {
  model:     { calories: 0.30, protein: 0.25, carbs: 0.28, fat: 0.42 },
  estimated: { calories: 0.23, protein: 0.23, carbs: 0.23, fat: 0.36 },
  weighed:   { calories: 0.16, protein: 0.15, carbs: 0.16, fat: 0.33 }
};

/** How the weight in this estimate was arrived at. */
export const PORTION_SOURCES = ['model', 'estimated', 'weighed'];

/**
 * Reads the portion source, tolerating entries saved before this existed.
 * Those carry only a boolean, and a boolean cannot tell an eyeballed
 * adjustment from a weighed one -- the conservative reading is the former.
 */
export function portionSourceOf(estimate) {
  const declared = estimate?.portionSource;
  if (PORTION_SOURCES.includes(declared)) return declared;
  return estimate?.portionConfirmed ? 'estimated' : 'model';
}

export const CONFIDENCE = { calories: 'medium', protein: 'medium', carbs: 'medium', fat: 'low' };

const round = (n, dp = 1) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

let seq = 0;
const nextId = () => `it${++seq}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Builds an estimate from the model's raw response.
 *
 * Items whose weight is missing or non-positive are dropped: a zero-gram item
 * contributes nothing but occupies a row the user has to dismiss. Items whose
 * macros are absent are kept with zero rates rather than discarded, so the
 * food still appears and can be corrected by hand.
 */
export function fromModelResponse(raw) {
  const src = Array.isArray(raw?.items) ? raw.items : [];
  const items = [];

  for (const it of src) {
    const grams = Number(it?.grams);
    if (!Number.isFinite(grams) || grams <= 0) continue;

    const name = String(it?.name || '').trim();
    if (!name) continue;

    // Per gram, so that editing the weight rescales the nutrition.
    const per = {
      calories: safeRate(it?.calories, grams),
      protein: safeRate(it?.protein_g ?? it?.protein, grams),
      fat: safeRate(it?.fat_g ?? it?.fat, grams),
      carbs: safeRate(it?.carbs_g ?? it?.carbs, grams)
    };

    items.push({ id: nextId(), name, grams: round(grams, 0), per, source: 'photo' });
  }

  return {
    items,
    portionSource: 'model',
    portionConfirmed: false,
    note: typeof raw?.note === 'string' ? raw.note.trim() : ''
  };
}

function safeRate(value, grams) {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0 || !grams) return 0;
  return v / grams;
}

/** Macros for one item at its current weight. */
export function itemMacros(item) {
  const out = {};
  for (const n of NUTRIENTS) out[n] = (item.per?.[n] || 0) * (item.grams || 0);
  return out;
}

export function totalsOf(estimate) {
  const t = { calories: 0, protein: 0, fat: 0, carbs: 0, grams: 0 };
  for (const item of estimate?.items || []) {
    const m = itemMacros(item);
    for (const n of NUTRIENTS) t[n] += m[n];
    t.grams += item.grams || 0;
  }
  for (const k of Object.keys(t)) t[k] = round(t[k], k === 'calories' || k === 'grams' ? 0 : 1);
  return t;
}

/**
 * Ranges to display. The band tightens as the weight becomes better known --
 * model guess, then user estimate, then scale -- because the measurement says
 * the estimate really is better at each step. It is not a cosmetic reward, and
 * it deliberately does not jump straight to the tightest band on any edit.
 *
 * The band applies only to the part of the meal a model read off a photograph.
 * A barcode or database item carries exact per-gram nutrition, so its only
 * uncertainty is the weight the user typed; widening it by the photo error
 * would claim doubt that is not there, and would make a carefully scanned
 * yoghurt look as vague as a guessed plate of stew.
 */
export function rangesOf(estimate) {
  const items = estimate?.items || [];
  const band = ERROR_BANDS[portionSourceOf(estimate)] || ERROR_BANDS.model;

  const photo = { calories: 0, protein: 0, fat: 0, carbs: 0 };
  const exact = { calories: 0, protein: 0, fat: 0, carbs: 0 };
  for (const item of items) {
    const target = item.source === 'photo' ? photo : exact;
    const m = itemMacros(item);
    for (const n of NUTRIENTS) target[n] += m[n];
  }

  const out = {};
  for (const n of NUTRIENTS) {
    const dp = n === 'calories' ? 0 : 1;
    const value = photo[n] + exact[n];
    out[n] = {
      value: round(value, dp),
      low: round(Math.max(0, exact[n] + photo[n] * (1 - band[n])), dp),
      high: round(exact[n] + photo[n] * (1 + band[n]), dp),
      confidence: photo[n] > 0 ? CONFIDENCE[n] : 'exact'
    };
  }
  return out;
}

/** True when any part of this estimate came from a photograph. */
export function hasPhotoItems(estimate) {
  return (estimate?.items || []).some((i) => i.source === 'photo');
}

/**
 * Records that the user has set the weight themselves.
 *
 * An edit is treated as an eyeballed estimate, never as a weighing: the app
 * cannot tell the difference, and assuming the better of the two would report
 * a scale's accuracy for a glance. `markWeighed` is the explicit upgrade, and
 * a weighing survives further nudges -- someone who weighed the plate and then
 * adjusted an item is still working from a scale.
 */
function withUserPortion(estimate) {
  return portionSourceOf(estimate) === 'weighed' ? 'weighed' : 'estimated';
}

/** Declare how the weight was arrived at. */
export function markWeighed(estimate, weighed = true) {
  return {
    ...estimate,
    portionSource: weighed ? 'weighed' : 'estimated',
    portionConfirmed: true
  };
}

/** Change one item's weight. */
export function setItemGrams(estimate, itemId, grams) {
  const g = Number(grams);
  if (!Number.isFinite(g) || g < 0) return estimate;
  return {
    ...estimate,
    portionSource: withUserPortion(estimate),
    portionConfirmed: true,
    items: estimate.items.map((it) => (it.id === itemId ? { ...it, grams: round(g, 0) } : it))
  };
}

/**
 * Correct the weight of the whole plate, distributing the change across items
 * in their existing proportions.
 *
 * This is the interaction the measurement argues for: in the probe, rescaling
 * the model's own answer by the true total weight recovered almost as much
 * accuracy as re-identifying every item (median 16.0% against 13.5%), for one
 * number from the user and no extra model call.
 */
export function setTotalGrams(estimate, totalGrams) {
  const target = Number(totalGrams);
  if (!Number.isFinite(target) || target <= 0) return estimate;

  const current = (estimate.items || []).reduce((a, i) => a + (i.grams || 0), 0);
  if (current <= 0) return estimate;

  const k = target / current;
  return {
    ...estimate,
    portionSource: withUserPortion(estimate),
    portionConfirmed: true,
    items: estimate.items.map((it) => ({ ...it, grams: round(it.grams * k, 0) }))
  };
}

export function removeItem(estimate, itemId) {
  return {
    ...estimate,
    items: (estimate.items || []).filter((it) => it.id !== itemId)
  };
}

/**
 * Add a food by hand. Rates are given per 100 g, which is how nutrition labels
 * and food databases express them.
 */
export function addManualItem(estimate, { name, grams, per100 }) {
  const g = Number(grams);
  if (!name || !Number.isFinite(g) || g <= 0) return estimate;
  const per = {};
  for (const n of NUTRIENTS) per[n] = (Number(per100?.[n]) || 0) / 100;
  return {
    ...estimate,
    items: [...(estimate.items || []), { id: nextId(), name: String(name).trim(), grams: round(g, 0), per, source: 'manual' }]
  };
}

export { NUTRIENTS };
