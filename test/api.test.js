// End-to-end API tests against a real SQLite file in a temp directory.
// No mocks for the store: the schema, the constraints and the JSON round-trip
// are exactly what these tests exist to check.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-test-'));
process.env.NODE_ENV = 'test';
process.env.COOKIE_INSECURE = '1';

const { app } = await import('../server/index.js');
const { createInvite } = await import('../server/auth.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const api = (p, opts = {}) => fetch(base + p, {
  ...opts,
  headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
});

async function registerDevice() {
  const code = createInvite('test');
  const res = await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, auth: { Cookie: cookie } };
}

test('health reports whether analysis is configured', async () => {
  const r = await (await api('/api/health')).json();
  assert.equal(r.ok, true);
  assert.equal(typeof r.analysisConfigured, 'boolean');
});

test('the API is closed without a token', async () => {
  for (const p of ['/api/me', '/api/entries?day=2026-08-30', '/api/days']) {
    assert.equal((await api(p)).status, 401, `${p} must require a device`);
  }
});

test('an invite code works exactly once', async () => {
  const code = createInvite();
  assert.equal((await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code }) })).status, 200);
  assert.equal((await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code }) })).status, 400);
});

test('a bogus code is rejected', async () => {
  const res = await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code: 'NOPE-NOPE1' }) });
  assert.equal(res.status, 400);
});

test('admin routes are unreachable without the private-listener header', async () => {
  assert.equal((await api('/api/admin/invites')).status, 403);
  assert.equal((await api('/api/admin/invites', { method: 'POST', body: '{}' })).status, 403);

  const ok = await api('/api/admin/invites', { headers: { 'X-Admin': '1' } });
  assert.equal(ok.status, 200);
});

test('profile round-trips and yields a maintenance band', async () => {
  const { auth } = await registerDevice();
  const res = await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 80, heightCm: 180, ageYears: 30, sex: 'male', activity: 'moderate' })
  });
  assert.equal(res.status, 200);

  const { maintenance } = await res.json();
  assert.equal(maintenance.kcal, Math.round(1780 * 1.55));
  assert.ok(maintenance.low < maintenance.kcal && maintenance.kcal < maintenance.high);

  const me = await (await api('/api/me', { headers: auth })).json();
  assert.equal(me.profile.weightKg, 80);
});

test('an impossible profile is rejected, not clamped', async () => {
  const { auth } = await registerDevice();
  const res = await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 900, heightCm: 180, ageYears: 30, sex: 'male', activity: 'moderate' })
  });
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()).fields, ['weightKg']);
});

test('entries save, list and total correctly', async () => {
  const { auth } = await registerDevice();
  const items = [
    { name: 'chicken', grams: 150, per: { calories: 1.65, protein: 0.31, fat: 0.036, carbs: 0 } },
    { name: 'rice', grams: 200, per: { calories: 1.3, protein: 0.027, fat: 0.003, carbs: 0.28 } }
  ];

  const created = await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ day: '2026-08-30', meal: 'lunch', items, portionConfirmed: true })
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).totals.calories, 508);

  const day = await (await api('/api/entries?day=2026-08-30', { headers: auth })).json();
  assert.equal(day.entries.length, 1);
  assert.equal(day.summary.totals.calories, 508);
  assert.equal(day.summary.byMeal.lunch.count, 1);
  assert.ok(day.split.protein > 0, 'macro split is computed for the day');
});

test('entries are scoped to the device that wrote them', async () => {
  const a = await registerDevice();
  const b = await registerDevice();

  await api('/api/entries', {
    method: 'POST', headers: a.auth,
    body: JSON.stringify({
      day: '2026-08-29', meal: 'dinner',
      items: [{ name: 'soup', grams: 300, per: { calories: 0.4, protein: 0.02, fat: 0.01, carbs: 0.05 } }]
    })
  });

  const mine = await (await api('/api/entries?day=2026-08-29', { headers: a.auth })).json();
  const theirs = await (await api('/api/entries?day=2026-08-29', { headers: b.auth })).json();
  assert.equal(mine.entries.length, 1);
  assert.equal(theirs.entries.length, 0, 'another device must not see these entries');
});

test('an entry cannot be deleted by another device', async () => {
  const a = await registerDevice();
  const b = await registerDevice();

  const created = await (await api('/api/entries', {
    method: 'POST', headers: a.auth,
    body: JSON.stringify({
      day: '2026-08-28',
      items: [{ name: 'toast', grams: 60, per: { calories: 2.6, protein: 0.09, fat: 0.03, carbs: 0.49 } }]
    })
  })).json();

  assert.equal((await api(`/api/entries/${created.id}`, { method: 'DELETE', headers: b.auth })).status, 404);
  assert.equal((await api(`/api/entries/${created.id}`, { method: 'DELETE', headers: a.auth })).status, 200);
});

