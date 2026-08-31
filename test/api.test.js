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
  const { code } = createInvite('test');
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
  const { code } = createInvite();
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
  const { code } = createInvite();

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

  // The day reads newest first, so the cases come back in reverse. This test
  // is about what was stored, not about the order, hence the reversal here
  // rather than a sort that would hide a genuine ordering change.
  const day = await (await api('/api/entries?day=2026-08-20', { headers: auth })).json();
  assert.deepEqual(day.entries.map((e) => e.portionSource), cases.map((c) => c[1]).reverse());
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
  const { code } = createInvite();
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
  const { code } = createInvite();
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
  const { code } = createInvite();
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

// ------------------------------------------- the shared invite console

test('a created invite carries what the console needs to send it', async () => {
  const inv = createInvite('for the console');
  assert.ok(inv.id, 'an id to act on');
  assert.ok(inv.code, 'the plaintext, once');
  assert.ok(inv.expires_at, 'an expiry to display');
  assert.equal(inv.expires_in_days, 7);
});

test('the invite listing exposes the plaintext only while it can still be used', async () => {
  const inv = createInvite('pending');
  let listed = (await (await api('/api/admin/invites', { headers: { 'X-Admin': '1' } })).json());
  assert.equal(listed.ttl_days, 7);

  let row = listed.invites.find((i) => i.id === inv.id);
  assert.equal(row.code, inv.code, 'an unused invite can be re-sent');
  assert.equal(row.used_at, null);

  await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code: inv.code }) });

  listed = await (await api('/api/admin/invites', { headers: { 'X-Admin': '1' } })).json();
  row = listed.invites.find((i) => i.id === inv.id);
  assert.ok(row.used_at, 'now marked used');
  assert.equal(row.code, null, 'and the plaintext is gone from the response');
  assert.ok(row.device_id, 'with the device it registered');
});

test('a spent invite leaves no plaintext in the database either', async () => {
  const { db } = await import('../server/db.js');
  const inv = createInvite('spent');
  await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code: inv.code }) });

  // Not merely hidden by the API: cleared at the source.
  const row = db.prepare('SELECT code, url FROM invites WHERE id = ?').get(inv.id);
  assert.equal(row.code, null);
  assert.equal(row.url, null);
});

test('an invite can be cancelled before use, and then refuses to register', async () => {
  const inv = createInvite('cancel me');
  assert.equal((await api(`/api/admin/invites/${inv.id}/revoke`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: '{}'
  })).status, 200);

  assert.equal((await api('/api/auth/redeem', {
    method: 'POST', body: JSON.stringify({ code: inv.code })
  })).status, 400, 'a cancelled code must not work');
});

test('a used invite cannot be cancelled, and says why', async () => {
  const inv = createInvite('used');
  await api('/api/auth/redeem', { method: 'POST', body: JSON.stringify({ code: inv.code }) });

  const res = await api(`/api/admin/invites/${inv.id}/revoke`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: '{}'
  });
  assert.equal(res.status, 404);
  assert.ok((await res.json()).detail, 'the console shows detail on failure');
});

test('an expired invite refuses to register', async () => {
  const { db } = await import('../server/db.js');
  const inv = createInvite('stale');
  db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), inv.id);

  assert.equal((await api('/api/auth/redeem', {
    method: 'POST', body: JSON.stringify({ code: inv.code })
  })).status, 400);
});

test('revoking a device locks it out and can be undone', async () => {
  const { auth } = await registerDevice();
  const { devices } = await (await api('/api/admin/devices', { headers: { 'X-Admin': '1' } })).json();
  const me = devices[0];
  assert.equal(me.revoked, false);

  await api(`/api/admin/devices/${me.id}/revoke`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ revoked: true })
  });
  assert.equal((await api('/api/me', { headers: auth })).status, 401, 'revoked devices cannot authenticate');

  // Reversible, which a delete would not have been.
  await api(`/api/admin/devices/${me.id}/revoke`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ revoked: false })
  });
  assert.equal((await api('/api/me', { headers: auth })).status, 200, 'restore brings it back');
});

