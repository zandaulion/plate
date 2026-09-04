import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, nowIso, PHOTO_DIR } from './db.js';
import { swVersion } from './serve-sw.js';
import {
  requireDevice, requireAdmin, redeemInvite, setTokenCookie,
  createInvite, listInvites, revokeInvite, COOKIE_NAME,
  createLinkCode, redeemLinkCode, redeemRecovery, resetRecovery,
  listDevices, revokeDevice, listAllDevices, setDeviceRevoked, setDeviceLabel,
  ThrottledError
} from './auth.js';
import { analysePhoto, AnalysisError, isConfigured, getModel } from './gemini.js';
import {
  lookupBarcode, searchFoods, LookupError, usdaConfigured,
  productImagePath, hasProductImage
} from './foods.js';
import { summariseRecent } from '../core/foods.js';
import { toJson, toCsv } from '../core/export.js';
import { smoothSeries, weightTrend, trendGap } from '../core/weight.js';
import { adaptiveExpenditure } from '../core/expenditure.js';
import { summariseUsage } from '../core/usage.js';
import { cleanBatch, summariseEvents } from '../core/events.js';
import { zip } from './zip.js';
import {
  fromModelResponse, totalsOf, rangesOf, PORTION_SOURCES, portionSourceOf, hasPhotoItems
} from '../core/analysis/estimate.js';
import { parseResponse } from '../core/analysis/prompt.js';
import {
  charge, refund, BudgetError, MAX_CORRECTIONS,
  cachedAnalysis, cacheAnalysis, forgetPhoto
} from './budget.js';
import { maintenanceEnergy, ACTIVITY_LEVELS, ageFromBirthYear } from '../core/nutrition.js';
import { summariseDay, macroSplit, MEALS } from '../core/day.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8097);

// Photos arrive base64-encoded inside JSON, already downscaled by the client.
// 8 MB is generous for a 1600px JPEG and still bounds a malicious upload.
app.use(express.json({ limit: '8mb' }));
// Both of these go before express.static: it is configured with
// extensions:['html'], so it would answer /bust from bust.html itself and the
// Clear-Site-Data header -- the entire point of the route -- would be lost.
app.get('/bust', (req, res) => {
  // The escape hatch, for a client wedged on an old worker. sw.js refuses to
  // intercept this path, or the way out would sit behind the thing it exists
  // to get out of.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Clear-Site-Data', '"cache"');
  res.sendFile(path.join(__dirname, '../web/bust.html'));
});

app.use(swVersion(path.join(__dirname, '../web')));
app.use(express.static(path.join(__dirname, '../web'), { extensions: ['html'] }));

// core/ is served to the browser so the PWA runs the same estimate and
// nutrition code the server does, rather than a second implementation that
// drifts from it. Tests are excluded -- they are not part of the app.
app.use('/core', (req, res, next) => {
  if (req.path.endsWith('.test.js')) return res.status(404).end();
  next();
}, express.static(path.join(__dirname, '../core')));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ----------------------------------------------------------- cache buster



// ---------------------------------------------------------------- health

app.get('/api/health', (req, res) => {
  const devices = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;
  const entries = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
  res.json({
    ok: true,
    analysisConfigured: isConfigured(),
    model: isConfigured() ? getModel() : null,
    devices, entries,
    time: nowIso()
  });
});

// ------------------------------------------------------------------ auth

const deviceLabel = (v) => (typeof v === 'string' ? v.slice(0, 60) : null);

app.post('/api/auth/redeem', (req, res) => {
  const result = redeemInvite(req.body?.code, deviceLabel(req.body?.label));
  if (!result) {
    return res.status(400).json({ error: 'bad_code', message: 'That code is not valid, or has already been used.' });
  }
  setTokenCookie(res, result.token);
  // The recovery code is returned exactly once, here. It is stored hashed and
  // cannot be shown again -- only replaced.
  res.json({
    ok: true,
    accountId: result.accountId,
    deviceId: result.deviceId,
    recoveryCode: result.recoveryCode
  });
});

/** Joins this device to an existing account using a code from another device. */
app.post('/api/auth/link', (req, res) => {
  const result = redeemLinkCode(req.body?.code, deviceLabel(req.body?.label));
  if (!result) {
    return res.status(400).json({ error: 'bad_code', message: 'That link code is not valid or has expired.' });
  }
  setTokenCookie(res, result.token);
  res.json({ ok: true, accountId: result.accountId, deviceId: result.deviceId });
});

/** Last resort: the code written down at signup, when no device survives. */
app.post('/api/auth/recover', (req, res) => {
  const result = redeemRecovery(req.body?.code, deviceLabel(req.body?.label));
  if (!result) {
    return res.status(400).json({ error: 'bad_code', message: 'That recovery code is not valid.' });
  }
  setTokenCookie(res, result.token);
  res.json({ ok: true, accountId: result.accountId, deviceId: result.deviceId });
});

// ------------------------------------------------------------- devices

app.get('/api/devices', requireDevice, (req, res) => {
  res.json({
    devices: listDevices(req.device.account_id).map((d) => ({
      id: d.id, label: d.label, createdAt: d.created_at, lastSeen: d.last_seen,
      current: d.id === req.device.id
    }))
  });
});

app.post('/api/devices/link-code', requireDevice, (req, res) => {
  res.status(201).json(createLinkCode(req.device.account_id));
});

