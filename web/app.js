// Plate — PWA front end.
//
// The estimate maths is imported from /core, the same modules the server runs,
// so a portion edit produces identical numbers on both sides and the Android
// client can reuse them unchanged.

import {
  totalsOf, rangesOf, setTotalGrams, setItemGrams, removeItem, itemMacros,
  addManualItem, hasPhotoItems, markWeighed, portionSourceOf
} from '/core/analysis/estimate.js';
import { toItem, isPlausible } from '/core/foods.js';
import { macroAgreement } from '/core/nutrition.js';
import { localDayKey } from '/core/day.js';
import { start as startTracking, track, screen } from '/track.js';
import { smoothSeries } from '/core/weight.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  day: localDayKey(),
  me: null,
  estimate: null,
  photo: null,      // { base64, mimeType, objectUrl }
  meal: null,
  busy: false,
  entriesById: new Map(),
  expenditure: null,
  // One sheet serves three paths: seeded from a photo, started empty and
  // filled by search, or loaded from a saved entry. Keeping them in one place
  // avoids three near-identical editors drifting apart.
  mode: 'photo',    // 'photo' | 'manual' | 'edit'
  editingId: null,
  existingPhotoId: null
};

// -------------------------------------------------------------------- api

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });

  if (res.status === 401) {
    showGate();
    throw new Error('not_registered');
  }

  let body = null;
  try { body = await res.json(); } catch {}

  if (!res.ok) {
    const err = new Error(body?.message || body?.error || `Request failed (${res.status})`);
    err.code = body?.error;
    err.status = res.status;
    err.note = body?.note;
    throw err;
  }
  return body;
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

// ------------------------------------------------------------ navigation

/**
 * Makes the Android back gesture close the top screen instead of leaving the
 * app.
 *
 * Every overlay pushes a history entry when it opens, and the browser's back
 * navigation is what closes it. Dismiss buttons do not close anything
 * directly -- they call history.go(), and the resulting popstate does the
 * closing. Routing both gestures through the same path is what keeps the
 * history depth and the visible stack from drifting apart, which is how these
 * end up closing two sheets at once or leaving a stranded entry that swallows
 * the next back.
 *
 * Day navigation deliberately stays out of this: walking back through
 * yesterday, then the day before, would make the gesture unpredictable.
 */
const screens = [];

function openScreen(name, close) {
  screens.push({ name, close });
  history.pushState({ plateScreen: name, depth: screens.length }, '');
}

/** User-initiated dismissal: unwind history, and let popstate do the closing. */
function dismissScreen(name) {
  // Skipping screens already on their way out matters: history.go() is
  // asynchronous, so a double tap on a close button -- or a tap that also
  // lands on the backdrop -- would otherwise unwind twice and drop the user
  // out of the app entirely.
  const index = screens.findIndex((s) => s.name === name && !s.dismissing);
  if (index === -1) return;
  for (let i = index; i < screens.length; i++) screens[i].dismissing = true;
  history.go(-(screens.length - index));
}

/** Whether a screen is currently open and not already closing. */
function screenIsOpen(name) {
  return screens.some((s) => s.name === name && !s.dismissing);
}

window.addEventListener('popstate', () => {
  // Anything deeper than the entry we landed on is now closed. Unwinding from
  // the top down means a nested screen (the scanner over the sheet) closes in
  // the order it was opened.
  const depth = history.state?.depth || 0;
  while (screens.length > depth) {
    const screen = screens.pop();
    try {
      screen.close();
    } catch (err) {
      console.error('failed to close screen', screen.name, err);
    }
  }
});

// ------------------------------------------------------------------ gate

function showGate() {
  $('app').hidden = true;
  $('gate').hidden = false;
}

/**
 * Three ways in, because a device token is the only credential and it can be
 * lost: a fresh invite, a code from another signed-in device, or the recovery
 * code written down at signup.
 */
const GATE_MODES = {
  invite: {
    path: '/api/auth/redeem', label: 'Invite code',
    placeholder: 'ABCDE-FGHJK', hint: 'The code you were sent.'
  },
  link: {
    path: '/api/auth/link', label: 'Link code',
    placeholder: 'ABCDE-FGH',
    hint: 'Open Plate on a device you are already signed in on, and add this one from there.'
  },
  recover: {
    path: '/api/auth/recover', label: 'Recovery code',
    placeholder: 'ABCDE-FGHJKLM',
    hint: 'The code you saved when you first signed in.'
  }
};

let gateMode = 'invite';

function setGateMode(mode) {
  gateMode = mode;
  const m = GATE_MODES[mode];
  $('gate-label').textContent = m.label;
  $('invite').placeholder = m.placeholder;
  $('invite').value = '';
  $('gate-hint').textContent = m.hint;
  $('gate-error').hidden = true;
  document.querySelectorAll('[data-gate]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.gate === mode));
  });
}

document.querySelector('.gate-modes').addEventListener('click', (ev) => {
  const mode = ev.target.closest('[data-gate]')?.dataset.gate;
  if (mode) setGateMode(mode);
});

$('redeem-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('gate-error');
  err.hidden = true;

  try {
    const body = await api(GATE_MODES[gateMode].path, {
      method: 'POST',
      body: JSON.stringify({ code: $('invite').value.trim() })
    });
    $('gate').hidden = true;
    $('app').hidden = false;
    await start();
    // Shown once and never again, so it is put in front of the user
    // immediately rather than left for them to discover in settings.
    if (body?.recoveryCode) {
      loadDevices();
      renderRecoveryState();
      $('settings').hidden = false;
      openScreen('settings', () => { $('settings').hidden = true; });
      showCode('Save this recovery code', body.recoveryCode,
        'It is the only way back into your log if you lose this device. '
        + 'It is stored hashed and cannot be shown again.', true);
    }
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
});

// -------------------------------------------------------------- day view

function dayTitle(key) {
  const today = localDayKey();
  if (key === today) return 'Today';

  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDayKey(yesterday)) return 'Yesterday';

  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function shiftDay(key, delta) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + delta);
  return localDayKey(date);
}

/**
 * Asks for the profile only while its absence actually costs something.
 *
 * Once expenditure is measured from logged intake and weight, the profile
 * stops feeding the calculation entirely -- so a banner still demanding it
 * would be asking for something the app no longer uses. It names the specific
 * fields that are missing rather than saying "complete your profile", and it
 * does not claim the details make the estimate accurate: they make it
 * possible, and logging is what makes it accurate.
 */
function renderProfileBanner(expenditure) {
  const el = $('profile-banner');
  const missing = expenditure?.method === 'formula' ? (expenditure.profileMissing || []) : [];

  if (!missing.length) { el.hidden = true; return; }

  const names = missing.map((f) => f.label);
  const list = names.length > 1
    ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : names[0];

  el.hidden = false;
  el.innerHTML = `
    <span class="ico" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="20" height="20">
        <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.7"/>
        <path d="M12 7.6v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        <circle cx="12" cy="16.1" r="1.05" fill="currentColor"/>
      </svg>
    </span>
    <div class="body">
      <h2>Add your ${esc(list)}</h2>
      <p>Without them the app cannot work out what you burn, so a day's total has
         nothing to sit against. Real numbers, not round ones — the estimate is
         only as good as what it is given.</p>
      <button class="act" type="button" id="banner-open">Fill them in</button>
    </div>`;

  $('banner-open').addEventListener('click', () => $('open-profile').click());
}

function renderMaintenance(summary, expenditure) {
  const el = $('maintenance');
  const m = summary.maintenance;

  if (!m) {
    // The banner above is already asking; repeating it here would be two
    // requests for the same thing on one screen.
    el.className = 'maintenance none';
    el.textContent = 'What you burn is not known yet.';
    return;
  }

  el.className = 'maintenance';
  const measured = expenditure?.method === 'measured';
  // How the figure was arrived at changes what it is worth, so it is stated
  // rather than left for the user to assume.
  const source = measured
    ? 'measured from your weight and what you logged'
    : 'estimated from your details';

  // Nothing logged is not a deficit -- it is a day that has not been recorded
  // yet. Reporting "2,294 under" against an empty log states a fast that did
  // not happen.
  if (!summary.entries) {
    el.innerHTML = `You burn about <b>${m.kcal} kcal</b> a day &mdash; ${source},
      and spanning ${m.low}&ndash;${m.high}.`;
    return;
  }

  const b = summary.balance;
  if (b?.withinBand) {
    el.innerHTML = `About what you burn &mdash; roughly <b>${m.low}&ndash;${m.high} kcal</b> a day,
      ${source}.`;
  } else if (b) {
    const word = b.kcal < 0 ? 'under' : 'over';
    el.innerHTML = `<b>${Math.abs(b.kcal)} kcal</b> ${word} the <b>${m.kcal}</b> you burn
      &mdash; ${source}, and spanning ${m.low}&ndash;${m.high}.`;
  }
}

const MACRO_META = [
  ['protein', 'Protein', 'var(--protein)', false],
  ['carbs', 'Carbs', 'var(--carbs)', false],
  ['fat', 'Fat', 'var(--fat)', true]
];

