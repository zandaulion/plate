// The estimate a photo produces, and what happens when the user corrects it.
//
// Shaped directly by the measurement run of 30 Aug 2026 (145 weighed plates,
// gemini-3.7-flash, see the macro-probe harness):
//
//   * Portion is the dominant error term. Correcting the plate weight took
//     median calorie error from 30% to 16% and the share of plates within 25%
//     of truth from 44% to 66%. Nothing else came close.
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
 * Median absolute percentage error, from the run above. Used to draw the
 * range shown next to every number. `corrected` applies once the user has
 * confirmed or changed the weight; the band genuinely narrows, so the UI
 * rewards the correction with a visibly tighter estimate.
 */
export const ERROR_BANDS = {
  raw:       { calories: 0.30, protein: 0.25, carbs: 0.28, fat: 0.42 },
  corrected: { calories: 0.16, protein: 0.15, carbs: 0.16, fat: 0.33 }
};

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
 * Ranges to display. Once the portion has been confirmed the band tightens,
 * because the measurement says the estimate really is better -- this is not a
 * cosmetic reward.
 */
export function rangesOf(estimate) {
  const totals = totalsOf(estimate);
  const band = estimate?.portionConfirmed ? ERROR_BANDS.corrected : ERROR_BANDS.raw;
  const out = {};
  for (const n of NUTRIENTS) {
    const v = totals[n];
    out[n] = {
      value: v,
      low: round(Math.max(0, v * (1 - band[n])), n === 'calories' ? 0 : 1),
      high: round(v * (1 + band[n]), n === 'calories' ? 0 : 1),
      confidence: CONFIDENCE[n]
    };
  }
  return out;
}

/** Change one item's weight. Marks the portion as user-confirmed. */
export function setItemGrams(estimate, itemId, grams) {
  const g = Number(grams);
  if (!Number.isFinite(g) || g < 0) return estimate;
  return {
    ...estimate,
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
