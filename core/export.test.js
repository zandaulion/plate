import test from 'node:test';
import assert from 'node:assert/strict';
import { toJson, toCsv, weightsToCsv, CSV_COLUMNS, EXPORT_VERSION } from './export.js';

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
  const out = toJson({
    entries: ENTRIES,
    profile: { weightKg: 80 },
    weights: [{ day: '2026-08-02', kg: 79.6, measuredAt: '2026-08-02T07:00:00Z' }],
    accountCreatedAt: '2026-08-01T00:00:00Z'
  });
  assert.equal(out.exportVersion, EXPORT_VERSION);
  assert.equal(out.entryCount, 2);
  assert.equal(out.profile.weightKg, 80);
  assert.deepEqual(out.weights, [{ day: '2026-08-02', kg: 79.6, measuredAt: '2026-08-02T07:00:00Z' }]);

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

test('the export carries weigh-ins, not just food', () => {
  // Cele două se citesc împreună -- ce s-a mâncat față de ce s-a întâmplat cu
  // greutatea -- iar un export cu doar una dintre ele răspunde la jumătate
  // din întrebare.
  const out = toJson({
    entries: [],
    weights: [
      { day: '2026-09-01', kg: 83.4, at: '2026-09-01T07:12:00.000Z' },
      { day: '2026-09-08', kg: 82.6, at: '2026-09-08T07:05:00.000Z' }
    ]
  });
  assert.equal(out.weightCount, 2);
  assert.deepEqual(out.weights[0], {
    day: '2026-09-01', kg: 83.4, measuredAt: '2026-09-01T07:12:00.000Z'
  });
});

test('an account that has never weighed in still exports cleanly', () => {
  const out = toJson({ entries: [] });
  assert.equal(out.weightCount, 0);
  assert.deepEqual(out.weights, []);
});

test('weigh-ins get their own table rather than being forced into the food one', () => {
  // Fișierul cu mâncare are un rând per aliment, cu coloanele intrării
  // repetate alături: o greutate acolo ar inventa coloane pe care nimic
  // altceva nu le folosește, sau s-ar da drept ceva mâncat.
  const csv = weightsToCsv({
    weights: [{ day: '2026-09-08', kg: 82.64, at: '2026-09-08T07:05:00.000Z' }]
  });
  const [header, row] = csv.trim().split('\n');
  assert.equal(header, 'day,kg,measured_at');
  assert.equal(row, '2026-09-08,82.64,2026-09-08T07:05:00.000Z');

  const food = toCsv({ entries: [] });
  assert.ok(!food.includes('kg'), 'tabelul cu mâncare rămâne despre mâncare');
});

test('weights accept either shape the server might hand over', () => {
  // `at` din interogare, `measuredAt` dacă trece printr-un JSON deja formatat.
  const a = toJson({ entries: [], weights: [{ day: '2026-09-08', kg: 80, at: 'X' }] });
  const b = toJson({ entries: [], weights: [{ day: '2026-09-08', kg: 80, measuredAt: 'X' }] });
  assert.equal(a.weights[0].measuredAt, 'X');
  assert.equal(b.weights[0].measuredAt, 'X');
});

test('a weight CSV field cannot become a spreadsheet formula', () => {
  const csv = weightsToCsv({ weights: [{ day: '=cmd|calc', kg: 80, at: '@evil' }] });
  assert.ok(csv.includes("'=cmd|calc"), 'ziua e neutralizată');
  assert.ok(csv.includes("'@evil"), 'marcajul de timp e neutralizat');
});
