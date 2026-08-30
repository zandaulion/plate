// Turning an account's history into files a person can keep.
//
// Export is what makes "your data" mean anything: the app is invite-only and
// self-hosted, but without a way out that is a claim rather than a property.
// Both shapes are produced here rather than in the server so the Android
// client can offer the same export from the same code.
//
// JSON is the faithful one -- every field, including the per-gram rates and
// how the portion was arrived at, so an export can be read back without loss.
// CSV is the useful one, flattened to a row per food so it pivots in a
// spreadsheet without anyone parsing nested JSON.

import { totalsOf } from './analysis/estimate.js';
import { portionSourceOf } from './analysis/estimate.js';

export const EXPORT_VERSION = 1;

/**
 * Complete, loss-free representation of an account.
 * `photos` lists the filenames referenced by entries, so a consumer can tell
 * whether an accompanying archive is complete.
 */
export function toJson({ entries = [], profile = null, accountCreatedAt = null } = {}) {
  const rows = entries.map((e) => ({
    id: e.id,
    day: e.day,
    meal: e.meal ?? null,
    loggedAt: e.createdAt ?? e.created_at ?? null,
    portionSource: portionSourceOf(e),
    note: e.note ?? null,
    photo: e.photoId ?? e.photo_id ?? null,
    items: (e.items || []).map((i) => ({
      name: i.name,
      grams: i.grams,
      source: i.source ?? null,
      // Per gram, as stored. Multiplying by grams reproduces the totals
      // exactly, which is what makes this round-trippable.
      per: i.per ?? null
    })),
    totals: e.totals ?? totalsOf(e)
  }));

  return {
    exportVersion: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    accountCreatedAt,
    profile,
    entryCount: rows.length,
    photos: rows.map((r) => r.photo).filter(Boolean),
    entries: rows
  };
}

const CSV_COLUMNS = [
  'day', 'meal', 'logged_at', 'entry_id', 'portion_source',
  'food', 'food_source', 'grams',
  'calories', 'protein_g', 'fat_g', 'carbs_g',
  'note', 'photo'
];

/**
 * Quotes a CSV field.
 *
 * A leading =, +, - or @ is prefixed with a quote as well: spreadsheets treat
 * such a value as a formula, and food names come from a model and an
 * open database, neither of which is under our control.
 */
function csvField(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

const round = (n, dp) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '';
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** One row per food, with the entry's columns repeated alongside it. */
export function toCsv({ entries = [] } = {}) {
  const lines = [CSV_COLUMNS.join(',')];

  for (const e of entries) {
    const base = [
      e.day,
      e.meal ?? '',
      e.createdAt ?? e.created_at ?? '',
      e.id,
      portionSourceOf(e)
    ];

    const items = e.items || [];
    if (!items.length) continue;

    for (const i of items) {
      const grams = Number(i.grams) || 0;
      const per = i.per || {};
      lines.push([
        ...base,
        i.name,
        i.source ?? '',
        round(grams, 0),
        round((per.calories || 0) * grams, 0),
        round((per.protein || 0) * grams, 1),
        round((per.fat || 0) * grams, 1),
        round((per.carbs || 0) * grams, 1),
        e.note ?? '',
        e.photoId ?? e.photo_id ?? ''
      ].map(csvField).join(','));
    }
  }

  // Trailing newline: without it some tools drop or mangle the final row.
  return `${lines.join('\n')}\n`;
}

export { CSV_COLUMNS };
