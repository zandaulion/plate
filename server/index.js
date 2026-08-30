import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, nowIso, PHOTO_DIR } from './db.js';
import {
  requireDevice, requireAdmin, redeemInvite, setTokenCookie,
  createInvite, listInvites, COOKIE_NAME
} from './auth.js';
import { analysePhoto, AnalysisError, isConfigured, getModel } from './gemini.js';
import { lookupBarcode, searchFoods, LookupError, usdaConfigured } from './foods.js';
import { fromModelResponse, totalsOf, rangesOf } from '../core/analysis/estimate.js';
import { parseResponse } from '../core/analysis/prompt.js';
import { maintenanceEnergy, ACTIVITY_LEVELS } from '../core/nutrition.js';
import { summariseDay, macroSplit, MEALS } from '../core/day.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8097);

// Photos arrive base64-encoded inside JSON, already downscaled by the client.
// 8 MB is generous for a 1600px JPEG and still bounds a malicious upload.
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '../web'), { extensions: ['html'] }));

// core/ is served to the browser so the PWA runs the same estimate and
// nutrition code the server does, rather than a second implementation that
// drifts from it. Tests are excluded -- they are not part of the app.
app.use('/core', (req, res, next) => {
  if (req.path.endsWith('.test.js')) return res.status(404).end();
  next();
}, express.static(path.join(__dirname, '../core')));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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

app.post('/api/auth/redeem', (req, res) => {
  const { code, label } = req.body || {};
  const result = redeemInvite(code, typeof label === 'string' ? label.slice(0, 60) : null);
  if (!result) {
    return res.status(400).json({ error: 'bad_code', message: 'That code is not valid, or has already been used.' });
  }
  setTokenCookie(res, result.token);
  res.json({ ok: true, deviceId: result.deviceId });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
});

// --------------------------------------------------------------- profile

function profileFor(deviceId) {
  const row = db.prepare('SELECT * FROM profiles WHERE device_id = ?').get(deviceId);
  if (!row) return null;
  return {
    weightKg: row.weight_kg, heightCm: row.height_cm,
    ageYears: row.age_years, sex: row.sex, activity: row.activity,
    updatedAt: row.updated_at
  };
}

app.get('/api/me', requireDevice, (req, res) => {
  const profile = profileFor(req.device.id);
  res.json({
    deviceId: req.device.id,
    label: req.device.label,
    profile,
    maintenance: profile ? maintenanceEnergy(profile) : null,
    activityLevels: ACTIVITY_LEVELS,
    meals: MEALS,
    analysisConfigured: isConfigured(),
    // The UI warns that search covers packaged food only when USDA is absent,
    // rather than letting generic searches quietly return branded noise.
    genericSearch: usdaConfigured()
  });
});

app.put('/api/profile', requireDevice, (req, res) => {
  const b = req.body || {};
  const num = (v) => (v === null || v === '' || v === undefined ? null : Number(v));

  const weightKg = num(b.weightKg);
  const heightCm = num(b.heightCm);
  const ageYears = num(b.ageYears);
  const sex = ['male', 'female'].includes(b.sex) ? b.sex : null;
  const activity = ACTIVITY_LEVELS.some((l) => l.id === b.activity) ? b.activity : null;

  // Out-of-range values are rejected rather than clamped: silently changing
  // someone's stated weight would produce a maintenance figure they cannot
  // account for.
  const bad = [];
  if (weightKg !== null && !(weightKg > 20 && weightKg < 400)) bad.push('weightKg');
  if (heightCm !== null && !(heightCm > 90 && heightCm < 260)) bad.push('heightCm');
  if (ageYears !== null && !(ageYears >= 13 && ageYears <= 120)) bad.push('ageYears');
  if (bad.length) {
    return res.status(400).json({ error: 'out_of_range', fields: bad });
  }

  db.prepare(`
    INSERT INTO profiles (device_id, weight_kg, height_cm, age_years, sex, activity, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      weight_kg = excluded.weight_kg, height_cm = excluded.height_cm,
      age_years = excluded.age_years, sex = excluded.sex,
      activity = excluded.activity, updated_at = excluded.updated_at
  `).run(req.device.id, weightKg, heightCm, ageYears, sex, activity, nowIso());

  const profile = profileFor(req.device.id);
  res.json({ profile, maintenance: maintenanceEnergy(profile) });
});

// -------------------------------------------------------------- analysis

