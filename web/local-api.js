// Local-first adapter for the Android host.
//
// The PWA continues to use its HTTP API in a browser. Inside the packaged
// Android WebView, the same UI calls this module instead: IndexedDB is private
// to the app's synthetic https://plate.local origin and never needs Plate's
// Express server. Keeping the boundary here makes the UI migration gradual
// rather than rewriting every screen before the first local build can run.

import { totalsOf, portionSourceOf } from '/core/analysis/estimate.js';
import { summariseDay, macroSplit, MEALS } from '/core/day.js';
import { ACTIVITY_LEVELS, ageFromBirthYear, maintenanceEnergy } from '/core/nutrition.js';
import { adaptiveExpenditure } from '/core/expenditure.js';
import { smoothSeries, weightTrend, trendGap } from '/core/weight.js';
import { summariseRecent, collapseRepeatable } from '/core/foods.js';

const DB_NAME = 'plate-local-v1';
const DB_VERSION = 2;
const PROFILE_KEY = 'profile';
const NATIVE_ENTRIES_MIGRATION_KEY = 'native-entries-v1';
const NATIVE_PHOTOS_MIGRATION_KEY = 'native-photos-v1';

const DIETS = [
  { id: 'omnivore', label: 'Omnivore (anything goes)' },
  { id: 'vegetarian', label: 'Vegetarian (no meat/fish)' },
  { id: 'vegan', label: 'Vegan (100% plant-based)' },
  { id: 'pescatarian', label: 'Pescatarian (vegetarian + seafood)' },
  { id: 'keto', label: 'Keto / Low-carb' }
];

const DIETARY_GOALS = [
  { id: 'balanced', label: 'Balanced (standard split)' },
  { id: 'high_protein', label: 'High protein (satiety & muscle)' },
  { id: 'low_fat', label: 'Lower fat (heart & calorie density)' },
  { id: 'low_carb', label: 'Low carbohydrate' }
];

export class LocalApiError extends Error {
  constructor(message, { code = 'local_error', status = 400 } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let dbPromise;
function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const out = request.result;
      if (!out.objectStoreNames.contains('profile')) out.createObjectStore('profile', { keyPath: 'id' });
      if (!out.objectStoreNames.contains('entries')) out.createObjectStore('entries', { keyPath: 'id' });
      if (!out.objectStoreNames.contains('weights')) out.createObjectStore('weights', { keyPath: 'day' });
      // Binary-like photo data is deliberately retained here while entry
      // metadata moves to Room. The native bridge never handles base64 bytes.
      if (!out.objectStoreNames.contains('photos')) out.createObjectStore('photos', { keyPath: 'id' });
      if (!out.objectStoreNames.contains('meta')) out.createObjectStore('meta', { keyPath: 'id' });
      // This is intentionally only a device cache. Open Food Facts results
      // will be written here after a user-enabled, device-direct lookup.
      if (!out.objectStoreNames.contains('foods')) out.createObjectStore('foods', { keyPath: 'barcode' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function store(name, mode, work) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(name, mode);
    let value;
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    value = work(transaction.objectStore(name));
  });
}

async function get(name, key) {
  return store(name, 'readonly', (s) => new Promise((resolve, reject) => {
    const r = s.get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  }));
}

async function all(name) {
  return store(name, 'readonly', (s) => new Promise((resolve, reject) => {
    const r = s.getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error);
  }));
}

async function put(name, value) {
  return store(name, 'readwrite', (s) => { s.put(value); });
}

async function remove(name, key) {
  return store(name, 'readwrite', (s) => { s.delete(key); });
}

/**
 * The Android host owns barcode cache rows in Room. This bridge deliberately
 * exposes only individual reads and writes, never a general SQLite interface.
 */
async function nativeFoodCache(method, barcode, food = null) {
  if (typeof window.PlateNative?.readCachedFood !== 'function') return null;
  const result = await new Promise((resolve) => {
    window.__plateNativeFoodCacheResult = (payload) => {
      delete window.__plateNativeFoodCacheResult;
      try { resolve(JSON.parse(payload)); } catch {
        resolve({ ok: false, code: 'cache_error', message: 'The local barcode cache could not be read.' });
      }
    };
    if (method === 'read') window.PlateNative.readCachedFood(barcode);
    else window.PlateNative.writeCachedFood(barcode, JSON.stringify(food));
  });
  if (!result.ok) {
    throw new LocalApiError(result.message || 'The local barcode cache could not be opened.', {
      code: result.code || 'cache_error', status: 503
    });
  }
  return result.foodJson ? JSON.parse(result.foodJson) : null;
}

