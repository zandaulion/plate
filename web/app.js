// Plate — PWA front end.
//
// The estimate maths is imported from /core, the same modules the server runs,
// so a portion edit produces identical numbers on both sides and the Android
// client can reuse them unchanged.

import {
  totalsOf, rangesOf, setTotalGrams, setItemGrams, removeItem, itemMacros,
  addManualItem, hasPhotoItems, markWeighed, portionSourceOf, markEaten, ateFraction
} from '/core/analysis/estimate.js';
import { toItem, isPlausible, QUICK_BITES, createQuickBiteItem, getGrazingSuggestions } from '/core/foods.js';
import { macroAgreement, ageFromBirthYear } from '/core/nutrition.js';
import { localDayKey } from '/core/day.js';
import { start as startTracking, track, screen } from '/track.js';
import { smoothSeries } from '/core/weight.js';
import { getMacroRecommendation } from '/core/recommendations.js';
import { installUpdates } from '/pwa-update.js';

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
  recentFoods: [],
  grazingSelected: new Set(),
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
function toast(message, undoAction = null) {
  const el = $('toast');
  clearTimeout(toastTimer);

  if (undoAction) {
    el.innerHTML = `<span>${esc(message)}</span><button type="button" class="toast-undo">Undo</button>`;
    const btn = el.querySelector('.toast-undo');
    btn?.addEventListener('click', async () => {
      clearTimeout(toastTimer);
      el.hidden = true;
      try {
        await undoAction();
      } catch (err) {
        toast(err.message);
      }
    }, { once: true });
  } else {
    el.textContent = message;
  }

  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, undoAction ? 6000 : 2800);
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
  ['fat', 'Fat', 'var(--fat)', true],
  ['fiber', 'Fiber', 'var(--fiber)', false]
];

function renderMacros(el, totals) {
  el.innerHTML = MACRO_META.map(([key, label, colour, lowConf]) => `
    <div class="${lowConf ? 'lowconf' : ''}">
      <dt style="--dot:${colour}">${label}</dt>
      <dd>${Math.round(totals[key] || 0)}<small>g</small></dd>
    </div>`).join('');
}