app.delete('/api/devices/:id', requireDevice, (req, res) => {
  if (req.params.id === req.device.id) {
    // Revoking the device you are holding would sign you out with no way back
    // except the recovery code. Logging out is the deliberate way to do that.
    return res.status(400).json({
      error: 'cannot_revoke_self',
      message: 'Use sign out to remove this device.'
    });
  }
  if (!revokeDevice(req.device.account_id, req.params.id)) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.json({ ok: true });
});

app.post('/api/devices/recovery-code', requireDevice, (req, res) => {
  res.json({ recoveryCode: resetRecovery(req.device.account_id) });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

// --------------------------------------------------------------- profile

/**
 * The profile as the maths should see it.
 *
 * `profiles.weight_kg` is whatever was typed at sign-up and is never revised,
 * so someone who has since logged themselves four kilos lighter would still
 * have their expenditure computed from the old figure. A reading on the scale
 * beats a number remembered months ago, so the most recent one wins when there
 * is one. The stated value is left untouched -- it is the user's, not ours to
 * overwrite.
 */
function effectiveProfile(accountId) {
  const profile = profileFor(accountId);
  if (!profile) return null;
  const latest = db.prepare(
    'SELECT kg FROM weights WHERE account_id = ? ORDER BY day DESC LIMIT 1'
  ).get(accountId);
  return latest ? { ...profile, weightKg: latest.kg, weightFromReading: true } : profile;
}

export const DIETS = [
  { id: 'omnivore', label: 'Omnivore (anything goes)' },
  { id: 'vegetarian', label: 'Vegetarian (no meat/fish)' },
  { id: 'vegan', label: 'Vegan (100% plant-based)' },
  { id: 'pescatarian', label: 'Pescatarian (vegetarian + seafood)' },
  { id: 'keto', label: 'Keto / Low-carb' }
];

export const DIETARY_GOALS = [
  { id: 'balanced', label: 'Balanced (standard split)' },
  { id: 'high_protein', label: 'High protein (satiety & muscle)' },
  { id: 'low_fat', label: 'Lower fat (heart & calorie density)' },
  { id: 'low_carb', label: 'Low carbohydrate' }
];

function profileFor(accountId) {
  const row = db.prepare('SELECT * FROM profiles WHERE account_id = ?').get(accountId);
  if (!row) return null;
  // Age is derived, never read from storage: the stored one was true only on
  // the day it was typed. birth_year is the fact; ageYears is still handed to
  // the client because everything downstream -- the Mifflin-St Jeor term, the
  // "what is still missing" list, the Android port -- speaks in years.
  const ageYears = ageFromBirthYear(row.birth_year);
  return {
    weightKg: row.weight_kg, heightCm: row.height_cm,
    birthYear: row.birth_year ?? null,
    ageYears,
    sex: row.sex, activity: row.activity,
    diet: row.diet || 'omnivore',
    dietaryGoal: row.dietary_goal || 'balanced',
    updatedAt: row.updated_at
  };
}

app.get('/api/me', requireDevice, (req, res) => {
  const profile = profileFor(req.device.account_id);
  // Accounts created by the v1 -> accounts migration have no recovery code:
  // it is issued when an invite is redeemed, which for them already happened.
  // The client surfaces this, because such an account is exactly one lost
  // cookie away from an unreachable history.
  const account = db.prepare('SELECT recovery_hash FROM accounts WHERE id = ?')
    .get(req.device.account_id);
  res.json({
    hasRecoveryCode: Boolean(account?.recovery_hash),
    accountId: req.device.account_id,
    deviceId: req.device.id,
    label: req.device.label,
    profile,
    maintenance: maintenanceEnergy(effectiveProfile(req.device.account_id)),
    // Which weight the figure came from. The profile form no longer shows one,
    // so the screen has to say what it used.
    weightUsedKg: effectiveProfile(req.device.account_id)?.weightKg ?? null,
    expenditure: expenditureFor(req.device.account_id),
    activityLevels: ACTIVITY_LEVELS,
    diets: DIETS,
    dietaryGoals: DIETARY_GOALS,
    meals: MEALS,
    analysisConfigured: isConfigured(),
    // The client collects nothing unless this says so, and the server drops
    // anything it sends regardless.
    trackingEnabled: trackingEnabled(req.device.account_id),
    // The UI warns that search covers packaged food only when USDA is absent,
    // rather than letting generic searches quietly return branded noise.
    genericSearch: usdaConfigured()
  });
});

/**
 * Partial update: a field absent from the body is left alone, and only an
 * explicit null clears it.
 *
 * This matters since weight left the profile form. The client no longer sends
 * weightKg, and a blanket overwrite would silently wipe the stored figure of
 * anyone who has not yet logged a reading -- taking away their expenditure
 * estimate the first time they corrected their height.
 */
app.put('/api/profile', requireDevice, (req, res) => {
  const b = req.body || {};
  const num = (v) => (v === null || v === '' ? null : Number(v));
  const current = profileFor(req.device.account_id) || {};
  const given = (k) => Object.prototype.hasOwnProperty.call(b, k);

  const weightKg = given('weightKg') ? num(b.weightKg) : (current.weightKg ?? null);
  const heightCm = given('heightCm') ? num(b.heightCm) : (current.heightCm ?? null);
  // Either shape is accepted. A birth year wins where both are sent, and a
  // bare age is converted on the way in rather than stored, so a client that
  // has not been updated yet still writes something that stays true.
  let birthYear;
  if (given('birthYear')) {
    birthYear = num(b.birthYear);
  } else if (given('ageYears')) {
    // Explicit here means explicit: a null clears the field rather than
    // falling back to what was stored, which is what "given" is for.
    const age = num(b.ageYears);
    birthYear = age === null ? null : new Date().getFullYear() - age;
  } else {
    birthYear = current.birthYear ?? null;
  }
  const ageYears = ageFromBirthYear(birthYear);
  const sex = given('sex')
    ? (['male', 'female'].includes(b.sex) ? b.sex : null)
    : (current.sex ?? null);
  const activity = given('activity')
    ? (ACTIVITY_LEVELS.some((l) => l.id === b.activity) ? b.activity : null)
    : (current.activity ?? null);
  const diet = given('diet')
    ? (DIETS.some((d) => d.id === b.diet) ? b.diet : 'omnivore')
    : (current.diet ?? 'omnivore');
  const dietaryGoal = given('dietaryGoal')
    ? (DIETARY_GOALS.some((g) => g.id === b.dietaryGoal) ? b.dietaryGoal : 'balanced')
    : (current.dietaryGoal ?? 'balanced');

  // Out-of-range values are rejected rather than clamped: silently changing
  // someone's stated weight would produce a maintenance figure they cannot
  // account for.
  const bad = [];
  if (weightKg !== null && !(weightKg > 20 && weightKg < 400)) bad.push('weightKg');
  if (heightCm !== null && !(heightCm > 90 && heightCm < 260)) bad.push('heightCm');
  if (birthYear !== null && !(ageYears !== null && ageYears >= 13 && ageYears <= 120)) {
    bad.push('birthYear');
  }
  if (bad.length) {
    return res.status(400).json({ error: 'out_of_range', fields: bad });
  }

  db.prepare(`
    INSERT INTO profiles (account_id, weight_kg, height_cm, birth_year, age_years,
                          sex, activity, diet, dietary_goal, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id) DO UPDATE SET
      weight_kg = excluded.weight_kg, height_cm = excluded.height_cm,
      birth_year = excluded.birth_year, age_years = excluded.age_years,
      sex = excluded.sex,
      activity = excluded.activity, diet = excluded.diet,
      dietary_goal = excluded.dietary_goal, updated_at = excluded.updated_at
  `).run(req.device.account_id, weightKg, heightCm, birthYear, ageYears,
         sex, activity, diet, dietaryGoal, nowIso());

  const profile = profileFor(req.device.account_id);
  const effective = effectiveProfile(req.device.account_id);
  res.json({
    profile,
    // Computed from the effective profile, not the stored one: the answer must
    // match what the rest of the app shows.
    maintenance: maintenanceEnergy(effective),
    weightUsedKg: effective?.weightKg ?? null
  });
});

// -------------------------------------------------------------- analysis

app.post('/api/analyse', requireDevice, asyncRoute(async (req, res) => {
  const { image, mimeType, correction } = req.body || {};
  if (typeof image !== 'string' || image.length < 100) {
    return res.status(400).json({ error: 'no_image', message: 'No photo was received.' });
  }

  charge(req.device.account_id);
  let raw, usage, model;
  try {
    ({ raw, usage, model } = await analysePhoto(
      image, mimeType || 'image/jpeg',
      typeof correction === 'string' ? correction.slice(0, 200) : null));
  } catch (err) {
    // Nothing was spent if the request never got as far as the model.
    if (err.status === 503 || err.status === 429) refund(req.device.account_id);
    throw err;
  }
  const parsed = parseResponse(raw);

  if (!parsed.ok) {
    // "Not food" and "found nothing" are different failures with different
    // remedies, so the client is told which one happened.
    return res.status(422).json({ error: parsed.reason, note: parsed.note, usage, model });
  }

  const estimate = fromModelResponse({ items: parsed.items, note: parsed.note });
  if (!estimate.items.length) {
    return res.status(422).json({ error: 'nothing_found', note: parsed.note, usage, model });
  }

  res.json({
    estimate,
    totals: totalsOf(estimate),
    ranges: rangesOf(estimate),
    usage, model
  });
}));

// ----------------------------------------------------------------- foods

app.get('/api/foods/barcode/:code', requireDevice, asyncRoute(async (req, res) => {
  res.json({ food: await lookupBarcode(req.params.code) });
}));

/**
 * Foods this device has logged before, ready to add again.
 *
 * Read from the entries themselves rather than a separate table: the list is
 * always in step with what was actually eaten, and there is no second store to
 * keep consistent when an entry is edited or deleted.
 */
app.get('/api/foods/recent', requireDevice, (req, res) => {
  // 400 items is several weeks of ordinary logging, and bounds the work
  // regardless of how long the history grows.
  const rows = db.prepare(`
    SELECT je.value AS item_json, e.created_at
    FROM entries e, json_each(e.items_json) je
    WHERE e.account_id = ?
    ORDER BY e.created_at DESC
    LIMIT 400
  `).all(req.device.account_id);

  const parsed = [];
  for (const row of rows) {
    try {
      parsed.push({ item: JSON.parse(row.item_json), loggedAt: row.created_at });
    } catch {
      // A row we cannot read is skipped rather than failing the list.
    }
  }

  res.json({ recent: summariseRecent(parsed) });
});

/**
 * The cached product shot for a barcode.
 *
 * Served from here rather than linked upstream: the browser asking Open Food
 * Facts for the picture would tell them the reader's address and what they are
 * about to eat, which proxying the lookup exists to avoid.
 */
app.get('/api/foods/image/:barcode', requireDevice, (req, res) => {
  if (!hasProductImage(req.params.barcode)) return res.status(404).end();
  res.type('image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=604800');
  fs.createReadStream(productImagePath(req.params.barcode)).pipe(res);
});

app.get('/api/foods/search', requireDevice, asyncRoute(async (req, res) => {
  res.json({
    results: await searchFoods(req.query.q),
    genericSearch: usdaConfigured()
  });
}));

// --------------------------------------------------------------- entries

function savePhoto(image, mimeType) {
  if (typeof image !== 'string' || image.length < 100) return null;
  const id = crypto.randomUUID();
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const name = `${id}.${ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), Buffer.from(image, 'base64'));
  return name;
}

app.post('/api/entries', requireDevice, (req, res) => {
  const b = req.body || {};
  const day = typeof b.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : null;
  if (!day) return res.status(400).json({ error: 'bad_day', message: 'A local calendar date is required.' });

  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: 'no_items', message: 'An entry needs at least one food.' });

  const portionSource = PORTION_SOURCES.includes(b.portionSource)
    ? b.portionSource
    : portionSourceOf({ portionConfirmed: b.portionConfirmed });
  const estimate = { items, portionSource };
  const totals = totalsOf(estimate);

  const id = crypto.randomUUID();
  // A camera photo always wins. Failing that, a scanned product's own picture
  // stands in, so a barcode entry looks like the others in the log instead of
  // being the one row with an empty square.
  let photoId = savePhoto(b.image, b.mimeType);
  if (!photoId) photoId = adoptProductImage(items);

  db.prepare(`
    INSERT INTO entries (id, account_id, device_id, day, meal, created_at, photo_id, note,
                         portion_confirmed, portion_source, items_json, totals_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.device.account_id, req.device.id, day,
    MEALS.includes(b.meal) ? b.meal : null,
    nowIso(), photoId,
    typeof b.note === 'string' ? b.note.slice(0, 500) : null,
    portionSource === 'model' ? 0 : 1, portionSource,
    JSON.stringify(items), JSON.stringify(totals)
  );

  res.status(201).json({ id, day, totals, photoId });
});

/**
 * Copies a cached product shot into this entry's own photo.
 *
 * Copied rather than referenced, so deleting or exporting an entry behaves
 * exactly as it does for a photograph -- a shared file would be unlinked out
 * from under every other entry that used the same product.
 */
function adoptProductImage(items) {
  const withCode = (items || []).find((i) => i?.barcode && hasProductImage(i.barcode));
  if (!withCode) return null;
  try {
    const name = `${crypto.randomUUID()}.jpg`;
    fs.copyFileSync(productImagePath(withCode.barcode), path.join(PHOTO_DIR, name));
    return name;
  } catch {
    return null;
  }
}

function rowToEntry(row) {
  return {
    id: row.id, day: row.day, meal: row.meal, createdAt: row.created_at,
    photoId: row.photo_id, note: row.note,
    portionConfirmed: Boolean(row.portion_confirmed),
    // So the app can retire the correction offer rather than let it be tapped
    // into a refusal.
    corrections: row.corrections || 0,
    portionSource: portionSourceOf({
      portionSource: row.portion_source, portionConfirmed: row.portion_confirmed
    }),
    items: JSON.parse(row.items_json),
    totals: JSON.parse(row.totals_json)
  };
}

app.get('/api/entries', requireDevice, (req, res) => {
  const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
    ? req.query.day : null;
  if (!day) return res.status(400).json({ error: 'bad_day' });

  // Newest first. A day is read while it is still being lived: the meal just
  // logged is the one being looked at, and on a full day the evening ones
  // would otherwise sit below the fold behind breakfast.
  const rows = db.prepare(
    'SELECT * FROM entries WHERE account_id = ? AND day = ? ORDER BY created_at DESC'
  ).all(req.device.account_id, day).map(rowToEntry);

  // The day is compared against measured expenditure when there is enough
  // evidence for one, and the formula otherwise -- the summary should not be
  // the only screen still using a population average.
  const expenditure = expenditureFor(req.device.account_id);
  const summary = summariseDay(rows, expenditure.available ? expenditure : null);

  // Weight rides along with the day rather than being a second request: the
  // day view now offers weighing in, and a prompt that arrives after the rest
  // of the screen has painted would flicker into place.
  const weights = weightRows(req.device.account_id, 120);
  const todays = weights.find((w) => w.day === day) || null;

  // What to pre-fill with when the day has no reading. The nearest reading
  // *before* the day in question, not simply the most recent overall --
  // filling in a missed Tuesday should start from Monday, not from Friday.
  const before = weights.filter((w) => w.day <= day);
  const nearest = before.length ? before[before.length - 1]
    : (weights.length ? weights[0] : null);

  res.json({
    day, entries: rows, summary, expenditure, split: macroSplit(summary.totals),
    weight: {
      today: todays ? todays.kg : null,
      last: nearest ? nearest.kg : null,
      trend: weightTrend(weights),
      // Sent alongside, so the prompt can name what is short instead of
      // guessing at one of the two requirements.
      gap: trendGap(weights)
    }
  });
});

/** Recent days, for the history strip. */
app.get('/api/days', requireDevice, (req, res) => {
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 14));
  const rows = db.prepare(`
    SELECT day, COUNT(*) AS entries, SUM(json_extract(totals_json, '$.calories')) AS calories
    FROM entries WHERE account_id = ?
    GROUP BY day ORDER BY day DESC LIMIT ?
  `).all(req.device.account_id, limit);
  res.json({ days: rows.map((r) => ({ ...r, calories: Math.round(r.calories || 0) })) });
});