async function nativeGenericFoodSearch(query) {
  if (typeof window.PlateNative?.searchGenericFoods !== 'function') {
    throw new LocalApiError('The on-device food table is not available in this build.', { status: 503 });
  }
  const requestId = `generic-${++nativeSearchSequence}`;
  const result = await new Promise((resolve) => {
    nativeSearchWaiters.set(requestId, resolve);
    window.PlateNative.searchGenericFoods(query, requestId);
  });
  if (!result.ok) {
    throw new LocalApiError(result.message || 'The on-device food table could not be opened.', {
      code: result.code || 'search_error', status: 503
    });
  }
  return { results: result.results || [], genericSearch: true };
}

let nativeSearchSequence = 0;
const nativeSearchWaiters = new Map();
window.__plateNativeGenericFoodSearchResult = (requestId, payload) => {
  const resolve = nativeSearchWaiters.get(requestId);
  if (!resolve) return;
  nativeSearchWaiters.delete(requestId);
  try { resolve(JSON.parse(payload)); } catch {
    resolve({ ok: false, code: 'search_error', message: 'The on-device food table could not be read.' });
  }
};

const jsonBody = (options) => {
  if (!options?.body) return {};
  if (typeof options.body === 'string') {
    try { return JSON.parse(options.body); } catch {
      throw new LocalApiError('The local request could not be read.');
    }
  }
  return options.body;
};

function localDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function localProfile(row) {
  if (!row) return null;
  const birthYear = row.birthYear ?? null;
  return {
    weightKg: row.weightKg ?? null,
    heightCm: row.heightCm ?? null,
    birthYear,
    ageYears: ageFromBirthYear(birthYear),
    sex: row.sex || null,
    activity: row.activity || null,
    diet: row.diet || 'omnivore',
    dietaryGoal: row.dietaryGoal || 'balanced',
    updatedAt: row.updatedAt || null
  };
}

let nativeDiarySequence = 0;
const nativeDiaryWaiters = new Map();
window.__plateNativeDiaryResult = (requestId, payload) => {
  const resolve = nativeDiaryWaiters.get(requestId);
  if (!resolve) return;
  nativeDiaryWaiters.delete(requestId);
  try { resolve(JSON.parse(payload)); } catch {
    resolve({ ok: false, code: 'storage_error', message: 'The local diary could not be read.' });
  }
};

async function nativeDiary(operation, payload = {}) {
  if (typeof window.PlateNative?.localDiary !== 'function') {
    throw new LocalApiError('This local diary storage is not available in this build.', { status: 503 });
  }
  const requestId = `diary-${++nativeDiarySequence}`;
  const result = await new Promise((resolve) => {
    nativeDiaryWaiters.set(requestId, resolve);
    window.PlateNative.localDiary(operation, JSON.stringify(payload), requestId);
  });
  if (!result.ok) {
    throw new LocalApiError(result.message || 'The local diary could not be updated.', {
      code: result.code || 'storage_error', status: 503
    });
  }
  return result;
}

let nativePhotoSequence = 0;
const nativePhotoWaiters = new Map();
window.__plateNativePhotoResult = (requestId, payload) => {
  const resolve = nativePhotoWaiters.get(requestId);
  if (!resolve) return;
  nativePhotoWaiters.delete(requestId);
  try { resolve(JSON.parse(payload)); } catch {
    resolve({ ok: false, code: 'photo_error', message: 'The local photo could not be read.' });
  }
};