app.post('/api/analyse', requireDevice, asyncRoute(async (req, res) => {
  const { image, mimeType } = req.body || {};
  if (typeof image !== 'string' || image.length < 100) {
    return res.status(400).json({ error: 'no_image', message: 'No photo was received.' });
  }

  const { raw, usage, model } = await analysePhoto(image, mimeType || 'image/jpeg');
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

  const estimate = { items, portionConfirmed: Boolean(b.portionConfirmed) };
  const totals = totalsOf(estimate);

  const id = crypto.randomUUID();
  const photoId = savePhoto(b.image, b.mimeType);

  db.prepare(`
    INSERT INTO entries (id, device_id, day, meal, created_at, photo_id, note, portion_confirmed, items_json, totals_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.device.id, day,
    MEALS.includes(b.meal) ? b.meal : null,
    nowIso(), photoId,
    typeof b.note === 'string' ? b.note.slice(0, 500) : null,
    estimate.portionConfirmed ? 1 : 0,
    JSON.stringify(items), JSON.stringify(totals)
  );

  res.status(201).json({ id, day, totals, photoId });
});

function rowToEntry(row) {
  return {
    id: row.id, day: row.day, meal: row.meal, createdAt: row.created_at,
    photoId: row.photo_id, note: row.note,
    portionConfirmed: Boolean(row.portion_confirmed),
    items: JSON.parse(row.items_json),
    totals: JSON.parse(row.totals_json)
  };
}

app.get('/api/entries', requireDevice, (req, res) => {
  const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
    ? req.query.day : null;
  if (!day) return res.status(400).json({ error: 'bad_day' });

  const rows = db.prepare(
    'SELECT * FROM entries WHERE device_id = ? AND day = ? ORDER BY created_at'
  ).all(req.device.id, day).map(rowToEntry);

  const profile = profileFor(req.device.id);
  const summary = summariseDay(rows, profile ? maintenanceEnergy(profile) : null);

  res.json({ day, entries: rows, summary, split: macroSplit(summary.totals) });
});

/** Recent days, for the history strip. */
app.get('/api/days', requireDevice, (req, res) => {
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 14));
  const rows = db.prepare(`
    SELECT day, COUNT(*) AS entries, SUM(json_extract(totals_json, '$.calories')) AS calories
    FROM entries WHERE device_id = ?
    GROUP BY day ORDER BY day DESC LIMIT ?
  `).all(req.device.id, limit);
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
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND device_id = ?')
    .get(req.params.id, req.device.id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) {
    return res.status(400).json({ error: 'no_items', message: 'An entry needs at least one food.' });
  }

  const totals = totalsOf({ items });
  db.prepare(`
    UPDATE entries SET meal = ?, note = ?, portion_confirmed = ?, items_json = ?, totals_json = ?
    WHERE id = ?
  `).run(
    MEALS.includes(b.meal) ? b.meal : null,
    typeof b.note === 'string' ? b.note.slice(0, 500) : null,
    b.portionConfirmed ? 1 : 0,
    JSON.stringify(items), JSON.stringify(totals), row.id
  );

  res.json({ id: row.id, day: row.day, totals });
});

app.delete('/api/entries/:id', requireDevice, (req, res) => {
  const row = db.prepare('SELECT * FROM entries WHERE id = ? AND device_id = ?')
    .get(req.params.id, req.device.id);
  if (!row) return res.status(404).json({ error: 'not_found' });

  db.prepare('DELETE FROM entries WHERE id = ?').run(row.id);
  if (row.photo_id) {
    // The photo is the user's; deleting the entry must delete it too, not
    // orphan it on disk.
    try { fs.unlinkSync(path.join(PHOTO_DIR, row.photo_id)); } catch {}
  }
  res.json({ ok: true });
});

app.get('/api/photo/:id', requireDevice, (req, res) => {
  const owned = db.prepare('SELECT 1 FROM entries WHERE photo_id = ? AND device_id = ?')
    .get(req.params.id, req.device.id);
  if (!owned) return res.status(404).end();

  const file = path.join(PHOTO_DIR, path.basename(req.params.id));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type(file.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res);
});

// ----------------------------------------------------------------- admin

app.post('/api/admin/invites', requireAdmin, (req, res) => {
  const code = createInvite(typeof req.body?.label === 'string' ? req.body.label.slice(0, 60) : null);
  res.status(201).json({ code });
});

app.get('/api/admin/invites', requireAdmin, (req, res) => {
  res.json({ invites: listInvites().map(({ code_hash, ...rest }) => rest) });
});

app.get('/api/admin/devices', requireAdmin, (req, res) => {
  res.json({
    devices: db.prepare(`
      SELECT d.id, d.label, d.created_at, d.last_seen,
             (SELECT COUNT(*) FROM entries e WHERE e.device_id = d.id) AS entries
      FROM devices d ORDER BY d.created_at DESC
    `).all()
  });
});

app.delete('/api/admin/devices/:id', requireAdmin, (req, res) => {
  const photos = db.prepare('SELECT photo_id FROM entries WHERE device_id = ? AND photo_id IS NOT NULL')
    .all(req.params.id);
  const out = db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id);
  if (!out.changes) return res.status(404).json({ error: 'not_found' });
  for (const p of photos) {
    try { fs.unlinkSync(path.join(PHOTO_DIR, p.photo_id)); } catch {}
  }
  res.json({ ok: true });
});

// ----------------------------------------------------------------- errors

app.use((err, req, res, next) => {
  if (err instanceof AnalysisError || err instanceof LookupError) {
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
