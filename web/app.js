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
      fillProfile();
      $('profile').hidden = false;
      openScreen('profile', () => { $('profile').hidden = true; });
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

function renderMaintenance(summary, expenditure) {
  const el = $('maintenance');
  const m = summary.maintenance;

  if (!m) {
    el.className = 'maintenance none';
    el.innerHTML = 'Add your details in <b>&#9881;</b> to see what you burn on an average day.';
    return;
  }

  el.className = 'maintenance';
  const measured = expenditure?.method === 'measured';
  // How the figure was arrived at changes what it is worth, so it is stated
  // rather than left for the user to assume.
  const source = measured
    ? 'measured from your weight and what you logged'
    : 'estimated from your details';

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
          ${e.portionSource === 'weighed'
            ? '<span class="badge-est badge-weighed">weighed</span>'
            : e.portionSource === 'estimated' ? ''
            : '<span class="badge-est">weight not set</span>'}
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
  $('day-kcal').textContent = Math.round(data.summary.totals.calories);
  renderMaintenance(data.summary, data.expenditure);
  renderSplit(data.split);
  renderMacros($('macros'), data.summary.totals);
  renderEntries(data.entries);
}

$('prev-day').addEventListener('click', () => { state.day = shiftDay(state.day, -1); loadDay(); });
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
    toast('Deleted');
    return loadDay();
  }

  const id = ev.target.closest('.entry')?.dataset.id;
  const entry = id && state.entriesById?.get(id);
  if (entry) openReview('edit', entry);
});

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
  setStatus('<span class="spinner"></span>Reading the photo…');

  try {
    state.photo = await prepareImage(file);
    // The user can back out while the photo is being read or analysed. Every
    // resumption point checks the sheet is still open, so a cancelled capture
    // cannot repopulate a closed sheet or leave stale state behind it.
    if (!screenIsOpen('review')) return;
    $('review-photo').src = state.photo.objectUrl;

    setStatus('<span class="spinner"></span>Working out what is on the plate…');
    const data = await api('/api/analyse', {
      method: 'POST',
      body: JSON.stringify({ image: state.photo.base64, mimeType: state.photo.mimeType })
    });
    if (!screenIsOpen('review')) return;

    state.estimate = data.estimate;
    state.meal = guessMeal();
    setStatus('');
    initWeightSlider();
    renderReview();
  } catch (err) {
    if (!screenIsOpen('review')) return;
    if (err.code === 'not_food') {
      setStatus(err.note || 'That does not look like food. Try another photo.', true);
    } else if (err.code === 'nothing_found') {
      setStatus(err.note || 'Nothing recognisable in that photo. Try a clearer one.', true);
    } else if (err.message !== 'not_registered') {
      setStatus(err.message, true);
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

function setStatus(html, isError = false) {
  const el = $('review-status');
  el.innerHTML = html;
  el.classList.toggle('err', isError);
}

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
  $('food-q').value = '';
  $('food-results').innerHTML = '';
  $('finder-hint').textContent = state.me?.genericSearch === false
    ? 'Generic foods may be missing — search covers packaged products best.'
    : '';
  setStatus('');

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
  openScreen('review', teardownReview);
  showRecent();
  if (mode === 'manual') setTimeout(() => $('food-q').focus(), 120);
}

/** Tears the sheet down. Only ever called by the navigation layer. */
function teardownReview() {
  if (state.photo?.objectUrl) URL.revokeObjectURL(state.photo.objectUrl);
  state.estimate = null;
  state.photo = null;
  state.editingId = null;
  state.existingPhotoId = null;
  $('review').hidden = true;
}

const closeReview = () => dismissScreen('review');
$('review-close').addEventListener('click', closeReview);
$('review').addEventListener('click', (ev) => { if (ev.target === $('review')) closeReview(); });
$('add-food-btn').addEventListener('click', () => openReview('manual'));

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

$('total-weight').addEventListener('input', (ev) => {
  if (!state.estimate) return;
  state.estimate = setTotalGrams(state.estimate, Number(ev.target.value));
  renderReview();
});

$('weighed').addEventListener('change', (ev) => {
  if (!state.estimate) return;
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
  const item = state.estimate.items.find((i) => i.id === id);
  state.estimate = setItemGrams(state.estimate, id, Math.max(0, item.grams + step));
  $('total-weight').value = totalsOf(state.estimate).grams;
  renderReview();
});

$('review-items').addEventListener('change', (ev) => {
  if (ev.target.tagName !== 'INPUT' || !state.estimate) return;
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

  if (food.source === 'recent') {
    // Already per-gram, at the weight last used, so it is added directly
    // rather than round-tripped through the per-100 g form.
    state.estimate = {
      ...base,
      items: [...base.items, {
        id: `re${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        name: food.name, grams: food.grams, per: food.per, source: 'manual'
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
  const food = results[Number(btn.dataset.i)];
  if (food) addFood(food);
});

// ---------------------------------------------------------- typed panel

let manualBasis = 'portion';

$('manual-toggle').addEventListener('click', () => {
  const form = $('manual-form');
  form.hidden = !form.hidden;
  $('manual-toggle').setAttribute('aria-expanded', String(!form.hidden));
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
  $('manual-toggle').setAttribute('aria-expanded', 'false');
  $('food-q').value = '';
  $('food-results').innerHTML = '';

  renderReview();
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
$('scan-btn').addEventListener('click', async () => {
  if (!('BarcodeDetector' in window)) {
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
    const typed = prompt('No camera access. Type the barcode number:');
    if (typed) lookupBarcode(typed.trim());
    return;
  }

  const video = document.createElement('video');
  video.className = 'scanner';
  video.playsInline = true;
  video.srcObject = stream;

  // The camera must be released however the scanner goes away -- back
  // gesture, tap, timeout or a successful scan -- so teardown lives in one
  // place and the navigation layer owns when it runs.
  const teardown = () => {
    stream.getTracks().forEach((t) => t.stop());
    video.remove();
  };

  // Registered before the overlay is on screen and before play() is awaited.
  // Doing it afterwards leaves a window -- however brief, and it is not brief
  // while a phone camera warms up -- where the viewfinder is covering the app
  // but the back gesture would close the sheet underneath it and leave the
  // camera running.
  document.body.appendChild(video);
  openScreen('scanner', teardown);

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
  video.addEventListener('click', stop);

  const deadline = Date.now() + 20000;
  const tick = async () => {
    if (!video.isConnected) return;
    if (Date.now() > deadline) {
      stop();
      $('finder-hint').textContent = 'No barcode found. Tap the scan button to try again.';
      return;
    }
    try {
      const found = await detector.detect(video);
      if (found.length) {
        const code = found[0].rawValue;
        stop();
        lookupBarcode(code);
        return;
      }
    } catch {}
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// ------------------------------------------------------------------ save

$('save-entry').addEventListener('click', async () => {
  if (!state.estimate || state.busy) return;
  state.busy = true;
  $('save-entry').disabled = true;
  setStatus('<span class="spinner"></span>Saving…');

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
    closeReview();
    toast(state.mode === 'edit' ? 'Updated' : 'Logged');
    await loadDay();
  } catch (err) {
    setStatus(err.message, true);
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
  $('p-weight').value = p.weightKg ?? '';
  $('p-height').value = p.heightCm ?? '';
  $('p-age').value = p.ageYears ?? '';
  $('p-sex').value = p.sex ?? '';
  if (p.activity) $('p-activity').value = p.activity;
  showMaintenanceResult(state.me.maintenance);
}

function showMaintenanceResult(m) {
  const el = $('profile-result');
  if (!m) {
    el.className = 'maintenance none';
    el.textContent = 'Fill in every field to see an estimate.';
    return;
  }
  el.className = 'maintenance';
  el.innerHTML = `You burn roughly <b>${m.kcal} kcal</b> on an average day
    &mdash; most likely between <b>${m.low}</b> and <b>${m.high}</b>.
    This is an estimate from a population formula, not a measurement.`;
}

const closeProfile = () => dismissScreen('profile');

$('open-profile').addEventListener('click', () => {
  fillProfile();
  loadDevices();
  loadWeight();
  renderRecoveryState();
  $('code-box').hidden = true;
  $('profile').hidden = false;
  openScreen('profile', () => { $('profile').hidden = true; });
});
$('profile-close').addEventListener('click', closeProfile);
$('profile').addEventListener('click', (ev) => { if (ev.target === $('profile')) closeProfile(); });

$('profile-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('profile-error');
  err.hidden = true;

  try {
    const data = await api('/api/profile', {
      method: 'PUT',
      body: JSON.stringify({
        weightKg: $('p-weight').value || null,
        heightCm: $('p-height').value || null,
        ageYears: $('p-age').value || null,
        sex: $('p-sex').value || null,
        activity: $('p-activity').value || null
      })
    });
    state.me.profile = data.profile;
    state.me.maintenance = data.maintenance;
    showMaintenanceResult(data.maintenance);
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

  if (series.length < 2) {
    el.innerHTML = '<svg viewBox="0 0 300 84" preserveAspectRatio="none">'
      + '<text class="empty" x="8" y="46">Log your weight a few times to see a trend.</text></svg>';
    return;
  }

  const w = 300, h = 84, pad = 6;
  const xs = series.map((p) => p.at);
  const ys = series.map((p) => p.kg);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const spanY = Math.max(0.5, y1 - y0); // never let a flat series fill the box

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
    if (p.loggedDays < p.neededDays) parts.push(`${p.neededDays - p.loggedDays} more logged days`);
    if (p.weighings < p.neededWeighings) parts.push(`${p.neededWeighings - p.weighings} more weigh-ins`);

    el.innerHTML = `
      <div class="big">${exp.available ? `${exp.kcal} kcal` : '&mdash;'}
        <span class="method formula">formula</span></div>
      <p class="progress">${exp.available
        ? 'From your height, weight, age and activity — a population average, not you.'
        : 'Fill in your details above for a first estimate.'}</p>
      <p class="progress">${parts.length
        ? `Log ${parts.join(' and ')} and this becomes a measurement of what you actually burn.`
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
    if (weights.length) $('w-kg').placeholder = `Last: ${weights[weights.length - 1].kg} kg`;
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
  if (!state.me.analysisConfigured) toast('Photo analysis is not configured on this server.');
  await loadDay();
}

(async () => {
  try {
    await start();
    $('app').hidden = false;
  } catch (err) {
    if (err.message !== 'not_registered') {
      showGate();
      $('gate-error').textContent = 'Could not reach the server.';
      $('gate-error').hidden = false;
    }
  }
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