function renderSplit(split) {
  const el = $('split');
  const topbarEl = $('topbar-split');
  if (!split) {
    el.innerHTML = '';
    if (topbarEl) topbarEl.innerHTML = '';
    return;
  }
  const html =
    `<i class="p" style="width:${split.protein}%"></i>` +
    `<i class="c" style="width:${split.carbs}%"></i>` +
    `<i class="f" style="width:${split.fat}%"></i>`;
  el.innerHTML = html;
  if (topbarEl) topbarEl.innerHTML = html;
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

function getFoodEmoji(name = '') {
  const n = String(name || '').toLowerCase();
  if (/\bbite\b|bouchée/i.test(n)) return '🍏';
  if (/\bhandful\b|poignée/i.test(n)) return '🥜';
  if (/\bsnack\b|collation/i.test(n)) return '🥐';
  if (/nut|cajou|cashew|almond|amande|walnut|noix|peanut|cacahu|noisette|pistach|grain|seed/i.test(n)) return '🥜';
  if (/choc|cacao|cookie|biscuit|cake|gateau|sweet|candy|bonbon|sugar|bar/i.test(n)) return '🍫';
  if (/apple|pomme|fruit|banana|banane|berry|fraise|orange|raisin|grape|peach|poire|melon|citron/i.test(n)) return '🍎';
  if (/cheese|fromage|yaourt|yogurt|milk|lait|butter|beurre/i.test(n)) return '🧀';
  if (/coffee|café|tea|the|latte|espresso|drink|boisson|juice|jus|water|eau/i.test(n)) return '☕';
  if (/chip|crisp|cracker|pretzel|popcorn|bread|pain|toast|croissant/i.test(n)) return '🥨';
  if (/egg|oeuf|avocado|avocat|salad|salade|olive|hummus|houmous/i.test(n)) return '🥑';
  if (/meat|beef|chicken|poulet|steak|pork|porc|fish|poisson|salmon|saumon|tuna|thon|viande/i.test(n)) return '🥩';
  if (/pasta|pâtes|rice|riz|noodle|pizza|burger|sandwich/i.test(n)) return '🍝';
  return '🍏';
}

function renderEntries(entries) {
  const list = $('entries');
  // Kept so a tap can reopen the entry in the editor without another request.
  state.entriesById = new Map(entries.map((e) => [e.id, e]));
  $('empty-day').hidden = entries.length > 0;

  list.innerHTML = entries.map((e) => {
    const foods = e.items.map((i) => i.name).join(', ');
    const firstBarcode = e.items.find((i) => i.barcode)?.barcode;

    let thumb;
    if (e.photoId) {
      thumb = `<img src="/api/photo/${encodeURIComponent(e.photoId)}" alt="" loading="lazy">`;
    } else if (firstBarcode) {
      thumb = `<img src="/api/barcode/${encodeURIComponent(firstBarcode)}/image" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'noimg food-emoji\\' aria-hidden=\\'true\\'>${getFoodEmoji(foods)}</div>'">`;
    } else {
      const emoji = getFoodEmoji(foods);
      thumb = `<div class="noimg food-emoji" aria-hidden="true">${emoji}</div>`;
    }

    const time = new Date(e.createdAt)
      .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

    const p = Math.round(e.totals?.protein ?? 0);
    const c = Math.round(e.totals?.carbs ?? 0);
    const f = Math.round(e.totals?.fat ?? 0);

    return `<li class="entry" data-id="${esc(e.id)}">
      ${thumb}
      <div class="entry-main">
        <div class="entry-foods">${esc(foods) || 'Meal'}</div>
        <div class="entry-meta">
          <span class="entry-meal">${e.meal ? esc(e.meal) : time}</span>
          <span class="entry-meta-sep">•</span>
          <span class="entry-macros" aria-label="Protein ${p}g, Carbs ${c}g, Fat ${f}g">
            <span class="entry-macro p"><small>P</small>${p}g</span>
            <span class="entry-macro c"><small>C</small>${c}g</span>
            <span class="entry-macro f"><small>F</small>${f}g</span>
          </span>
          ${badgeFor(e)}
        </div>
      </div>
      <div class="entry-side">
        <div class="entry-kcal">${Math.round(e.totals?.calories ?? 0)}</div>
        <div class="entry-actions">
          <button class="entry-action-btn entry-dup" data-dup="${esc(e.id)}" aria-label="Duplicate this entry" title="Duplicate">
            <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
          </button>
          <button class="entry-action-btn entry-del" data-del="${esc(e.id)}" aria-label="Delete this entry" title="Delete">&times;</button>
        </div>
      </div>
    </li>`;
  }).join('');
}

async function loadQuickBites() {
  try {
    const { recent } = await api('/api/foods/recent');
    state.recentFoods = recent || [];
  } catch {
    state.recentFoods = [];
  }
  renderQuickBiteTray(state.recentFoods);
}

function renderQuickBiteTray(recents) {
  const container = $('quick-bite-chips');
  if (!container) return;

  const suggestions = getGrazingSuggestions(recents || [], { limit: 4 });

  const presetHtml = QUICK_BITES.map((b) =>
    `<button class="bite-tile preset" type="button" data-preset="${esc(b.id)}" aria-label="Log ${esc(b.name)}">
      <div class="tile-glyph">${b.icon || '🍏'}</div>
      <div class="tile-name">${esc(b.label || b.name)}</div>
      <div class="tile-badge">+${b.calories}<small>kcal</small></div>
    </button>`
  ).join('');

  const recentHtml = suggestions.map((f, i) => {
    const kcal = Math.round((f.per?.calories || 0) * (f.grams || 0));
    const thumbHtml = f.barcode
      ? `<img class="tile-img" src="/api/barcode/${esc(f.barcode)}/image" alt="" loading="lazy" onerror="this.outerHTML='<span class=\\'tile-glyph\\'>${getFoodEmoji(f.name)}</span>'">`
      : `<span class="tile-glyph">${getFoodEmoji(f.name)}</span>`;

    return `<button class="bite-tile recent" type="button" data-recent="${i}" aria-label="Log ${esc(f.name)} ${f.grams}g">
      <div class="tile-thumb">${thumbHtml}</div>
      <div class="tile-name" title="${esc(f.name)}">${esc(f.name)}</div>
      <div class="tile-badge">+${kcal}<small>kcal</small></div>
    </button>`;
  }).join('');

  const customHtml = `
    <button class="bite-tile custom-tile" type="button" data-action="custom" aria-label="Add custom bite">
      <div class="tile-glyph plus-glyph">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </div>
      <div class="tile-name">Custom</div>
    </button>`;

  container.innerHTML = presetHtml + recentHtml + customHtml;
}

function getBiteySvg(mood = 'happy') {
  const isNom = mood === 'nom';
  const isFull = mood === 'full';
  const isThinking = mood === 'thinking';

  let eyesSvg = '';
  if (isNom) {
    eyesSvg = `
      <path d="M 57 37 Q 60 33 63 37" fill="none" stroke="#1C241D" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="75" cy="38" r="1.5" fill="#F59E0B"/>
      <circle cx="79" cy="42" r="1" fill="#F59E0B"/>
    `;
  } else if (isFull) {
    eyesSvg = `
      <path d="M 56 37 Q 60 33 64 37" fill="none" stroke="#1C241D" stroke-width="2.2" stroke-linecap="round"/>
    `;
  } else if (isThinking) {
    eyesSvg = `
      <!-- Thoughtful raised brow and curious eyes -->
      <path d="M 56 30 Q 60 27 64 29" fill="none" stroke="#1C241D" stroke-width="2" stroke-linecap="round"/>
      <ellipse cx="60" cy="35" rx="3.8" ry="5.2" fill="#1C241D"/>
      <circle cx="61.5" cy="33" r="1.8" fill="#FFFFFF"/>
      <circle cx="58.5" cy="37" r="0.8" fill="#FFFFFF"/>
      <!-- Lightbulb idea spark -->
      <circle cx="76" cy="27" r="2.2" fill="#F59E0B"/>
      <path d="M 76 22 L 76 20 M 72 24 L 70 23 M 80 24 L 82 23" stroke="#F59E0B" stroke-width="1.4" stroke-linecap="round"/>
    `;
  } else {
    eyesSvg = `
      <ellipse cx="60" cy="36" rx="4.2" ry="5.5" fill="#1C241D"/>
      <circle cx="61.5" cy="34" r="1.8" fill="#FFFFFF"/>
      <circle cx="58.5" cy="38" r="0.8" fill="#FFFFFF"/>
    `;
  }

  let mouthSvg = '';
  if (isNom) {
    mouthSvg = `<path d="M 68 44 Q 72 49 76 45" fill="#DC2626" stroke="#1C241D" stroke-width="1.8" stroke-linecap="round"/>`;
  } else if (isFull) {
    mouthSvg = `<path d="M 67 44 Q 72 50 77 44" fill="none" stroke="#1C241D" stroke-width="2.2" stroke-linecap="round"/>`;
  } else if (isThinking) {
    mouthSvg = `<path d="M 68 45 Q 71 43 75 45" fill="none" stroke="#1C241D" stroke-width="2" stroke-linecap="round"/>`;
  } else {
    mouthSvg = `<path d="M 68 44 Q 72 48 75 43" fill="none" stroke="#1C241D" stroke-width="2" stroke-linecap="round"/>`;
  }

  return `<svg viewBox="0 0 100 100" class="bitey-dino-svg" xmlns="http://www.w3.org/2000/svg">
    <!-- Dino back spikes -->
    <path d="M 22 45 Q 16 48 22 55 Q 15 58 22 65" fill="none" stroke="#F59E0B" stroke-width="5" stroke-linecap="round"/>
    <!-- Head & neck -->
    <path d="M 32 78 C 30 65 30 45 42 32 C 52 22 72 24 78 35 C 84 44 80 56 68 58 C 60 59 55 68 54 78 Z" fill="#38A169"/>
    <!-- Belly highlight -->
    <path d="M 48 48 C 54 44 65 44 68 52 C 60 56 55 68 54 78 C 50 78 48 70 48 48 Z" fill="#6EE7B7" opacity="0.65"/>
    <!-- Cheeks -->
    <circle cx="66" cy="46" r="4.5" fill="#F43F5E" opacity="0.45"/>
    ${eyesSvg}
    ${mouthSvg}
    <!-- Bib around neck -->
    <path d="M 44 60 C 44 60 52 62 60 58 C 63 68 55 74 46 72 Z" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1.5"/>
    <circle cx="53" cy="66" r="2.5" fill="#EF4444"/>
    <path d="M 53 63 Q 54 61 55 62" fill="none" stroke="#10B981" stroke-width="1"/>
    <!-- Arm -->
    <path d="M 44 68 Q 38 65 36 72" fill="none" stroke="#2F855A" stroke-width="4" stroke-linecap="round"/>
    <!-- Tiny wooden fork -->
    <g transform="rotate(-18 34 68)">
      <rect x="33" y="66" width="3" height="13" rx="1.5" fill="#D97706"/>
      <path d="M 31 66 L 31 61 M 34 66 L 34 60 M 37 66 L 37 61" stroke="#D97706" stroke-width="1.2" stroke-linecap="round"/>
    </g>
  </svg>`;
}

const BITEY_QUOTES = [
  "Rawr means I love healthy food in dinosaur! 🦕",
  "Spendosaurus counts the pennies, I count the calories! 🦖",
  "A little graze here, a little graze there... it all counts! 🍏",
  "Hydration check! Have you had water today? 💧",
  "Protein makes dino muscles strong! 💪🌿",
  "Honest logging is the secret to real progress! ✨",
  "I'm a herbivore, but I respect the macros! 🥗",
  "Back in the Jurassic, we didn't have barcode scanners. We just nibbled trees! 🌲",
  "T-Rex skips arm day, but Bitey never skips meal logging! 🦖",
  "Brachiosaurus was 40 tons of pure plant-powered gains! 🌿",
  "Meteor showers? Scary. Forgetting to log olive oil? Even scarier! 🫒",
  "Dinosaurs roamed for 165 million years, so take your time and build great habits! ⏳",
  "Fossil record confirms: you're doing fantastic today! 🦴✨",
  "Pterodactyls fly high, but your nutritional consistency is higher! 🦅",
  "Prehistoric wisdom: a balanced plate prevents extinction! 🍽️",
  "Herbivore secret: crisp greens give you mega sauropod energy! 🥬",
  "My tiny wooden fork was carved from a petrified redwood tree! 🌲🍴",
  "A bite of cheese, a handful of almonds... Bitey sees all, Bitey logs all! 🧀",
  "Grazing is an ancient dinosaur foraging technique. Very respectable! 🌾",
  "Did you know? Two bites of cookie still count as fuel! 🍪",
  "Honest snacking beats secret snacking every single time! 🌟",
  "That little 50 kcal apple bite was sheer culinary perfection! 🍏",
  "Handful of berries? Top-tier foraging behavior right there! 🫐",
  "Snack smarter, rawr louder! 🦕📣",
  "No guilt on this plate — just delicious fuel and great data! 📊",
  "Crunch crunch crunch... is that a handful of pretzels I hear? 🥨",
  "Even three cashew nuts deserve their moment of glory in the log! 🥜",
  "Consistency is your superpower. Small steps move big mountains! 🏔️",
  "One good meal at a time. No stress, just steady fueling! 🎯",
  "Nutrition isn't about perfection, it's about awareness! 💡",
  "Drink a tall glass of water! Your inner dinosaur will thank you! 💧🦕",
  "Fueling your body well is the ultimate form of self-respect! 💚",
  "You don't need a cheat day when you genuinely enjoy what you eat! 🥑",
  "A colorful plate is a happy plate. Look at those vibrant macros! 🌈",
  "High protein day? Bitey flexes his tiny sauropod bicep! 💪",
  "Energy in, energy out — the ancient rhythm of the cosmos! 🌌",
  "Progress isn't a straight line, it's a gentle, steady trend! 📈",
  "Spendosaurus saves the dollars, I savor the calories! 💰😋",
  "Can dinosaurs have espresso? Asking for a prehistoric friend! ☕🦖",
  "Rawr! That's dinosaur for 'I believe in you!' 🦕❤️",
  "My bib has an apple on it because fresh fruit never disappoints! 🍎",
  "Did someone say carbs? Carbs are just energy waiting to be unleashed! ⚡",
  "Healthy fats make everything taste better. Avocados are honorary dinos! 🥑",
  "Plate is full, spirit is strong, belly is satisfied! 😋",
  "If you ever lose motivation, remember: you're way more evolved than a Stegosaurus! 🦕",
  "I may have a small dino brain, but my nutritional instincts are razor sharp! 🧠✨",
  "Tap me again! I have 165 million years worth of food advice! 🦕💬",
  "Snack time is undeniably the best hour of the 24-hour day! 🕒🥨",
  "Who needs a personal trainer when you have a personal sauropod? 🦖🏋️",
  "Eating mindful meals is the modern version of top-tier foraging! 🧺",
  "If you enjoy chocolate, log it with pride! No hiding from Bitey! 🍫",
  "Fiber keeps the dinosaur digestive system running smooth as clockwork! 🌾",
  "Fun fact: Sauropods ate 400 kg of greens a day. You only need a tasty salad! 🥗",
  "Treat your body like a treasured museum fossil: take good care of it! 🏛️✨",
  "Today's forecast: 100% chance of great nutrition and happy dinos! ☀️🦕",
  "Every meal logged is a victory for your future self! 🏆",
  "Stay curious, eat delicious food, and keep crushing your goals! 🚀"
];

let biteyCycleTimer = null;
let lastBiteyQuoteIdx = -1;

function getNextBiteyQuote() {
  if (!BITEY_QUOTES.length) return "Rawr! 🦕";
  let idx = Math.floor(Math.random() * BITEY_QUOTES.length);
  if (idx === lastBiteyQuoteIdx && BITEY_QUOTES.length > 1) {
    idx = (idx + 1) % BITEY_QUOTES.length;
  }
  lastBiteyQuoteIdx = idx;
  return BITEY_QUOTES[idx];
}

function cycleBiteyMessage(specificMessage = null, bounce = false) {
  const speech = $('bitey-speech');
  const btn = $('bitey-avatar');
  const wrap = $('bitey-svg-wrap');
  if (!speech) return;

  // Don't interrupt if Bitey is currently munching on a fresh bite
  if (!specificMessage && state.lastBiteMunchTime && (Date.now() - state.lastBiteMunchTime < 4500)) {
    return;
  }

  const message = specificMessage || (state.activeBiteyRecommendation?.text && !bounce
    ? state.activeBiteyRecommendation.text
    : getNextBiteyQuote());

  if (bounce && btn) {
    btn.classList.remove('is-bouncing');
    void btn.offsetWidth;
    btn.classList.add('is-bouncing');
    if ('vibrate' in navigator) {
      try { navigator.vibrate([15, 30, 15]); } catch {}
    }
  }

  speech.style.opacity = '0';
  setTimeout(() => {
    speech.textContent = message;
    speech.style.opacity = '1';
    if (wrap && (!state.lastBiteMunchTime || (Date.now() - state.lastBiteMunchTime >= 4500))) {
      const mood = message === state.activeBiteyRecommendation?.text
        ? (state.activeBiteyRecommendation?.mood || 'happy')
        : 'happy';
      wrap.innerHTML = getBiteySvg(mood);
    }
  }, 150);
}

function startBiteyCycle() {
  if (biteyCycleTimer) clearInterval(biteyCycleTimer);
  biteyCycleTimer = setInterval(() => {
    cycleBiteyMessage();
  }, 20000);
}

const BIRTH_YEAR_DEFAULT = 2000;

/**
 * Puts the birth year in the field, and says what it works out to.
 *
 * A year is harder to sanity-check than an age -- 1979 is just a number until
 * you subtract it -- so the label carries the age it produces and updates as
 * the field is typed in. That is also the check that catches a typo: nobody
 * misses "126 years old".
 *
 * The 2000 default is only offered to someone who has never set one. Filling
 * it in for an existing profile would replace a real answer with a guess, and
 * leaving it blank for a new one makes the stepper start at some arbitrary
 * floor.
 */
function fillBirthYear(stored) {
  const input = $('p-birth-year');
  if (!input) return;
  const now = new Date().getFullYear();
  input.min = now - 120;
  input.max = now - 13;
  input.value = stored ?? BIRTH_YEAR_DEFAULT;
  showDerivedAge();
}

function showDerivedAge() {
  const hint = $('p-age-hint');
  const input = $('p-birth-year');
  if (!hint || !input) return;
  const age = ageFromBirthYear(input.value);
  hint.textContent = age === null || age < 0 ? 'year' : `${age} yrs`;
}

$('p-birth-year')?.addEventListener('input', showDerivedAge);

/**
 * What to say while there is no trend yet.
 *
 * A trend needs three readings *and* a week between the first and the last,
 * and which half is missing changes what the reader should do. This used to
 * say "trend needs 3 days" whatever the reason, which was wrong in both
 * directions: it named the wrong number, and it told someone with four
 * readings over five days to do the thing they had already done.
 */
function trendWanted(gap) {
  if (!gap) return 'trend on the way';
  const { readings = 0, days = 0 } = gap;
  if (readings > 0 && days > 0) return 'trend needs 3 weigh-ins over a week';
  if (readings > 0) return `trend needs ${readings} more weigh-in${readings > 1 ? 's' : ''}`;
  if (days > 0) return `trend needs ${days} more day${days > 1 ? 's' : ''}`;
  return 'trend on the way';
}

function updateBiteyCompanion(summary, split = null, entries = []) {
  const wrap = $('bitey-svg-wrap');
  const speech = $('bitey-speech');
  const actionsEl = $('bitey-actions');
  if (!wrap || !speech) return;

  if (state.lastBiteMunchTime && (Date.now() - state.lastBiteMunchTime < 4500)) {
    wrap.innerHTML = getBiteySvg('nom');
    speech.textContent = state.lastBiteName
      ? `Nom nom nom! ${state.lastBiteName} was delicious! 😋`
      : `Nom nom nom! Delicious snack! 🍏`;
    if (actionsEl) { actionsEl.hidden = true; actionsEl.innerHTML = ''; }
    return;
  }

  const diet = state.me?.profile?.diet || 'omnivore';
  const dietaryGoal = state.me?.profile?.dietaryGoal || 'balanced';
  const weightKg = state.me?.weightUsedKg || state.me?.profile?.weightKg || null;
  const entriesCount = entries?.length ?? state.entriesById?.size ?? 0;

  const rec = getMacroRecommendation({
    totals: summary?.totals,
    split,
    diet,
    dietaryGoal,
    entriesCount,
    weightKg
  });

  if (rec) {
    state.activeBiteyRecommendation = rec;
    wrap.innerHTML = getBiteySvg(rec.mood || 'happy');
    speech.textContent = rec.text;

    if (actionsEl) {
      if (rec.suggestions?.length) {
        actionsEl.hidden = false;
        actionsEl.innerHTML = rec.suggestions.map((s) =>
          `<button type="button" class="bitey-chip" data-name="${esc(s.name)}" data-calories="${s.calories}" data-grams="${s.grams}" data-protein="${s.protein}" data-fat="${s.fat}" data-carbs="${s.carbs}" data-fiber="${s.fiber ?? 0}">
            <span>+ ${esc(s.name)}</span>
            <span class="bitey-chip-cal">${s.calories} kcal</span>
          </button>`
        ).join('');
      } else {
        actionsEl.hidden = true;
        actionsEl.innerHTML = '';
      }
    }
    return;
  }

  // A recommendation belongs to the day it was computed from. Clearing the
  // state without clearing the bubble left the previous day's line standing:
  // step back to yesterday, step forward to a morning with one meal in it, and
  // Bitey was still reporting yesterday's fats. The text is only left
  // alone when it is one of the idle quotes, which cycle on their own timer and
  // would restart on every render otherwise.
  const stale = state.activeBiteyRecommendation?.text || null;
  state.activeBiteyRecommendation = null;
  if (actionsEl) {
    actionsEl.hidden = true;
    actionsEl.innerHTML = '';
  }

  if (!speech.textContent || speech.textContent === stale
      || speech.textContent === 'Rawr! What are we eating today?') {
    speech.textContent = getNextBiteyQuote();
  }

  wrap.innerHTML = getBiteySvg('happy');
}

async function loadDay() {
  const title = dayTitle(state.day);
  const labelText = $('day-label-text');
  if (labelText) labelText.textContent = title;
  else $('day-label').textContent = title;

  const data = await api(`/api/entries?day=${state.day}`);

  state.expenditure = data.expenditure || null;
  renderProfileBanner(data.expenditure);
  const kcalVal = Math.round(data.summary.totals.calories);
  $('day-kcal').textContent = kcalVal;
  const compactKcal = $('day-compact-kcal');
  if (compactKcal) compactKcal.textContent = kcalVal;
  const pVal = $('day-compact-p');
  if (pVal) pVal.textContent = Math.round(data.summary.totals.protein || 0);
  const cVal = $('day-compact-c');
  if (cVal) cVal.textContent = Math.round(data.summary.totals.carbs || 0);
  const fVal = $('day-compact-f');
  if (fVal) fVal.textContent = Math.round(data.summary.totals.fat || 0);
  const fibVal = Math.round(data.summary.totals.fiber || 0);
  const fibEl = $('day-compact-fib');
  if (fibEl) fibEl.textContent = fibVal;

  renderMaintenance(data.summary, data.expenditure);
  renderSplit(data.split);
  renderMacros($('macros'), data.summary.totals);
  renderWeigh(state.day, data.weight, data.expenditure);
  renderEntries(data.entries);
  await loadQuickBites();
  updateBiteyCompanion(data.summary, data.split, data.entries);
}

$('quick-bite-chips')?.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.bite-tile');
  if (!btn || state.busy) return;

  if (btn.dataset.action === 'custom') {
    const dialog = $('quick-custom-dialog');
    if (dialog) {
      dialog.hidden = !dialog.hidden;
      if (!dialog.hidden) {
        $('quick-name')?.focus();
        dialog.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
    return;
  }

  if ('vibrate' in navigator) {
    try { navigator.vibrate(10); } catch {}
  }

  let item = null;
  const presetId = btn.dataset.preset;
  const recentIdx = btn.dataset.recent;

  if (presetId) {
    const preset = QUICK_BITES.find((p) => p.id === presetId);
    if (preset) item = createQuickBiteItem(preset);
  } else if (recentIdx !== undefined) {
    const suggestions = getGrazingSuggestions(state.recentFoods, { limit: 4 });
    const f = suggestions[Number(recentIdx)];
    if (f) {
      item = {
        name: f.name,
        grams: f.grams,
        per100: {
          calories: Math.round((f.per?.calories || 0) * 100 * 10) / 10,
          protein: Math.round((f.per?.protein || 0) * 100 * 10) / 10,
          fat: Math.round((f.per?.fat || 0) * 100 * 10) / 10,
          carbs: Math.round((f.per?.carbs || 0) * 100 * 10) / 10
        },
        barcode: f.barcode || null
      };
    }
  }

  if (!item) return;

  const cal = Math.round((item.per100.calories * item.grams) / 100);
  const estimate = addManualItem({ items: [], portionSource: 'model', note: '' }, item);

  state.busy = true;
  try {
    const res = await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({
        day: state.day,
        meal: 'snack',
        items: estimate.items,
        portionSource: 'estimated',
        portionConfirmed: true,
        note: 'Quick bite'
      })
    });
    track('quick_bite_logged', { name: item.name, calories: cal });
    state.lastBiteMunchTime = Date.now();
    state.lastBiteName = item.name;
    const avatarBtn = $('bitey-avatar');
    if (avatarBtn) {
      avatarBtn.classList.remove('is-bouncing');
      void avatarBtn.offsetWidth;
      avatarBtn.classList.add('is-bouncing');
    }
    const entryId = res.entry?.id;
    await loadDay();
    toast(`Logged ${item.name}`, entryId ? async () => {
      await api(`/api/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
      track('entry_deleted');
      toast('Undone');
      await loadDay();
    } : null);
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
  }
});

$('quick-custom-btn')?.addEventListener('click', () => {
  const dialog = $('quick-custom-dialog');
  dialog.hidden = !dialog.hidden;
  if (!dialog.hidden) {
    $('quick-name').focus();
  }
});

$('quick-custom-cancel')?.addEventListener('click', () => {
  $('quick-custom-dialog').hidden = true;
});

$('quick-custom-form')?.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const name = $('quick-name').value.trim() || 'Quick snack';
  const kcal = Number($('quick-kcal').value);
  const grams = Number($('quick-grams').value) || (kcal <= 70 ? 15 : kcal <= 150 ? 30 : 50);

  if (!Number.isFinite(kcal) || kcal <= 0) return toast('Enter calories');

  const item = createQuickBiteItem({ name, calories: kcal, grams });
  const estimate = addManualItem({ items: [], portionSource: 'model', note: '' }, item);

  state.busy = true;
  try {
    const res = await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({
        day: state.day,
        meal: 'snack',
        items: estimate.items,
        portionSource: 'estimated',
        portionConfirmed: true,
        note: 'Quick snack'
      })
    });
    track('quick_bite_logged', { name, calories: kcal, custom: true });
    state.lastBiteMunchTime = Date.now();
    state.lastBiteName = name;
    const customAvatarBtn = $('bitey-avatar');
    if (customAvatarBtn) {
      customAvatarBtn.classList.remove('is-bouncing');
      void customAvatarBtn.offsetWidth;
      customAvatarBtn.classList.add('is-bouncing');
    }
    $('quick-name').value = '';
    $('quick-kcal').value = '';
    $('quick-grams').value = '';
    $('quick-custom-dialog').hidden = true;
    const entryId = res.entry?.id;
    await loadDay();
    toast(`Logged ${name} (${kcal} kcal)`, entryId ? async () => {
      await api(`/api/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
      track('entry_deleted');
      toast('Undone');
      await loadDay();
    } : null);
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
  }
});