function renderMacros(el, totals) {
  el.innerHTML = MACRO_META.map(([key, label, colour, lowConf]) => `
    <div class="${lowConf ? 'lowconf' : ''}">
      <dt style="--dot:${colour}">${label}</dt>
      <dd>${Math.round(totals[key] || 0)} g</dd>
    </div>`).join('');
}

function renderSplit(split) {
  const el = $('split');
  if (!split) { el.innerHTML = ''; return; }
  el.innerHTML =
    `<i class="p" style="width:${split.protein}%"></i>` +
    `<i class="c" style="width:${split.carbs}%"></i>` +
    `<i class="f" style="width:${split.fat}%"></i>`;
  el.setAttribute('aria-label',
    `Protein ${split.protein}%, carbohydrate ${split.carbs}%, fat ${split.fat}% of calories`);
}

/**
 * Portion source is only worth flagging when it changes the numbers.
 *
 * It does that for a photograph, where the weight is the dominant error. It
 * does not for a scanned barcode or a typed panel: the nutrition there is
 * exact and rangesOf already declines to widen it, so labelling such an entry
 * "weight not set" reports a doubt the app does not actually have.
 */
function badgeFor(entry) {
  const fromPhoto = (entry.items || []).some((i) => i.source === 'photo');
  if (!fromPhoto) return '';
  if (entry.portionSource === 'weighed') return '<span class="badge-est badge-weighed">weighed</span>';
  if (entry.portionSource === 'estimated') return '';
  return '<span class="badge-est">weight not set</span>';
}

function renderEntries(entries) {
  const list = $('entries');
  // Kept so a tap can reopen the entry in the editor without another request.
  state.entriesById = new Map(entries.map((e) => [e.id, e]));
  $('empty-day').hidden = entries.length > 0;

  list.innerHTML = entries.map((e) => {
    const foods = e.items.map((i) => i.name).join(', ');
    const thumb = e.photoId
      ? `<img src="/api/photo/${encodeURIComponent(e.photoId)}" alt="" loading="lazy">`
      : '<div class="noimg" aria-hidden="true">&#9738;</div>';
    const time = new Date(e.createdAt)
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    return `<li class="entry" data-id="${esc(e.id)}">
      ${thumb}
      <div class="entry-main">
        <div class="entry-foods">${esc(foods) || 'Meal'}</div>
        <div class="entry-meta">
          <span>${e.meal ? esc(e.meal) : time}</span>
          ${badgeFor(e)}
        </div>
      </div>
      <div>
        <div class="entry-kcal">${Math.round(e.totals.calories)}</div>
        <button class="entry-del" data-del="${esc(e.id)}" aria-label="Delete this entry">&times;</button>
      </div>
    </li>`;
  }).join('');
}

async function loadDay() {
  $('day-label').textContent = dayTitle(state.day);
  const data = await api(`/api/entries?day=${state.day}`);

  state.expenditure = data.expenditure || null;
  renderProfileBanner(data.expenditure);
  $('day-kcal').textContent = Math.round(data.summary.totals.calories);
  renderMaintenance(data.summary, data.expenditure);
  renderSplit(data.split);
  renderMacros($('macros'), data.summary.totals);
  renderWeigh(state.day, data.weight, data.expenditure);
  renderEntries(data.entries);
}

$('prev-day').addEventListener('click', () => {
  track('day_nav', { dir: -1 });
  state.day = shiftDay(state.day, -1); loadDay();
});
$('next-day').addEventListener('click', () => {
  const next = shiftDay(state.day, 1);
  // Logging into the future is always a mistake, so the control stops at today.
  if (next > localDayKey()) return toast('That is tomorrow.');
  state.day = next;
  loadDay();
});
$('day-label').addEventListener('click', () => { state.day = localDayKey(); loadDay(); });

$('entries').addEventListener('click', async (ev) => {
  const deleteId = ev.target.closest('[data-del]')?.dataset.del;
  if (deleteId) {
    if (!confirm('Delete this entry?')) return;
    await api(`/api/entries/${encodeURIComponent(deleteId)}`, { method: 'DELETE' });
    track('entry_deleted');
    toast('Deleted');
    return loadDay();
  }

  const id = ev.target.closest('.entry')?.dataset.id;
  const entry = id && state.entriesById?.get(id);
  if (entry) openReview('edit', entry);
});

// ---------------------------------------------------------------- trends

const W = 320, PAD_L = 30, PAD_R = 8;

const dayLabel = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** Evenly spaced date ticks that always include the first and last day. */
function ticksFor(days, x) {
  if (days.length < 2) return '';
  const want = Math.min(4, days.length);
  const step = (days.length - 1) / (want - 1);
  const out = [];
  for (let i = 0; i < want; i++) {
    const idx = Math.round(i * step);
    const anchor = i === 0 ? 'start' : i === want - 1 ? 'end' : 'middle';
    out.push(`<text class="axis" x="${x(idx).toFixed(1)}" y="100%" dy="-1"
      text-anchor="${anchor}">${esc(dayLabel(days[idx].day))}</text>`);
  }
  return out.join('');
}

/**
 * Weight over the range: readings as dots, the least-squares fit as the line.
 *
 * Same choice as the small chart in You -- the line is the fit the expenditure
 * figure is computed from, not a moving average, so the picture and the number
 * cannot disagree.
 */
