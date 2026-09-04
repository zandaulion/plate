// Weight series: smoothing for display, and a trend with its uncertainty.
//
// Scale weight is dominated by water, glycogen and gut contents -- swings of a
// kilogram or two between mornings are ordinary and mean nothing about stored
// energy. Anything that reads a trend out of raw readings is reading noise, so
// two things are produced here:
//
//   * a smoothed series, which is what a person should look at
//   * a least-squares slope *with a standard error*, which is what the
//     expenditure estimate consumes
//
// The standard error is the point. A slope without one invites a confident
// answer from four days of data, and four days of data cannot support one.

const DAY_MS = 86400000;

/** Student's t at 95%, two-tailed, by degrees of freedom. */
const T_95 = {
  1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31,
  9: 2.26, 10: 2.23, 12: 2.18, 15: 2.13, 20: 2.09, 25: 2.06, 30: 2.04, 40: 2.02
};

export function tCritical(df) {
  if (df <= 0) return null;
  const keys = Object.keys(T_95).map(Number).sort((a, b) => a - b);
  for (const k of keys) if (df <= k) return T_95[k];
  return 1.96; // large sample
}

const toTime = (d) => (typeof d === 'number' ? d : Date.parse(d));

/** Sorted, de-duplicated by day, with the latest reading winning a repeat. */
export function normaliseWeights(rows) {
  const byDay = new Map();
  for (const row of rows || []) {
    const kg = Number(row?.kg ?? row?.weight_kg);
    if (!Number.isFinite(kg) || kg <= 0 || kg > 500) continue;

    const stamp = toTime(row?.at ?? row?.measured_at ?? row?.date);

    // The day the weight is *about*, not the moment it was typed in. Filling
    // in last Tuesday from today's phone sends a timestamp of now, so keying
    // on the timestamp filed that reading under today: two back-filled days
    // collapsed into one row, and the span the trend is fitted over shrank to
    // the length of the data-entry session rather than the period weighed.
    // The timestamp is still the fallback for rows that carry no day.
    const key = typeof row?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day)
      ? row.day
      : (Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : null);
    if (!key) continue;

    // Positioned at midday of its own date, so the regression's x-axis is the
    // calendar rather than the hour someone happened to stand on the scale.
    const t = Date.parse(`${key}T12:00:00.000Z`);
    // Two weigh-ins on one morning are one day's evidence; the later reading
    // wins, ordered by when they were actually taken.
    const order = Number.isFinite(stamp) ? stamp : t;
    const existing = byDay.get(key);
    if (!existing || order >= existing.order) byDay.set(key, { t, kg, day: key, order });
  }
  return [...byDay.values()]
    .sort((a, b) => a.t - b.t)
    .map(({ order, ...row }) => row);
}

/**
 * Exponentially weighted trend, the "trend weight" a person should read
 * instead of the scale. `halfLifeDays` sets how much of the past it holds:
 * ten days is slow enough to ignore a salty dinner and fast enough to show a
 * real change within a fortnight.
 *
 * Time-aware rather than per-reading, so gaps in weighing do not distort it.
 */
export function smoothSeries(weights, halfLifeDays = 10) {
  const rows = normaliseWeights(weights);
  if (!rows.length) return [];

  const out = [];
  let trend = rows[0].kg;
  let prev = rows[0].t;

  for (const row of rows) {
    const gapDays = Math.max(0, (row.t - prev) / DAY_MS);
    const alpha = 1 - Math.pow(0.5, gapDays / halfLifeDays);
    trend += (row.kg - trend) * alpha;
    prev = row.t;
    out.push({ day: row.day, at: row.t, kg: row.kg, trend: Math.round(trend * 100) / 100 });
  }
  return out;
}

/**
 * Least-squares slope in kg/day over the readings, with its standard error.
 *
 * Returns null when the data cannot support a trend at all: fewer than three
 * readings, or a span too short for one. Refusing is the honest answer, and
 * the caller is expected to say so rather than substitute a guess.
 */
export function weightTrend(weights, { minReadings = 3, minSpanDays = 7 } = {}) {
  const rows = normaliseWeights(weights);
  if (rows.length < minReadings) return null;

  const spanDays = (rows[rows.length - 1].t - rows[0].t) / DAY_MS;
  if (spanDays < minSpanDays) return null;

  const t0 = rows[0].t;
  const xs = rows.map((r) => (r.t - t0) / DAY_MS);
  const ys = rows.map((r) => r.kg);
  const n = rows.length;

  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;

  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = my - slope * mx;

  // Residual spread around the fit is what the standard error is built from:
  // a noisy weigher gets a wider band, which is the correct outcome.
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;

  const df = n - 2;
  const slopeSe = df > 0 ? Math.sqrt((sse / df) / sxx) : null;

  return {
    slopeKgPerDay: slope,
    slopeKgPerWeek: slope * 7,
    slopeSeKgPerDay: slopeSe,
    // The fitted line itself, so the chart can draw the same line the
    // expenditure estimate was computed from. Showing a different smoother
    // than the one behind the number invites the two to disagree on screen.
    interceptKg: intercept,
    fitFrom: rows[0].t,
    readings: n,
    spanDays: Math.round(spanDays * 10) / 10,
    firstKg: rows[0].kg,
    lastKg: rows[rows.length - 1].kg,
    df
  };
}

/**
 * What is still missing before a trend can be fitted.
 *
 * The gate has two halves -- enough readings, and enough time between the
 * first and the last -- and they run out at different moments. Four readings
 * taken over five days satisfies one and not the other, and being told "trend
 * needs 3 days" at that point is worse than being told nothing: it names a
 * requirement that is already met, so the obvious response is to weigh again
 * tomorrow, which does not help.
 *
 * Both halves are returned rather than the first failing one, so the caller
 * can say which is short and by how much.
 */
export function trendGap(weights, { minReadings = 3, minSpanDays = 7 } = {}) {
  const rows = normaliseWeights(weights);
  if (!rows.length) return { readings: minReadings, days: minSpanDays };

  const spanDays = (rows[rows.length - 1].t - rows[0].t) / DAY_MS;
  return {
    readings: Math.max(0, minReadings - rows.length),
    days: Math.max(0, Math.ceil(minSpanDays - spanDays))
  };
}

export { DAY_MS };