async function nativePhoto(operation, id, payload = '', mimeType = '') {
  if (typeof window.PlateNative?.localPhoto !== 'function') {
    throw new LocalApiError('This local photo storage is not available in this build.', { status: 503 });
  }
  const requestId = `photo-${++nativePhotoSequence}`;
  const result = await new Promise((resolve) => {
    nativePhotoWaiters.set(requestId, resolve);
    window.PlateNative.localPhoto(operation, id, payload, mimeType, requestId);
  });
  if (!result.ok) {
    throw new LocalApiError(result.message || 'The local photo could not be saved.', {
      code: result.code || 'photo_error', status: 503
    });
  }
  return result;
}

async function rawProfile() {
  if (!window.__PLATE_NATIVE__) return get('profile', PROFILE_KEY);
  const { profile: stored } = await nativeDiary('profile.read');
  if (stored) return stored;

  // One-time, non-destructive migration for early Android builds that kept
  // profile data in IndexedDB. Room becomes the source of truth afterwards.
  const legacy = await get('profile', PROFILE_KEY);
  if (legacy) await nativeDiary('profile.write', legacy);
  return legacy;
}

async function profile() {
  return localProfile(await rawProfile());
}

async function weights() {
  if (!window.__PLATE_NATIVE__) {
    return (await all('weights')).sort((a, b) => a.day.localeCompare(b.day));
  }
  const { weights: stored } = await nativeDiary('weights.list');
  if (stored.length) return stored;

  // Like the profile migration, copy prior local readings once rather than
  // risking a disappearing trend on upgrade. New writes use Room directly.
  const legacy = await all('weights');
  for (const weight of legacy) await nativeDiary('weights.write', weight);
  return legacy.sort((a, b) => a.day.localeCompare(b.day));
}

async function savePhoto(row) {
  if (!row?.photoId || typeof row.photoData !== 'string' || !row.photoData) return;
  if (window.__PLATE_NATIVE__) {
    await nativePhoto('write', row.photoId, row.photoData, row.photoMimeType || 'image/jpeg');
    return;
  }
  await put('photos', {
    id: row.photoId,
    data: row.photoData,
    mimeType: row.photoMimeType || 'image/jpeg'
  });
}

async function hydrateEntry(row) {
  if (!row?.photoId || row.photoData) return row;
  if (window.__PLATE_NATIVE__) return row;
  const photo = await get('photos', row.photoId);
  if (!photo) return row;
  return { ...row, photoData: photo.data, photoMimeType: row.photoMimeType || photo.mimeType };
}

function roomEntry(row) {
  // Keep image bytes out of Room and, crucially, out of the JavaScript bridge.
  const { photoData, ...metadata } = row;
  return metadata;
}

async function writeNativeEntry(row) {
  await savePhoto(row);
  const { entry } = await nativeDiary('entries.write', roomEntry(row));
  return entry;
}

async function migrateNativePhotos(rows) {
  if (await get('meta', NATIVE_PHOTOS_MIGRATION_KEY)) return;
  for (const entry of rows) {
    if (!entry?.photoId) continue;
    // Version 3 stored the image in the new photos store when available, but
    // very early Android rows kept it alongside the entry. Check both before
    // marking the migration complete so neither kind of upgrade loses a photo.
    const stored = await get('photos', entry.photoId);
    const legacy = stored || await get('entries', entry.id);
    if (typeof legacy?.data === 'string' && legacy.data) {
      await nativePhoto('write', entry.photoId, legacy.data, legacy.mimeType || entry.photoMimeType || 'image/jpeg');
    } else if (typeof legacy?.photoData === 'string' && legacy.photoData) {
      await nativePhoto('write', entry.photoId, legacy.photoData, legacy.photoMimeType || entry.photoMimeType || 'image/jpeg');
    }
  }
  await put('meta', { id: NATIVE_PHOTOS_MIGRATION_KEY, at: new Date().toISOString() });
}

async function diaryEntries() {
  if (!window.__PLATE_NATIVE__) return all('entries');

  const { entries: stored } = await nativeDiary('entries.list');
  if (await get('meta', NATIVE_ENTRIES_MIGRATION_KEY)) {
    await migrateNativePhotos(stored);
    return Promise.all(stored.map(hydrateEntry));
  }

  // An early Android build stored whole entries in IndexedDB. Copy metadata
  // into Room once, keeping any image bytes under a distinct private key.
  const legacy = await all('entries');
  for (const entry of legacy) await writeNativeEntry(entry);
  await put('meta', { id: NATIVE_ENTRIES_MIGRATION_KEY, at: new Date().toISOString() });
  const { entries } = await nativeDiary('entries.list');
  await migrateNativePhotos(entries);
  return Promise.all(entries.map(hydrateEntry));
}

