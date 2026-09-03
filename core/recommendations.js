// Dietary preference definitions and macro-aware recommendation engine for Bitey.
// No I/O, no framework -- this file has to run unchanged inside the Android app
// or browser, so it stays free of Node and browser APIs.

export const LEAN_PROTEIN_FOODS = {
  vegetarian: [
    { name: 'Edamame', calories: 122, grams: 100, protein: 11.9, fat: 5.2, carbs: 8.9, fiber: 5.2 },
    { name: 'Skyr (0% fat)', calories: 100, grams: 170, protein: 17.0, fat: 0.2, carbs: 6.0, fiber: 0.0 },
    { name: 'Seitan', calories: 140, grams: 100, protein: 28.0, fat: 1.5, carbs: 4.0, fiber: 1.5 },
    { name: 'Tofu (firm)', calories: 125, grams: 150, protein: 15.0, fat: 7.0, carbs: 3.0, fiber: 1.2 },
    { name: 'Cottage cheese (low fat)', calories: 116, grams: 160, protein: 18.0, fat: 2.6, carbs: 4.8, fiber: 0.0 }
  ],
  vegan: [
    { name: 'Seitan', calories: 140, grams: 100, protein: 28.0, fat: 1.5, carbs: 4.0, fiber: 1.5 },
    { name: 'Edamame', calories: 122, grams: 100, protein: 11.9, fat: 5.2, carbs: 8.9, fiber: 5.2 },
    { name: 'Red lentils (cooked)', calories: 174, grams: 150, protein: 13.5, fat: 0.6, carbs: 30.0, fiber: 7.9 },
    { name: 'Tempeh', calories: 193, grams: 100, protein: 20.3, fat: 10.8, carbs: 7.6, fiber: 5.0 },
    { name: 'Tofu (firm)', calories: 125, grams: 150, protein: 15.0, fat: 7.0, carbs: 3.0, fiber: 1.2 }
  ],
  pescatarian: [
    { name: 'Tuna in water', calories: 110, grams: 100, protein: 26.0, fat: 0.5, carbs: 0.0, fiber: 0.0 },
    { name: 'Shrimp (cooked)', calories: 99, grams: 100, protein: 24.0, fat: 0.3, carbs: 0.2, fiber: 0.0 },
    { name: 'Edamame', calories: 122, grams: 100, protein: 11.9, fat: 5.2, carbs: 8.9, fiber: 5.2 },
    { name: 'Skyr (0% fat)', calories: 100, grams: 170, protein: 17.0, fat: 0.2, carbs: 6.0, fiber: 0.0 }
  ],
  omnivore: [
    { name: 'Chicken breast (grilled)', calories: 165, grams: 100, protein: 31.0, fat: 3.6, carbs: 0.0, fiber: 0.0 },
    { name: 'Tuna in water', calories: 110, grams: 100, protein: 26.0, fat: 0.5, carbs: 0.0, fiber: 0.0 },
    { name: 'Egg whites', calories: 52, grams: 100, protein: 11.0, fat: 0.2, carbs: 0.7, fiber: 0.0 },
    { name: 'Skyr (0% fat)', calories: 100, grams: 170, protein: 17.0, fat: 0.2, carbs: 6.0, fiber: 0.0 },
    { name: 'Edamame', calories: 122, grams: 100, protein: 11.9, fat: 5.2, carbs: 8.9, fiber: 5.2 }
  ],
  keto: [
    { name: 'Avocado', calories: 160, grams: 100, protein: 2.0, fat: 14.7, carbs: 1.8, fiber: 6.7 },
    { name: 'Macadamia nuts', calories: 204, grams: 28, protein: 2.2, fat: 21.5, carbs: 1.5, fiber: 2.4 },
    { name: 'Olives', calories: 60, grams: 50, protein: 0.4, fat: 5.4, carbs: 1.5, fiber: 1.6 }
  ]
};

export const HIGH_FIBER_FOODS = [
  { name: 'Chia seeds', calories: 97, grams: 20, protein: 3.3, fat: 6.2, carbs: 8.4, fiber: 6.9 },
  { name: 'Raspberries', calories: 64, grams: 125, protein: 1.5, fat: 0.8, carbs: 14.7, fiber: 8.0 },
  { name: 'Edamame', calories: 122, grams: 100, protein: 11.9, fat: 5.2, carbs: 8.9, fiber: 5.2 },
  { name: 'Red lentils (cooked)', calories: 174, grams: 150, protein: 13.5, fat: 0.6, carbs: 30.0, fiber: 7.9 },
  { name: 'Rolled oats', calories: 150, grams: 40, protein: 5.0, fat: 2.5, carbs: 27.0, fiber: 4.0 }
];

