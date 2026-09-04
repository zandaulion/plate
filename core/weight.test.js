import test from 'node:test';
import assert from 'node:assert/strict';
import { weightTrend, smoothSeries, normaliseWeights, tCritical, trendGap } from './weight.js';

const DAY = 86400000;
const T0 = Date.parse('2026-08-01T07:00:00Z');
const at = (d) => new Date(T0 + d * DAY).toISOString();

const series = (n, startKg, perDay, noise = () => 0) =>
  Array.from({ length: n }, (_, i) => ({ at: at(i), kg: startKg + perDay * i + noise(i) }));

test('recovers a clean linear trend', () => {
  const t = weightTrend(series(15, 80, -0.05));
  assert.ok(Math.abs(t.slopeKgPerDay + 0.05) < 1e-9);
  assert.ok(Math.abs(t.slopeKgPerWeek + 0.35) < 1e-9);
  assert.equal(t.readings, 15);
  assert.equal(t.spanDays, 14);
});

test('a perfect fit has no slope uncertainty; a noisy one does', () => {
  const clean = weightTrend(series(15, 80, -0.05));
  const noisy = weightTrend(series(15, 80, -0.05, (i) => (i % 2 ? 0.8 : -0.8)));
  assert.ok(clean.slopeSeKgPerDay < 1e-9);
  assert.ok(noisy.slopeSeKgPerDay > clean.slopeSeKgPerDay);
  // The estimate itself is barely moved by symmetric noise; only the band is.
  assert.ok(Math.abs(noisy.slopeKgPerDay + 0.05) < 0.02);
});

test('refuses a trend it cannot support', () => {
  assert.equal(weightTrend(series(2, 80, -0.05)), null, 'two readings');
  assert.equal(weightTrend(series(6, 80, -0.05).slice(0, 6).map((r, i) => ({ ...r, at: at(i * 0.5) }))), null,
    'six readings crammed into three days');
  assert.equal(weightTrend([]), null);
  assert.equal(weightTrend(null), null);
});

test('two weigh-ins on one day count once', () => {
  const rows = [
    { at: at(0), kg: 80 }, { at: at(0) , kg: 80 },
    ...series(9, 80, -0.05).slice(1)
  ];
  assert.equal(normaliseWeights(rows).length, 9);
});

test('a repeat on the same day keeps the later reading', () => {
  const rows = [
    { at: '2026-08-01T07:00:00Z', kg: 80 },
    { at: '2026-08-01T19:00:00Z', kg: 81 }
  ];
  assert.equal(normaliseWeights(rows)[0].kg, 81);
});