async function diaryEntry(id) {
  if (!window.__PLATE_NATIVE__) return get('entries', id);
  const { entry } = await nativeDiary('entries.read', { id });
  return hydrateEntry(entry);
}

async function deleteDiaryEntry(row) {
  if (!window.__PLATE_NATIVE__) {
    await remove('entries', row.id);
    return true;
  }
  const { deleted } = await nativeDiary('entries.delete', { id: row.id });
  if (deleted && row.photoId) await nativePhoto('delete', row.photoId);
  return deleted;
}

async function effectiveProfile() {
  const base = await profile();
  if (!base) return null;
  const readings = await weights();
  const last = readings.at(-1);
  return last ? { ...base, weightKg: last.kg, weightFromReading: true } : base;
}

function publicEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    day: row.day,
    meal: row.meal || null,
    createdAt: row.createdAt,
    photoId: row.photoId || null,
    // Photo bytes remain in the WebView's private IndexedDB, keyed by photoId.
    // They are hydrated only for the local host and never sent over the network.
    photoData: row.photoData || null,
    photoMimeType: row.photoMimeType || null,
    note: row.note || null,
    portionConfirmed: row.portionSource !== 'model',
    portionSource: row.portionSource || 'model',
    corrections: row.corrections || 0,
    items: row.items || [],
    totals: row.totals || totalsOf({ items: row.items || [] })
  };
}

async function expenditure() {
  const from = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  const entries = (await diaryEntries())
    .filter((e) => e.day >= from)
    .map(publicEntry);
  return adaptiveExpenditure({ entries, weights: await weights(), profile: await effectiveProfile() });
}

async function me() {
  const stored = await profile();
  const effective = await effectiveProfile();
  return {
    // Identity is deliberately local: no account, device token, invite, or
    // recovery credential survives in a service we operate.
    accountId: 'local-device',
    deviceId: 'local-device',
    label: 'This device',
    hasRecoveryCode: false,
    profile: stored,
    maintenance: maintenanceEnergy(effective),
    weightUsedKg: effective?.weightKg ?? null,
    expenditure: await expenditure(),
    activityLevels: ACTIVITY_LEVELS,
    diets: DIETS,
    dietaryGoals: DIETARY_GOALS,
    meals: MEALS,
    analysisConfigured: false,
    trackingEnabled: false,
    genericSearch: true
  };
}

async function dayPayload(day) {
  const entries = (await diaryEntries())
    .filter((e) => e.day === day)
    .sort((a, b) => b.sortKey - a.sortKey)
    .map(publicEntry);
  const exp = await expenditure();
  const summary = summariseDay(entries, exp.available ? exp : null);
  const readings = await weights();
  const today = readings.find((w) => w.day === day) || null;
  const before = readings.filter((w) => w.day <= day).at(-1) || readings[0] || null;
  return {
    day,
    entries,
    summary,
    expenditure: exp,
    split: macroSplit(summary.totals),
    weight: {
      today: today?.kg ?? null,
      last: before?.kg ?? null,
      trend: weightTrend(readings),
      gap: trendGap(readings)
    }
  };
}

function dayKey(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dayOffset(offset) {
  const now = new Date();
  return dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset));
}

/** The PWA Trends sheet consumes a dense series. Keep the local host's
 * calendar-day behaviour identical, including genuinely empty days. */
