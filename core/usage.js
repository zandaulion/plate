// Reading behaviour out of what the app already stores.
//
// No events, no timers, no instrumentation. Every figure here is derived from
// rows the app has to keep in order to work at all -- an entry knows when it
// was written, which day it was for, how its portion was arrived at, and where
// each food came from. That is enough to answer most of what usability testing
// wants to know, and it costs nothing to collect because it was already there.
//
// Scoped to one account by construction. Nothing here aggregates across
// people, and it should stay that way: reading a friend's food diary to find
// out whether a button works is not a trade worth making.

const DAY_MS = 86400000;

/** How a meal got into the log, from the shape of its items. */
export function entryPath(entry) {
  const items = entry?.items || [];
  if (items.some((i) => i.source === 'photo')) return 'photo';
  if (items.some((i) => i.barcode)) return 'barcode';
  return 'manual';
}

const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

function tally(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts.entries()]
    .map(([key, n]) => ({ key, n, pct: pct(n, values.length) }))
    .sort((a, b) => b.n - a.n);
}

/** Longest run of consecutive days present in a set of day keys. */
export function longestStreak(dayKeys) {
  const days = [...new Set(dayKeys)].sort();
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    const t = Date.parse(d);
    run = prev !== null && t - prev === DAY_MS ? run + 1 : 1;
    prev = t;
    if (run > best) best = run;
  }
  return best;
}

export function summariseUsage({ entries = [], weights = [], days = 30, now = Date.now() } = {}) {
  const from = new Date(now - (days - 1) * DAY_MS).toISOString().slice(0, 10);
  const rows = entries.filter((e) => e.day >= from);
  const weighed = weights.filter((w) => w.day >= from);

  const loggedDays = new Set(rows.map((e) => e.day));

  // How long after midnight of the day it describes the entry was written.
  // Roughly "logged at the time" versus "caught up later that evening".
  const lags = rows.map((e) => {
    const wrote = Date.parse(e.createdAt ?? e.created_at);
    const forDay = Date.parse(`${e.day}T00:00:00.000Z`);
    return Number.isFinite(wrote) && Number.isFinite(forDay) ? (wrote - forDay) / 3600000 : null;
  }).filter((v) => v !== null);

  const sameDay = lags.filter((h) => h >= 0 && h < 24).length;

  const hours = rows.map((e) => new Date(e.createdAt ?? e.created_at).getHours())
    .filter((h) => Number.isFinite(h));

  // Foods logged more than once: the case a "recents" list exists to serve.
  const names = new Map();
  for (const e of rows) {
    for (const i of e.items || []) {
      const key = String(i.name || '').trim().toLowerCase();
      if (key) names.set(key, (names.get(key) || 0) + 1);
    }
  }
  const repeated = [...names.values()].filter((n) => n > 1);
  const itemCount = [...names.values()].reduce((a, b) => a + b, 0);

  return {
    windowDays: days,
    entries: rows.length,

    logging: {
      daysLogged: loggedDays.size,
      coveragePct: pct(loggedDays.size, days),
      longestStreak: longestStreak([...loggedDays]),
      entriesPerLoggedDay: loggedDays.size
        ? Math.round((rows.length / loggedDays.size) * 10) / 10 : 0,
      sameDayPct: pct(sameDay, lags.length),
      byHour: tally(hours.map((h) => `${String(h).padStart(2, '0')}:00`)),
      byMeal: tally(rows.map((e) => e.meal || 'unset'))
    },

    // Which of the three buttons actually gets used.
    paths: tally(rows.map(entryPath)),

    portion: {
      // 'model' means the slider was never touched, which is the case the
      // measurement says costs the most accuracy.
      bySource: tally(rows.map((e) => e.portionSource || 'model')),
      photoEntries: rows.filter((e) => entryPath(e) === 'photo').length,
      photoLeftUncorrected: rows.filter(
        (e) => entryPath(e) === 'photo' && (e.portionSource || 'model') === 'model').length
    },

    weighing: {
      count: weighed.length,
      daysCovered: new Set(weighed.map((w) => w.day)).size,
      coveragePct: pct(new Set(weighed.map((w) => w.day)).size, days),
      longestStreak: longestStreak(weighed.map((w) => w.day)),
      // A gap of more than a couple of days is what stops a trend forming.
      biggestGapDays: (() => {
        const ds = [...new Set(weighed.map((w) => w.day))].sort();
        let gap = 0;
        for (let i = 1; i < ds.length; i++) {
          gap = Math.max(gap, Math.round((Date.parse(ds[i]) - Date.parse(ds[i - 1])) / DAY_MS));
        }
        return gap;
      })()
    },

    foods: {
      distinct: names.size,
      repeatedFoods: repeated.length,
      // How much of the logging a recents list could have served.
      repeatSharePct: pct(repeated.reduce((a, b) => a + b, 0) - repeated.length, itemCount),
      itemsPerEntry: rows.length
        ? Math.round((rows.reduce((a, e) => a + (e.items || []).length, 0) / rows.length) * 10) / 10 : 0
    }
  };
}