test('a device can be renamed from the console', async () => {
  await registerDevice();
  const { devices } = await (await api('/api/admin/devices', { headers: { 'X-Admin': '1' } })).json();
  const id = devices[0].id;

  assert.equal((await api(`/api/admin/devices/${id}/label`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ label: "Ana's phone" })
  })).status, 200);

  const after = await (await api('/api/admin/devices', { headers: { 'X-Admin': '1' } })).json();
  assert.equal(after.devices.find((d) => d.id === id).label, "Ana's phone");

  assert.equal((await api(`/api/admin/devices/${id}/label`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ label: '' })
  })).status, 400);
});

test('a revoked device is hidden from the account that owns it', async () => {
  const { auth } = await registerDevice();
  const second = await linkNewDevice(auth, 'spare');
  const all = await (await api('/api/admin/devices', { headers: { 'X-Admin': '1' } })).json();
  const spare = all.devices.find((d) => d.label === 'spare');

  await api(`/api/admin/devices/${spare.id}/revoke`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ revoked: true })
  });

  const mine = await (await api('/api/devices', { headers: auth })).json();
  assert.ok(!mine.devices.some((d) => d.id === spare.id), 'the owner should not see a dead device');
});

test('the day payload carries what the weigh-in row needs', async () => {
  const { auth } = await registerDevice();
  const today = new Date().toISOString().slice(0, 10);

  let day = await (await api(`/api/entries?day=${today}`, { headers: auth })).json();
  assert.equal(day.weight.today, null, 'nothing logged yet');
  assert.equal(day.weight.last, null, 'and nothing to pre-fill from');

  // A reading from an earlier day is what the row should offer as a default.
  const earlier = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  await api('/api/weights', { method: 'PUT', headers: auth, body: JSON.stringify({ day: earlier, kg: 78.4 }) });

  day = await (await api(`/api/entries?day=${today}`, { headers: auth })).json();
  assert.equal(day.weight.today, null, 'still nothing for today');
  assert.equal(day.weight.last, 78.4, 'so the row pre-fills from the most recent');

  await api('/api/weights', { method: 'PUT', headers: auth, body: JSON.stringify({ day: today, kg: 78.6 }) });
  day = await (await api(`/api/entries?day=${today}`, { headers: auth })).json();
  assert.equal(day.weight.today, 78.6, 'once logged the row reports instead of asking');
});

test('a past day reports its own weight, not the latest', async () => {
  const { auth } = await registerDevice();
  for (const [day, kg] of [['2026-08-04', 80], ['2026-08-05', 79.5]]) {
    await api('/api/weights', { method: 'PUT', headers: auth, body: JSON.stringify({ day, kg }) });
  }
  const day = await (await api('/api/entries?day=2026-08-04', { headers: auth })).json();
  assert.equal(day.weight.today, 80, 'the row must reflect the day being viewed');
});

test('the formula uses the latest weight reading, not the one typed at signup', async () => {
  const { auth } = await registerDevice();
  await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 90, heightCm: 180, ageYears: 30, sex: 'male', activity: 'moderate' })
  });
  const before = (await (await api('/api/me', { headers: auth })).json()).maintenance.kcal;
  assert.equal(before, Math.round((10 * 90 + 6.25 * 180 - 5 * 30 + 5) * 1.55));

  // Four kilos lighter, on the scale. The stored profile still says 90.
  await api('/api/weights', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ day: new Date().toISOString().slice(0, 10), kg: 86 })
  });

  const me = await (await api('/api/me', { headers: auth })).json();
  assert.equal(me.profile.weightKg, 90, 'the stated value is left alone');
  assert.equal(me.maintenance.kcal, Math.round((10 * 86 + 6.25 * 180 - 5 * 30 + 5) * 1.55),
    'but the maths uses what the scale said');
});

test('expenditure reports which profile details are still missing', async () => {
  const { auth } = await registerDevice();
  let exp = await (await api('/api/expenditure', { headers: auth })).json();
  assert.deepEqual(exp.profileMissing.map((f) => f.id),
    ['weightKg', 'heightCm', 'ageYears', 'activity']);
  assert.equal(exp.available, false);

  await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 80, heightCm: 180, ageYears: 30, activity: 'light' })
  });
  exp = await (await api('/api/expenditure', { headers: auth })).json();
  assert.deepEqual(exp.profileMissing, [], 'sex is not required');
  assert.equal(exp.available, true);
});

