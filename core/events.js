// What is worth recording, and what the recording is for.
//
// The derived report in core/usage.js can see everything that left a row
// behind. It cannot see the things that did not happen: a sheet opened and
// abandoned, a search that returned nothing, a scan that timed out, a button
// hunted for. Those are exactly the usability failures worth catching, and
// they leave no trace unless something writes one.
//
// So this list is deliberately about *interaction*, not about food. No event
// carries a photograph, a calorie figure or a weight -- those already live in
// entries, and duplicating them here would turn a usability log into a second
// copy of a person's diary.

export const EVENTS = [
  // Where attention goes, and for how long.
  'screen_open', 'screen_close',

  // The three ways in, and whether each one finished.
  'entry_start', 'entry_saved', 'entry_abandoned', 'entry_edited', 'entry_deleted', 'entry_duplicated',

  // The photo path, which costs money and can fail.
  'analyse_start', 'analyse_ok', 'analyse_fail',

  // Correcting a misidentification, as opposed to a portion. How often this
  // is needed says how much the photo path can be trusted on its own.
  'correct_open', 'correct_submit', 'correct_ok', 'correct_fail',

  // The correction the whole design rests on.
  'portion_slider', 'portion_item_step', 'portion_item_typed', 'portion_weighed_ticked',

  // Search and scan, including the failures that leave no row.
  'search', 'search_empty', 'search_pick',
  'scan_start', 'scan_ok', 'scan_fail', 'scan_cancel', 'scan_typed',
  'manual_open', 'manual_add', 'manual_warned',

  // Grazing & micro-intake fast paths.
  'quick_bite_logged', 'grazing_catchup_added', 'shortcut_opened',

  // Weighing, which the expenditure estimate depends on.
  'weigh_prompt_shown', 'weigh_dismissed', 'weigh_open', 'weigh_saved', 'weigh_backfill',

  // Getting around.
  'day_nav', 'trends_open', 'trends_range', 'export_click',

  // Anything the person was actually shown as a failure.
  'error_shown'
];

const KNOWN = new Set(EVENTS);

/** Property values are bounded so a log cannot become a data dump. */
function cleanProps(props) {
  if (!props || typeof props !== 'object') return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (n >= 12) break;
    if (!/^[a-z_][a-z0-9_]{0,24}$/i.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
    else if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 60);
    else continue;
    n++;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validates a batch. Unknown names are dropped rather than stored: the point
 * of a fixed list is that the log stays readable, and a typo in the client
 * should not quietly create a new event type nobody analyses.
 */
export function cleanBatch(batch, { max = 200 } = {}) {
  const rows = Array.isArray(batch) ? batch.slice(0, max) : [];
  const out = [];
  for (const e of rows) {
    if (!KNOWN.has(e?.name)) continue;
    const at = Date.parse(e?.at);
    out.push({
      name: e.name,
      at: Number.isFinite(at) ? new Date(at).toISOString() : new Date().toISOString(),
      session: String(e?.session || '').slice(0, 40) || 'unknown',
      props: cleanProps(e?.props)
    });
  }
  return out;
}

/** Funnels worth reading back, computed from the raw log. */
export function summariseEvents(rows) {
  const count = (name) => rows.filter((r) => r.name === name).length;
  const props = (name) => rows.filter((r) => r.name === name).map((r) => r.props || {});

  const durations = (screen) => props('screen_close')
    .filter((p) => p.screen === screen && Number.isFinite(p.seconds))
    .map((p) => p.seconds);

  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
  };

  const started = count('entry_start');
  const saved = count('entry_saved');

  return {
    events: rows.length,
    sessions: new Set(rows.map((r) => r.session)).size,

    // The number that matters most: how often starting an entry produces one.
    completion: {
      started,
      saved,
      abandoned: count('entry_abandoned'),
      completedPct: started ? Math.round((saved / started) * 100) : null
    },

    photo: {
      attempts: count('analyse_start'),
      failures: count('analyse_fail'),
      medianSeconds: median(props('analyse_ok').map((p) => p.seconds).filter(Number.isFinite)),
      // How often the model named the wrong food, which portion correction
      // cannot fix and which nothing else in the log would reveal.
      correctionsAsked: count('correct_submit'),
      correctionsApplied: count('correct_ok')
    },

    scanning: {
      opened: count('scan_start'),
      found: count('scan_ok'),
      gaveUp: count('scan_fail') + count('scan_cancel'),
      typedInstead: count('scan_typed'),
      medianSeconds: median(props('scan_ok').map((p) => p.seconds).filter(Number.isFinite))
    },

    search: {
      queries: count('search'),
      cameBackEmpty: count('search_empty'),
      picked: count('search_pick'),
      // A query that returns results and is then ignored is a ranking failure.
      pickRatePct: count('search') ? Math.round((count('search_pick') / count('search')) * 100) : null
    },

    weighing: {
      promptsSeen: count('weigh_prompt_shown'),
      dismissed: count('weigh_dismissed'),
      saved: count('weigh_saved'),
      backfilled: count('weigh_backfill')
    },

    portion: {
      sliderUses: count('portion_slider'),
      itemSteps: count('portion_item_step'),
      typed: count('portion_item_typed'),
      weighedTicked: count('portion_weighed_ticked')
    },

    screenSeconds: Object.fromEntries(
      ['day', 'review', 'trends', 'you', 'settings', 'scanner']
        .map((s) => [s, median(durations(s))]).filter(([, v]) => v !== null)),

    errorsShown: props('error_shown')
      .reduce((acc, p) => { const k = p.code || 'unknown'; acc[k] = (acc[k] || 0) + 1; return acc; }, {})
  };
}