function renderWeightChart2(days, trend) {
  const el = $('chart-weight');
  const points = days.map((d, i) => ({ i, kg: d.weight })).filter((p) => p.kg !== null);
  const H = 120, plot = H - 18;

  // Only a genuinely empty range draws nothing. A single reading is still
  // something the person did and wants to see; withholding the whole chart
  // until a trend can be fitted hides their own data from them, and the line
  // below already says when the trend will appear.
  if (!points.length) {
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty" x="0" y="${H / 2}">`
      + 'No weigh-ins in this range yet.</text></svg>';
    return;
  }

  const ys = points.map((p) => p.kg);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const flat = hi - lo < 0.05;
  // A single reading, or several identical ones, has no range to scale to --
  // half a kilo either side keeps the dot off the edges without implying a
  // spread that is not there.
  const span = flat ? 1 : Math.max(0.6, hi - lo);
  const base = flat ? lo - 0.5 : lo;

  const x = (i) => PAD_L + (i / Math.max(1, days.length - 1)) * (W - PAD_L - PAD_R);
  const y = (kg) => 8 + (1 - (kg - base) / span) * (plot - 16);

  // Without a fitted line the dots are the whole chart, so they are drawn as
  // the subject rather than as the faint scatter behind a line.
  const hasFit = trend?.interceptKg !== undefined && points.length > 1;
  const dots = points.map((p) =>
    `<circle class="dot${hasFit ? '' : ' solo'}" cx="${x(p.i).toFixed(1)}"
       cy="${y(p.kg).toFixed(1)}" r="${hasFit ? 2.4 : 3.6}"/>`).join('');

  // The fit is drawn only when there is one. Its absence is explained in words
  // beneath the chart rather than by an empty box.
  let fit = '';
  if (hasFit) {
    const at = (i) => trend.interceptKg
      + trend.slopeKgPerDay * ((Date.parse(days[i].day) - trend.fitFrom) / 86400000);
    const a = points[0].i, b = points[points.length - 1].i;
    fit = `<path class="fit" d="M${x(a).toFixed(1)},${y(at(a)).toFixed(1)}`
        + ` L${x(b).toFixed(1)},${y(at(b)).toFixed(1)}"/>`;
  }

  const axis = flat
    ? `<text class="axis" x="0" y="${(y(lo) + 3.5).toFixed(1)}">${lo.toFixed(1)}</text>`
    : `<text class="axis" x="0" y="12">${hi.toFixed(1)}</text>
       <text class="axis" x="0" y="${(plot - 6).toFixed(0)}">${lo.toFixed(1)}</text>`;

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${points.length === 1 ? `One weigh-in, ${lo.toFixed(1)} kilograms`
        : `Weight from ${lo.toFixed(1)} to ${hi.toFixed(1)} kilograms`}">
    ${axis}${dots}${fit}${ticksFor(days, x)}
  </svg>`;
}

/**
 * Daily intake, each bar stacked by where its energy came from.
 *
 * Stacked by *energy* rather than grams, so the bar's height is the day's
 * calories and its composition is the macro split -- one chart answering both
 * questions instead of two that have to be read together. The dashed line is
 * expenditure, which is what makes the picture mean anything: bars above it
 * are surplus days, bars below are deficit ones.
 */
function renderIntakeChart(days, expenditure) {
  const el = $('chart-intake');
  const H = 150, plot = H - 18;
  const logged = days.filter((d) => d.calories !== null);

  if (!logged.length) {
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty" x="0" y="${H / 2}">`
      + 'Nothing logged in this range.</text></svg>';
    return;
  }

  const burn = expenditure?.available ? expenditure.kcal : null;
  const top = Math.max(...logged.map((d) => d.calories), burn || 0) * 1.12 || 1;

  const x = (i) => PAD_L + (i / Math.max(1, days.length - 1)) * (W - PAD_L - PAD_R);
  const y = (kcal) => 8 + (1 - kcal / top) * (plot - 16);
  const bw = Math.max(1.6, Math.min(9, (W - PAD_L - PAD_R) / days.length - 1.4));

  const bars = days.map((d, i) => {
    if (d.calories === null) return '';
    // Energy per macro, so the segments sum to the bar rather than to grams.
    const parts = [
      ['bar-p', (d.protein || 0) * 4],
      ['bar-c', (d.carbs || 0) * 4],
      ['bar-f', (d.fat || 0) * 9]
    ];
    const sum = parts.reduce((a, [, v]) => a + v, 0);
    // Scale to the recorded calorie total, so a day whose macros do not quite
    // add up still draws a bar of the right height.
    const k = sum > 0 ? d.calories / sum : 0;

    let cursor = 0;
    return parts.map(([cls, v]) => {
      const h = v * k;
      if (h <= 0) return '';
      const y0 = y(cursor + h), y1 = y(cursor);
      cursor += h;
      return `<rect class="${cls}" x="${(x(i) - bw / 2).toFixed(1)}" y="${y0.toFixed(1)}"
        width="${bw.toFixed(1)}" height="${Math.max(0.6, y1 - y0).toFixed(1)}"/>`;
    }).join('');
  }).join('');

  const burnLine = burn ? `
    <line class="burn" x1="${PAD_L}" x2="${W - PAD_R}" y1="${y(burn).toFixed(1)}" y2="${y(burn).toFixed(1)}"/>
    <text class="burn-label" x="${W - PAD_R}" y="${(y(burn) - 4).toFixed(1)}" text-anchor="end">${burn} burn</text>` : '';

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Daily calories, stacked by macronutrient">
    <text class="axis" x="0" y="12">${Math.round(top)}</text>
    ${bars}${burnLine}${ticksFor(days, x)}
  </svg>`;

  $('chart-legend').innerHTML =
    `<span><i style="background:var(--protein)"></i>Protein</span>`
    + `<span><i style="background:var(--carbs)"></i>Carbs</span>`
    + `<span><i style="background:var(--fat)"></i>Fat</span>`
    + (burn ? `<span><i class="dash"></i>What you burn</span>` : '');
}

let trendsRange = 30;

async function loadTrends() {
  try {
    const h = await api(`/api/history?days=${trendsRange}`);
    renderWeightChart2(h.days, h.weightTrend);
    renderIntakeChart(h.days, h.expenditure);

    const t = h.weightTrend;
    const weighed = h.days.filter((d) => d.weight !== null).length;
    if (t) {
      $('trend-weight').textContent =
        `${t.readings} weigh-ins over ${Math.round(t.spanDays)} days — `
        + `${t.slopeKgPerWeek < 0 ? 'down' : 'up'} ${Math.abs(t.slopeKgPerWeek).toFixed(2)} kg a week.`;
    } else if (!weighed) {
      $('trend-weight').textContent = 'A trend needs 3 weigh-ins spread over a week.';
    } else {
      // Say what is there and what is still wanted, rather than only the rule.
      const left = Math.max(0, 3 - weighed);
      $('trend-weight').textContent =
        `${weighed} weigh-in${weighed === 1 ? '' : 's'} so far. `
        + (left
          ? `${left} more, spread over a week, and a trend line appears.`
          : 'Spread over a week, and a trend line appears.');
    }

    const logged = h.days.filter((d) => d.calories !== null);
    const mean = logged.length
      ? Math.round(logged.reduce((a, d) => a + d.calories, 0) / logged.length) : 0;
    // The chart already says so when it is empty; repeating it underneath is
    // the same sentence twice.
    $('trend-intake').textContent = logged.length
      ? `${logged.length} of ${h.days.length} days logged, averaging ${mean} kcal on the days you did.`
      : '';
  } catch (err) {
    $('trend-weight').textContent = err.message;
  }
}

$('range-picker').addEventListener('click', (ev) => {
  const range = Number(ev.target.closest('[data-range]')?.dataset.range);
  if (!range) return;
  trendsRange = range;
  track('trends_range', { days: range });
  document.querySelectorAll('#range-picker [data-range]').forEach((b) =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.range) === range)));
  loadTrends();
});

const closeTrends = () => dismissScreen('trends');
$('open-trends').addEventListener('click', () => {
  track('trends_open');
  const close = screen('trends');
  $('trends').hidden = false;
  openScreen('trends', () => { close(); $('trends').hidden = true; });
  loadTrends();
});
$('trends-close').addEventListener('click', closeTrends);
$('trends').addEventListener('click', (ev) => { if (ev.target === $('trends')) closeTrends(); });

// --------------------------------------------------------------- weigh-in

// A dial and a needle, not a box with an arrow -- the first attempt read as
// an upload icon at 20px, which is the only size it is ever drawn at.
const SCALE_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
  <rect x="3.4" y="4.6" width="17.2" height="14.8" rx="3.6" fill="none"
        stroke="currentColor" stroke-width="1.7"/>
  <path d="M8.2 14.4a3.8 3.8 0 0 1 7.6 0" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round"/>
  <path d="M12 14.4l2.4-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
</svg>`;

/**
 * Days the prompt has been dismissed on. Someone who only wants to log food
 * should be able to make the ask go away without it returning until tomorrow.
 */
const dismissedKey = 'plate.weigh.dismissed';
const isDismissed = (day) => {
  try { return localStorage.getItem(dismissedKey) === day; } catch { return false; }
};
const dismiss = (day) => {
  try { localStorage.setItem(dismissedKey, day); } catch {}
};

const roundKg = (v) => Math.round(v * 10) / 10;

function renderWeigh(day, weight, expenditure) {
  const el = $('weigh');
  const isToday = day === localDayKey();

  // A missed day can be filled in later -- the expenditure estimate wants
  // coverage, and a forgotten Tuesday should be repairable on Wednesday. Only
  // today's prompt can be dismissed; a past day simply offers, quietly.
  if (weight?.today === null && isToday && isDismissed(day)) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  if (weight?.today !== null && weight?.today !== undefined) {
    const t = weight.trend;
    const sub = t
      ? `${t.slopeKgPerWeek < 0 ? 'down' : 'up'} ${Math.abs(t.slopeKgPerWeek).toFixed(2)} kg a week`
      : 'a trend needs 3 weigh-ins over a week';
    el.innerHTML = `
      <button class="weigh-row" type="button" id="weigh-open">
        <span class="ico">${SCALE_ICON}</span>
        <span class="lab">${isToday ? 'Weighed in today' : 'Weight that day'}
          <span class="sub">${esc(sub)}</span></span>
        <span class="val">${weight.today.toFixed(1)} kg</span>
        <span class="chev" aria-hidden="true">&rsaquo;</span>
      </button>`;
  } else {
    // Progress is shown here because this is where the ask is made: a prompt
    // with a visible reason is a different thing from a chore.
    const p = expenditure?.method !== 'measured' ? expenditure?.progress : null;
    const left = p && p.weighings < p.neededWeighings ? p.neededWeighings - p.weighings : 0;
    const sub = left
      ? `${left} more and this becomes a measurement`
      : 'keeps the estimate honest';
    const title = isToday ? 'Weigh in' : 'No weight for this day';
    const line = isToday ? sub : 'Fill it in — it counts towards the estimate.';
    el.innerHTML = `
      <div style="display:flex;align-items:center">
        <button class="weigh-row" type="button" id="weigh-open">
          <span class="ico">${SCALE_ICON}</span>
          <span class="lab">${esc(title)}<span class="sub">${esc(line)}</span></span>
          <span class="val dim">${weight?.last ? `${weight.last.toFixed(1)} kg` : ''}</span>
          <span class="chev" aria-hidden="true">&rsaquo;</span>
        </button>
        ${isToday ? `<button class="weigh-dismiss" type="button" id="weigh-skip"
                aria-label="Not today">&times;</button>` : ''}
      </div>`;
    track('weigh_prompt_shown', { today: isToday });
    if (isToday) {
      $('weigh-skip').addEventListener('click', () => {
        track('weigh_dismissed');
        dismiss(day); renderWeigh(day, weight, expenditure);
      });
    }
  }

  $('weigh-open').addEventListener('click', () => {
    track('weigh_open', { hadReading: weight?.today !== null && weight?.today !== undefined });
    openWeighEditor(day, weight);
  });
}

/**
 * Replaces the row with a stepper, pre-filled from the most recent reading.
 *
 * Weight moves slowly, so yesterday's number is nearly always within a nudge
 * of today's -- which means the common case should not raise a keyboard at
 * all. The field stays typable for the times it has genuinely moved.
 */
