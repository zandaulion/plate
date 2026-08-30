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
          carbs_g: { type: 'NUMBER' }
        },
        required: ['name', 'grams', 'calories', 'protein_g', 'fat_g', 'carbs_g']
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
  - the calories, protein, fat and carbohydrate for that weight

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