$('bitey-actions')?.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.bitey-chip');
  if (!btn || state.busy) return;
  ev.stopPropagation();

  const name = btn.dataset.name;
  const kcal = Number(btn.dataset.calories) || 100;
  const grams = Number(btn.dataset.grams) || 100;
  const protein = Number(btn.dataset.protein) || 0;
  const fat = Number(btn.dataset.fat) || 0;
  const carbs = Number(btn.dataset.carbs) || 0;
  const fiber = Number(btn.dataset.fiber) || 0;

  const item = {
    name,
    grams,
    per100: {
      calories: Math.round((kcal / grams) * 100 * 10) / 10,
      protein: Math.round((protein / grams) * 100 * 10) / 10,
      fat: Math.round((fat / grams) * 100 * 10) / 10,
      carbs: Math.round((carbs / grams) * 100 * 10) / 10,
      fiber: Math.round((fiber / grams) * 100 * 10) / 10
    }
  };

  const est = addManualItem({ items: [], portionSource: 'model', note: '' }, item);
  state.busy = true;
  try {
    const res = await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({
        day: state.day,
        meal: 'snack',
        items: est.items,
        portionSource: 'estimated',
        portionConfirmed: true,
        note: `Bitey recommendation: ${name}`
      })
    });
    track('recommendation_logged', { name, calories: kcal, diet: state.me?.profile?.diet });
    state.lastBiteMunchTime = Date.now();
    state.lastBiteName = name;

    const avatarBtn = $('bitey-avatar');
    if (avatarBtn) {
      avatarBtn.classList.remove('is-bouncing');
      void avatarBtn.offsetWidth;
      avatarBtn.classList.add('is-bouncing');
    }

    const entryId = res.id;
    await loadDay();
    toast(`Logged ${name} (${kcal} kcal)`, entryId ? async () => {
      await api(`/api/entries/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
      track('entry_deleted');
      toast('Undone');
      await loadDay();
    } : null);
  } catch (err) {
    toast(err.message);
  } finally {
    state.busy = false;
  }
});

const onBiteyTap = (ev) => {
  if (ev?.target?.closest?.('.bitey-chip')) return;
  cycleBiteyMessage(null, true);
  startBiteyCycle();
};
$('bitey-card')?.addEventListener('click', onBiteyTap);
$('bitey-card')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    onBiteyTap();
  }
});

let isDayNavigating = false;

async function cardDealTransition(direction, updateFn) {
  const cards = $('day-cards') || $('day-view');
  if (isDayNavigating) return;
  isDayNavigating = true;

  try {
    const exitClass = direction === 'prev' ? 'card-deal-exit-right' : 'card-deal-exit-left';
    const enterClass = direction === 'prev' ? 'card-deal-enter-left' : 'card-deal-enter-right';

    if (cards) {
      cards.classList.remove('card-deal-enter-left', 'card-deal-enter-right', 'card-deal-exit-left', 'card-deal-exit-right', 'card-wobble-blocked');
      cards.classList.add(exitClass);
    }

    // Fast 85ms exit flick
    await new Promise((r) => setTimeout(r, 85));

    // Update the day and load data
    await updateFn();

    // Bitey cheers / hops for the new day
    const biteyBtn = $('bitey-avatar');
    if (biteyBtn) {
      biteyBtn.classList.remove('is-bouncing');
      void biteyBtn.offsetWidth;
      biteyBtn.classList.add('is-bouncing');
    }

    if (cards) {
      cards.classList.remove(exitClass);
      void cards.offsetWidth; // force reflow
      cards.classList.add(enterClass);
      setTimeout(() => {
        cards.classList.remove(enterClass);
      }, 300);
    }
  } finally {
    isDayNavigating = false;
  }
}

async function goToPrevDay(source = 'button') {
  track('day_nav', { dir: -1, source });
  if ('vibrate' in navigator) try { navigator.vibrate(12); } catch {}
  await cardDealTransition('prev', async () => {
    state.day = shiftDay(state.day, -1);
    await loadDay();
  });
}

async function goToNextDay(source = 'button') {
  const next = shiftDay(state.day, 1);
  if (next > localDayKey()) {
    const cards = $('day-cards') || $('day-view');
    if (cards) {
      cards.classList.remove('card-wobble-blocked');
      void cards.offsetWidth;
      cards.classList.add('card-wobble-blocked');
      setTimeout(() => cards.classList.remove('card-wobble-blocked'), 340);
    }
    if ('vibrate' in navigator) try { navigator.vibrate([15, 30, 15]); } catch {}
    return toast('That is tomorrow.');
  }

  track('day_nav', { dir: 1, source });
  if ('vibrate' in navigator) try { navigator.vibrate(12); } catch {}
  await cardDealTransition('next', async () => {
    state.day = next;
    await loadDay();
  });
}

function initDaySwipe() {
  let startX = 0;
  let startY = 0;
  let startTime = 0;
  let isIgnored = false;
  let isVerticalScroll = false;

  window.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) {
      isIgnored = true;
      return;
    }
    if (document.querySelector('.sheet:not([hidden])') || $('app').hidden) {
      isIgnored = true;
      return;
    }
    if (e.target.closest('.quick-bite-scroll, input, textarea, select')) {
      isIgnored = true;
      return;
    }
    isIgnored = false;
    isVerticalScroll = false;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startTime = Date.now();
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (isIgnored || isVerticalScroll || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
      isVerticalScroll = true;
    }
  }, { passive: true });

  window.addEventListener('touchend', (e) => {
    if (isIgnored || isVerticalScroll) return;
    if (!e.changedTouches || e.changedTouches.length === 0) return;

    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const dt = Date.now() - startTime;

    if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 600) {
      if (dx > 0) {
        goToPrevDay('swipe');
      } else {
        goToNextDay('swipe');
      }
    }
  }, { passive: true });

  window.addEventListener('keydown', (e) => {
    if ($('app').hidden || document.querySelector('.sheet:not([hidden])')) return;
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') {
      goToPrevDay('keyboard');
    } else if (e.key === 'ArrowRight') {
      goToNextDay('keyboard');
    }
  });
}

$('prev-day')?.addEventListener('click', () => goToPrevDay('button'));
$('next-day')?.addEventListener('click', () => goToNextDay('button'));
$('day-label').addEventListener('click', () => {
  if (window.scrollY > 80) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    state.day = localDayKey();
    loadDay();
  }
});

$('entries').addEventListener('click', async (ev) => {
  const dupId = ev.target.closest('[data-dup]')?.dataset.dup;
  if (dupId) {
    ev.stopPropagation();
    try {
      const entry = state.entriesById?.get(dupId);
      const foodName = entry?.items?.[0]?.name || 'Meal';
      await api(`/api/entries/${encodeURIComponent(dupId)}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({ day: state.day })
      });
      track('entry_duplicated', { source: 'list' });
      toast(`Logged another: ${foodName}`);
      return loadDay();
    } catch (err) {
      toast(err.message || 'Failed to duplicate');
    }
    return;
  }

  const deleteId = ev.target.closest('[data-del]')?.dataset.del;
  if (deleteId) {
    ev.stopPropagation();
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
    let sub = '';
    if (t) {
      const dir = t.slopeKgPerWeek < 0 ? 'down' : 'up';
      sub = `${dir} ${Math.abs(t.slopeKgPerWeek).toFixed(2)} kg/wk`;
    } else {
      sub = trendWanted(weight.gap);
    }
    el.innerHTML = `
      <button class="weigh-row weigh-pill" type="button" id="weigh-open">
        <span class="weigh-pill-left">
          <span class="ico">${SCALE_ICON}</span>
          <span class="val">${weight.today.toFixed(1)}<small>kg</small></span>
          <span class="weigh-dot">•</span>
          <span class="sub">${esc(sub)}</span>
        </span>
        <span class="chev" aria-hidden="true">&rsaquo;</span>
      </button>`;
  } else {
    // Progress is shown here because this is where the ask is made: a prompt
    // with a visible reason is a different thing from a chore.
    const p = expenditure?.method !== 'measured' ? expenditure?.progress : null;
    const left = p && p.weighings < p.neededWeighings ? p.neededWeighings - p.weighings : 0;
    const sub = left
      ? `${left} more to measure`
      : 'keeps estimate honest';
    const title = isToday ? 'Weigh in' : 'No weight';
    el.innerHTML = `
      <div class="weigh-pill-wrap">
        <button class="weigh-row weigh-pill" type="button" id="weigh-open">
          <span class="weigh-pill-left">
            <span class="ico">${SCALE_ICON}</span>
            <span class="lab">${esc(title)}</span>
            <span class="weigh-dot">•</span>
            <span class="sub">${esc(sub)}</span>
          </span>
          ${weight?.last ? `<span class="val dim">${weight.last.toFixed(1)}<small>kg</small></span>` : ''}
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
  const dupBtn = $('dup-entry');
  if (dupBtn) {
    dupBtn.hidden = mode !== 'edit';
    dupBtn.disabled = false;
  }

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
  const sheet = $('review');
  if (sheet) {
    sheet.hidden = true;
    sheet.classList.remove('closing');
  }
}

function closeReview() {
  document.activeElement?.blur?.();
  const sheet = $('review');
  if (sheet && !sheet.hidden && !sheet.classList.contains('closing')) {
    sheet.classList.add('closing');
    setTimeout(() => {
      teardownReview();
    }, 180);
  } else {
    teardownReview();
  }
  dismissScreen('review');
}

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

  renderAte(est);

  $('review-items').innerHTML = est.items.map((it) => `
    <li class="item${ateFraction(it) < 1 ? ' is-part' : ''}" data-id="${esc(it.id)}">
      <span class="item-name">${esc(it.name)}${
        ateFraction(it) < 1 ? `<small class="item-ate">${esc(ateWords(ateFraction(it)))}</small>` : ''}</span>
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
  renderGrazingCatchup();
  $('save-entry').disabled = est.items.length === 0;
  if ($('dup-entry')) $('dup-entry').disabled = est.items.length === 0;
}

