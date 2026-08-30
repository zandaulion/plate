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

test('how the weight was arrived at is stored and returned', async () => {
  const { auth } = await registerDevice();
  const item = { name: 'stew', grams: 300, per: { calories: 1.2, protein: 0.06, fat: 0.05, carbs: 0.09 }, source: 'photo' };

  const cases = [
    [{ portionSource: 'weighed' }, 'weighed'],
    [{ portionSource: 'estimated' }, 'estimated'],
    [{}, 'model'],
    // Entries from a client that only knows the old boolean.
    [{ portionConfirmed: true }, 'estimated'],
    // A value we do not recognise must not be trusted through to storage.
    [{ portionSource: 'weighed-ish' }, 'model']
  ];

  for (const [extra, expected] of cases) {
    const created = await (await api('/api/entries', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ day: '2026-08-20', items: [item], ...extra })
    })).json();
    assert.ok(created.id, JSON.stringify(extra));
  }

  const day = await (await api('/api/entries?day=2026-08-20', { headers: auth })).json();
  assert.deepEqual(day.entries.map((e) => e.portionSource), cases.map((c) => c[1]));
});

test('editing can upgrade an entry to weighed', async () => {
  const { auth } = await registerDevice();
  const item = { name: 'porridge', grams: 250, per: { calories: 0.7, protein: 0.02, fat: 0.01, carbs: 0.12 }, source: 'photo' };

  const created = await (await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ day: '2026-08-19', items: [item] })
  })).json();

  await api(`/api/entries/${created.id}`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ items: [item], portionSource: 'weighed' })
  });

  const day = await (await api('/api/entries?day=2026-08-19', { headers: auth })).json();
  assert.equal(day.entries[0].portionSource, 'weighed');
});

// ------------------------------------------------------- accounts & devices

async function linkNewDevice(auth, label = 'second') {
  const { code } = await (await api('/api/devices/link-code', { method: 'POST', headers: auth, body: '{}' })).json();
  const res = await api('/api/auth/link', { method: 'POST', body: JSON.stringify({ code, label }) });
  assert.equal(res.status, 200, 'link code should be accepted');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return { cookie, auth: { Cookie: cookie }, body: await res.json() };
}

test('redeeming an invite returns a recovery code exactly once', async () => {
  const code = createInvite();
  const body = await (await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code }) })).json();
  assert.ok(body.recoveryCode, 'the recovery code is only ever shown here');
  assert.ok(body.accountId);
  assert.ok(body.deviceId);
});

test('a linked device shares the same account, history and profile', async () => {
  const first = await registerDevice();
  await api('/api/profile', {
    method: 'PUT', headers: first.auth,
    body: JSON.stringify({ weightKg: 75, heightCm: 175, ageYears: 35, sex: 'female', activity: 'light' })
  });
  await api('/api/entries', {
    method: 'POST', headers: first.auth,
    body: JSON.stringify({
      day: '2026-08-18', meal: 'lunch',
      items: [{ name: 'soup', grams: 300, per: { calories: 0.4, protein: 0.02, fat: 0.01, carbs: 0.05 } }]
    })
  });

  const second = await linkNewDevice(first.auth, 'tablet');

  const mine = await (await api('/api/me', { headers: first.auth })).json();
  const theirs = await (await api('/api/me', { headers: second.auth })).json();
  assert.equal(mine.accountId, theirs.accountId, 'both devices are one account');
  assert.notEqual(mine.deviceId, theirs.deviceId, 'but they are still distinct devices');
  assert.equal(theirs.profile.weightKg, 75, 'the profile is shared, not re-entered');

  const day = await (await api('/api/entries?day=2026-08-18', { headers: second.auth })).json();
  assert.equal(day.entries.length, 1, 'the second device sees the first one’s log');

  // And writes land in the same history.
  await api('/api/entries', {
    method: 'POST', headers: second.auth,
    body: JSON.stringify({
      day: '2026-08-18',
      items: [{ name: 'apple', grams: 150, per: { calories: 0.52, protein: 0, fat: 0, carbs: 0.14 } }]
    })
  });
  const after = await (await api('/api/entries?day=2026-08-18', { headers: first.auth })).json();
  assert.equal(after.entries.length, 2, 'the first device sees what the second wrote');
});

test('a link code works once and then not again', async () => {
  const { auth } = await registerDevice();
  const { code } = await (await api('/api/devices/link-code', { method: 'POST', headers: auth, body: '{}' })).json();

  assert.equal((await api('/api/auth/link', { method: 'POST', body: JSON.stringify({ code }) })).status, 200);
  assert.equal((await api('/api/auth/link', { method: 'POST', body: JSON.stringify({ code }) })).status, 400);
});