async function historyPayload(requestedDays) {
  const days = Math.min(180, Math.max(7, Number(requestedDays) || 30));
  const from = dayOffset(-(days - 1));
  const to = dayOffset(0);
  const intake = new Map();

  for (const entry of await diaryEntries()) {
    if (entry.day < from || entry.day > to) continue;
    const totals = entry.totals || totalsOf({ items: entry.items || [] });
    const prior = intake.get(entry.day) || { calories: 0, protein: 0, fat: 0, carbs: 0, entries: 0 };
    const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
    prior.calories += finite(totals.calories);
    prior.protein += finite(totals.protein);
    prior.fat += finite(totals.fat);
    prior.carbs += finite(totals.carbs);
    prior.entries += 1;
    intake.set(entry.day, prior);
  }

  const readings = await weights();
  const displayedWeights = new Map(readings.filter((row) => row.day >= from && row.day <= to).map((row) => [row.day, row.kg]));
  // One reading before the visible range may still inform the fitted trend,
  // matching the hosted endpoint's days + 1 query.
  const trendReadings = readings.filter((row) => row.day >= dayOffset(-days) && row.day <= to);
  const series = [];
  for (let index = -(days - 1); index <= 0; index += 1) {
    const day = dayOffset(index);
    const row = intake.get(day);
    series.push({
      day,
      calories: row ? Math.round(row.calories) : null,
      protein: row ? Math.round(row.protein * 10) / 10 : null,
      fat: row ? Math.round(row.fat * 10) / 10 : null,
      carbs: row ? Math.round(row.carbs * 10) / 10 : null,
      entries: row?.entries || 0,
      weight: displayedWeights.has(day) ? displayedWeights.get(day) : null
    });
  }
  return { from, to, days: series, expenditure: await expenditure(), weightTrend: weightTrend(trendReadings) };
}

async function saveEntry(body, { copyPhotoFrom = null } = {}) {
  const day = localDay(body.day);
  if (!day) throw new LocalApiError('A local calendar date is required.', { code: 'bad_day' });
  if (!Array.isArray(body.items) || !body.items.length) {
    throw new LocalApiError('An entry needs at least one food.', { code: 'no_items' });
  }
  const id = crypto.randomUUID();
  const portionSource = ['model', 'estimated', 'weighed'].includes(body.portionSource)
    ? body.portionSource
    : portionSourceOf({ portionConfirmed: body.portionConfirmed });
  const row = {
    id,
    day,
    meal: MEALS.includes(body.meal) ? body.meal : null,
    createdAt: new Date().toISOString(),
    // Random tie-breaking avoids the millisecond ordering issue in the server
    // version when several quick bites are saved in the same tick.
    sortKey: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    photoId: typeof body.image === 'string' && body.image.length > 100 ? id : (copyPhotoFrom ? id : null),
    photoData: typeof body.image === 'string' && body.image.length > 100 ? body.image : null,
    photoMimeType: body.mimeType || null,
    note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
    portionSource,
    items: body.items,
    totals: totalsOf({ items: body.items, portionSource })
  };
  if (window.__PLATE_NATIVE__) {
    if (copyPhotoFrom) await nativePhoto('copy', row.photoId, copyPhotoFrom);
    await writeNativeEntry(row);
  }
  else await put('entries', row);
  return { id, day, totals: row.totals, photoId: row.photoId, entry: publicEntry(row) };
}

async function updateEntry(id, body) {
  const row = await diaryEntry(id);
  if (!row) throw new LocalApiError('Entry not found.', { code: 'not_found', status: 404 });
  if (!Array.isArray(body.items) || !body.items.length) {
    throw new LocalApiError('An entry needs at least one food.', { code: 'no_items' });
  }
  const portionSource = ['model', 'estimated', 'weighed'].includes(body.portionSource)
    ? body.portionSource
    : portionSourceOf({ portionConfirmed: body.portionConfirmed });
  const next = {
    ...row,
    meal: MEALS.includes(body.meal) ? body.meal : null,
    note: typeof body.note === 'string' ? body.note.slice(0, 500) : null,
    portionSource,
    items: body.items,
    totals: totalsOf({ items: body.items, portionSource })
  };
  if (window.__PLATE_NATIVE__) await writeNativeEntry(next);
  else await put('entries', next);
  return { id, day: next.day, totals: next.totals, entry: publicEntry(next) };
}