/**
 * Replace an entry's contents.
 *
 * The photo is deliberately not replaceable here: editing exists so a portion
 * can be corrected after the fact, and re-analysing would cost another model
 * call to answer a question the user has already answered by hand.
 */
app.put('/api/entries/:id', requireDevice, (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) {
    return res.status(400).json({ error: 'no_items', message: 'An entry needs at least one food.' });
  }

  const totals = totalsOf({ items });
  const portionSource = PORTION_SOURCES.includes(b.portionSource)
    ? b.portionSource
    : portionSourceOf({ portionConfirmed: b.portionConfirmed });

  db.prepare(`
    UPDATE entries SET meal = ?, note = ?, portion_confirmed = ?, portion_source = ?,
                       items_json = ?, totals_json = ?
    WHERE id = ?
  `).run(
    MEALS.includes(b.meal) ? b.meal : null,
    typeof b.note === 'string' ? b.note.slice(0, 500) : null,
    portionSource === 'model' ? 0 : 1, portionSource,
    JSON.stringify(items), JSON.stringify(totals), row.id
  );

  res.json({ id: row.id, day: row.day, totals });
});

/**
 * Duplicate an existing entry.
 *
 * Copies items, portions and totals into a fresh entry with the current timestamp.
 * If the original carries a photograph, it is physically copied so subsequent
 * deletion or export behaves independently for each meal.
 */