test('an unknown link code is refused', async () => {
  assert.equal((await api('/api/auth/link', { method: 'POST', body: JSON.stringify({ code: 'ZZZZZ-ZZZ' }) })).status, 400);
});

test('devices are listed per account, with the current one marked', async () => {
  const first = await registerDevice();
  await linkNewDevice(first.auth, 'tablet');

  const { devices } = await (await api('/api/devices', { headers: first.auth })).json();
  assert.equal(devices.length, 2);
  assert.equal(devices.filter((d) => d.current).length, 1, 'exactly one device is the caller');
  assert.ok(devices.some((d) => d.label === 'tablet'));
});

test('revoking a device removes its access but keeps the history', async () => {
  const first = await registerDevice();
  await api('/api/entries', {
    method: 'POST', headers: first.auth,
    body: JSON.stringify({
      day: '2026-08-17',
      items: [{ name: 'bread', grams: 80, per: { calories: 2.6, protein: 0.09, fat: 0.03, carbs: 0.49 } }]
    })
  });
  const second = await linkNewDevice(first.auth, 'lost phone');

  const { devices } = await (await api('/api/devices', { headers: first.auth })).json();
  const lost = devices.find((d) => d.label === 'lost phone');
  assert.equal((await api(`/api/devices/${lost.id}`, { method: 'DELETE', headers: first.auth })).status, 200);

  // The revoked device is locked out...
  assert.equal((await api('/api/me', { headers: second.auth })).status, 401);
  // ...and the log it could see is untouched.
  const day = await (await api('/api/entries?day=2026-08-17', { headers: first.auth })).json();
  assert.equal(day.entries.length, 1, 'revoking a device must never delete history');
});

test('a device cannot revoke itself', async () => {
  const { auth } = await registerDevice();
  const { devices } = await (await api('/api/devices', { headers: auth })).json();
  const me = devices.find((d) => d.current);

  const res = await api(`/api/devices/${me.id}`, { method: 'DELETE', headers: auth });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'cannot_revoke_self');
});

test('a device cannot revoke one belonging to someone else', async () => {
  const a = await registerDevice();
  const b = await registerDevice();
  const { devices } = await (await api('/api/devices', { headers: b.auth })).json();

  assert.equal((await api(`/api/devices/${devices[0].id}`, { method: 'DELETE', headers: a.auth })).status, 404);
  assert.equal((await api('/api/me', { headers: b.auth })).status, 200, 'their device still works');
});

test('the recovery code restores access to the same account', async () => {
  const code = createInvite();
  const redeemed = await (await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code }) })).json();
  const original = { Cookie: `plate_token=x` }; // deliberately unusable: the phone is gone

  const res = await api('/api/auth/recover', {
    method: 'POST', body: JSON.stringify({ code: redeemed.recoveryCode, label: 'new phone' })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.accountId, redeemed.accountId, 'recovery must land on the original account');
  assert.notEqual(body.deviceId, redeemed.deviceId, 'as a new device');
  assert.equal((await api('/api/me', { headers: original })).status, 401);
});

test('a reissued recovery code retires the old one', async () => {
  const code = createInvite();
  const redeemed = await (await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code }) })).json();
  // Reissue from the signed-in device.
  const auth = { Cookie: (await (async () => {
    const r = await api('/api/auth/recover', { method: 'POST', body: JSON.stringify({ code: redeemed.recoveryCode }) });
    return r.headers.get('set-cookie').split(';')[0];
  })()) };

  const { recoveryCode: fresh } = await (await api('/api/devices/recovery-code', { method: 'POST', headers: auth, body: '{}' })).json();
  assert.notEqual(fresh, redeemed.recoveryCode);

  assert.equal((await api('/api/auth/recover', { method: 'POST', body: JSON.stringify({ code: redeemed.recoveryCode }) })).status, 400,
    'the superseded code must stop working');
  assert.equal((await api('/api/auth/recover', { method: 'POST', body: JSON.stringify({ code: fresh }) })).status, 200);
});

test('an unknown recovery code is refused', async () => {
  assert.equal((await api('/api/auth/recover', { method: 'POST', body: JSON.stringify({ code: 'AAAAA-AAAAAAA' }) })).status, 400);
});

