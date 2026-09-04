// The vision prompt and the response shape it is bound to.
//
// Kept in core/ rather than in the server because the Android app will send
// the same prompt to the same model, and a prompt that drifts between the two
// clients would make their numbers disagree for no visible reason.
//
// The design follows the measurement run of 30 Aug 2026: the model is asked
// for per-item weights *and* per-item nutrition, because grounding the
// nutrition in a food database was measured to add nothing (34.8% -> 34.0%
// MAPE) while per-item weights are what the user needs in order to correct
// the part that does matter.

export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_food: { type: 'BOOLEAN' },
    note: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          grams: { type: 'NUMBER' },
          calories: { type: 'NUMBER' },
          protein_g: { type: 'NUMBER' },
          fat_g: { type: 'NUMBER' },
          carbs_g: { type: 'NUMBER' },
          fiber_g: { type: 'NUMBER' }
        },
        required: ['name', 'grams', 'calories', 'protein_g', 'fat_g', 'carbs_g', 'fiber_g']
      }
    }
  },
  required: ['is_food', 'items', 'note']
};

export const PROMPT = `You are reading a photograph of food in order to log it.

List every distinct food and drink you can see. For each one give:
  - a short plain name, as a person would say it ("chicken breast", "white rice",
    "olive oil dressing"), without brand names or cooking adjectives
  - the weight in grams of that item as served in this photo
  - the calories, protein, fat, carbohydrate and dietary fiber for that weight

Rules:
  - Report what is actually in the photo, for the whole portion shown. Not per
    100 g, not a standard serving.
  - Include cooking fat and dressings as their own item when you can see or
    infer them. Oil absorbed during frying, butter on vegetables and dressing
    on a salad are easy to miss and matter a great deal.
  - If several foods are mixed together and cannot be separated, give the dish
    one entry rather than guessing at its components.
  - Use anything in the frame that helps you judge size: a plate is usually
    26 cm across, a fork about 19 cm long, a standard mug holds 250 ml.
  - If the photo does not show food, set is_food to false and return no items.

In "note", say in one short sentence what limited your reading of the photo --
an obscured item, an unknown sauce, a portion you could not judge from the
angle. If nothing did, leave it empty.

Your weights will be corrected by the person who ate the meal, so give your
honest best estimate for each one rather than a cautious round number.`;

/**
 * The prompt, optionally carrying a correction from the person eating.
 *
 * A photograph can be read confidently and wrongly: a vegetarian shawarma and
 * a chicken one look alike, and no amount of portion adjustment fixes a
 * misidentification. The person at the table knows what they ordered, so their
 * word is stated as fact rather than as a hint to weigh up -- a model told
 * "consider that it may be vegetarian" will often keep its own answer.
 *
 * The correction is also a reason to start again rather than edit: swapping
 * chicken for falafel changes the whole nutrition of the dish, not one line of
 * it.
 */
export function buildPrompt(correction) {
  const note = String(correction || '').trim().slice(0, 200);
  if (!note) return PROMPT;

  return `${PROMPT}

IMPORTANT — the person eating this has corrected your reading. They said:

  "${note}"

They know what they ordered and you do not. Treat this as fact, not as a
suggestion, even where it contradicts what the photograph appears to show.
If it changes what the dish is, work the nutrition out again from the start
rather than adjusting your previous answer, and name the items accordingly.`;
}

/**
 * Normalises a raw model response into the shape core/analysis/estimate.js
 * expects, and reports why an empty result is empty.
 *
 * The distinction between "this is not food" and "this is food but I read
 * nothing from it" matters at the UI layer: the first is the user's mistake
 * and the second is ours, and they deserve different messages.
 */
export function parseResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'unreadable', items: [], note: '' };
  }

  if (raw.is_food === false) {
    return { ok: false, reason: 'not_food', items: [], note: String(raw.note || '') };
  }

  const items = Array.isArray(raw.items) ? raw.items : [];
  if (!items.length) {
    return { ok: false, reason: 'nothing_found', items: [], note: String(raw.note || '') };
  }

  return { ok: true, reason: null, items, note: String(raw.note || '') };
}

// ------------------------------------------------------------- leftovers

/**
 * Reading a plate at the end of a meal against the same plate at the start.
 *
 * Deliberately asks for a *fraction per item* rather than for grams. Two
 * reasons. The absolute weight has already been estimated once from the first
 * photograph, and asking again would replace that reading with a second one
 * taken from a worse angle -- half a portion is harder to judge than a whole
 * one, not easier. And the fraction is the thing the photographs actually
 * answer: they are the same plate under the same light, so what remains is a
 * comparison, which is the kind of judgement both models and people make far
 * better than an absolute reading.
 *
 * Per item, because one number for the whole plate cannot say that the chicken
 * went and the rice stayed -- and that is the case a photograph is for. If a
 * single fraction were enough, tapping "half" would have been enough too.
 */
export const LEFTOVERS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    same_meal: { type: 'BOOLEAN' },
    note: { type: 'STRING' },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          eaten: { type: 'NUMBER' }
        },
        required: ['id', 'eaten']
      }
    }
  },
  required: ['same_meal', 'items', 'note']
};

export function buildLeftoversPrompt(items) {
  const list = (items || [])
    .map((i) => `  ${i.id}: ${i.name} (${Math.round(i.grams)} g served)`)
    .join('\n');

  return `Two photographs of the same meal. The first was taken before eating,
the second after.

For each item listed below, judge what fraction of it was eaten, as a number
between 0 and 1. 1 means it is all gone, 0 means it is untouched, 0.5 means
about half of it was eaten.

${list}

Judge each item on its own. People do not eat evenly: finishing the meat and
leaving the potatoes is ordinary, and reporting one figure across the plate
would be wrong in both directions at once.

Answer in fractions, not in grams. How much of the plate is gone is something
the two photographs show directly. How many grams that is has already been
worked out from the first photograph, and re-reading it from a half-eaten
plate would be a worse measurement, not a better one.

Judge only what you can see. Do not assume a plate is empty because it is
usual to finish. If an item is not visible in the second photograph and the
plate looks cleared, it was eaten; if it is hidden by a napkin or out of
frame, say so in the note and give your best guess.

Round to the nearest quarter unless you are confident of something finer. A
false precision helps nobody: 0.75 honestly is worth more than 0.7312.

Set same_meal to false if the second photograph is clearly not the same meal
as the first, and say why in the note. Guessing in that case would silently
rewrite what somebody ate.`;
}

/**
 * Reads the leftovers reply into fractions we can apply.
 *
 * Anything the model did not mention is left alone rather than assumed eaten:
 * an item missing from the reply is a gap in the answer, and filling it with
 * "all of it" would quietly restore the very number this feature exists to
 * correct.
 */
export function parseLeftovers(raw, items) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'unreadable', eaten: {}, note: '' };
  }
  const note = String(raw.note || '');
  if (raw.same_meal === false) {
    return { ok: false, reason: 'different_meal', eaten: {}, note };
  }

  const known = new Set((items || []).map((i) => i.id));
  const eaten = {};
  for (const row of Array.isArray(raw.items) ? raw.items : []) {
    const id = String(row?.id ?? '');
    const v = Number(row?.eaten);
    if (!known.has(id) || !Number.isFinite(v)) continue;
    eaten[id] = Math.min(1, Math.max(0, v));
  }

  if (!Object.keys(eaten).length) {
    return { ok: false, reason: 'nothing_read', eaten: {}, note };
  }
  return { ok: true, reason: null, eaten, note };
}