/**
 * The "how much did you eat" control.
 *
 * Hidden until there is something to apply it to. It reads the estimate rather
 * than keeping its own state, so reopening a saved entry shows what was
 * recorded instead of resetting to "all of it".
 */
function renderAte(est) {
  const block = $('ate-block');
  if (!block) return;
  const items = est.items || [];
  block.hidden = items.length === 0;
  if (!items.length) return;

  const fractions = items.map(ateFraction);
  const uniform = fractions.every((f) => f === fractions[0]) ? fractions[0] : null;

  for (const btn of $('ate-row').querySelectorAll('button')) {
    btn.classList.toggle('is-on', uniform !== null && Number(btn.dataset.ate) === uniform);
  }

  $('ate-out').textContent = uniform === null
    ? 'different for each'
    : ateWords(uniform);

  // Only offered where there is an original photograph to compare against.
  // Without one there is nothing for the second picture to be measured relative
  // to, and the answer would be a fresh guess dressed up as a comparison.
  const canShoot = Boolean(state.editingId && state.existingPhotoId);
  $('leftovers-shoot').hidden = !canShoot;

  $('ate-hint').textContent = uniform === 1
    ? ''
    : 'Counted as this much of the plate. What was served stays as it was, so you can change this later.';
}

const ATE_WORDS = new Map([[0, 'none of it'], [0.25, 'a quarter'], [0.5, 'half'],
                           [0.75, 'three quarters'], [1, 'all of it']]);