test('deleting an account removes its devices, entries and profile', async () => {
  const { db } = await import('../server/db.js');
  const first = await registerDevice();
  await linkNewDevice(first.auth, 'second');
  await api('/api/profile', {
    method: 'PUT', headers: first.auth,
    body: JSON.stringify({ weightKg: 70, heightCm: 170, ageYears: 30, sex: 'male', activity: 'light' })
  });
  await api('/api/entries', {
    method: 'POST', headers: first.auth,
    body: JSON.stringify({
      day: '2026-08-15',
      items: [{ name: 'x', grams: 100, per: { calories: 1, protein: 0, fat: 0, carbs: 0 } }]
    })
  });

  const { accountId } = await (await api('/api/me', { headers: first.auth })).json();

  // Devices reference the account with no ON DELETE action, so this used to
  // fail the foreign key and return 500.
  const res = await api(`/api/admin/accounts/${accountId}`, {
    method: 'DELETE', headers: { 'X-Admin': '1' }
  });
  assert.equal(res.status, 200);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM devices WHERE account_id = ?').get(accountId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries WHERE account_id = ?').get(accountId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?').get(accountId).n, 0);
  assert.equal((await api('/api/me', { headers: first.auth })).status, 401, 'its devices are locked out');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no dangling references');
});

test('deleting an unknown account is a 404, not a 500', async () => {
  const res = await api('/api/admin/accounts/does-not-exist', {
    method: 'DELETE', headers: { 'X-Admin': '1' }
  });
  assert.equal(res.status, 404);
});

// ------------------------------------------------------------------ export

async function seedForExport() {
  const { auth } = await registerDevice();
  await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 82, heightCm: 181, ageYears: 41, sex: 'male', activity: 'light' })
  });
  // Stands in for a photo. The server stores the bytes it is given without
  // decoding them, and only requires enough of them to be a plausible upload,
  // so the content does not need to be a real image -- but it does need to
  // clear that length floor, which a 1-pixel PNG does not.
  const png = Buffer.alloc(400, 0x89).toString('base64');
  await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-08-12', meal: 'lunch', portionSource: 'weighed',
      image: png, mimeType: 'image/png',
      items: [{ name: 'stew, beef', grams: 300, source: 'photo', per: { calories: 1.2, protein: 0.06, fat: 0.05, carbs: 0.09 } }]
    })
  });
  await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-08-13',
      items: [{ name: 'porridge', grams: 250, source: 'manual', per: { calories: 0.71, protein: 0.025, fat: 0.014, carbs: 0.12 } }]
    })
  });
  return auth;
}

test('export requires a device', async () => {
  for (const p of ['/api/export.json', '/api/export.csv', '/api/export.zip']) {
    assert.equal((await api(p)).status, 401, p);
  }
});

test('JSON export contains the whole account and is offered as a download', async () => {
  const auth = await seedForExport();
  const res = await api('/api/export.json', { headers: auth });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="plate-\d{4}-\d{2}-\d{2}\.json"/);

  const body = await res.json();
  assert.equal(body.entryCount, 2);
  assert.equal(body.profile.weightKg, 82);
  assert.equal(body.entries[0].portionSource, 'weighed');
  assert.equal(body.photos.length, 1);
  // Round-trippable: rate x grams reproduces the stored total.
  const item = body.entries[0].items[0];
  assert.equal(Math.round(item.per.calories * item.grams), 360);
});

test('CSV export is a row per food', async () => {
  const auth = await seedForExport();
  const res = await api('/api/export.csv', { headers: auth });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);

  const lines = (await res.text()).trim().split('\n');
  assert.equal(lines.length, 3, 'header plus two foods');
  assert.match(lines[1], /"stew, beef"/, 'a comma in a name must be quoted');
});

test('an export only ever contains its own account', async () => {
  const mine = await seedForExport();
  const theirs = await registerDevice();

  const empty = await (await api('/api/export.json', { headers: theirs.auth })).json();
  assert.equal(empty.entryCount, 0, 'a different account sees nothing of mine');
  assert.equal(empty.profile, null);
});