function openWeighEditor(day, weight) {
  const el = $('weigh');
  const start = weight?.today ?? weight?.last ?? 75;

  el.innerHTML = `
    <div class="weigh-edit">
      <div class="weigh-stepper">
        <button class="step" type="button" id="w-down" aria-label="Lower by 100 grams">&minus;</button>
        <label class="sr-only" for="w-value">Weight in kilograms</label>
        <span class="weigh-field">
          <input id="w-value" type="number" inputmode="decimal" step="0.1" min="20" max="400"
                 value="${roundKg(start).toFixed(1)}">
          <span class="unit">kg</span>
        </span>
        <button class="step" type="button" id="w-up" aria-label="Raise by 100 grams">+</button>
      </div>
      <div class="weigh-actions">
        <button class="primary" type="button" id="w-commit">Save</button>
        <button class="secondary" type="button" id="w-cancel">Cancel</button>
      </div>
      <p class="weigh-why">Starts from your last reading — nudge it rather than typing.</p>
    </div>`;

  const field = $('w-value');
  const nudge = (delta) => {
    const next = roundKg((Number(field.value) || start) + delta);
    field.value = Math.min(400, Math.max(20, next)).toFixed(1);
  };
  $('w-down').addEventListener('click', () => nudge(-0.1));
  $('w-up').addEventListener('click', () => nudge(0.1));
  $('w-cancel').addEventListener('click', () => loadDay());

  $('w-commit').addEventListener('click', async () => {
    const kg = Number(String(field.value).replace(',', '.'));
    if (!Number.isFinite(kg) || kg < 20 || kg > 400) return toast('That weight looks wrong.');
    $('w-commit').disabled = true;
    try {
      await api('/api/weights', {
        method: 'PUT',
        body: JSON.stringify({ day, kg, at: new Date().toISOString() })
      });
      track('weigh_saved', { backfill: day !== localDayKey() });
      if (day !== localDayKey()) track('weigh_backfill');
      toast('Weight logged');
      await loadDay();
    } catch (err) {
      $('w-commit').disabled = false;
      toast(err.message);
    }
  });
}

// ------------------------------------------------------------- capturing

/**
 * Downscales in the browser before upload. A modern phone photo is 3-8 MB and
 * the model sees no more detail than a 1280px edge gives it, so shrinking here
 * saves the user's data allowance and most of the round trip.
 */
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1280;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(blob);
  });

  return { base64, mimeType: 'image/jpeg', objectUrl: URL.createObjectURL(blob) };
}

$('add-btn').addEventListener('click', () => $('file-input').click());

$('file-input').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;

  openReview('photo');
  busy('Reading the photo…');

  try {
    state.photo = await prepareImage(file);
    // The user can back out while the photo is being read or analysed. Every
    // resumption point checks the sheet is still open, so a cancelled capture
    // cannot repopulate a closed sheet or leave stale state behind it.
    if (!screenIsOpen('review')) return;
    $('review-photo').src = state.photo.objectUrl;

    busy('Working out what is on the plate…');
    const analyseAt = Date.now();
    track('analyse_start');
    const data = await api('/api/analyse', {
      method: 'POST',
      body: JSON.stringify({ image: state.photo.base64, mimeType: state.photo.mimeType })
    });
    if (!screenIsOpen('review')) return;

    track('analyse_ok', { seconds: (Date.now() - analyseAt) / 1000, items: data.estimate.items.length });
    state.estimate = data.estimate;
    state.meal = guessMeal();
    idle();
    initWeightSlider();
    renderReview();
  } catch (err) {
    if (!screenIsOpen('review')) return;
    track('analyse_fail', { code: err.code || 'unknown' });
    if (err.code === 'not_food') {
      failed(err.note || 'That does not look like food. Try another photo.');
    } else if (err.code === 'nothing_found') {
      failed(err.note || 'Nothing recognisable in that photo. Try a clearer one.');
    } else if (err.message !== 'not_registered') {
      failed(err.message);
    }
  }
});

function guessMeal() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 22) return 'dinner';
  return 'snack';
}

/**
 * Waiting on the model, and the failures that come back from it.
 *
 * These were a line of small print at the foot of the review sheet. On a
 * scrolled sheet that line sits under the save bar, so the one thing actually
 * happening was the one thing you could not see.
 *
 * The two states behave differently on purpose. A wait cannot be dismissed --
 * there is nothing to do but wait, and the sheet underneath is about to be
 * replaced. A failure must be dismissed, because it is the app declining to do
 * what was asked and that should not scroll quietly past.
 */
function busy(text) {
  const el = $('wait');
  el.hidden = false;
  el.classList.remove('err');
  $('wait-spin').hidden = false;
  $('wait-msg').textContent = text;
  $('wait-ok').hidden = true;
}

function failed(text) {
  if (!text) return idle();
  track('error_shown', { where: 'review' });
  const el = $('wait');
  el.hidden = false;
  el.classList.add('err');
  $('wait-spin').hidden = true;
  $('wait-msg').textContent = text;
  $('wait-ok').hidden = false;
  // Registered as a screen so the back gesture dismisses the message rather
  // than the sheet behind it.
  if (!screenIsOpen('alert')) openScreen('alert', () => { $('wait').hidden = true; });
  $('wait-ok').focus();
}

function idle() {
  if (screenIsOpen('alert')) return dismissScreen('alert');
  $('wait').hidden = true;
}

$('wait-ok').addEventListener('click', () => dismissScreen('alert'));

// ---------------------------------------------------------------- review

const SHEET_TITLES = {
  photo: 'Check the portion',
  manual: 'Add food',
  edit: 'Edit this meal'
};

function openReview(mode, entry = null) {
  state.mode = mode;
  state.editingId = entry?.id || null;
  state.existingPhotoId = entry?.photoId || null;
  state.corrections = entry?.corrections || 0;
  state.photo = null;
  state.estimate = entry
    ? {
        items: entry.items,
        portionSource: portionSourceOf(entry),
        portionConfirmed: entry.portionConfirmed,
        note: entry.note || ''
      }
    : null;
  state.meal = entry?.meal || guessMeal();

  $('review-heading').textContent = SHEET_TITLES[mode];
  $('save-entry').textContent = mode === 'edit' ? 'Save changes' : 'Save';

  const photoEl = $('review-photo');
  if (entry?.photoId) {
    photoEl.src = `/api/photo/${encodeURIComponent(entry.photoId)}`;
    photoEl.hidden = false;
  } else {
    photoEl.removeAttribute('src');
    photoEl.hidden = mode !== 'photo';
  }

  $('review-note').hidden = true;
  $('correct-block').hidden = true;
  $('correct-form').hidden = true;
  $('correct-toggle').setAttribute('aria-expanded', 'false');
  $('correct-text').value = '';
  $('food-q').value = '';
  $('food-results').innerHTML = '';
  $('finder-hint').textContent = state.me?.genericSearch === false
    ? 'Generic foods may be missing — search covers packaged products best.'
    : '';
  idle();

  if (entry) {
    renderReview();
    if (hasPhotoItems(state.estimate)) initWeightSlider();
  } else {
    $('review-items').innerHTML = '';
    $('review-kcal').textContent = '0';
    $('review-range').textContent = '';
    $('review-macros').innerHTML = '';
    $('weight-block').hidden = true;
    $('save-entry').disabled = true;
    renderMealChips();
  }

  $('review').hidden = false;
  state.closeReviewScreen = screen('review');
  track('entry_start', { mode, editing: mode === 'edit' });
  openScreen('review', teardownReview);
  showRecent();

  // "Manual" means the user intends to enter it themselves, so both routes to
  // that -- searching by name and typing the numbers -- are open on arrival
  // rather than one behind a disclosure.
  //
  // Deliberately no autofocus. Focusing the search box raises the keyboard,
  // which covers the typed-numbers form directly below it -- so the app would
  // be quietly choosing one of the two routes on the user's behalf, which is
  // the opposite of what an explicit "Manual" button is for.
  $('manual-form').hidden = mode !== 'manual';
  syncManualToggle();
}

/** Tears the sheet down. Only ever called by the navigation layer. */
function teardownReview() {
  if (state.closeReviewScreen) {
    // Whether the sheet produced an entry is the whole question.
    state.closeReviewScreen({ items: state.estimate?.items?.length || 0, saved: Boolean(state.savedFromReview) });
    if (!state.savedFromReview) track('entry_abandoned', { mode: state.mode, items: state.estimate?.items?.length || 0 });
    state.closeReviewScreen = null;
  }
  state.savedFromReview = false;
  if (state.photo?.objectUrl) URL.revokeObjectURL(state.photo.objectUrl);
  state.estimate = null;
  state.photo = null;
  state.editingId = null;
  state.existingPhotoId = null;
  state.corrections = 0;
  // A request may still be in flight -- the reply checks whether the sheet is
  // still open and returns without clearing anything, so the overlay has to
  // come down with the sheet or it would outlive it.
  $('wait').hidden = true;
  $('review').hidden = true;
}

const closeReview = () => dismissScreen('review');
$('review-close').addEventListener('click', closeReview);
$('review').addEventListener('click', (ev) => { if (ev.target === $('review')) closeReview(); });
$('add-manual').addEventListener('click', () => openReview('manual'));

// Barcode is its own way in, not a control inside the sheet: the sheet opens
// and the scanner starts immediately, so scanning a packet is one tap.
$('add-barcode').addEventListener('click', async () => {
  openReview('manual');
  $('manual-form').hidden = true;
  syncManualToggle();
  await startScan();
});

function initWeightSlider() {
  const grams = totalsOf(state.estimate).grams || 100;
  const slider = $('total-weight');
  // Range is centred on the current weight so the user can move either way
  // with one thumb, rather than starting at an arbitrary end of a fixed scale.
  slider.min = Math.max(10, Math.round(grams * 0.25 / 10) * 10);
  slider.max = Math.round(grams * 2.5 / 10) * 10;
  slider.step = grams > 600 ? 20 : 10;
  slider.value = grams;
}

