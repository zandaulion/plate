// Verifies the v1 -> accounts migration against a database built in the old
// shape, rather than trusting that a fresh install happens to come out right.
//
// This is the one migration in the project that moves existing rows between
// tables, and the failure mode is silent: a wrong device-to-account mapping
// would show someone an empty log while their data sat in the file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plate-migrate-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';

// --- build a v1 database by hand, before importing anything that migrates it
{
  const db = new DatabaseSync(path.join(DATA_DIR, 'plate.db'));
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, label TEXT,
      created_at TEXT NOT NULL, last_seen TEXT
    );
    CREATE TABLE invites (
      code_hash TEXT PRIMARY KEY, label TEXT, created_at TEXT NOT NULL,
      redeemed_at TEXT, redeemed_by TEXT REFERENCES devices(id) ON DELETE SET NULL
    );
    CREATE TABLE profiles (
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      weight_kg REAL, height_cm REAL, age_years INTEGER, sex TEXT, activity TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      day TEXT NOT NULL, meal TEXT, created_at TEXT NOT NULL, photo_id TEXT, note TEXT,
      portion_confirmed INTEGER NOT NULL DEFAULT 0,
      items_json TEXT NOT NULL, totals_json TEXT NOT NULL
    );
  `);

  const now = '2026-08-20T10:00:00.000Z';
  for (const [id, label] of [['dev-a', 'phone'], ['dev-b', 'tablet']]) {
    db.prepare('INSERT INTO devices (id, token_hash, label, created_at, last_seen) VALUES (?,?,?,?,?)')
      .run(id, `hash-${id}`, label, now, now);
  }
  db.prepare('INSERT INTO profiles (device_id, weight_kg, height_cm, age_years, sex, activity, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('dev-a', 80, 180, 40, 'male', 'light', now);

  const items = JSON.stringify([{ name: 'rice', grams: 200, per: { calories: 1.3 }, source: 'photo' }]);
  const totals = JSON.stringify({ calories: 260, protein: 5, fat: 1, carbs: 56 });
  db.prepare('INSERT INTO entries (id, device_id, day, meal, created_at, photo_id, note, portion_confirmed, items_json, totals_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('e1', 'dev-a', '2026-08-20', 'lunch', now, 'p1.jpg', null, 1, items, totals);
  db.prepare('INSERT INTO entries (id, device_id, day, meal, created_at, photo_id, note, portion_confirmed, items_json, totals_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('e2', 'dev-b', '2026-08-20', 'dinner', now, null, null, 0, items, totals);
  db.close();
}

// Importing this runs the migration.
const { db } = await import('../server/db.js');
test.after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

test('every pre-existing device gets its own account', () => {
  const devices = db.prepare('SELECT id, account_id FROM devices ORDER BY id').all();
  assert.equal(devices.length, 2);
  for (const d of devices) assert.ok(d.account_id, `${d.id} has no account`);
  assert.notEqual(devices[0].account_id, devices[1].account_id,
    'nothing in the data says these were the same person, so they must not be merged');
});

test('entries follow their device onto the right account', () => {
  const rows = db.prepare(`
    SELECT e.id, e.account_id, e.device_id, d.account_id AS device_account
    FROM entries e LEFT JOIN devices d ON d.id = e.device_id ORDER BY e.id
  `).all();
  assert.equal(rows.length, 2, 'no entry may be lost');
  for (const r of rows) {
    assert.equal(r.account_id, r.device_account, `${r.id} landed on the wrong account`);
  }
});

test('entry contents survive intact', () => {
  const e = db.prepare('SELECT * FROM entries WHERE id = ?').get('e1');
  assert.equal(JSON.parse(e.totals_json).calories, 260);
  assert.equal(JSON.parse(e.items_json)[0].name, 'rice');
  assert.equal(e.photo_id, 'p1.jpg');
  assert.equal(e.portion_confirmed, 1);
  assert.equal(e.meal, 'lunch');
});

test('the profile moves from the device to its account', () => {
  const cols = db.prepare('PRAGMA table_info(profiles)').all().map((c) => c.name);
  assert.ok(cols.includes('account_id'));
  assert.ok(!cols.includes('device_id'));

  const owner = db.prepare('SELECT account_id FROM devices WHERE id = ?').get('dev-a');
  const p = db.prepare('SELECT * FROM profiles WHERE account_id = ?').get(owner.account_id);
  assert.equal(p.weight_kg, 80);
  assert.equal(p.sex, 'male');
});

test('revoking a device no longer destroys its history', () => {
  // The v1 schema had ON DELETE CASCADE here, which would have made revoking a
  // lost phone delete the log it wrote. This is the reason entries was rebuilt.
  const before = db.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
  db.prepare('DELETE FROM devices WHERE id = ?').run('dev-b');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries').get().n, before,
    'entries must outlive the device that wrote them');
  assert.equal(db.prepare('SELECT device_id FROM entries WHERE id = ?').get('e2').device_id, null,
    'the provenance link is cleared, not the row');
  assert.ok(db.prepare('SELECT account_id FROM entries WHERE id = ?').get('e2').account_id,
    'the entry still belongs to its account');
});

test('the migration leaves no broken references', () => {
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('running it again is a no-op', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const { default: _ } = await import('../server/db.js').then((m) => ({ default: m }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, before,
    'a second startup must not create duplicate accounts');
});