test('a missed day pre-fills from the reading before it, not the latest', async () => {
  const { auth } = await registerDevice();
  const put = (day, kg) => api('/api/weights', { method: 'PUT', headers: auth, body: JSON.stringify({ day, kg }) });

  await put('2026-07-06', 80);   // Monday
  await put('2026-07-10', 78);   // Friday

  // Filling in the missed Tuesday should start from Monday's 80, not Friday's
  // 78 -- the later reading is evidence about a day that had not happened yet.
  const tue = await (await api('/api/entries?day=2026-07-07', { headers: auth })).json();
  assert.equal(tue.weight.today, null);
  assert.equal(tue.weight.last, 80);

  const sat = await (await api('/api/entries?day=2026-07-11', { headers: auth })).json();
  assert.equal(sat.weight.last, 78, 'after the last reading, the last reading is nearest');
});

test('a day before any reading falls back to the earliest one', async () => {
  const { auth } = await registerDevice();
  await api('/api/weights', { method: 'PUT', headers: auth, body: JSON.stringify({ day: '2026-07-20', kg: 75 }) });
  const earlier = await (await api('/api/entries?day=2026-07-15', { headers: auth })).json();
  assert.equal(earlier.weight.last, 75);
});

// ------------------------------------------------------------------ history

test('history returns a dense series, gaps included', async () => {
  const { auth } = await registerDevice();
  const dayKey = (back) => new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

  // Two logged days three days apart, so the gap between them is real.
  for (const back of [5, 2]) {
    await api('/api/entries', {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        day: dayKey(back),
        items: [{ name: 'x', grams: 500, per: { calories: 4, protein: 0.05, fat: 0.03, carbs: 0.1 } }]
      })
    });
  }
  await api('/api/weights', { method: 'PUT', headers: auth, body: JSON.stringify({ day: dayKey(5), kg: 80 }) });

  const h = await (await api('/api/history?days=7', { headers: auth })).json();
  assert.equal(h.days.length, 7, 'every day in the range appears');

  // A chart drawn only from days with data would show these as adjacent.
  const logged = h.days.filter((d) => d.calories !== null);
  assert.equal(logged.length, 2);
  assert.equal(h.days.filter((d) => d.calories === null).length, 5);

  const first = h.days.find((d) => d.day === dayKey(5));
  assert.equal(first.calories, 2000);
  assert.equal(first.protein, 25);
  assert.equal(first.weight, 80);
  assert.equal(h.days.find((d) => d.day === dayKey(4)).weight, null);
});

test('history clamps the range rather than trusting the query', async () => {
  const { auth } = await registerDevice();
  for (const [q, expected] of [['1', 7], ['999', 180], ['nonsense', 30], ['', 30]]) {
    const h = await (await api(`/api/history?days=${q}`, { headers: auth })).json();
    assert.equal(h.days.length, expected, `days=${q}`);
  }
});

test('history is scoped to the account', async () => {
  const a = await registerDevice();
  const b = await registerDevice();
  await api('/api/entries', {
    method: 'POST', headers: a.auth,
    body: JSON.stringify({
      day: new Date().toISOString().slice(0, 10),
      items: [{ name: 'x', grams: 100, per: { calories: 1, protein: 0, fat: 0, carbs: 0 } }]
    })
  });
  const theirs = await (await api('/api/history?days=7', { headers: b.auth })).json();
  assert.ok(theirs.days.every((d) => d.calories === null));
});

test('saving the profile without a weight leaves the stored one alone', async () => {
  const { auth } = await registerDevice();
  await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 88, heightCm: 180, ageYears: 30, sex: 'male', activity: 'light' })
  });

  // What the form now sends: no weightKg at all.
  const res = await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ heightCm: 179, ageYears: 46, sex: 'male', activity: 'sedentary' })
  });
  assert.equal(res.status, 200);

  const me = await (await api('/api/me', { headers: auth })).json();
  assert.equal(me.profile.weightKg, 88, 'an absent field must not wipe the value');
  assert.equal(me.profile.heightCm, 179);
  assert.equal(me.profile.ageYears, 46);
});

test('an explicit null still clears a field', async () => {
  const { auth } = await registerDevice();
  await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 88, heightCm: 180, ageYears: 30, activity: 'light' })
  });
  await api('/api/profile', { method: 'PUT', headers: auth, body: JSON.stringify({ ageYears: null }) });

  const me = await (await api('/api/me', { headers: auth })).json();
  assert.equal(me.profile.ageYears, null, 'null means clear');
  assert.equal(me.profile.weightKg, 88, 'and only that field');
});