/**
 * Analyzes the current day's progress, body weight, and dietary preferences
 * to produce a proactive, actionable recommendation for Bitey.
 *
 * @param {Object} params
 * @param {Object} params.totals - { calories, protein, fat, carbs, fiber }
 * @param {Object} params.split - { protein: %, carbs: %, fat: % }
 * @param {string} [params.diet='omnivore'] - 'omnivore' | 'vegetarian' | 'vegan' | 'pescatarian' | 'keto'
 * @param {string} [params.dietaryGoal='balanced'] - 'balanced' | 'high_protein' | 'low_fat' | 'low_carb'
 * @param {number} [params.entriesCount=0]
 * @param {number|null} [params.weightKg=null]
 * @returns {Object|null} recommendation - { type, mood, text, suggestions }
 */
export function getMacroRecommendation({
  totals = { calories: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 },
  split = null,
  diet = 'omnivore',
  dietaryGoal = 'balanced',
  entriesCount = 0,
  weightKg = null
} = {}) {
  const calories = Math.round(Number(totals?.calories) || 0);
  const protein = Math.round(Number(totals?.protein) || 0);
  const fiber = Math.round(Number(totals?.fiber) || 0);
  const pPct = Math.round(Number(split?.protein) || 0);
  const cPct = Math.round(Number(split?.carbs) || 0);
  const fPct = Math.round(Number(split?.fat) || 0);

  const weight = Number(weightKg) && Number(weightKg) > 30 && Number(weightKg) < 300
    ? Number(weightKg)
    : 75;

  // Targets based on body weight:
  // - High protein goal: ~1.4 g/kg (e.g. ~115g for 82kg)
  // - Standard/balanced goal: ~1.1 g/kg (e.g. ~90g for 82kg)
  const proteinTargetG = Math.round(dietaryGoal === 'high_protein' ? weight * 1.4 : weight * 1.1);

  // Plentiful protein threshold: if user has already consumed >= 85g of protein
  // (or >= 85% of their daily target), protein is NEVER flagged as "lagging".
  const isProteinPlentiful = protein >= Math.min(proteinTargetG * 0.85, 85);
  const hasMetProteinGoal = protein >= proteinTargetG;

  // When no food is logged yet
  if (calories < 50 || entriesCount === 0) {
    if (diet === 'vegetarian') {
      return {
        type: 'start',
        mood: 'happy',
        text: 'Ready for a healthy vegetarian day! Bitey is here to help keep your protein up and macros balanced. 🥦🦖',
        suggestions: []
      };
    }
    if (diet === 'vegan') {
      return {
        type: 'start',
        mood: 'happy',
        text: 'Plant power day! What delicious meal or snack are we logging first? 🌿🦖',
        suggestions: []
      };
    }
    if (diet === 'keto') {
      return {
        type: 'start',
        mood: 'happy',
        text: 'Keto mode active! Keep those carbs low and healthy fats flowing. 🥑🦖',
        suggestions: []
      };
    }
    return {
      type: 'start',
      mood: 'happy',
      text: 'Rawr! What are we eating today? Log your meals and Bitey will watch your macros!',
      suggestions: []
    };
  }

  // 1. Keto check: carbs exceeding allowance
  if (diet === 'keto' && totals.carbs >= 30) {
    return {
      type: 'keto_carbs_high',
      mood: 'thinking',
      text: `Carb check! You've had ${Math.round(totals.carbs)}g carbs today. For ketosis, lean into healthy fats and low-carb greens.`,
      suggestions: LEAN_PROTEIN_FOODS.keto
    };
  }

  // 2. Protein target met celebration (high protein goal)
  if (hasMetProteinGoal && calories >= 600) {
    return {
      type: 'protein_target_met',
      mood: 'happy',
      text: `Protein target crushed today (${protein}g)! Your muscles and energy are well fueled. 💪🦖`,
      suggestions: []
    };
  }

  // 3. Fiber check: low fiber with substantial calories logged
  const hasFiberData = totals?.fiber !== undefined && totals?.fiber !== null;
  if (hasFiberData && calories >= 850 && fiber < 10) {
    return {
      type: 'fiber_low',
      mood: 'thinking',
      text: `Fiber check! You're at ${fiber}g today (daily target: 25–35g). Adding berries, chia seeds, or legumes will keep digestion thriving! 🌾🦖`,
      suggestions: HIGH_FIBER_FOODS.slice(0, 3)
    };
  }

  // 4. Fiber goal celebration
  if (fiber >= 25 && calories >= 600) {
    return {
      type: 'fiber_goal_met',
      mood: 'happy',
      text: `Outstanding fiber intake today (${fiber}g)! Dinosaur digestion is running smooth as clockwork! 🥦✨`,
      suggestions: []
    };
  }

  // 5. Balanced macros celebration
  if (calories >= 600 && pPct >= 19 && pPct <= 35 && fPct >= 20 && fPct <= 36) {
    return {
      type: 'balanced',
      mood: 'happy',
      text: `Awesome macro balance today! Protein (${pPct}%), carbs (${cPct}%), and fats (${fPct}%) are spot on. Bitey approves! 🦖✨`,
      suggestions: []
    };
  }

  // 6. Plentiful protein acknowledgement (e.g. 98g protein, even if fats/carbs are also high)
  if (isProteinPlentiful && calories >= 700) {
    if (fPct >= 45) {
      return {
        type: 'high_fat_plentiful_protein',
        mood: 'thinking',
        text: `You've got a strong ${protein}g of protein today! Fats took up most of the remaining energy (${fPct}%). Keep your next bite light and balanced. 🥑`,
        suggestions: []
      };
    }
    return {
      type: 'solid_protein',
      mood: 'happy',
      text: `Great job on protein today (${protein}g)! Your protein intake is solid and well on track. 💪🦖`,
      suggestions: []
    };
  }

  // 7. Vegetarian high fat + low protein scenario (only when protein is genuinely not plentiful)
  if (diet === 'vegetarian' && fPct >= 38 && pPct <= 18 && calories >= 400 && !isProteinPlentiful) {
    return {
      type: 'veg_high_fat_low_protein',
      mood: 'thinking',
      text: `Fats are high today (${fPct}%), but protein is lagging (${pPct}%, ${protein}g). Try balancing your next meal with lean plant or dairy protein!`,
      suggestions: LEAN_PROTEIN_FOODS.vegetarian.slice(0, 3)
    };
  }

  // 8. Vegan low protein scenario (only when protein is not plentiful)
  if (diet === 'vegan' && pPct <= 16 && calories >= 400 && !isProteinPlentiful) {
    return {
      type: 'vegan_low_protein',
      mood: 'thinking',
      text: `Plant protein is running low today (${pPct}%, ${protein}g). Consider a boost like seitan, edamame, or lentils for your next meal!`,
      suggestions: LEAN_PROTEIN_FOODS.vegan.slice(0, 3)
    };
  }

  // 9. Pescatarian high fat + low protein
  if (diet === 'pescatarian' && fPct >= 38 && pPct <= 18 && calories >= 400 && !isProteinPlentiful) {
    return {
      type: 'pesc_high_fat_low_protein',
      mood: 'thinking',
      text: `Fats are up (${fPct}%) while protein is lagging (${pPct}%, ${protein}g). A light fish or plant protein would balance your day nicely!`,
      suggestions: LEAN_PROTEIN_FOODS.pescatarian.slice(0, 3)
    };
  }

  // 10. Omnivore high fat + low protein
  if (diet === 'omnivore' && fPct >= 40 && pPct <= 18 && calories >= 450 && !isProteinPlentiful) {
    return {
      type: 'omni_high_fat_low_protein',
      mood: 'thinking',
      text: `Fats are currently ${fPct}% of calories and protein is at ${pPct}% (${protein}g). Try reaching for lean proteins for your next bite!`,
      suggestions: LEAN_PROTEIN_FOODS.omnivore.slice(0, 3)
    };
  }

  // 11. High protein goal check (only when protein is behind)
  if (dietaryGoal === 'high_protein' && pPct < 20 && calories >= 600 && !isProteinPlentiful) {
    const pool = LEAN_PROTEIN_FOODS[diet] || LEAN_PROTEIN_FOODS.omnivore;
    return {
      type: 'goal_protein_behind',
      mood: 'thinking',
      text: `Aiming for high protein today, but currently at ${pPct}% (${protein}g / ${proteinTargetG}g target). Time to fuel up with some protein-dense foods!`,
      suggestions: pool.slice(0, 3)
    };
  }

  // 12. High carbs + low protein (across any diet)
  if (cPct >= 60 && pPct <= 15 && calories >= 500 && !isProteinPlentiful) {
    const pool = LEAN_PROTEIN_FOODS[diet] || LEAN_PROTEIN_FOODS.omnivore;
    return {
      type: 'high_carb_low_protein',
      mood: 'thinking',
      text: `Carbs are taking the lead today (${cPct}%) while protein is at ${pPct}% (${protein}g). Adding some protein will keep energy steady!`,
      suggestions: pool.slice(0, 3)
    };
  }

  return null;
}
