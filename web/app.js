// Plate — PWA front end.
//
// The estimate maths is imported from /core, the same modules the server runs,
// so a portion edit produces identical numbers on both sides and the Android
// client can reuse them unchanged.

import {
  totalsOf, rangesOf, setTotalGrams, setItemGrams, removeItem, itemMacros
} from '/core/analysis/estimate.js';
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
  busy: false
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
  const id = ev.target.closest('[data-del]')?.dataset.del;
  if (!id) return;
  if (!confirm('Delete this entry?')) return;
  await api(`/api/entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
  toast('Deleted');
  loadDay();
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

  openReview();
  setStatus('<span class="spinner"></span>Reading the photo…');

  try {
    state.photo = await prepareImage(file);
    $('review-photo').src = state.photo.objectUrl;

    setStatus('<span class="spinner"></span>Working out what is on the plate…');
    const data = await api('/api/analyse', {
      method: 'POST',
      body: JSON.stringify({ image: state.photo.base64, mimeType: state.photo.mimeType })
    });

    state.estimate = data.estimate;
    state.meal = guessMeal();
    setStatus('');
    initWeightSlider();
    renderReview();
  } catch (err) {
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

function openReview() {
  state.estimate = null;
  state.photo = null;
  $('review-photo').removeAttribute('src');
  $('review-items').innerHTML = '';
  $('review-note').hidden = true;
  $('review-kcal').textContent = '0';
  $('review-range').textContent = '';
  $('review-macros').innerHTML = '';
  $('save-entry').disabled = true;
  $('review').hidden = false;
}

function closeReview() {
  if (state.photo?.objectUrl) URL.revokeObjectURL(state.photo.objectUrl);
  state.estimate = null;
  state.photo = null;
  $('review').hidden = true;
}

$('review-close').addEventListener('click', closeReview);
$('review').addEventListener('click', (ev) => { if (ev.target === $('review')) closeReview(); });

function initWeightSlider() {
  const grams = totalsOf(state.estimate).grams || 100;
  const slider = $('total-weight');
  // Range is centred on the model's guess so the user can move either way with
  // one thumb, rather than starting at an arbitrary end of a fixed scale.
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

  $('weight-out').textContent = `${Math.round(totals.grams)} g`;
  $('review-kcal').textContent = Math.round(totals.calories);
  $('review-range').textContent =
    `Likely ${ranges.calories.low}–${ranges.calories.high} kcal` +
    (est.portionConfirmed ? '' : ' — narrows once you check the weight');
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
    initWeightSlider();
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

$('save-entry').addEventListener('click', async () => {
  if (!state.estimate || state.busy) return;
  state.busy = true;
  $('save-entry').disabled = true;
  setStatus('<span class="spinner"></span>Saving…');

  try {
    await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({
        day: state.day,
        meal: state.meal,
        items: state.estimate.items,
        portionConfirmed: state.estimate.portionConfirmed,
        note: state.estimate.note || null,
        image: state.photo?.base64,
        mimeType: state.photo?.mimeType
      })
    });
    closeReview();
    toast('Logged');
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

$('open-profile').addEventListener('click', () => { fillProfile(); $('profile').hidden = false; });
$('profile-close').addEventListener('click', () => { $('profile').hidden = true; });
$('profile').addEventListener('click', (ev) => { if (ev.target === $('profile')) $('profile').hidden = true; });

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