test('the profile reports which weight its estimate used', async () => {
  const { auth } = await registerDevice();
  await api('/api/profile', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ weightKg: 82.7, heightCm: 179, ageYears: 46, sex: 'male', activity: 'sedentary' })
  });

  let me = await (await api('/api/me', { headers: auth })).json();
  assert.equal(me.weightUsedKg, 82.7, 'the stored value, while there is no reading');

  await api('/api/weights', {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ day: new Date().toISOString().slice(0, 10), kg: 83 })
  });

  me = await (await api('/api/me', { headers: auth })).json();
  assert.equal(me.weightUsedKg, 83, 'the weigh-in, once there is one');
  assert.equal(me.maintenance.kcal, Math.round((10 * 83 + 6.25 * 179 - 5 * 46 + 5) * 1.2),
    'and the figure agrees with what it says it used');
});

// -------------------------------------------------------- product images

test('a scanned product without a cached image is still saveable', async () => {
  const { auth } = await registerDevice();
  const created = await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-07-01',
      items: [{ name: 'Yoghurt', grams: 150, barcode: '0000000000000',
                per: { calories: 0.6, protein: 0.05, fat: 0.02, carbs: 0.07 } }]
    })
  });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).photoId, null, 'no picture, and that is fine');
});

test('a barcode entry adopts the cached product shot as its own photo', async () => {
  const { auth } = await registerDevice();
  const { PRODUCT_DIR } = await import('../server/db.js');
  const barcode = '1234567890123';
  // Stand in for what lookupBarcode would have fetched.
  fs.writeFileSync(path.join(PRODUCT_DIR, `${barcode}.jpg`), Buffer.alloc(600, 0xAB));

  const created = await (await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-07-02',
      items: [{ name: 'Nutella', grams: 30, barcode,
                per: { calories: 5.39, protein: 0.063, fat: 0.309, carbs: 0.575 } }]
    })
  })).json();

  assert.ok(created.photoId, 'the entry gets a picture');
  const day = await (await api('/api/entries?day=2026-07-02', { headers: auth })).json();
  assert.equal(day.entries[0].photoId, created.photoId);

  // Served through the ordinary authenticated photo route, like any other.
  assert.equal((await api(`/api/photo/${created.photoId}`, { headers: auth })).status, 200);
});

test('the copy is the entry’s own, so deleting it leaves the product image alone', async () => {
  const { auth } = await registerDevice();
  const { PRODUCT_DIR } = await import('../server/db.js');
  const barcode = '4444444444444';
  const source = path.join(PRODUCT_DIR, `${barcode}.jpg`);
  fs.writeFileSync(source, Buffer.alloc(600, 0xCD));

  const item = { name: 'Thing', grams: 50, barcode, per: { calories: 2, protein: 0, fat: 0, carbs: 0 } };
  const a = await (await api('/api/entries', { method: 'POST', headers: auth,
    body: JSON.stringify({ day: '2026-07-03', items: [item] }) })).json();
  const b = await (await api('/api/entries', { method: 'POST', headers: auth,
    body: JSON.stringify({ day: '2026-07-04', items: [item] }) })).json();

  assert.notEqual(a.photoId, b.photoId, 'each entry gets its own copy, not a shared file');

  await api(`/api/entries/${a.id}`, { method: 'DELETE', headers: auth });
  assert.ok(fs.existsSync(source), 'the cached product image survives');
  assert.equal((await api(`/api/photo/${b.photoId}`, { headers: auth })).status, 200,
    'and the other entry still has its picture');
});

test('a camera photo always beats the product shot', async () => {
  const { auth } = await registerDevice();
  const { PRODUCT_DIR } = await import('../server/db.js');
  const barcode = '5555555555555';
  fs.writeFileSync(path.join(PRODUCT_DIR, `${barcode}.jpg`), Buffer.alloc(600, 0x01));

  const created = await (await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-07-05', image: Buffer.alloc(400, 0x89).toString('base64'), mimeType: 'image/jpeg',
      items: [{ name: 'Thing', grams: 50, barcode, per: { calories: 2, protein: 0, fat: 0, carbs: 0 } }]
    })
  })).json();

  assert.ok(created.photoId.endsWith('.jpg'));
  const bytes = fs.readFileSync(path.join(process.env.DATA_DIR, 'photos', created.photoId));
  assert.equal(bytes.length, 400, 'the uploaded photo was kept, not the product shot');
});