function renderReview() {
  const est = state.estimate;
  if (!est) return;

  const totals = totalsOf(est);
  const ranges = rangesOf(est);

  // The weight slider rescales the whole plate proportionally, which only
  // makes sense for a photo estimate. When every item came from a database
  // the grams were entered deliberately, so the control would fight the user.
  const photoBased = hasPhotoItems(est);
  $('weight-block').hidden = !photoBased;
  // Correctable either from the photo still in memory, or -- for an entry
  // already saved -- from the copy the server kept, which is the case that
  // matters most: a wrong identification is usually spotted after the fact.
  // Withdrawn once this photograph has been read again twice: a third go is
  // refused by the server, and an offer that cannot be taken up is worse than
  // no offer.
  const correctable = state.photo?.base64
    || (state.existingPhotoId && (state.corrections || 0) < 2);
  $('correct-block').hidden = !(photoBased && correctable);
  // Tense follows the meal: a plate in front of you is still being eaten, one
  // logged yesterday is not.
  $('correct-toggle').textContent = state.editingId
    ? "Not what you ate?" : "Not what you're eating?";

  $('weight-out').textContent = `${Math.round(totals.grams)} g`;
  $('review-kcal').textContent = Math.round(totals.calories);

  if (photoBased) {
    const source = portionSourceOf(est);
    const tail = {
      model: ' \u2014 set the weight if you know it',
      estimated: ' \u2014 from your estimate of the weight',
      weighed: ' \u2014 from a weighed portion'
    }[source];
    $('review-range').textContent =
      `Likely ${ranges.calories.low}\u2013${ranges.calories.high} kcal${tail}`;

    $('weighed').checked = source === 'weighed';
    // Stated plainly, because the measurement does not support "always
    // adjust": a guess worse than about 30% is no better than leaving the
    // model's own estimate alone.
    $('weight-hint').textContent = source === 'weighed'
      ? 'Weighed portions are roughly twice as accurate as an eyeballed one.'
      : 'Only worth changing if you have a better idea than the photo does — '
        + 'a rough guess is no more accurate than leaving it.';
  } else {
    $('review-range').textContent = totals.calories
      ? 'From the food database \u2014 exact for the weights you entered.'
      : '';
  }
  renderMacros($('review-macros'), totals);

  if (est.note) {
    $('review-note').textContent = est.note;
    $('review-note').hidden = false;
  }

  $('review-items').innerHTML = est.items.map((it) => `
    <li class="item" data-id="${esc(it.id)}">
      <span class="item-name">${esc(it.name)}</span>
      <span class="item-kcal">${Math.round(itemMacros(it).calories)} kcal</span>
      <span class="grams">
        <button type="button" data-step="-10" aria-label="Less ${esc(it.name)}">&minus;</button>
        <input type="number" inputmode="numeric" min="0" step="5" value="${Math.round(it.grams)}"
               aria-label="Grams of ${esc(it.name)}">
        <button type="button" data-step="10" aria-label="More ${esc(it.name)}">+</button>
      </span>
      <button class="item-del" type="button" data-remove aria-label="Remove ${esc(it.name)}">&times;</button>
    </li>`).join('');

  renderMealChips();
  $('save-entry').disabled = est.items.length === 0;
}

function renderMealChips() {
  const meals = state.me?.meals || ['breakfast', 'lunch', 'dinner', 'snack'];
  $('meal-picker').innerHTML = meals.map((m) =>
    `<button type="button" class="chip" data-meal="${esc(m)}"
       aria-pressed="${state.meal === m}">${esc(m[0].toUpperCase() + m.slice(1))}</button>`).join('');
}

$('meal-picker').addEventListener('click', (ev) => {
  const meal = ev.target.closest('[data-meal]')?.dataset.meal;
  if (!meal) return;
  state.meal = meal;
  renderMealChips();
});

let sliderTracked = false;
$('total-weight').addEventListener('input', (ev) => {
  if (!state.estimate) return;
  if (!sliderTracked) { track('portion_slider'); sliderTracked = true; }
  state.estimate = setTotalGrams(state.estimate, Number(ev.target.value));
  renderReview();
});

$('weighed').addEventListener('change', (ev) => {
  if (!state.estimate) return;
  track('portion_weighed_ticked', { on: ev.target.checked });
  state.estimate = markWeighed(state.estimate, ev.target.checked);
  renderReview();
});

$('review-items').addEventListener('click', (ev) => {
  const li = ev.target.closest('.item');
  if (!li || !state.estimate) return;
  const id = li.dataset.id;

  if (ev.target.closest('[data-remove]')) {
    state.estimate = removeItem(state.estimate, id);
    if (hasPhotoItems(state.estimate)) initWeightSlider();
    renderReview();
    return;
  }

  const step = Number(ev.target.closest('[data-step]')?.dataset.step);
  if (!step) return;
  track('portion_item_step', { step });
  const item = state.estimate.items.find((i) => i.id === id);
  state.estimate = setItemGrams(state.estimate, id, Math.max(0, item.grams + step));
  $('total-weight').value = totalsOf(state.estimate).grams;
  renderReview();
});

$('review-items').addEventListener('change', (ev) => {
  if (ev.target.tagName !== 'INPUT' || !state.estimate) return;
  track('portion_item_typed');
  const id = ev.target.closest('.item')?.dataset.id;
  state.estimate = setItemGrams(state.estimate, id, Number(ev.target.value));
  $('total-weight').value = totalsOf(state.estimate).grams;
  renderReview();
});

// ----------------------------------------------------------- food finder

let searchTimer = null;
let searchSeq = 0;

const SOURCE_LABEL = { usda: 'USDA', openfoodfacts: 'OFF', recent: 'again' };

function renderResults(results) {
  $('food-results').innerHTML = results.map((f, i) => {
    const meta = f.source === 'recent'
      ? `${f.grams} g · ${Math.round((f.per?.calories || 0) * f.grams)} kcal`
        + (f.uses > 1 ? ` · logged ${f.uses}×` : '')
      : `${Math.round(f.per100.calories)} kcal / 100 g`;
    return `
    <li><button class="result" type="button" data-i="${i}">
      <span class="result-name">${esc(f.name)}<span class="src">${esc(SOURCE_LABEL[f.source] || f.source)}</span></span>
      <span class="result-meta">${esc(meta)}</span>
      <span class="result-add" aria-hidden="true">+</span>
    </button></li>`;
  }).join('');
  $('food-results').dataset.payload = JSON.stringify(results);
}

/**
 * Foods logged before, offered before the user types anything.
 *
 * Most meals repeat, so the common case should cost one tap rather than a
 * search. Rendered into the same list as search results so the two behave
 * identically when tapped.
 */
async function showRecent() {
  const seq = ++searchSeq;
  try {
    const { recent } = await api('/api/foods/recent');
    if (seq !== searchSeq || $('food-q').value.trim()) return;
    if (!recent.length) return;

    renderResults(recent.map((f) => ({
      name: f.name,
      source: 'recent',
      per100: null,
      // Recents carry per-gram rates already, and the weight last used.
      per: f.per,
      grams: f.grams,
      barcode: f.barcode || null,
      hasImage: Boolean(f.barcode),
      uses: f.uses
    })));
    $('finder-hint').textContent = 'Recently logged — tap to add again.';
  } catch {
    // A failed recents fetch is not worth a message: the search box works.
  }
}

async function runSearch(query) {
  // Every response carries the sequence number of the request that asked for
  // it, so a slow early reply cannot overwrite a fast later one.
  const seq = ++searchSeq;
  $('finder-hint').textContent = 'Searching…';

  try {
    const data = await api(`/api/foods/search?q=${encodeURIComponent(query)}`);
    if (seq !== searchSeq) return;
    // Query length rather than the query: what matters is whether searching
    // worked, not what was eaten.
    track('search', { chars: query.length, results: data.results.length });
    if (!data.results.length) track('search_empty', { chars: query.length });
    renderResults(data.results);
    $('finder-hint').textContent = data.results.length
      ? (data.genericSearch ? '' : 'Generic foods may be missing — packaged products search best.')
      : 'Nothing found. Try a different word, or scan the barcode.';
  } catch (err) {
    if (seq !== searchSeq) return;
    $('food-results').innerHTML = '';
    $('finder-hint').textContent = err.message;
  }
}

$('food-q').addEventListener('input', (ev) => {
  const query = ev.target.value.trim();
  clearTimeout(searchTimer);
  if (query.length < 2) {
    $('food-results').innerHTML = '';
    $('finder-hint').textContent = '';
    if (!query) showRecent();
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), 350);
});

$('food-q').addEventListener('focus', () => {
  if (!$('food-q').value.trim()) showRecent();
});

/**
 * Adds a looked-up food at its stated serving size, or 100 g when it has
 * none.
 *
 * Deliberately no weight prompt: the item lands in the list with the same
 * grams stepper every other item has, so adjusting it uses the control the
 * user already knows instead of a modal that interrupts the flow.
 */