function ateWords(f) {
  if (ATE_WORDS.has(f)) return ATE_WORDS.get(f);
  return `${Math.round(f * 100)}%`;
}

$('ate-row')?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-ate]');
  if (!btn || !state.estimate) return;
  state.estimate = markEaten(state.estimate, Number(btn.dataset.ate));
  renderReview();
});

/**
 * Read the leftovers from a photograph of them.
 *
 * Nothing is saved by this: the fractions come back, are applied to the
 * estimate in front of you, and are written only when you save -- so a reading
 * that looks wrong is abandoned by closing the sheet, exactly like a re-read
 * of the original photo.
 */
$('leftovers-shoot')?.addEventListener('click', () => $('file-leftovers').click());

$('file-leftovers')?.addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file || !state.editingId) return;

  const btn = $('leftovers-shoot');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading what is left…';
  try {
    const { base64 } = await prepareImage(file);
    const out = await api(`/api/entries/${state.editingId}/leftovers`, {
      method: 'POST',
      body: JSON.stringify({ image: base64 })
    });
    state.estimate = markEaten(state.estimate, out.eaten);
    renderReview();
    toast(out.note ? out.note.slice(0, 90) : 'Read what was left');
  } catch (err) {
    toast(err.message || 'Could not read the leftovers');
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
});