test('the ZIP export is a valid archive containing the data and the photos', async () => {
  const { execFileSync } = await import('node:child_process');
  const auth = await seedForExport();

  const res = await api('/api/export.zip', { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');

  const file = path.join(process.env.DATA_DIR, 'export-test.zip');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));

  // Checked with the real unzip rather than by reading our own bytes back:
  // a hand-written container that only our own reader accepts is not an export.
  const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
  assert.match(listing, /plate\.json/);
  assert.match(listing, /plate\.csv/);
  assert.match(listing, /photos\//, 'the photograph must be in the archive');

  const verify = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
  assert.match(verify, /No errors detected/, 'CRCs must be correct');

  const json = JSON.parse(execFileSync('unzip', ['-p', file, 'plate.json'], { encoding: 'utf8' }));
  assert.equal(json.entryCount, 2);
  assert.equal(json.photos.length, 1);

  // Every photo the JSON names is present in the archive.
  for (const photo of json.photos) {
    assert.match(listing, new RegExp(photo.replace(/[.]/g, '\\.')), `${photo} missing from archive`);
  }
});

// ------------------------------------------------- weight & expenditure

test('a weight reading is stored once per day and replaced on a repeat', async () => {
  const { auth } = await registerDevice();
  assert.equal((await api('/api/weights', {
    method: 'PUT', headers: auth, body: JSON.stringify({ day: '2026-08-10', kg: 80.4 })
  })).status, 200);

  // Weighing again the same morning is not new evidence.
  await api('/api/weights', {
    method: 'PUT', headers: auth, body: JSON.stringify({ day: '2026-08-10', kg: 80.9 })
  });

  const { weights } = await (await api('/api/weights', { headers: auth })).json();
  assert.equal(weights.length, 1);
  assert.equal(weights[0].kg, 80.9, 'the later reading wins');
});

test('impossible weights are refused', async () => {
  const { auth } = await registerDevice();
  for (const kg of [0, -5, 900, 'heavy']) {
    const res = await api('/api/weights', {
      method: 'PUT', headers: auth, body: JSON.stringify({ day: '2026-08-10', kg })
    });
    assert.equal(res.status, 400, `should refuse ${kg}`);
  }
});

test('weights are scoped to the account', async () => {
  const a = await registerDevice();
  const b = await registerDevice();
  await api('/api/weights', { method: 'PUT', headers: a.auth, body: JSON.stringify({ day: '2026-08-11', kg: 77 }) });

  assert.equal((await (await api('/api/weights', { headers: b.auth })).json()).weights.length, 0);
  assert.equal((await api('/api/weights/2026-08-11', { method: 'DELETE', headers: b.auth })).status, 404);
  assert.equal((await api('/api/weights/2026-08-11', { method: 'DELETE', headers: a.auth })).status, 200);
});

test('the weight endpoint returns a smoothed series and a trend', async () => {
  const { auth } = await registerDevice();
  const start = Date.parse('2026-08-01T07:00:00Z');
  for (let i = 0; i < 15; i++) {
    const at = new Date(start + i * 86400000);
    await api('/api/weights', {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ day: at.toISOString().slice(0, 10), kg: 80 - i * 0.05, at: at.toISOString() })
    });
  }
  const body = await (await api('/api/weights', { headers: auth })).json();
  assert.equal(body.series.length, 15);
  assert.ok('trend' in body.series[0], 'the smoothed value rides alongside the raw one');
  assert.ok(Math.abs(body.trend.slopeKgPerWeek + 0.35) < 0.01);
});

test('expenditure falls back to the formula and reports what is missing', async () => {
  const { auth } = await registerDevice();
  await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 80, heightCm: 180, ageYears: 30, sex: 'male', activity: 'moderate' })
  });

  const out = await (await api('/api/expenditure', { headers: auth })).json();
  assert.equal(out.method, 'formula');
  assert.equal(out.kcal, Math.round(1780 * 1.55));
  assert.ok(out.missing.some((m) => m.what === 'weighings'));
});

test('expenditure becomes measured once there is enough evidence', async () => {
  const { auth } = await registerDevice();
  await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 80, heightCm: 180, ageYears: 30, sex: 'male', activity: 'moderate' })
  });

  // 2,000 kcal/day against a true 2,500 expenditure: a 500 kcal deficit, which
  // must show up as roughly 0.065 kg/day of loss.
  const slope = (2000 - 2500) / 7700;
  const now = Date.now();
  for (let i = 27; i >= 0; i--) {
    const at = new Date(now - i * 86400000);
    const day = at.toISOString().slice(0, 10);
    await api('/api/entries', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        day, portionSource: 'weighed',
        items: [{ name: 'food', grams: 500, source: 'manual', per: { calories: 4, protein: 0, fat: 0, carbs: 0 } }]
      })
    });
    await api('/api/weights', {
      method: 'PUT', headers: auth,
      body: JSON.stringify({ day, kg: 80 + slope * (27 - i), at: at.toISOString() })
    });
  }

  const out = await (await api('/api/expenditure', { headers: auth })).json();
  assert.equal(out.method, 'measured');
  assert.ok(Math.abs(out.kcal - 2500) < 60, `expected ~2500, got ${out.kcal}`);
  assert.ok(out.low < 2500 && 2500 < out.high);
  assert.ok(out.basis.coveragePct >= 75);
  // The formula is carried alongside, and disagrees -- which is the point.
  assert.ok(out.formula.kcal > 0);

  // And the day view compares against the measured figure, not the formula.
  const day = await (await api(`/api/entries?day=${new Date(now).toISOString().slice(0, 10)}`, { headers: auth })).json();
  assert.equal(day.expenditure.method, 'measured');
  assert.equal(day.summary.maintenance.kcal, out.kcal);
});