function addFood(food) {
  const base = state.estimate || { items: [], portionSource: 'model', note: '' };

  if (food.barcode && food.hasImage) {
    const photoEl = $('review-photo');
    photoEl.src = `/api/foods/image/${encodeURIComponent(food.barcode)}`;
    photoEl.hidden = false;
  }

  if (food.source === 'recent') {
    // Already per-gram, at the weight last used, so it is added directly
    // rather than round-tripped through the per-100 g form.
    state.estimate = {
      ...base,
      items: [...base.items, {
        id: `re${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: food.name, grams: food.grams, per: food.per, source: 'manual',
        ...(food.barcode ? { barcode: food.barcode } : {})
      }]
    };
  } else {
    const item = toItem(food, food.servingG || 100);
    if (!item) return;
    state.estimate = addManualItem(base, item);
  }

  $('food-q').value = '';
  $('food-results').innerHTML = '';
  $('finder-hint').textContent = '';
  renderReview();

  const added = state.estimate.items[state.estimate.items.length - 1];
  toast(`Added ${food.name} at ${added.grams} g — adjust below`);

  // Put the new row's weight field under the thumb straight away.
  const field = document.querySelector(`.item[data-id="${added.id}"] input`);
  field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

$('food-results').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-i]');
  if (!btn) return;
  const results = JSON.parse($('food-results').dataset.payload || '[]');
  const idx = Number(btn.dataset.i);
  const food = results[idx];
  // Which rank got picked says whether the ranking is any good.
  if (food) { track('search_pick', { rank: idx + 1, source: food.source }); addFood(food); }
});

// ---------------------------------------------------------- typed panel

let manualBasis = 'portion';

/** Keeps the disclosure's own label honest about what it will do next. */
function syncManualToggle() {
  const open = !$('manual-form').hidden;
  $('manual-toggle').textContent = open ? 'Hide these fields' : 'Type in the numbers instead';
  $('manual-toggle').setAttribute('aria-expanded', String(open));
}

// ------------------------------------------------------ correcting the AI

$('correct-toggle').addEventListener('click', () => {
  const form = $('correct-form');
  form.hidden = !form.hidden;
  $('correct-toggle').setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) {
    track('correct_open');
    $('correct-text').focus();
  }
});

/**
 * Re-reads the same photograph, having been told what the food actually is.
 *
 * The photo is still in memory from the original capture, so this costs one
 * more model call and no second picture. The correction is kept on the
 * estimate's note so the entry records why its numbers changed.
 */
$('correct-go').addEventListener('click', async () => {
  const correction = $('correct-text').value.trim();
  if (!correction) return toast('Say what it is first.');

  // Fresh capture sends the bytes it holds; a saved entry names itself and
  // lets the server read the photo it already has, so this works even on an
  // entry logged from a different phone.
  const live = !!state.photo?.base64;
  if (!live && !(state.editingId && state.existingPhotoId)) {
    return toast('The photo is no longer available — take another.');
  }

  $('correct-go').disabled = true;
  busy('Reading it again…');
  track('correct_submit', { chars: correction.length });
  const startedAt = Date.now();

  try {
    const data = live
      ? await api('/api/analyse', {
          method: 'POST',
          body: JSON.stringify({
            image: state.photo.base64, mimeType: state.photo.mimeType, correction
          })
        })
      : await api(`/api/entries/${state.editingId}/reanalyse`, {
          method: 'POST', body: JSON.stringify({ correction })
        });
    if (!screenIsOpen('review')) return;

    track('correct_ok', {
      seconds: (Date.now() - startedAt) / 1000,
      items: data.estimate.items.length,
      repeated: Boolean(data.repeated)
    });
    if (!live && !data.repeated) state.corrections = (state.corrections || 0) + 1;
    state.estimate = { ...data.estimate, note: `You said: ${correction}` };
    idle();
    $('correct-form').hidden = true;
    $('correct-toggle').setAttribute('aria-expanded', 'false');
    $('correct-text').value = '';
    initWeightSlider();
    renderReview();
    toast('Read again');
  } catch (err) {
    track('correct_fail', { code: err.code || 'unknown' });
    failed(err.message);
  } finally {
    $('correct-go').disabled = false;
  }
});

$('manual-toggle').addEventListener('click', () => {
  const form = $('manual-form');
  form.hidden = !form.hidden;
  if (!form.hidden) track('manual_open');
  syncManualToggle();
  if (!form.hidden) {
    // Carry over whatever was being searched for, so switching to typing it
    // in does not mean retyping the name.
    if (!$('m-name').value) $('m-name').value = $('food-q').value.trim();
    $('m-name').focus();
  }
});

$('m-basis').addEventListener('click', (ev) => {
  const basis = ev.target.closest('[data-basis]')?.dataset.basis;
  if (!basis) return;
  manualBasis = basis;
  document.querySelectorAll('#m-basis [data-basis]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.basis === basis));
  });
  checkManual();
});

const manualNumber = (id) => {
  const raw = String($(id).value).replace(',', '.').trim();
  if (!raw) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
};

/** The typed figures reduced to per-100g, or null when incomplete. */
function readManual() {
  const grams = manualNumber('m-grams');
  const kcal = manualNumber('m-kcal');
  if (!grams || grams <= 0 || kcal === null) return null;

  const scale = manualBasis === 'per100' ? 1 : 100 / grams;
  const per100 = {
    calories: kcal * scale,
    protein: (manualNumber('m-protein') ?? 0) * scale,
    fat: (manualNumber('m-fat') ?? 0) * scale,
    carbs: (manualNumber('m-carbs') ?? 0) * scale
  };
  return { name: $('m-name').value.trim(), grams, per100 };
}

/**
 * Warns when typed figures do not hold together.
 *
 * Printed panels are wrong more often than people expect: a restaurant menu
 * that prompted this feature stated 940 kcal for macros that add to 807, a
 * 14% contradiction. The app cannot tell which number is wrong, but it can say
 * that one of them is.
 */
function checkManual() {
  const parsed = readManual();
  const warn = $('manual-warn');
  if (!parsed) { warn.hidden = true; return null; }

  if (!isPlausible(parsed.per100)) {
    warn.textContent = 'Those numbers are not physically possible for 100 g of food — check '
      + 'whether they are per portion or per 100 g.';
    warn.hidden = false;
    return null;
  }

  const disagreement = macroAgreement({
    calories: parsed.per100.calories,
    protein: parsed.per100.protein,
    fat: parsed.per100.fat,
    carbs: parsed.per100.carbs
  });

  // 10%, not 15%. The menu that prompted this feature was out by 14.1% and
  // slipped under a 15% threshold. Some slack is still needed: fibre counts
  // as carbohydrate on EU labels but yields about 2 kcal/g rather than 4, and
  // panels are rounded, so small gaps are normal and not worth a warning.
  if (disagreement !== null && disagreement > 0.10) {
    const implied = Math.round(
      (parsed.per100.protein * 4 + parsed.per100.carbs * 4 + parsed.per100.fat * 9)
      * parsed.grams / 100);
    track('manual_warned', { gap: Math.round(disagreement * 100) });
    warn.textContent = `The macros add up to about ${implied} kcal, not `
      + `${Math.round(parsed.per100.calories * parsed.grams / 100)}. Printed panels are often out — `
      + 'worth a second look. The calories you entered are what will be used.';
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  return parsed;
}

for (const id of ['m-grams', 'm-kcal', 'm-protein', 'm-fat', 'm-carbs']) {
  $(id).addEventListener('input', checkManual);
}

$('m-add').addEventListener('click', () => {
  const parsed = checkManual();
  if (!parsed) return toast('Enter at least a weight and the calories.');
  if (!parsed.name) return toast('Give it a name.');

  // source stays 'manual', so no photo-error band is applied to it.
  state.estimate = addManualItem(
    state.estimate || { items: [], portionSource: 'model', note: '' }, parsed);

  for (const id of ['m-name', 'm-grams', 'm-kcal', 'm-protein', 'm-fat', 'm-carbs']) $(id).value = '';
  $('manual-warn').hidden = true;
  $('manual-form').hidden = true;
  syncManualToggle();
  $('food-q').value = '';
  $('food-results').innerHTML = '';

  renderReview();
  track('manual_add');
  toast(`Added ${parsed.name}`);
});

async function lookupBarcode(code) {
  $('finder-hint').textContent = 'Looking up…';
  try {
    const { food } = await api(`/api/foods/barcode/${encodeURIComponent(code)}`);
    $('finder-hint').textContent = '';
    addFood(food);
  } catch (err) {
    $('finder-hint').textContent = err.message;
  }
}

/**
 * Scans with the browser's BarcodeDetector where it exists (Chrome on
 * Android). Everywhere else the barcode can still be typed, which is slower
 * but never leaves the user stuck.
 */
async function startScan() {
  track('scan_start');
  if (!('BarcodeDetector' in window)) {
    track('scan_typed', { reason: 'no_detector' });
    const typed = prompt('Type the barcode number:');
    if (typed) lookupBarcode(typed.trim());
    return;
  }

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' }
    });
  } catch {
    track('scan_typed', { reason: 'no_camera' });
    const typed = prompt('No camera access. Type the barcode number:');
    if (typed) lookupBarcode(typed.trim());
    return;
  }

  // A bare camera feed tells the user nothing about what it wants, so the
  // viewfinder is framed: a dimmed surround with a barcode-shaped window,
  // corner brackets, and an explicit way out. The window is wide and short
  // because that is the shape of the thing being looked for.
  const wrap = document.createElement('div');
  wrap.className = 'scanner-wrap';
  wrap.innerHTML = `
    <video class="scanner" playsinline></video>
    <div class="scan-ui">
      <p class="scan-title">Point at the barcode</p>
      <div class="scan-window" role="img" aria-label="Barcode viewfinder">
        <i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>
        <div class="scan-line"></div>
      </div>
      <p class="scan-hint" id="scan-hint" role="status"></p>
      <button class="scan-cancel" type="button">Cancel</button>
    </div>`;

  const video = wrap.querySelector('video');
  video.srcObject = stream;

  // The camera must be released however the scanner goes away -- back
  // gesture, cancel, timeout or a successful scan -- so teardown lives in one
  // place and the navigation layer owns when it runs.
  const teardown = () => {
    stream.getTracks().forEach((t) => t.stop());
    wrap.remove();
  };

  // Registered before the overlay is on screen and before play() is awaited.
  // Doing it afterwards leaves a window -- however brief, and it is not brief
  // while a phone camera warms up -- where the viewfinder is covering the app
  // but the back gesture would close the sheet underneath it and leave the
  // camera running.
  const scanAt = Date.now();
  const closeScanScreen = screen('scanner');
  document.body.appendChild(wrap);
  openScreen('scanner', () => { closeScanScreen(); teardown(); });

  try {
    await video.play();
  } catch {
    // Autoplay refused. The stream is still attached, so the frame grab below
    // may still work; if it does not, the timeout ends the scan cleanly.
  }

  const detector = new window.BarcodeDetector({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']
  });

  const stop = () => dismissScreen('scanner');
  wrap.querySelector('.scan-cancel').addEventListener('click', () => {
    track('scan_cancel', { seconds: (Date.now() - scanAt) / 1000 });
    stop();
  });

  // Say something before giving up. Twenty seconds of an unchanging camera
  // with no feedback reads as a broken app rather than a difficult barcode.
  const nudge = setTimeout(() => {
    const hint = wrap.querySelector('#scan-hint');
    if (hint) hint.textContent = 'Still looking — try more light, or move closer so the '
      + 'barcode fills the frame.';
  }, 6000);

  const deadline = Date.now() + 25000;
  const tick = async () => {
    if (!wrap.isConnected) { clearTimeout(nudge); return; }
    if (Date.now() > deadline) {
      clearTimeout(nudge);
      track('scan_fail', { seconds: (Date.now() - scanAt) / 1000 });
      stop();
      $('finder-hint').textContent =
        'No barcode found. Try again, or use the barcode button here to type the number.';
      return;
    }
    try {
      const found = await detector.detect(video);
      if (found.length) {
        const code = found[0].rawValue;
        clearTimeout(nudge);
        track('scan_ok', { seconds: (Date.now() - scanAt) / 1000 });
        // Confirm the hit before the camera disappears, so a successful scan
        // does not just look like the screen closing on its own.
        wrap.classList.add('hit');
        stop();
        lookupBarcode(code);
        return;
      }
    } catch {}
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

$('scan-btn').addEventListener('click', startScan);

// ------------------------------------------------------------------ save

$('save-entry').addEventListener('click', async () => {
  if (!state.estimate || state.busy) return;
  state.busy = true;
  $('save-entry').disabled = true;
  busy('Saving…');

  const body = {
    meal: state.meal,
    items: state.estimate.items,
    portionSource: portionSourceOf(state.estimate),
    portionConfirmed: state.estimate.portionConfirmed,
    note: state.estimate.note || null
  };

  try {
    if (state.mode === 'edit') {
      await api(`/api/entries/${encodeURIComponent(state.editingId)}`, {
        method: 'PUT', body: JSON.stringify(body)
      });
    } else {
      await api('/api/entries', {
        method: 'POST',
        body: JSON.stringify({
          ...body,
          day: state.day,
          image: state.photo?.base64,
          mimeType: state.photo?.mimeType
        })
      });
    }
    state.savedFromReview = true;
    track(state.mode === 'edit' ? 'entry_edited' : 'entry_saved',
      { mode: state.mode, items: state.estimate.items.length, portion: portionSourceOf(state.estimate) });
    // Ahead of closeReview() rather than leaning on the teardown: dismissing a
    // screen goes through history.go(), which is asynchronous, and the overlay
    // would otherwise linger over the toast for a frame or two.
    idle();
    closeReview();
    toast(state.mode === 'edit' ? 'Updated' : 'Logged');
    await loadDay();
  } catch (err) {
    failed(err.message);
    $('save-entry').disabled = false;
  } finally {
    state.busy = false;
  }
});

// --------------------------------------------------------------- profile

function fillProfile() {
  const p = state.me?.profile;
  $('p-activity').innerHTML = (state.me?.activityLevels || [])
    .map((l) => `<option value="${esc(l.id)}">${esc(l.label)}</option>`).join('');

  if (!p) return;
  $('p-height').value = p.heightCm ?? '';
  $('p-age').value = p.ageYears ?? '';
  $('p-sex').value = p.sex ?? '';
  if (p.activity) $('p-activity').value = p.activity;
  showMaintenanceResult(state.me.maintenance, state.me.weightUsedKg);
}

/**
 * `usedKg` says which weight the figure was computed from, because the answer
 * is no longer visible in a field on this screen -- it comes from the weigh-in
 * log, and a number with no stated input invites exactly the confusion this
 * change removed.
 */
function showMaintenanceResult(m, usedKg) {
  const el = $('profile-result');
  if (!m) {
    el.className = 'maintenance none';
    el.textContent = usedKg
      ? 'Fill in height, age and a typical week to see an estimate.'
      : 'Log a weight below, and fill in height, age and a typical week.';
    return;
  }
  el.className = 'maintenance';
  el.innerHTML = `You burn roughly <b>${m.kcal} kcal</b> on an average day
    &mdash; most likely between <b>${m.low}</b> and <b>${m.high}</b>.
    ${usedKg ? `Worked out from your latest weigh-in, <b>${Number(usedKg).toFixed(1)} kg</b>. ` : ''}
    This is an estimate from a population formula, not a measurement.`;
}

const closeProfile = () => dismissScreen('profile');
const closeSettings = () => dismissScreen('settings');

/** Who you are: the details the estimate needs, and what it makes of them. */
$('open-profile').addEventListener('click', () => {
  fillProfile();
  loadWeight();
  const close = screen('you');
  $('profile').hidden = false;
  openScreen('profile', () => { close(); $('profile').hidden = true; });
});
$('profile-close').addEventListener('click', closeProfile);
$('profile').addEventListener('click', (ev) => { if (ev.target === $('profile')) closeProfile(); });

/** How the app is set up: devices, your data, getting back in. */
$('open-settings').addEventListener('click', () => {
  loadDevices();
  renderRecoveryState();
  $('code-box').hidden = true;
  const close = screen('settings');
  $('settings').hidden = false;
  openScreen('settings', () => { close(); $('settings').hidden = true; });
});
$('settings-close').addEventListener('click', closeSettings);
$('settings').addEventListener('click', (ev) => { if (ev.target === $('settings')) closeSettings(); });

$('profile-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('profile-error');
  err.hidden = true;

  try {
    const data = await api('/api/profile', {
      method: 'PUT',
      // weightKg is deliberately not sent. The server treats an absent field
      // as "leave it alone", so saving here never disturbs a weight that came
      // from a weigh-in.
      body: JSON.stringify({
        heightCm: $('p-height').value || null,
        ageYears: $('p-age').value || null,
        sex: $('p-sex').value || null,
        activity: $('p-activity').value || null
      })
    });
    state.me.profile = data.profile;
    state.me.maintenance = data.maintenance;
    state.me.weightUsedKg = data.weightUsedKg;
    showMaintenanceResult(data.maintenance, data.weightUsedKg);
    toast('Saved');
    await loadDay();
  } catch (e) {
    err.textContent = e.status === 400 && e.code === 'out_of_range'
      ? 'Those numbers look out of range — check them and try again.'
      : e.message;
    err.hidden = false;
  }
});

// ------------------------------------------------------- weight & burn

/**
 * Raw readings as faint dots, and the fitted trend as a straight line.
 *
 * Both are drawn deliberately: the dots show a person their scale really does
 * jump around, which is the argument for not reacting to any single morning.
 * The line is the *least-squares fit* rather than a moving average, because
 * that fit is what the expenditure figure is computed from -- drawing a
 * different smoother would put a line on screen that disagrees with the number
 * beside it.
 */
function renderWeightChart(rows, trend) {
  const el = $('weight-chart');
  const series = smoothSeries(rows);

  if (!series.length) {
    el.innerHTML = '<svg viewBox="0 0 300 84" preserveAspectRatio="none">'
      + '<text class="empty" x="8" y="46">No weigh-ins yet.</text></svg>';
    return;
  }

  const w = 300, h = 84, pad = 6;
  const xs = series.map((p) => p.at);
  const ys = series.map((p) => p.kg);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const flat = hi - lo < 0.05;
  const y0 = flat ? lo - 0.5 : lo;
  const spanY = flat ? 1 : Math.max(0.5, hi - lo); // never let a flat series fill the box

  const px = (t) => pad + ((t - x0) / Math.max(1, x1 - x0)) * (w - pad * 2);
  const py = (kg) => h - pad - ((kg - y0) / spanY) * (h - pad * 2);

  const dots = series.map((p) => `<circle class="raw" cx="${px(p.at).toFixed(1)}" cy="${py(p.kg).toFixed(1)}" r="2"/>`).join('');

  let line = '';
  if (trend?.interceptKg !== undefined) {
    const fitAt = (t) => trend.interceptKg + trend.slopeKgPerDay * ((t - trend.fitFrom) / 86400000);
    line = `<path class="trend" d="M${px(x0).toFixed(1)},${py(fitAt(x0)).toFixed(1)}`
      + ` L${px(x1).toFixed(1)},${py(fitAt(x1)).toFixed(1)}"/>`;
  }

  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${dots}${line}</svg>`;
  el.setAttribute('aria-label',
    `Weight from ${series[0].kg.toFixed(1)} to ${series[series.length - 1].kg.toFixed(1)} kilograms`);
}

function renderExpenditure(exp) {
  const el = $('exp-detail');
  if (!exp) { el.innerHTML = ''; return; }

  if (exp.method !== 'measured') {
    const p = exp.progress || {};
    const parts = [];
    const plural = (n, one, many) => `${n} more ${n === 1 ? one : many}`;
    if (p.loggedDays < p.neededDays) parts.push(plural(p.neededDays - p.loggedDays, 'day logged', 'days logged'));
    if (p.weighings < p.neededWeighings) parts.push(plural(p.neededWeighings - p.weighings, 'weigh-in', 'weigh-ins'));

    el.innerHTML = `
      <div class="big">${exp.available ? `${exp.kcal} kcal` : '&mdash;'}
        <span class="method formula">formula</span></div>
      <p class="progress">${exp.available
        ? 'From your height, weight, age and activity — a population average, not you.'
        : 'Fill in your details above for a first estimate.'}</p>
      <p class="progress">${parts.length
        ? `Needs ${parts.join(' and ')}. Then it becomes a measurement of what you actually burn,
           rather than an average of people your size.`
        : 'Keep logging and weighing — this becomes a measurement once there is enough.'}</p>`;
    return;
  }

  const b = exp.basis;
  const dir = b.slopeKgPerWeek < 0 ? 'losing' : 'gaining';
  el.innerHTML = `
    <div class="big">${exp.kcal} kcal <span class="method measured">measured</span></div>
    <p class="progress">Likely ${exp.low}&ndash;${exp.high}. Worked out from what you ate and how
      your weight moved, not from a formula.</p>
    <dl>
      <dt>Weight</dt><dd>${dir} ${Math.abs(b.slopeKgPerWeek).toFixed(2)} kg/week</dd>
      <dt>You ate</dt><dd>${b.meanIntake} kcal/day on ${b.loggedDays} days</dd>
      <dt>Weigh-ins</dt><dd>${b.weighings} over ${Math.round(b.weightSpanDays)} days</dd>
      ${exp.formula?.kcal ? `<dt>Formula says</dt><dd>${exp.formula.kcal} kcal</dd>` : ''}
    </dl>`;
}

async function loadWeight() {
  try {
    const [{ weights, trend }, exp] = await Promise.all([
      api('/api/weights'),
      api('/api/expenditure')
    ]);
    state.expenditure = exp;
    renderWeightChart(weights, trend);
    renderExpenditure(exp);

    if (trend) {
      const dir = trend.slopeKgPerWeek < 0 ? 'down' : 'up';
      $('weight-trend').textContent =
        `${trend.readings} weigh-ins over ${Math.round(trend.spanDays)} days — trending ${dir} `
        + `${Math.abs(trend.slopeKgPerWeek).toFixed(2)} kg a week.`;
    } else {
      $('weight-trend').textContent = 'A trend needs at least 3 weigh-ins spread over a week.';
    }
    if (weights.length) {
      $('w-kg').placeholder = `Last: ${weights[weights.length - 1].kg} kg`;
      state.me = state.me || {};
      state.me.weightUsedKg = weights[weights.length - 1].kg;
      if (state.me.maintenance) showMaintenanceResult(state.me.maintenance, state.me.weightUsedKg);
    }
  } catch {
    $('weight-trend').textContent = '';
  }
}

$('w-save').addEventListener('click', async () => {
  const kg = Number(String($('w-kg').value).replace(',', '.'));
  if (!Number.isFinite(kg) || kg <= 0) return toast('Enter a weight first.');
  try {
    await api('/api/weights', {
      method: 'PUT',
      body: JSON.stringify({ day: localDayKey(), kg, at: new Date().toISOString() })
    });
    $('w-kg').value = '';
    toast('Weight logged');
    await loadWeight();
    await loadDay();
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------- devices

function showCode(title, code, hint, warn = false) {
  $('code-title').textContent = title;
  $('code-value').textContent = code;
  $('code-hint').textContent = hint;
  $('code-box').classList.toggle('warn', warn);
  $('code-box').hidden = false;
  $('code-box').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const mins = (Date.now() - Date.parse(iso)) / 60000;
  if (!Number.isFinite(mins)) return 'unknown';
  if (mins < 2) return 'just now';
  if (mins < 60) return `${Math.round(mins)} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} d ago`;
}

async function loadDevices() {
  try {
    const { devices } = await api('/api/devices');
    $('device-list').innerHTML = devices.map((d) => `
      <li class="device" data-id="${esc(d.id)}">
        <span class="device-name">${esc(d.label || 'Unnamed device')}${
          d.current ? '<span class="device-this">this one</span>' : ''}</span>
        <span class="device-meta">last used ${esc(relativeTime(d.lastSeen))}</span>
        ${d.current ? '<span></span>'
          : `<button class="device-revoke" type="button" data-revoke="${esc(d.id)}">Remove</button>`}
      </li>`).join('');
  } catch {
    $('device-list').innerHTML = '';
  }
}

function renderRecoveryState() {
  const has = state.me?.hasRecoveryCode;
  $('recovery-state').textContent = has
    ? 'A recovery code is set. Replacing it retires the old one.'
    : 'No recovery code yet — if you lose this device, your log cannot be reached.';
  $('recovery-state').style.color = has ? '' : 'var(--warn)';
  $('recovery-btn').textContent = has ? 'Replace recovery code' : 'Create a recovery code';
}

$('link-device').addEventListener('click', async () => {
  try {
    const { code, expiresInMs } = await api('/api/devices/link-code', { method: 'POST', body: '{}' });
    showCode('Enter this on the other device',
      code,
      `Open Plate there, choose "Link a device", and type this in. It expires in `
      + `${Math.round(expiresInMs / 60000)} minutes and works once.`);
  } catch (err) {
    toast(err.message);
  }
});

$('recovery-btn').addEventListener('click', async () => {
  if (state.me?.hasRecoveryCode
      && !confirm('Replace the recovery code? The old one stops working immediately.')) return;
  try {
    const { recoveryCode } = await api('/api/devices/recovery-code', { method: 'POST', body: '{}' });
    state.me.hasRecoveryCode = true;
    renderRecoveryState();
    showCode('Save this recovery code', recoveryCode,
      'It is the only way back into your log if you lose every device. '
      + 'It is stored hashed and cannot be shown again.', true);
  } catch (err) {
    toast(err.message);
  }
});

$('device-list').addEventListener('click', async (ev) => {
  const id = ev.target.closest('[data-revoke]')?.dataset.revoke;
  if (!id) return;
  if (!confirm('Remove this device? Its access ends immediately. Your log is not affected.')) return;
  try {
    await api(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
    toast('Device removed');
    loadDevices();
  } catch (err) {
    toast(err.message);
  }
});

$('logout').addEventListener('click', async () => {
  if (!confirm('Sign this device out? Your log stays on the server — you can get back in with a link code from another device, or your recovery code.')) return;
  await fetch('/api/auth/logout', { method: 'POST' });
  location.reload();
});

// ----------------------------------------------------------------- start

async function start() {
  state.me = await api('/api/me');
  // The server decides. Nothing is collected until it says so.
  startTracking(state.me.trackingEnabled);
  if (!state.me.analysisConfigured) toast('Photo analysis is not configured on this server.');
  await loadDay();
}

/**
 * An invite link carries its code in the query string, so the person opening it
 * does not have to retype anything. Read once and stripped from the address bar
 * immediately: leaving it there would put a live credential into history, into
 * any screenshot of the tab, and into whatever the browser syncs.
 */
function inviteFromUrl() {
  const params = new URLSearchParams(location.search);
  const code = params.get('invite');
  if (!code) return null;
  params.delete('invite');
  const rest = params.toString();
  history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : ''));
  return code.trim();
}

(async () => {
  const invited = inviteFromUrl();
  try {
    await start();
    $('app').hidden = false;
  } catch (err) {
    if (err.message !== 'not_registered') {
      showGate();
      $('gate-error').textContent = 'Could not reach the server.';
      $('gate-error').hidden = false;
      return;
    }
    // Arrived from an invite link: fill it in, but do not submit. The person
    // should see what is about to happen and press the button themselves.
    if (invited) {
      setGateMode('invite');
      $('invite').value = invited;
      $('gate-hint').textContent = 'Code filled in from your link — press Continue.';
    }
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