async function duplicateEntry(id, body) {
  const original = await diaryEntry(id);
  if (!original) throw new LocalApiError('Entry not found.', { code: 'not_found', status: 404 });
  const copyPhotoFrom = window.__PLATE_NATIVE__ && body.copyPhoto !== false ? original.photoId : null;
  return saveEntry({
    ...original,
    ...body,
    day: localDay(body.day) || original.day,
    meal: MEALS.includes(body.meal) ? body.meal : original.meal,
    items: Array.isArray(body.items) && body.items.length ? body.items : original.items,
    image: copyPhotoFrom || body.copyPhoto === false ? null : original.photoData,
    mimeType: original.photoMimeType,
    note: typeof body.note === 'string' ? body.note : original.note,
    portionSource: body.portionSource || original.portionSource
  }, { copyPhotoFrom });
}

async function saveProfile(body) {
  const prior = (await rawProfile()) || { id: PROFILE_KEY };
  const present = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const numberOrNull = (value) => value === null || value === '' ? null : Number(value);
  const next = { ...prior };
  if (present('heightCm')) next.heightCm = numberOrNull(body.heightCm);
  if (present('weightKg')) next.weightKg = numberOrNull(body.weightKg);
  if (present('birthYear')) next.birthYear = numberOrNull(body.birthYear);
  if (present('ageYears') && !present('birthYear')) {
    const age = numberOrNull(body.ageYears);
    next.birthYear = age === null ? null : new Date().getFullYear() - age;
  }
  if (present('sex')) next.sex = ['male', 'female'].includes(body.sex) ? body.sex : null;
  if (present('activity')) next.activity = ACTIVITY_LEVELS.some((x) => x.id === body.activity) ? body.activity : null;
  if (present('diet')) next.diet = DIETS.some((x) => x.id === body.diet) ? body.diet : 'omnivore';
  if (present('dietaryGoal')) next.dietaryGoal = DIETARY_GOALS.some((x) => x.id === body.dietaryGoal) ? body.dietaryGoal : 'balanced';

  const age = ageFromBirthYear(next.birthYear);
  const bad = [];
  if (next.weightKg !== null && next.weightKg !== undefined && !(next.weightKg > 20 && next.weightKg < 400)) bad.push('weightKg');
  if (next.heightCm !== null && next.heightCm !== undefined && !(next.heightCm > 90 && next.heightCm < 260)) bad.push('heightCm');
  if (next.birthYear !== null && next.birthYear !== undefined && !(age >= 13 && age <= 120)) bad.push('birthYear');
  if (bad.length) throw new LocalApiError('Those numbers look out of range.', { code: 'out_of_range' });

  next.updatedAt = new Date().toISOString();
  if (window.__PLATE_NATIVE__) await nativeDiary('profile.write', next);
  else await put('profile', next);
  const publicProfile = localProfile(next);
  const effective = await effectiveProfile();
  return { profile: publicProfile, maintenance: maintenanceEnergy(effective), weightUsedKg: effective?.weightKg ?? null };
}

async function recentFoods() {
  const rows = (await diaryEntries())
    .sort((a, b) => b.sortKey - a.sortKey)
    .flatMap((entry) => (entry.items || []).map((item) => ({ item, loggedAt: entry.createdAt })));
  return summariseRecent(rows);
}

async function recentMeals(url) {
  const before = localDay(url.searchParams.get('before'));
  if (!before) throw new LocalApiError('A local calendar date is required.', { code: 'bad_day' });
  const days = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 14));
  const start = new Date(`${before}T00:00:00`).getTime() - days * 86400000;
  const rows = (await diaryEntries()).filter((e) => e.day < before && new Date(`${e.day}T00:00:00`).getTime() >= start)
    .map(publicEntry);
  return { meals: collapseRepeatable(rows) };
}