test('malformed entries are refused', async () => {
  const { auth } = await registerDevice();
  const bad = [
    { day: 'yesterday', items: [{ name: 'x', grams: 1, per: {} }] },
    { day: '2026-08-30', items: [] },
    { day: '2026-08-30' }
  ];
  for (const body of bad) {
    const res = await api('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    assert.equal(res.status, 400, `should refuse ${JSON.stringify(body)}`);
  }
});

test('/api/days aggregates calories per day, newest first', async () => {
  const { auth } = await registerDevice();
  const item = { name: 'x', grams: 100, per: { calories: 1, protein: 0, fat: 0, carbs: 0 } };
  for (const day of ['2026-08-25', '2026-08-26', '2026-08-26']) {
    await api('/api/entries', { method: 'POST', headers: auth, body: JSON.stringify({ day, items: [item] }) });
  }
  const { days } = await (await api('/api/days', { headers: auth })).json();
  assert.equal(days[0].day, '2026-08-26');
  assert.equal(days[0].calories, 200);
  assert.equal(days[1].calories, 100);
});

test('analysis without a key fails as unavailable, not as a server error', async () => {
  const { auth } = await registerDevice();
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const res = await api('/api/analyse', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ image: 'x'.repeat(200) })
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'not_configured');

  if (saved) process.env.GEMINI_API_KEY = saved;
});

test('analysis rejects a request with no photo', async () => {
  const { auth } = await registerDevice();
  const res = await api('/api/analyse', { method: 'POST', headers: auth, body: JSON.stringify({}) });
  assert.equal(res.status, 400);
});

test('a re-used code leaves no orphaned device behind', async () => {
  const { db } = await import('../server/db.js');
  const code = createInvite();

  await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code }) });
  const after = db.prepare('SELECT COUNT(*) AS n FROM devices').get().n;

  // Second attempt must fail *and* roll back the speculative device row.
  await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code }) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, after);
});

test('food routes require a device', async () => {
  assert.equal((await api('/api/foods/search?q=banana')).status, 401);
  assert.equal((await api('/api/foods/barcode/3017624010701')).status, 401);
});

test('a malformed barcode is rejected before any network call', async () => {
  const { auth } = await registerDevice();
  for (const code of ['123', 'abc', '1234567890123456789']) {
    const res = await api(`/api/foods/barcode/${code}`, { headers: auth });
    assert.equal(res.status, 400, `should refuse ${code}`);
    assert.equal((await res.json()).error, 'bad_barcode');
  }
});

test('a one-character search is refused rather than sent upstream', async () => {
  const { auth } = await registerDevice();
  const res = await api('/api/foods/search?q=b', { headers: auth });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'short_query');
});

test('an entry can be edited, and only by its own device', async () => {
  const a = await registerDevice();
  const b = await registerDevice();
  const item = { name: 'rice', grams: 200, per: { calories: 1.3, protein: 0.027, fat: 0.003, carbs: 0.28 } };

  const created = await (await api('/api/entries', {
    method: 'POST', headers: a.auth,
    body: JSON.stringify({ day: '2026-08-27', meal: 'lunch', items: [item] })
  })).json();
  assert.equal(created.totals.calories, 260);

  // Halve the portion.
  const edited = await api(`/api/entries/${created.id}`, {
    method: 'PUT', headers: a.auth,
    body: JSON.stringify({ meal: 'dinner', portionConfirmed: true, items: [{ ...item, grams: 100 }] })
  });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).totals.calories, 130);

  const day = await (await api('/api/entries?day=2026-08-27', { headers: a.auth })).json();
  assert.equal(day.entries.length, 1, 'editing must not create a second entry');
  assert.equal(day.entries[0].meal, 'dinner');
  assert.equal(day.entries[0].portionConfirmed, true);

  assert.equal((await api(`/api/entries/${created.id}`, {
    method: 'PUT', headers: b.auth, body: JSON.stringify({ items: [item] })
  })).status, 404, 'another device must not edit this entry');
});

test('an edit that empties the entry is refused', async () => {
  const { auth } = await registerDevice();
  const created = await (await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-08-26',
      items: [{ name: 'x', grams: 10, per: { calories: 1, protein: 0, fat: 0, carbs: 0 } }]
    })
  })).json();

  const res = await api(`/api/entries/${created.id}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ items: [] })
  });
  assert.equal(res.status, 400);
});