test('impossible readings are dropped, not clamped', () => {
  const rows = normaliseWeights([
    { at: at(0), kg: 0 }, { at: at(1), kg: -5 }, { at: at(2), kg: 900 },
    { at: 'not a date', kg: 80 }, { at: at(3), kg: 80 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kg, 80);
});

test('the smoothed series lags the scale and is far calmer', () => {
  // A steady weight with one salty day producing a 2 kg spike.
  const rows = series(20, 80, 0).map((r, i) => (i === 10 ? { ...r, kg: 82 } : r));
  const smooth = smoothSeries(rows);

  const spike = smooth[10];
  assert.ok(spike.trend < 80.4, `the trend must barely move: ${spike.trend}`);
  assert.equal(spike.kg, 82, 'while the raw reading is preserved for display');
});

test('smoothing is time-aware, so a gap in weighing does not distort it', () => {
  // Same two readings, one a day apart and one a fortnight apart. The distant
  // reading should pull the trend much further.
  const near = smoothSeries([{ at: at(0), kg: 80 }, { at: at(1), kg: 84 }]);
  const far = smoothSeries([{ at: at(0), kg: 80 }, { at: at(14), kg: 84 }]);
  assert.ok(far[1].trend > near[1].trend + 1);
});

test('an empty series smooths to nothing rather than throwing', () => {
  assert.deepEqual(smoothSeries([]), []);
  assert.deepEqual(smoothSeries(null), []);
});

test('the t multiplier tightens as evidence accumulates', () => {
  assert.ok(tCritical(2) > tCritical(10));
  assert.ok(tCritical(10) > tCritical(30));
  assert.ok(tCritical(500) < 2);
  assert.equal(tCritical(0), null);
});

test('the gap names which half of the gate is short', () => {
  // Four readings over five days: the reading count is satisfied and the span
  // is not. Telling this person to weigh again tomorrow is telling them to do
  // what they have already done.
  const dense = [
    { day: '2026-08-30', kg: 83 }, { day: '2026-08-31', kg: 83 },
    { day: '2026-09-01', kg: 81.6 }, { day: '2026-09-04', kg: 80.6 }
  ];
  assert.equal(weightTrend(dense), null);
  assert.deepEqual(trendGap(dense), { readings: 0, days: 2 });

  // The other way round: far apart, but not enough of them.
  const sparse = [{ day: '2026-08-20', kg: 83 }, { day: '2026-09-04', kg: 80 }];
  assert.deepEqual(trendGap(sparse), { readings: 1, days: 0 });

  // Nothing at all, and one lonely reading.
  assert.deepEqual(trendGap([]), { readings: 3, days: 7 });
  assert.deepEqual(trendGap([{ day: '2026-09-04', kg: 80 }]), { readings: 2, days: 7 });
});

test('the gap closes exactly when the trend appears', () => {
  const ok = [
    { day: '2026-08-28', kg: 83 }, { day: '2026-09-01', kg: 82 },
    { day: '2026-09-04', kg: 81 }
  ];
  assert.deepEqual(trendGap(ok), { readings: 0, days: 0 });
  assert.ok(weightTrend(ok), 'and the fit is actually available at that point');
});

test('a weight belongs to the day it was measured, not the day it was typed', () => {
  // Filling in the past from today's phone: the client sends the real day and
  // a timestamp of now. Keying on the timestamp used to file all three under
  // today, leaving one row and no span at all.
  const now = '2026-09-02T06:27:00.000Z';
  const rows = [
    { day: '2026-08-30', kg: 83, at: now },
    { day: '2026-08-31', kg: 83, at: '2026-09-02T06:28:00.000Z' },
    { day: '2026-09-01', kg: 81.6, at: '2026-09-01T10:39:00.000Z' }
  ];

  const norm = normaliseWeights(rows);
  assert.equal(norm.length, 3, 'three separate days, not one entry session');
  assert.deepEqual(norm.map((r) => r.day), ['2026-08-30', '2026-08-31', '2026-09-01']);

  const span = (norm[2].t - norm[0].t) / DAY;
  assert.equal(span, 2, 'the span is the period weighed, not the minute spent typing');
});

test('within one day the later reading still wins, backfilled or not', () => {
  const rows = normaliseWeights([
    { day: '2026-08-30', kg: 83, at: '2026-09-02T06:00:00.000Z' },
    { day: '2026-08-30', kg: 84, at: '2026-09-02T07:00:00.000Z' }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kg, 84);
});

test('a backfilled week produces the trend it should', () => {
  // Eight days of weighing, all entered in one sitting afterwards. The trend
  // must come out of the weights, not out of the typing.
  const typedAt = '2026-09-10T20:00:00.000Z';
  const rows = Array.from({ length: 8 }, (_, i) => ({
    day: `2026-09-0${i + 1}`, kg: 83 - i * 0.1, at: typedAt
  }));

  const t = weightTrend(rows);
  assert.ok(t, 'a week of readings is a week, whenever it was entered');
  assert.equal(t.readings, 8);
  assert.equal(t.spanDays, 7);
  assert.ok(Math.abs(t.slopeKgPerWeek + 0.7) < 1e-9);
  assert.deepEqual(trendGap(rows), { readings: 0, days: 0 });
});