export async function localApi(path, options = {}) {
  const url = new URL(path, 'https://plate.local');
  const method = (options.method || 'GET').toUpperCase();
  const body = jsonBody(options);

  if (method === 'GET' && url.pathname === '/api/me') return me();
  if (method === 'PUT' && url.pathname === '/api/profile') return saveProfile(body);
  if (method === 'GET' && url.pathname === '/api/expenditure') return expenditure();
  if (method === 'GET' && url.pathname === '/api/history') return historyPayload(url.searchParams.get('days'));

  if (method === 'GET' && url.pathname === '/api/entries') {
    const day = localDay(url.searchParams.get('day'));
    if (!day) throw new LocalApiError('A local calendar date is required.', { code: 'bad_day' });
    return dayPayload(day);
  }
  if (method === 'POST' && url.pathname === '/api/entries') return saveEntry(body);
  if (method === 'GET' && url.pathname === '/api/entries/recent') return recentMeals(url);

  const entry = url.pathname.match(/^\/api\/entries\/([^/]+)$/);
  if (entry && method === 'PUT') return updateEntry(decodeURIComponent(entry[1]), body);
  if (entry && method === 'DELETE') {
    const id = decodeURIComponent(entry[1]);
    const row = await diaryEntry(id);
    if (!row) throw new LocalApiError('Entry not found.', { code: 'not_found', status: 404 });
    if (!await deleteDiaryEntry(row)) throw new LocalApiError('Entry not found.', { code: 'not_found', status: 404 });
    return { ok: true };
  }
  const duplicate = url.pathname.match(/^\/api\/entries\/([^/]+)\/duplicate$/);
  if (duplicate && method === 'POST') return duplicateEntry(decodeURIComponent(duplicate[1]), body);

  if (method === 'GET' && url.pathname === '/api/weights') {
    const rows = await weights();
    return { weights: rows, series: smoothSeries(rows), trend: weightTrend(rows) };
  }
  if (method === 'PUT' && url.pathname === '/api/weights') {
    const day = localDay(body.day);
    const kg = Number(body.kg);
    if (!day) throw new LocalApiError('A local calendar date is required.', { code: 'bad_day' });
    if (!(kg >= 20 && kg <= 400)) throw new LocalApiError('That weight looks wrong.', { code: 'out_of_range' });
    const next = { day, kg, at: body.at || new Date().toISOString() };
    if (window.__PLATE_NATIVE__) await nativeDiary('weights.write', next);
    else await put('weights', next);
    return { ok: true, day, kg };
  }
  const weight = url.pathname.match(/^\/api\/weights\/(\d{4}-\d{2}-\d{2})$/);
  if (weight && method === 'DELETE') {
    if (window.__PLATE_NATIVE__) {
      const { deleted } = await nativeDiary('weights.delete', { day: weight[1] });
      if (!deleted) throw new LocalApiError('Weight not found.', { code: 'not_found', status: 404 });
    } else {
      if (!await get('weights', weight[1])) throw new LocalApiError('Weight not found.', { code: 'not_found', status: 404 });
      await remove('weights', weight[1]);
    }
    return { ok: true };
  }

  if (method === 'GET' && url.pathname === '/api/foods/recent') return { recent: await recentFoods() };
  if (method === 'GET' && url.pathname === '/api/foods/search') {
    return nativeGenericFoodSearch(url.searchParams.get('q') || '');
  }
  const barcode = url.pathname.match(/^\/api\/foods\/barcode\/([^/]+)$/);
  if (barcode && method === 'GET') {
    const code = decodeURIComponent(barcode[1]);
    const food = window.__PLATE_NATIVE__
      ? await nativeFoodCache('read', code)
      : await get('foods', code);
    if (!food) throw new LocalApiError('This barcode is not saved on this device yet.', { code: 'not_found', status: 404 });
    return { food, cached: true };
  }
  if (barcode && method === 'PUT') {
    const code = decodeURIComponent(barcode[1]);
    const food = body.food;
    if (!food || food.barcode !== code || food.source !== 'openfoodfacts' || !food.per100?.calories) {
      throw new LocalApiError('That food result could not be saved locally.', { code: 'bad_food' });
    }
    // Do not retain Open Food Facts image URLs: fetching one later would be a
    // second unannounced upstream request. The nutrition record is all the
    // barcode flow needs, and it remains available offline.
    const cached = { ...food, imageUrl: null, hasImage: false, cachedAt: new Date().toISOString() };
    if (window.__PLATE_NATIVE__) await nativeFoodCache('write', code, cached);
    else await put('foods', cached);
    return { food: cached, cached: false };
  }

  if (url.pathname === '/api/analyse') {
    throw new LocalApiError('Photo analysis is not connected yet.', { code: 'not_configured', status: 503 });
  }
  throw new LocalApiError('This local feature has not been connected yet.', { code: 'not_implemented', status: 501 });
}