function renderGrazingCatchup() {
  const panel = $('grazing-panel');
  const toggle = $('grazing-toggle');
  const chipsContainer = $('grazing-chips');
  const catchupSection = $('grazing-catchup');
  if (!chipsContainer || !catchupSection) return;

  if (state.mode === 'edit') {
    catchupSection.hidden = true;
    return;
  }
  catchupSection.hidden = false;

  const suggestions = getGrazingSuggestions(state.recentFoods || [], { limit: 4 });
  const items = [
    ...QUICK_BITES.map((b) => ({
      id: b.id,
      name: b.name,
      label: b.label || b.name,
      icon: b.icon || '🍏',
      cal: b.calories,
      raw: b,
      type: 'preset'
    })),
    ...suggestions.map((f, i) => {
      const kcal = Math.round((f.per?.calories || 0) * (f.grams || 0));
      return {
        id: `rec-${i}`,
        name: `${f.name} (${f.grams}g)`,
        label: f.name,
        icon: getFoodEmoji(f.name),
        cal: kcal,
        raw: f,
        type: 'recent'
      };
    })
  ];

  chipsContainer.innerHTML = items.map((it) => {
    const isPressed = state.grazingSelected.has(it.id);
    return `<button class="grazing-chip" type="button" data-id="${esc(it.id)}" aria-pressed="${isPressed}">
      <span class="chip-icon">${it.icon}</span>
      <span class="chip-name">${esc(it.label)}</span>
      <span class="chip-cal">+${it.cal}</span>
    </button>`;
  }).join('');
  chipsContainer.dataset.items = JSON.stringify(items);
}

