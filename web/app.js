// Plate — PWA front end.
//
// The estimate maths is imported from /core, the same modules the server runs,
// so a portion edit produces identical numbers on both sides and the Android
// client can reuse them unchanged.

import {
  totalsOf, rangesOf, setTotalGrams, setItemGrams, removeItem, itemMacros,
  addManualItem, hasPhotoItems
} from '/core/analysis/estimate.js';
import { toItem } from '/core/foods.js';
import { localDayKey } from '/core/day.js';

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

$('redeem-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const err = $('gate-error');
  err.hidden = true;

  try {
    await api('/api/auth/redeem', {
      method: 'POST',
      body: JSON.stringify({ code: $('invite').value.trim() })
    });
    $('gate').hidden = true;
    $('app').hidden = false;
    await start();
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

function renderMaintenance(summary) {
  const el = $('maintenance');
  const m = summary.maintenance;

  if (!m) {
    el.className = 'maintenance none';
    el.innerHTML = 'Add your details in <b>&#9881;</b> to see what you burn on an average day.';
    return;
  }

  el.className = 'maintenance';
  const b = summary.balance;
  // The band is genuinely wide, so a day inside it is reported as
  // indistinguishable from maintenance rather than given a false precision.
  if (b?.withinBand) {
    el.innerHTML = `About what you burn &mdash; roughly <b>${m.low}&ndash;${m.high} kcal</b> a day.`;
  } else if (b) {
    const word = b.kcal < 0 ? 'under' : 'over';
    el.innerHTML = `<b>${Math.abs(b.kcal)} kcal</b> ${word} your estimated
      <b>${m.kcal}</b> &mdash; the estimate itself spans ${m.low}&ndash;${m.high}.`;
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
          ${e.portionConfirmed ? '' : '<span class="badge-est">not checked</span>'}
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

  $('day-kcal').textContent = Math.round(data.summary.totals.calories);
  renderMaintenance(data.summary);
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
    ? { items: entry.items, portionConfirmed: entry.portionConfirmed, note: entry.note || '' }
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
    $('review-range').textContent =
      `Likely ${ranges.calories.low}\u2013${ranges.calories.high} kcal`
      + (est.portionConfirmed ? '' : ' \u2014 narrows once you check the weight');
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

function renderResults(results) {
  $('food-results').innerHTML = results.map((f, i) => `
    <li><button class="result" type="button" data-i="${i}">
      <span class="result-name">${esc(f.name)}<span class="src">${esc(f.source === 'usda' ? 'USDA' : 'OFF')}</span></span>
      <span class="result-meta">${Math.round(f.per100.calories)} kcal / 100 g</span>
      <span class="result-add" aria-hidden="true">+</span>
    </button></li>`).join('');
  $('food-results').dataset.payload = JSON.stringify(results);
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
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), 350);
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
  const item = toItem(food, food.servingG || 100);
  if (!item) return;

  state.estimate = addManualItem(
    state.estimate || { items: [], portionConfirmed: false, note: '' }, item);

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

$('logout').addEventListener('click', async () => {
  if (!confirm('Sign this device out? Your entries stay on the server.')) return;
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