app.post('/api/entries/:id/duplicate', requireDevice, (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const b = req.body || {};
  const day = typeof b.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : row.day;
  const id = crypto.randomUUID();

  const items = Array.isArray(b.items) && b.items.length ? b.items : JSON.parse(row.items_json);
  const portionSource = b.portionSource && PORTION_SOURCES.includes(b.portionSource)
    ? b.portionSource
    : (b.portionConfirmed !== undefined
        ? portionSourceOf({ portionConfirmed: b.portionConfirmed })
        : row.portion_source);
  const estimate = { items, portionSource };
  const totals = totalsOf(estimate);
  const meal = b.meal && MEALS.includes(b.meal) ? b.meal : row.meal;
  const note = typeof b.note === 'string' ? b.note.slice(0, 500) : row.note;

  let photoId = null;
  if (row.photo_id) {
    try {
      const ext = path.extname(row.photo_id) || '.jpg';
      photoId = `${crypto.randomUUID()}${ext}`;
      fs.copyFileSync(path.join(PHOTO_DIR, row.photo_id), path.join(PHOTO_DIR, photoId));
    } catch {
      photoId = null;
    }
  }

  db.prepare(`
    INSERT INTO entries (id, account_id, device_id, day, meal, created_at, photo_id, note,
                         portion_confirmed, portion_source, items_json, totals_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.device.account_id, req.device.id, day,
    meal, nowIso(), photoId, note,
    portionSource === 'model' ? 0 : 1, portionSource,
    JSON.stringify(items), JSON.stringify(totals)
  );

  res.status(201).json({ id, day, totals, photoId });
});

/**
 * Read a saved entry's photograph again, with a correction from the person
 * who ate it.
 *
 * The same affordance as on the review sheet, reached later. It matters most
 * here: a misidentification is usually noticed after the fact, and until now
 * the only remedy was to delete the entry and photograph a meal that had
 * already been eaten.
 *
 * The photo never leaves the server for this. It is on disk already, so the
 * client sends the correction alone rather than uploading back the image it
 * was served -- which also means this works on an entry logged from another
 * phone, where the image was never in this browser.
 *
 * Nothing is written. The new estimate goes back for confirmation and is
 * saved by the ordinary edit path, so a correction that reads worse than the
 * original can simply be abandoned.
 */
app.post('/api/entries/:id/reanalyse', requireDevice, asyncRoute(async (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (!row.photo_id) {
    return res.status(400).json({
      error: 'no_photo',
      message: 'This entry was not logged from a photo, so there is nothing to read again.'
    });
  }

  // A barcode entry's picture is the product shot adopted for the log. Reading
  // a jar of yoghurt as if it were a plated meal would replace scanned facts
  // with a guess, which is strictly worse than what is already stored.
  if (!hasPhotoItems({ items: JSON.parse(row.items_json) })) {
    return res.status(400).json({
      error: 'not_photo_based',
      message: 'These numbers came from a barcode, not from reading the photo.'
    });
  }

  const file = path.join(PHOTO_DIR, path.basename(row.photo_id));
  if (!fs.existsSync(file)) {
    return res.status(410).json({
      error: 'photo_gone',
      message: 'The photograph for this entry is no longer stored.'
    });
  }

  const correction = typeof req.body?.correction === 'string'
    ? req.body.correction.slice(0, 200) : null;

  // Asked before, of this photograph, in these words. Answered from the last
  // reply rather than by asking again: sending the same correction twice is
  // what someone does when they did not like the answer, and it costs nothing
  // to be honest that the answer has not changed.
  const seen = cachedAnalysis(row.photo_id, correction);
  if (seen) return res.json({ ...seen, repeated: true });

  if (row.corrections >= MAX_CORRECTIONS) {
    return res.status(429).json({
      error: 'corrections_exhausted',
      message: 'The photo has been read again twice. Another go is unlikely to help — set the food by hand instead.'
    });
  }

  charge(req.device.account_id);
  let raw, usage, model;
  try {
    ({ raw, usage, model } = await analysePhoto(
      fs.readFileSync(file).toString('base64'),
      row.photo_id.endsWith('.png') ? 'image/png' : 'image/jpeg',
      correction));
  } catch (err) {
    if (err.status === 503 || err.status === 429) refund(req.device.account_id);
    throw err;
  }
  db.prepare('UPDATE entries SET corrections = corrections + 1 WHERE id = ?').run(row.id);
  const parsed = parseResponse(raw);

  if (!parsed.ok) return res.status(422).json({ error: parsed.reason, note: parsed.note, usage, model });

  const estimate = fromModelResponse({ items: parsed.items, note: parsed.note });
  if (!estimate.items.length) {
    return res.status(422).json({ error: 'nothing_found', note: parsed.note, usage, model });
  }

  const answer = {
    estimate,
    totals: totalsOf(estimate),
    ranges: rangesOf(estimate),
    usage, model
  };
  cacheAnalysis(row.photo_id, correction, answer);
  res.json(answer);
}));

app.delete('/api/entries/:id', requireDevice, (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  db.prepare('DELETE FROM entries WHERE id = ?').run(row.id);
  if (row.photo_id) {
    // The photo is the user's; deleting the entry must delete it too, not
    // orphan it on disk.
    try { fs.unlinkSync(path.join(PHOTO_DIR, row.photo_id)); } catch {}
    forgetPhoto(row.photo_id);
  }
  res.json({ ok: true });
});

app.get('/api/photo/:id', requireDevice, (req, res) => {
  const owned = db.prepare('SELECT 1 FROM entries WHERE photo_id = ? AND account_id = ?')
    .get(req.params.id, req.device.account_id);
  if (!owned) return res.status(404).end();

  const file = path.join(PHOTO_DIR, path.basename(req.params.id));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------- weight

/**
 * One reading per calendar day, replacing any earlier one for that day.
 *
 * Weighing twice in a morning is common and the second reading is not new
 * evidence, so the day is the unit. Storing both would double that day's pull
 * on the trend for no reason.
 */
app.put('/api/weights', requireDevice, (req, res) => {
  const kg = Number(req.body?.kg);
  if (!Number.isFinite(kg) || kg < 20 || kg > 400) {
    return res.status(400).json({ error: 'out_of_range', message: 'That weight looks wrong.' });
  }

  const day = typeof req.body?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.day)
    ? req.body.day : null;
  if (!day) return res.status(400).json({ error: 'bad_day' });

  const measuredAt = typeof req.body?.at === 'string' && !Number.isNaN(Date.parse(req.body.at))
    ? req.body.at : `${day}T12:00:00.000Z`;

  db.prepare(`
    INSERT INTO weights (id, account_id, day, kg, measured_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, day) DO UPDATE SET
      kg = excluded.kg, measured_at = excluded.measured_at
  `).run(crypto.randomUUID(), req.device.account_id, day, kg, measuredAt, nowIso());

  res.json({ ok: true, day, kg });
});

function weightRows(accountId, limitDays = 180) {
  const from = new Date(Date.now() - limitDays * 86400000).toISOString().slice(0, 10);
  return db.prepare(
    'SELECT day, kg, measured_at FROM weights WHERE account_id = ? AND day >= ? ORDER BY day'
  ).all(accountId, from).map((r) => ({ day: r.day, kg: r.kg, at: r.measured_at }));
}

app.get('/api/weights', requireDevice, (req, res) => {
  const rows = weightRows(req.device.account_id);
  res.json({ weights: rows, series: smoothSeries(rows), trend: weightTrend(rows) });
});

app.delete('/api/weights/:day', requireDevice, (req, res) => {
  const out = db.prepare('DELETE FROM weights WHERE account_id = ? AND day = ?')
    .run(req.device.account_id, req.params.day);
  if (!out.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

/** Everything the expenditure estimate needs, in one call. */
function expenditureFor(accountId) {
  const entries = db.prepare(`
    SELECT day, portion_source, portion_confirmed, totals_json
    FROM entries WHERE account_id = ? AND day >= ?
  `).all(accountId, new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10))
    .map((r) => ({
      day: r.day,
      portionSource: r.portion_source,
      portionConfirmed: r.portion_confirmed,
      totals: JSON.parse(r.totals_json)
    }));

  return adaptiveExpenditure({
    entries,
    weights: weightRows(accountId, 40),
    profile: effectiveProfile(accountId)
  });
}

app.get('/api/expenditure', requireDevice, (req, res) => {
  res.json(expenditureFor(req.device.account_id));
});

// ---------------------------------------------------------------- events

const trackingEnabled = (accountId) => Boolean(
  db.prepare('SELECT tracking_enabled FROM accounts WHERE id = ?').get(accountId)?.tracking_enabled);

/**
 * Accepts a batch of interaction events, and only from an account that has
 * been switched on for it.
 *
 * The check is here rather than in the client on purpose. A flag the browser
 * decides is one bug or one shared build away from recording someone who was
 * told the app tracks nothing; a flag the server enforces cannot be. An
 * account without it gets 204 and the batch is discarded -- silently, because
 * a client that keeps trying is not worth an error either.
 */
app.post('/api/events', requireDevice, (req, res) => {
  if (!trackingEnabled(req.device.account_id)) return res.status(204).end();

  const rows = cleanBatch(req.body?.events);
  if (!rows.length) return res.json({ stored: 0 });

  const insert = db.prepare(
    'INSERT INTO events (account_id, session, at, name, props_json) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      insert.run(req.device.account_id, r.session, r.at, r.name,
        r.props ? JSON.stringify(r.props) : null);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Ninety days is longer than any usability question stays interesting.
  db.prepare("DELETE FROM events WHERE account_id = ? AND at < ?")
    .run(req.device.account_id, new Date(Date.now() - 90 * 86400000).toISOString());

  res.json({ stored: rows.length });
});

/** Switching it on is an admin action, so it cannot happen from the phone. */
app.post('/api/admin/accounts/:id/tracking', requireAdmin, (req, res) => {
  const on = req.body?.enabled === true || req.body?.enabled === 1;
  const out = db.prepare('UPDATE accounts SET tracking_enabled = ? WHERE id = ?')
    .run(on ? 1 : 0, req.params.id);
  if (!out.changes) return res.status(404).json({ error: 'not_found', detail: 'No such account.' });
  if (!on) db.prepare('DELETE FROM events WHERE account_id = ?').run(req.params.id);
  res.json({ ok: true, trackingEnabled: on });
});

// ----------------------------------------------------------------- usage

/**
 * How this account has been using the app.
 *
 * Scoped to the caller by construction -- it reads req.device.account_id and
 * nothing else, so it cannot report on anyone else's diary no matter who asks.
 * That is deliberate: this exists to answer usability questions during
 * testing, and reading a friend's food log to find out whether a button works
 * is not a trade worth making.
 *
 * Nothing new is collected for it. Every figure comes from rows the app must
 * keep in order to function.
 */
app.get('/api/usage', requireDevice, (req, res) => {
  const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
  const account = req.device.account_id;
  const from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);

  const entries = db.prepare(
    'SELECT day, meal, created_at, portion_source, photo_id, items_json FROM entries WHERE account_id = ? AND day >= ?'
  ).all(account, from).map((r) => ({
    day: r.day,
    meal: r.meal,
    createdAt: r.created_at,
    portionSource: r.portion_source,
    photoId: r.photo_id,
    items: JSON.parse(r.items_json)
  }));

  const derived = summariseUsage({ entries, weights: weightRows(account, days + 1), days });

  // Event data only exists for an account that opted in, so its absence is
  // reported rather than left as a missing key.
  if (!trackingEnabled(account)) {
    return res.json({ ...derived, interaction: { tracking: false } });
  }

  const events = db.prepare(
    'SELECT session, at, name, props_json FROM events WHERE account_id = ? AND at >= ? ORDER BY at'
  ).all(account, new Date(Date.now() - days * 86400000).toISOString())
    .map((r) => ({ session: r.session, at: r.at, name: r.name, props: r.props_json ? JSON.parse(r.props_json) : null }));

  res.json({ ...derived, interaction: { tracking: true, ...summariseEvents(events) } });
});

// --------------------------------------------------------------- history

/**
 * A dense day-by-day series: intake, its macro split, and weight.
 *
 * Dense on purpose -- every day in the range appears, with nulls where nothing
 * was logged. A chart drawn from only the days that have data spaces them
 * evenly and quietly lies about time, turning a week's gap into one step.
 */
app.get('/api/history', requireDevice, (req, res) => {
  const days = Math.min(180, Math.max(7, Number(req.query.days) || 30));
  const account = req.device.account_id;

  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const key = (d) => d.toISOString().slice(0, 10);
  const from = key(start);

  const intake = new Map(db.prepare(`
    SELECT day,
           SUM(json_extract(totals_json, '$.calories')) AS calories,
           SUM(json_extract(totals_json, '$.protein'))  AS protein,
           SUM(json_extract(totals_json, '$.fat'))      AS fat,
           SUM(json_extract(totals_json, '$.carbs'))    AS carbs,
           COUNT(*) AS entries
    FROM entries WHERE account_id = ? AND day >= ?
    GROUP BY day
  `).all(account, from).map((r) => [r.day, r]));

  const weights = new Map(weightRows(account, days + 1).map((w) => [w.day, w.kg]));

  const series = [];
  for (let i = 0; i < days; i++) {
    const day = key(new Date(start.getTime() + i * 86400000));
    const r = intake.get(day);
    series.push({
      day,
      calories: r ? Math.round(r.calories) : null,
      protein: r ? Math.round(r.protein * 10) / 10 : null,
      fat: r ? Math.round(r.fat * 10) / 10 : null,
      carbs: r ? Math.round(r.carbs * 10) / 10 : null,
      entries: r ? r.entries : 0,
      weight: weights.has(day) ? weights.get(day) : null
    });
  }

  res.json({
    from, to: key(end), days: series,
    expenditure: expenditureFor(account),
    weightTrend: weightTrend(weightRows(account, days + 1))
  });
});

// ---------------------------------------------------------------- export

/**
 * Everything this account has, in one of three shapes.
 *
 * Export is what makes the data-sovereignty claim real rather than rhetorical,
 * so it is unauthenticated by nothing more than the ordinary device token, has
 * no premium gate, and includes the photographs -- an export of a food log
 * without its pictures is a subset of someone's data, not their data.
 */
function exportPayload(accountId) {
  const entries = db.prepare(
    'SELECT * FROM entries WHERE account_id = ? ORDER BY day, created_at'
  ).all(accountId).map(rowToEntry);

  const account = db.prepare('SELECT created_at FROM accounts WHERE id = ?').get(accountId);

  return {
    entries,
    profile: profileFor(accountId),
    accountCreatedAt: account?.created_at ?? null
  };
}

const stamp = () => new Date().toISOString().slice(0, 10);

function attach(res, filename, type) {
  res.type(type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
}

app.get('/api/export.json', requireDevice, (req, res) => {
  attach(res, `plate-${stamp()}.json`, 'application/json');
  res.send(JSON.stringify(toJson(exportPayload(req.device.account_id)), null, 2));
});

app.get('/api/export.csv', requireDevice, (req, res) => {
  attach(res, `plate-${stamp()}.csv`, 'text/csv; charset=utf-8');
  res.send(toCsv(exportPayload(req.device.account_id)));
});

app.get('/api/export.zip', requireDevice, (req, res) => {
  const payload = exportPayload(req.device.account_id);
  const files = [
    { name: 'plate.json', data: JSON.stringify(toJson(payload), null, 2) },
    { name: 'plate.csv', data: toCsv(payload) }
  ];

  let missing = 0;
  for (const entry of payload.entries) {
    if (!entry.photoId) continue;
    const file = path.join(PHOTO_DIR, path.basename(entry.photoId));
    try {
      files.push({ name: `photos/${entry.photoId}`, data: fs.readFileSync(file) });
    } catch {
      // A photo missing from disk should not fail the whole export; the JSON
      // still names it, so the gap is visible rather than silent.
      missing++;
    }
  }

  if (missing) {
    files.push({
      name: 'README.txt',
      data: `${missing} photo file(s) named in plate.json were not found on the server `
        + 'and are absent from this archive.\n'
    });
  }

  attach(res, `plate-${stamp()}.zip`, 'application/zip');
  res.send(zip(files));
});

// ----------------------------------------------------------------- admin

// The shared invite console fronts several apps through one page, so these
// match the shape the others expose: `detail` on errors, an id per invite, an
// expiry, and revocation as a reversible flag rather than a delete.
app.post('/api/admin/invites', requireAdmin, (req, res) => {
  res.status(201).json(createInvite(deviceLabel(req.body?.label)));
});

app.get('/api/admin/invites', requireAdmin, (req, res) => {
  res.json(listInvites());
});

app.post('/api/admin/invites/:id/revoke', requireAdmin, (req, res) => {
  if (!revokeInvite(Number(req.params.id))) {
    return res.status(404).json({ error: 'not_found', detail: 'No unused invite with that id.' });
  }
  res.json({ ok: true });
});

app.get('/api/admin/accounts', requireAdmin, (req, res) => {
  res.json({
    accounts: db.prepare(`
      SELECT a.id, a.created_at,
             (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id) AS devices,
             (SELECT COUNT(*) FROM entries e WHERE e.account_id = a.id) AS entries,
             (SELECT MAX(d.last_seen) FROM devices d WHERE d.account_id = a.id) AS last_seen
      FROM accounts a ORDER BY a.created_at DESC
    `).all()
  });
});

app.get('/api/admin/devices', requireAdmin, (req, res) => {
  res.json({ devices: listAllDevices() });
});

app.post('/api/admin/devices/:id/revoke', requireAdmin, (req, res) => {
  const revoked = req.body?.revoked === true || req.body?.revoked === 1;
  if (!setDeviceRevoked(req.params.id, revoked)) {
    return res.status(404).json({ error: 'not_found', detail: 'No device with that id.' });
  }
  res.json({ ok: true, revoked });
});

app.post('/api/admin/devices/:id/label', requireAdmin, (req, res) => {
  const label = deviceLabel(req.body?.label);
  if (!label) return res.status(400).json({ error: 'bad_label', detail: 'A label is required.' });
  if (!setDeviceLabel(req.params.id, label)) {
    return res.status(404).json({ error: 'not_found', detail: 'No device with that id.' });
  }
  res.json({ ok: true, label });
});

/**
 * Forgets a device outright. Its history is untouched: entries belong to the
 * account, so this costs that phone its session and nothing else. Revoking is
 * the reversible option, and is what the console offers first.
 */
app.delete('/api/admin/devices/:id', requireAdmin, (req, res) => {
  const out = db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  if (!out.changes) return res.status(404).json({ error: 'not_found', detail: 'No device with that id.' });
  res.json({ ok: true });
});

/**
 * Deletes a person: every device, entry, photo and profile.
 *
 * Devices are removed first and explicitly. devices.account_id was added by an
 * ALTER, which cannot carry an ON DELETE clause, so it defaults to NO ACTION
 * and a device blocks its own account's deletion. Doing it in dependency order
 * inside one transaction is both correct and clearer than the constraint
 * would have been.
 */
app.delete('/api/admin/accounts/:id', requireAdmin, (req, res) => {
  const accountId = req.params.id;
  const photos = db.prepare('SELECT photo_id FROM entries WHERE account_id = ? AND photo_id IS NOT NULL')
    .all(accountId);

  db.exec('BEGIN IMMEDIATE');
  let removed;
  try {
    db.prepare('DELETE FROM devices WHERE account_id = ?').run(accountId);
    removed = db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId).changes;
    if (!removed) {
      db.exec('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Files only once the rows are certainly gone: an unlinked photo whose row
  // survived a rollback would be a broken entry rather than a tidy one.
  let filesDeleted = 0;
  for (const p of photos) {
    try { fs.unlinkSync(path.join(PHOTO_DIR, p.photo_id)); filesDeleted++; } catch {}
  }
  res.json({ ok: true, photosDeleted: filesDeleted });
});

// ----------------------------------------------------------------- errors

app.use((err, req, res, next) => {
  if (err instanceof AnalysisError || err instanceof LookupError ||
      err instanceof ThrottledError || err instanceof BudgetError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  console.error('unhandled', err);
  res.status(500).json({ error: 'internal', message: 'Something went wrong on the server.' });
});

// Loopback by default, so running this directly on a host never exposes it to
// the network by accident. In a container the app must bind the namespace's
// external interface to be reachable at all, so the quadlet sets
// BIND_HOST=0.0.0.0 -- safe there because the port is published only to the
// host's 127.0.0.1, and Caddy is the sole thing in front of it.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, BIND_HOST, () => {
    console.log(`plate listening on ${BIND_HOST}:${PORT} (analysis ${isConfigured() ? 'on' : 'OFF'})`);
  });
}

export { app };
