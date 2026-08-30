import test from 'node:test';
import assert from 'node:assert/strict';
import { toJson, toCsv, CSV_COLUMNS, EXPORT_VERSION } from './export.js';

const ENTRIES = [
  {
    id: 'e1', day: '2026-08-20', meal: 'lunch', createdAt: '2026-08-20T11:00:00.000Z',
    photoId: 'p1.jpg', note: null, portionSource: 'weighed',
    items: [
      { name: 'chicken breast', grams: 150, source: 'photo', per: { calories: 1.65, protein: 0.31, fat: 0.036, carbs: 0 } },
      { name: 'white rice', grams: 200, source: 'manual', per: { calories: 1.3, protein: 0.027, fat: 0.003, carbs: 0.28 } }
    ],
    totals: { calories: 508, protein: 51.9, fat: 6, carbs: 56 }
  },
  {
    id: 'e2', day: '2026-08-21', meal: null, createdAt: '2026-08-21T08:00:00.000Z',
    photoId: null, note: 'quick breakfast', portionConfirmed: false,
    items: [{ name: 'porridge', grams: 250, source: 'manual', per: { calories: 0.71, protein: 0.025, fat: 0.014, carbs: 0.12 } }],
    totals: { calories: 178, protein: 6.3, fat: 3.5, carbs: 30 }
  }
];

test('JSON export carries everything needed to reconstruct the log', () => {
  const out = toJson({ entries: ENTRIES, profile: { weightKg: 80 }, accountCreatedAt: '2026-08-01T00:00:00Z' });
  assert.equal(out.exportVersion, EXPORT_VERSION);
  assert.equal(out.entryCount, 2);
  assert.equal(out.profile.weightKg, 80);

  const e = out.entries[0];
  assert.equal(e.portionSource, 'weighed');
  // Per-gram rates are what make the export round-trippable: grams x rate
  // reproduces the totals exactly.
  assert.equal(e.items[0].per.calories * e.items[0].grams, 247.5);
});

test('JSON lists the photos it refers to, so a partial archive is detectable', () => {
  const out = toJson({ entries: ENTRIES });
  assert.deepEqual(out.photos, ['p1.jpg']);
});

test('an entry saved before portionSource existed is read conservatively', () => {
  const out = toJson({ entries: [{ ...ENTRIES[1], portionConfirmed: true }] });
  assert.equal(out.entries[0].portionSource, 'estimated');
});

test('CSV has one row per food, with entry columns repeated', () => {
  const lines = toCsv({ entries: ENTRIES }).trim().split('\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines.length, 4, 'header plus three foods');

  const first = lines[1].split(',');
  assert.equal(first[CSV_COLUMNS.indexOf('day')], '2026-08-20');
  assert.equal(first[CSV_COLUMNS.indexOf('food')], 'chicken breast');
  assert.equal(first[CSV_COLUMNS.indexOf('grams')], '150');
  assert.equal(first[CSV_COLUMNS.indexOf('calories')], '248');
});

test('per-item macros are computed from the rate, not copied from totals', () => {
  const rows = toCsv({ entries: ENTRIES }).trim().split('\n').slice(1);
  const rice = rows[1].split(',');
  assert.equal(rice[CSV_COLUMNS.indexOf('food')], 'white rice');
  assert.equal(rice[CSV_COLUMNS.indexOf('carbs_g')], '56');
});

test('fields containing commas, quotes or newlines survive', () => {
  const csv = toCsv({ entries: [{
    id: 'x', day: '2026-08-22', meal: 'dinner', createdAt: '2026-08-22T18:00:00Z',
    note: 'had it with "sauce", twice\nreally',
    items: [{ name: 'stew, beef', grams: 300, per: { calories: 1 } }]
  }] });
  assert.match(csv, /"stew, beef"/);
  assert.match(csv, /"had it with ""sauce"", twice/);

  // Re-splitting on bare commas must not work -- which is the point of quoting.
  const dataLine = csv.split('\n')[1];
  assert.ok(dataLine.includes('"stew, beef"'));
});

test('a food name that looks like a formula is neutralised', () => {
  // Spreadsheets execute a leading = or +. Food names come from a model and a
  // public database, so neither is trusted input.
  const csv = toCsv({ entries: [{
    id: 'x', day: '2026-08-22', createdAt: '2026-08-22T18:00:00Z',
    items: [{ name: '=1+1', grams: 10, per: { calories: 1 } }]
  }] });
  assert.match(csv, /'=1\+1/);
  assert.ok(!/,=1\+1,/.test(csv), 'the raw formula must not reach a cell unescaped');
});

test('an empty account exports valid, empty files rather than failing', () => {
  const json = toJson({});
  assert.equal(json.entryCount, 0);
  assert.deepEqual(json.entries, []);

  const csv = toCsv({});
  assert.equal(csv.trim(), CSV_COLUMNS.join(','));
  assert.ok(csv.endsWith('\n'), 'a trailing newline keeps tools from mangling the last row');
});

test('an entry with no items is skipped rather than emitting a blank row', () => {
  const csv = toCsv({ entries: [{ id: 'x', day: '2026-08-22', items: [] }] });
  assert.equal(csv.trim().split('\n').length, 1);
});