$('grazing-toggle')?.addEventListener('click', () => {
  const panel = $('grazing-panel');
  panel.hidden = !panel.hidden;
  $('grazing-toggle').setAttribute('aria-expanded', String(!panel.hidden));
});

$('grazing-chips')?.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.grazing-chip');
  if (!btn) return;
  const id = btn.dataset.id;
  const selected = btn.getAttribute('aria-pressed') === 'true';
  const next = !selected;
  btn.setAttribute('aria-pressed', String(next));
  if (next) {
    state.grazingSelected.add(id);
  } else {
    state.grazingSelected.delete(id);
  }
});

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
    carbs: (manualNumber('m-carbs') ?? 0) * scale,
    fiber: (manualNumber('m-fiber') ?? 0) * scale
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

for (const id of ['m-grams', 'm-kcal', 'm-protein', 'm-fat', 'm-carbs', 'm-fiber']) {
  $(id)?.addEventListener('input', checkManual);
}

$('m-add').addEventListener('click', () => {
  const parsed = checkManual();
  if (!parsed) return toast('Enter at least a weight and the calories.');
  if (!parsed.name) return toast('Give it a name.');

  // source stays 'manual', so no photo-error band is applied to it.
  state.estimate = addManualItem(
    state.estimate || { items: [], portionSource: 'model', note: '' }, parsed);

  for (const id of ['m-name', 'm-grams', 'm-kcal', 'm-protein', 'm-fat', 'm-carbs', 'm-fiber']) if ($(id)) $(id).value = '';
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

    // Save any catch-up grazing items selected during this meal review
    if (state.mode !== 'edit' && state.grazingSelected?.size > 0) {
      const allItems = JSON.parse($('grazing-chips')?.dataset?.items || '[]');
      for (const id of state.grazingSelected) {
        const found = allItems.find((it) => it.id === id);
        if (!found) continue;
        let biteItem = null;
        if (found.type === 'preset') {
          biteItem = createQuickBiteItem(found.raw);
        } else if (found.type === 'recent') {
          const f = found.raw;
          biteItem = {
            name: f.name,
            grams: f.grams,
            per100: {
              calories: Math.round((f.per?.calories || 0) * 100 * 10) / 10,
              protein: Math.round((f.per?.protein || 0) * 100 * 10) / 10,
              fat: Math.round((f.per?.fat || 0) * 100 * 10) / 10,
              carbs: Math.round((f.per?.carbs || 0) * 100 * 10) / 10
            },
            barcode: f.barcode || null
          };
        }
        if (biteItem) {
          const est = addManualItem({ items: [], portionSource: 'model', note: '' }, biteItem);
          await api('/api/entries', {
            method: 'POST',
            body: JSON.stringify({
              day: state.day,
              meal: 'snack',
              items: est.items,
              portionSource: 'estimated',
              portionConfirmed: true,
              note: 'Grazing catch-up'
            })
          });
        }
      }
      track('grazing_catchup_added', { count: state.grazingSelected.size });
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

$('dup-entry')?.addEventListener('click', async () => {
  if (!state.editingId || !state.estimate || state.busy) return;
  state.busy = true;
  if ($('dup-entry')) $('dup-entry').disabled = true;
  $('save-entry').disabled = true;
  busy('Duplicating…');

  const body = {
    day: state.day,
    meal: state.meal,
    items: state.estimate.items,
    portionSource: portionSourceOf(state.estimate),
    portionConfirmed: state.estimate.portionConfirmed,
    note: state.estimate.note || null
  };

  try {
    await api(`/api/entries/${encodeURIComponent(state.editingId)}/duplicate`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    track('entry_duplicated', { source: 'sheet' });
    idle();
    closeReview();
    toast('Logged another');
    await loadDay();
  } catch (err) {
    failed(err.message || 'Failed to duplicate');
    if ($('dup-entry')) $('dup-entry').disabled = false;
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

  if ($('p-diet') && state.me?.diets) {
    $('p-diet').innerHTML = state.me.diets
      .map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('');
  }
  if ($('p-goal') && state.me?.dietaryGoals) {
    $('p-goal').innerHTML = state.me.dietaryGoals
      .map((g) => `<option value="${esc(g.id)}">${esc(g.label)}</option>`).join('');
  }

  // Ahead of the early return: someone with no profile at all is exactly who
  // the 2000 default is for, and they are the one case that used to fall
  // through here with an empty field and no bounds on it.
  fillBirthYear(p?.birthYear ?? null);

  if (!p) return;
  $('p-height').value = p.heightCm ?? '';
  $('p-sex').value = p.sex ?? '';
  if (p.activity) $('p-activity').value = p.activity;
  if (p.diet && $('p-diet')) $('p-diet').value = p.diet;
  if (p.dietaryGoal && $('p-goal')) $('p-goal').value = p.dietaryGoal;
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
      ? 'Fill in height, birth year and a typical week to see an estimate.'
      : 'Log a weight below, and fill in height, birth year and a typical week.';
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
        birthYear: $('p-birth-year').value || null,
        sex: $('p-sex').value || null,
        activity: $('p-activity').value || null,
        diet: $('p-diet')?.value || 'omnivore',
        dietaryGoal: $('p-goal')?.value || 'balanced'
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

function initStickyDayTracker() {
  const totalsSection = document.querySelector('.totals');
  const topbar = document.querySelector('.topbar');
  const compactTracker = $('day-compact-tracker');
  const topbarSplit = $('topbar-split');
  const biteyCard = $('bitey-card');

  // Calories, macros and split bar are always visible in the today card
  if (compactTracker) compactTracker.hidden = false;
  if (topbarSplit) topbarSplit.hidden = false;

  const updateTopbarHeight = () => {
    const h = topbar.offsetHeight || 60;
    document.documentElement.style.setProperty('--topbar-h', `${h}px`);
  };
  updateTopbarHeight();
  window.addEventListener('resize', updateTopbarHeight);

  const updateStickyState = () => {
    const isScrolled = window.scrollY > 20;
    topbar.classList.toggle('scrolled', isScrolled);
    if (biteyCard) {
      biteyCard.classList.toggle('is-sticky', isScrolled);
    }
  };

  window.addEventListener('scroll', updateStickyState, { passive: true });
  updateStickyState();
}

async function start() {
  state.me = await api('/api/me');
  // The server decides. Nothing is collected until it says so.
  startTracking(state.me.trackingEnabled);
  if (!state.me.analysisConfigured) toast('Photo analysis is not configured on this server.');
  await loadDay();
  handleUrlActions();
  initStickyDayTracker();
  cycleBiteyMessage();
  startBiteyCycle();
  initDaySwipe();
}

/**
 * Handles launcher / PWA shortcuts and update notices passed via query string.
 */
function handleUrlActions() {
  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  const updated = params.get('updated');

  if (params.has('bust') || action === 'bust') {
    params.delete('bust');
    if (action === 'bust') params.delete('action');
    const rest = params.toString();
    history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : ''));
    Promise.all([
      'caches' in window ? caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))) : Promise.resolve(),
      'serviceWorker' in navigator ? navigator.serviceWorker.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister()))) : Promise.resolve()
    ]).then(() => {
      window.location.replace('/?updated=' + Date.now());
    }).catch(() => {
      window.location.replace('/?updated=' + Date.now());
    });
    return;
  }

  // ?updated= was how the old worker signalled a forced reload. Clients
  // installed before this change can still arrive carrying it, so it is
  // cleaned up quietly; the message itself now comes from installUpdates.
  if (updated) {
    params.delete('updated');
    const rest = params.toString();
    history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : ''));
  }

  if (!action) return;

  params.delete('action');
  const rest = params.toString();
  history.replaceState(history.state, '', location.pathname + (rest ? `?${rest}` : ''));

  if (action === 'bite') {
    track('shortcut_opened', { action: 'bite' });
    const dialog = $('quick-custom-dialog');
    if (dialog) {
      dialog.hidden = false;
      $('quick-name')?.focus();
    }
  } else if (action === 'scan') {
    track('shortcut_opened', { action: 'scan' });
    $('add-barcode')?.click();
  }
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

installUpdates({
  appName: 'Plate',
  toast: (message) => toast(message),
  // A photo estimate on screen means unsaved work: a correction typed in, a
  // weight adjusted. Reloading through that would lose it, so the update waits
  // until the sheet is done with.
  isBusy: () => Boolean(state.estimate) && screenIsOpen('review')
});

// The day is refetched when the app comes back to the foreground; the update
// check that used to live here now belongs to installUpdates.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadDay().catch(() => {});
});