test('the product image route needs auth and 404s for an unknown barcode', async () => {
  const { auth } = await registerDevice();
  assert.equal((await api('/api/foods/image/1234567890123')).status, 401);
  assert.equal((await api('/api/foods/image/9999999999999', { headers: auth })).status, 404);
});

test('recents carry the barcode, so a repeat scan keeps its picture', async () => {
  const { auth } = await registerDevice();
  const barcode = '7777777777777';
  await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: new Date().toISOString().slice(0, 10),
      items: [{ name: 'Oat drink', grams: 200, barcode,
                per: { calories: 0.45, protein: 0.01, fat: 0.015, carbs: 0.066 } }]
    })
  });
  const { recent } = await (await api('/api/foods/recent', { headers: auth })).json();
  assert.equal(recent.find((f) => f.name === 'Oat drink').barcode, barcode);
});

test('a cached barcode is refreshed once it goes stale', async () => {
  const { db } = await import('../server/db.js');
  const { lookupBarcode } = await import('../server/foods.js');

  // Seed the cache directly with an old row and no network involved.
  const barcode = '8888888888888';
  db.prepare(`
    INSERT INTO food_cache (id, barcode, name, source, per100_json, serving_g, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(`off:${barcode}`, barcode, 'Old recipe', 'openfoodfacts',
    JSON.stringify({ calories: 100, protein: 1, fat: 1, carbs: 1 }), null,
    new Date(Date.now() - 5 * 86400000).toISOString());

  const fresh = await lookupBarcode(barcode);
  assert.equal(fresh.name, 'Old recipe');
  assert.equal(fresh.cached, true);
  assert.ok(!fresh.stale, 'five days old is still fresh');

  // Age it past the window. The refresh will fail (no such product), and the
  // stale answer must survive that rather than becoming an error.
  db.prepare('UPDATE food_cache SET fetched_at = ? WHERE barcode = ?')
    .run(new Date(Date.now() - 200 * 86400000).toISOString(), barcode);

  const stale = await lookupBarcode(barcode);
  assert.equal(stale.name, 'Old recipe', 'the known answer is still returned');
  assert.equal(stale.refreshFailed, true, 'and it says the refresh did not land');
});

test('an unknown barcode says so, rather than reporting an upstream failure', async () => {
  const { auth } = await registerDevice();
  const res = await api('/api/foods/barcode/8888888888887', { headers: auth });
  // Open Food Facts answers 404 for a code it does not know. That is a normal
  // outcome of scanning something obscure, not a fault, and the message a
  // person sees in a shop should say which.
  assert.equal(res.status, 404, `got ${res.status}`);
  const body = await res.json();
  assert.equal(body.error, 'not_found');
  assert.match(body.message, /not in the database/i);
});

// ------------------------------------------------- bundled generic search

test('generic search works with no network and no key', async () => {
  const { auth } = await registerDevice();
  // Open Food Facts may or may not answer during a test run; the bundled
  // table is what has to be there, so the assertions are about its results.
  const res = await api('/api/foods/search?q=banana', { headers: auth });
  assert.equal(res.status, 200);

  const { results, genericSearch } = await res.json();
  assert.equal(genericSearch, true, 'the table loaded');
  assert.ok(results.length, 'and returned something');

  const top = results[0];
  assert.match(top.name, /banana/i);
  assert.equal(top.source, 'usda');
  // The fruit, not a banana-flavoured product.
  assert.ok(top.per100.calories > 60 && top.per100.calories < 130,
    `expected fruit-like energy, got ${top.per100.calories}`);
});

test('word order does not matter, because USDA writes names backwards', async () => {
  const { auth } = await registerDevice();
  const { results } = await (await api('/api/foods/search?q=olive%20oil', { headers: auth })).json();
  // "Oil, olive, salad or cooking" only matches if the words are looked for
  // independently rather than as a phrase.
  assert.ok(results.some((r) => /oil, olive/i.test(r.name)), 'found the oil');
});

test('every bundled food is physically possible', async () => {
  const { isPlausible } = await import('../core/foods.js');
  const { auth } = await registerDevice();
  for (const q of ['cheese', 'rice', 'chicken', 'oil']) {
    const { results } = await (await api(`/api/foods/search?q=${q}`, { headers: auth })).json();
    for (const r of results.filter((x) => x.source === 'usda')) {
      assert.ok(isPlausible(r.per100), `${r.name}: ${JSON.stringify(r.per100)}`);
    }
  }
});

test('a query that matches nothing returns an empty list, not an error', async () => {
  const { auth } = await registerDevice();
  const res = await api('/api/foods/search?q=zzzzqqqx', { headers: auth });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).results, []);
});

// ------------------------------------------------------ interaction events

test('events are refused unless the account has been switched on', async () => {
  const { auth } = await registerDevice();
  const send = () => api('/api/events', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ events: [{ name: 'entry_start', at: new Date().toISOString(), session: 's1' }] })
  });

  // Default is off, and the refusal is silent -- a client that keeps trying
  // does not deserve an error, it deserves to be ignored.
  assert.equal((await send()).status, 204);

  const { accountId } = await (await api('/api/me', { headers: auth })).json();
  await api(`/api/admin/accounts/${accountId}/tracking`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ enabled: true })
  });

  const on = await send();
  assert.equal(on.status, 200);
  assert.equal((await on.json()).stored, 1);
});

test('one account being tracked does not track another', async () => {
  const tracked = await registerDevice();
  const other = await registerDevice();
  const { accountId } = await (await api('/api/me', { headers: tracked.auth })).json();
  await api(`/api/admin/accounts/${accountId}/tracking`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ enabled: true })
  });

  const body = JSON.stringify({ events: [{ name: 'day_nav', at: new Date().toISOString(), session: 's' }] });
  assert.equal((await api('/api/events', { method: 'POST', headers: tracked.auth, body })).status, 200);
  assert.equal((await api('/api/events', { method: 'POST', headers: other.auth, body })).status, 204,
    'the friend who was told the app tracks nothing is not tracked');

  const theirs = await (await api('/api/me', { headers: other.auth })).json();
  assert.equal(theirs.trackingEnabled, false);
});

test('turning tracking off deletes what was already collected', async () => {
  const { db } = await import('../server/db.js');
  const { auth } = await registerDevice();
  const { accountId } = await (await api('/api/me', { headers: auth })).json();
  const toggle = (enabled) => api(`/api/admin/accounts/${accountId}/tracking`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ enabled })
  });

  await toggle(true);
  await api('/api/events', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ events: [{ name: 'trends_open', at: new Date().toISOString(), session: 's' }] })
  });
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM events WHERE account_id = ?').get(accountId).n > 0);

  await toggle(false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE account_id = ?').get(accountId).n, 0,
    'switching off is not just a flag; the log goes too');
});

test('usage says plainly when there is no interaction data', async () => {
  const { auth } = await registerDevice();
  const u = await (await api('/api/usage', { headers: auth })).json();
  assert.equal(u.interaction.tracking, false);
  assert.ok(u.logging, 'the derived half is there regardless');
});

test('usage reports the funnels once events exist', async () => {
  const { auth } = await registerDevice();
  const { accountId } = await (await api('/api/me', { headers: auth })).json();
  await api(`/api/admin/accounts/${accountId}/tracking`, {
    method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ enabled: true })
  });

  const now = new Date().toISOString();
  await api('/api/events', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ events: [
      { name: 'entry_start', at: now, session: 's1' },
      { name: 'entry_start', at: now, session: 's1' },
      { name: 'entry_saved', at: now, session: 's1' },
      { name: 'entry_abandoned', at: now, session: 's1' },
      { name: 'screen_close', at: now, session: 's1', props: { screen: 'review', seconds: 42 } }
    ] })
  });

  const u = await (await api('/api/usage', { headers: auth })).json();
  assert.equal(u.interaction.tracking, true);
  assert.equal(u.interaction.completion.started, 2);
  assert.equal(u.interaction.completion.completedPct, 50);
  assert.equal(u.interaction.screenSeconds.review, 42);
});

test('events are scoped to the account, like everything else', async () => {
  const { db } = await import('../server/db.js');
  const a = await registerDevice();
  const b = await registerDevice();
  for (const who of [a, b]) {
    const { accountId } = await (await api('/api/me', { headers: who.auth })).json();
    await api(`/api/admin/accounts/${accountId}/tracking`, {
      method: 'POST', headers: { 'X-Admin': '1' }, body: JSON.stringify({ enabled: true })
    });
    await api('/api/events', {
      method: 'POST', headers: who.auth,
      body: JSON.stringify({ events: [{ name: 'day_nav', at: new Date().toISOString(), session: 'x' }] })
    });
  }
  const ids = db.prepare('SELECT DISTINCT account_id FROM events').all();
  assert.ok(ids.length >= 2);

  const ua = await (await api('/api/usage', { headers: a.auth })).json();
  assert.equal(ua.interaction.events, 1, 'each account sees only its own');
});

// --------------------------------------------------- correcting after the fact

/** An entry with a photograph and photo-read numbers, as the camera path makes. */
async function loggedFromPhoto(auth) {
  const png = Buffer.alloc(400, 0x89).toString('base64');
  const res = await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-08-14', meal: 'lunch', image: png, mimeType: 'image/png',
      items: [{ name: 'chicken shawarma', grams: 300, source: 'photo',
                per: { calories: 2.1, protein: 0.14, fat: 0.09, carbs: 0.18 } }]
    })
  });
  return (await res.json()).id;
}

test('a saved photo entry can be read again without re-uploading the picture', async () => {
  const { auth } = await registerDevice();
  const id = await loggedFromPhoto(auth);

  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const res = await api(`/api/entries/${id}/reanalyse`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ correction: "it's vegetarian, not chicken" })
  });
  if (saved) process.env.GEMINI_API_KEY = saved;

  // Reaching the model at all is the point: it got past every ownership and
  // eligibility check on the strength of the entry id alone, with no image in
  // the request. Only the missing key stopped it.
  assert.equal(res.status, 503, 'the request was accepted and only the key was missing');
  assert.equal((await res.json()).error, 'not_configured');
});

test('a barcode entry is not re-read, so scanned facts are not replaced by a guess', async () => {
  const { auth } = await registerDevice();
  const png = Buffer.alloc(400, 0x89).toString('base64');
  const id = (await (await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-08-14', image: png, mimeType: 'image/png',
      items: [{ name: 'yoghurt', grams: 150, source: 'manual', barcode: '5000112637922',
                per: { calories: 0.6, protein: 0.04, fat: 0.03, carbs: 0.05 } }]
    })
  })).json()).id;

  const res = await api(`/api/entries/${id}/reanalyse`, {
    method: 'POST', headers: auth, body: JSON.stringify({ correction: 'something else' })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'not_photo_based');
});

test('an entry logged without a photo has nothing to read again', async () => {
  const { auth } = await registerDevice();
  const id = (await (await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-08-14',
      items: [{ name: 'porridge', grams: 250, source: 'photo',
                per: { calories: 0.71, protein: 0.025, fat: 0.014, carbs: 0.12 } }]
    })
  })).json()).id;

  const res = await api(`/api/entries/${id}/reanalyse`, {
    method: 'POST', headers: auth, body: JSON.stringify({ correction: 'x' })
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'no_photo');
});

test('one account cannot re-read another account\'s photograph', async () => {
  const mine = await registerDevice();
  const theirs = await registerDevice();
  const id = await loggedFromPhoto(mine.auth);

  const res = await api(`/api/entries/${id}/reanalyse`, {
    method: 'POST', headers: theirs.auth, body: JSON.stringify({ correction: 'x' })
  });
  assert.equal(res.status, 404, 'not even told the entry exists');
});

test('a day reads newest first, so the meal just logged is at the top', async () => {
  const { auth } = await registerDevice();
  const item = { name: 'stew', grams: 100, per: { calories: 1, protein: 0.05, fat: 0.04, carbs: 0.1 }, source: 'photo' };

  for (const meal of ['breakfast', 'lunch', 'dinner']) {
    await api('/api/entries', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ day: '2026-08-21', meal, items: [item] })
    });
  }

  const day = await (await api('/api/entries?day=2026-08-21', { headers: auth })).json();
  assert.deepEqual(day.entries.map((e) => e.meal), ['dinner', 'lunch', 'breakfast']);
});

test('the export still reads forward in time, whatever the day view does', async () => {
  const { auth } = await registerDevice();
  const item = { name: 'stew', grams: 100, per: { calories: 1, protein: 0.05, fat: 0.04, carbs: 0.1 }, source: 'photo' };

  for (const meal of ['breakfast', 'lunch', 'dinner']) {
    await api('/api/entries', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ day: '2026-08-22', meal, items: [item] })
    });
  }

  // An export is read start to finish rather than scanned, so it keeps the
  // order the meals happened in.
  const dump = await (await api('/api/export.json', { headers: auth })).json();
  assert.deepEqual(dump.entries.map((e) => e.meal), ['breakfast', 'lunch', 'dinner']);
});

// ------------------------------------------------------- what a day may cost

test('the daily allowance is counted per account, not per feature', async () => {
  const { db } = await import('../server/db.js');
  const { charge, refund, usedToday, DAILY_LIMIT, BudgetError } = await import('../server/budget.js');
  const { auth } = await registerDevice();
  const id = db.prepare('SELECT account_id FROM devices LIMIT 1').get().account_id;

  for (let i = 0; i < DAILY_LIMIT; i++) charge(id);
  assert.equal(usedToday(id), DAILY_LIMIT);

  // The next one is refused rather than quietly allowed.
  assert.throws(() => charge(id), (err) =>
    err instanceof BudgetError && err.status === 429 && err.code === 'daily_limit');

  // And a call that never reached the model gives its place back.
  refund(id);
  assert.equal(usedToday(id), DAILY_LIMIT - 1);
  assert.equal(charge(id), DAILY_LIMIT, 'the returned place can be used');
  assert.ok(auth);
});

test('one account spending its allowance does not touch another', async () => {
  const { charge, usedToday, DAILY_LIMIT } = await import('../server/budget.js');
  const { db } = await import('../server/db.js');
  await registerDevice();
  const a = db.prepare('SELECT account_id FROM devices ORDER BY rowid DESC LIMIT 1').get().account_id;
  await registerDevice();
  const b = db.prepare('SELECT account_id FROM devices ORDER BY rowid DESC LIMIT 1').get().account_id;

  for (let i = 0; i < DAILY_LIMIT; i++) charge(a);
  assert.equal(usedToday(b), 0);
  assert.equal(charge(b), 1, 'a full neighbour is not a reason to refuse');
});

test('the same correction on the same photo is answered without asking again', async () => {
  const { cachedAnalysis, cacheAnalysis, forgetPhoto } = await import('../server/budget.js');
  const answer = { estimate: { items: [{ name: 'falafel wrap' }] }, totals: { calories: 500 } };

  cacheAnalysis('p1.jpg', 'It is  VEGETARIAN ', answer);
  // Case and spacing do not change the question, so they must not miss.
  assert.deepEqual(cachedAnalysis('p1.jpg', 'it is vegetarian'), answer);
  assert.equal(cachedAnalysis('p1.jpg', 'it is chicken'), null, 'different words, different question');
  assert.equal(cachedAnalysis('p2.jpg', 'it is vegetarian'), null, 'different photo, different question');

  // A deleted meal takes what the model said about it.
  forgetPhoto('p1.jpg');
  assert.equal(cachedAnalysis('p1.jpg', 'it is vegetarian'), null);
});

test('a photo cannot be read again beyond the cap', async () => {
  const { db } = await import('../server/db.js');
  const { MAX_CORRECTIONS } = await import('../server/budget.js');
  const { auth } = await registerDevice();
  const png = Buffer.alloc(400, 0x89).toString('base64');
  const id = (await (await api('/api/entries', {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      day: '2026-08-23', image: png, mimeType: 'image/png',
      items: [{ name: 'shawarma', grams: 300, source: 'photo',
                per: { calories: 2, protein: .1, fat: .08, carbs: .2 } }]
    })
  })).json()).id;

  db.prepare('UPDATE entries SET corrections = ? WHERE id = ?').run(MAX_CORRECTIONS, id);

  const res = await api(`/api/entries/${id}/reanalyse`, {
    method: 'POST', headers: auth, body: JSON.stringify({ correction: 'a third go' })
  });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, 'corrections_exhausted');

  // The count travels with the entry, so the app can withdraw the offer.
  const day = await (await api('/api/entries?day=2026-08-23', { headers: auth })).json();
  assert.equal(day.entries[0].corrections, MAX_CORRECTIONS);
});
