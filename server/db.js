import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
export const PHOTO_DIR = path.join(DATA_DIR, 'photos');
// Product shots fetched from Open Food Facts, keyed by barcode and shared
// between accounts. Kept apart from photos/, which holds people's own
// pictures and is theirs to delete.
export const PRODUCT_DIR = path.join(DATA_DIR, 'products');
for (const dir of [DATA_DIR, PHOTO_DIR, PRODUCT_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export const db = new DatabaseSync(path.join(DATA_DIR, 'plate.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  -- A person. Deliberately holds no name, email, phone or password: identity
  -- is the random id and nothing else, and recovery_hash is a hash of a code
  -- the user keeps. Nothing here identifies anyone off this server.
  CREATE TABLE IF NOT EXISTS accounts (
    id              TEXT PRIMARY KEY,
    created_at      TEXT NOT NULL,
    recovery_hash   TEXT,
    recovery_set_at TEXT
  );

  CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    label       TEXT,
    created_at  TEXT NOT NULL,
    last_seen   TEXT
  );

  CREATE TABLE IF NOT EXISTS invites (
    code_hash   TEXT PRIMARY KEY,
    label       TEXT,
    created_at  TEXT NOT NULL,
    redeemed_at TEXT,
    redeemed_by TEXT REFERENCES devices(id) ON DELETE SET NULL
  );

  -- One profile per device. Height, weight, age and sex are here and nowhere
  -- else; they exist solely to compute maintenance energy and are never sent
  -- off this server.
  CREATE TABLE IF NOT EXISTS profiles (
    device_id   TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    weight_kg   REAL,
    height_cm   REAL,
    age_years   INTEGER,
    sex         TEXT,
    activity    TEXT,
    diet        TEXT NOT NULL DEFAULT 'omnivore',
    dietary_goal TEXT NOT NULL DEFAULT 'balanced',
    updated_at  TEXT NOT NULL
  );

  -- NOTE: this is the v1 shape. migrateToAccounts() below rewrites entries and
  -- profiles onto account_id and relaxes the device foreign key -- including on
  -- a fresh database, which is where the definitions actually take effect. Read
  -- that function, not this block, for the live schema.
  --
  -- The "day" column is the logging device's local calendar date, supplied by the client.
  -- Deriving it here from created_at would misfile late dinners for anyone
  -- outside UTC.
  CREATE TABLE IF NOT EXISTS entries (
    id                TEXT PRIMARY KEY,
    device_id         TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    day               TEXT NOT NULL,
    meal              TEXT,
    created_at        TEXT NOT NULL,
    photo_id          TEXT,
    note              TEXT,
    portion_confirmed INTEGER NOT NULL DEFAULT 0,
    items_json        TEXT NOT NULL,
    totals_json       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_entries_day ON entries(device_id, day);
`);

/**
 * Moves history from devices to accounts.
 *
 * The first version made the device the identity: entries and the profile hung
 * off device_id, so a second device was a second person, and losing the cookie
 * lost everything with no way back. This introduces an account above the
 * device and repoints the data at it.
 *
 * Idempotent, and safe on a populated database: each existing device becomes
 * its own account, which is the only mapping the data supports -- nothing
 * records that two devices were ever the same person, which is precisely why
 * this could not be deferred.
 */
function migrateToAccounts() {
  const deviceCols = db.prepare('PRAGMA table_info(devices)').all().map((c) => c.name);
  if (deviceCols.includes('account_id')) return false;

  // Foreign key enforcement has to be off around a table rebuild, and the
  // pragma is a no-op inside a transaction, so it is set before BEGIN.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE devices ADD COLUMN account_id TEXT REFERENCES accounts(id)');

    const now = new Date().toISOString();
    const accountOf = new Map();
    for (const device of db.prepare('SELECT id FROM devices').all()) {
      const accountId = crypto.randomUUID();
      db.prepare('INSERT INTO accounts (id, created_at) VALUES (?, ?)').run(accountId, now);
      db.prepare('UPDATE devices SET account_id = ? WHERE id = ?').run(accountId, device.id);
      accountOf.set(device.id, accountId);
    }

    // entries is rebuilt rather than extended, for two reasons. account_id has
    // to be NOT NULL and SQLite cannot add a NOT NULL column to an existing
    // table; and device_id carried ON DELETE CASCADE, which would have made
    // revoking a lost phone delete its history -- the exact thing accounts
    // exist to prevent. It becomes a nullable provenance field that survives
    // its device.
    db.exec(`
      CREATE TABLE entries_new (
        id                TEXT PRIMARY KEY,
        account_id        TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        device_id         TEXT REFERENCES devices(id) ON DELETE SET NULL,
        day               TEXT NOT NULL,
        meal              TEXT,
        created_at        TEXT NOT NULL,
        photo_id          TEXT,
        note              TEXT,
        portion_confirmed INTEGER NOT NULL DEFAULT 0,
        portion_source    TEXT,
        items_json        TEXT NOT NULL,
        totals_json       TEXT NOT NULL
      );
    `);

    for (const row of db.prepare('SELECT * FROM entries').all()) {
      const accountId = accountOf.get(row.device_id);
      if (!accountId) continue; // orphaned row; nothing can own it
      db.prepare(`
        INSERT INTO entries_new (id, account_id, device_id, day, meal, created_at, photo_id,
                                 note, portion_confirmed, portion_source, items_json, totals_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row.id, accountId, row.device_id, row.day, row.meal, row.created_at, row.photo_id,
        row.note, row.portion_confirmed, row.portion_source ?? null, row.items_json, row.totals_json);
    }

    db.exec('DROP TABLE entries');
    db.exec('ALTER TABLE entries_new RENAME TO entries');

    // profiles was keyed by device_id, and SQLite cannot repoint a primary key
    // in place. One row per device becomes one row per account, which is
    // one-to-one at this point by construction.
    db.exec(`
      CREATE TABLE profiles_new (
        account_id  TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        weight_kg   REAL,
        height_cm   REAL,
        age_years   INTEGER,
        sex         TEXT,
        activity    TEXT,
        diet        TEXT NOT NULL DEFAULT 'omnivore',
        dietary_goal TEXT NOT NULL DEFAULT 'balanced',
        updated_at  TEXT NOT NULL
      );
      INSERT OR IGNORE INTO profiles_new
        SELECT d.account_id, p.weight_kg, p.height_cm, p.age_years, p.sex, p.activity,
               'omnivore', 'balanced', p.updated_at
        FROM profiles p JOIN devices d ON d.id = p.device_id;
      DROP TABLE profiles;
      ALTER TABLE profiles_new RENAME TO profiles;
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_entries_account_day ON entries(account_id, day)');
    db.exec('COMMIT');
    console.log('migrated device-scoped data onto accounts');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
    const bad = db.prepare('PRAGMA foreign_key_check').all();
    if (bad.length) throw new Error(`account migration left ${bad.length} broken references`);
  }
}

/**
 * Adds a column that a later version introduced, if it is missing.
 * SQLite has no IF NOT EXISTS for ADD COLUMN, and an unconditional ALTER
 * would abort startup on every restart after the first.
 */
export function addColumnIfMissing(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

// Added after the follow-up measurement showed that *how* a weight was
// arrived at changes its accuracy band, which a boolean cannot express.
addColumnIfMissing('entries', 'portion_source', 'TEXT');

migrateToAccounts();

// Dietary preferences and goals for Bitey recommendations
addColumnIfMissing('profiles', 'diet', "TEXT NOT NULL DEFAULT 'omnivore'");
addColumnIfMissing('profiles', 'dietary_goal', "TEXT NOT NULL DEFAULT 'balanced'");

/**
 * Widens invites so the shared invite console can front this app.
 *
 * The console needs an id to act on, an expiry to display, a revoked flag, and
 * the invite's own URL so a message can be re-sent. It also expects the
 * plaintext code to be readable *only while the invite can still register
 * something* -- so the column exists but is cleared the moment the invite is
 * used or revoked, and verification still runs against the hash.
 *
 * That is deliberately stricter than keeping the plaintext forever: an unused
 * invite is worth one empty account to whoever reads the database, and a used
 * one is worth nothing at all.
 */
function migrateInvites() {
  const cols = db.prepare('PRAGMA table_info(invites)').all().map((c) => c.name);
  if (cols.includes('id')) return false;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE invites_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash   TEXT NOT NULL UNIQUE,
        code        TEXT,
        label       TEXT,
        url         TEXT,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        used_at     TEXT,
        revoked     INTEGER NOT NULL DEFAULT 0,
        device_id   TEXT REFERENCES devices(id) ON DELETE SET NULL
      );
    `);

    // Codes minted before this migration were never stored in plaintext, so
    // they cannot be re-sent and are given a spent expiry rather than being
    // presented as usable.
    for (const row of db.prepare('SELECT * FROM invites').all()) {
      const created = row.created_at;
      const expires = new Date(Date.parse(created) + 7 * 86400000).toISOString();
      db.prepare(`
        INSERT INTO invites_new (code_hash, code, label, url, created_at, expires_at, used_at, revoked, device_id)
        VALUES (?, NULL, ?, NULL, ?, ?, ?, 0, ?)
      `).run(row.code_hash, row.label, created, expires, row.redeemed_at, row.redeemed_by);
    }

    db.exec('DROP TABLE invites');
    db.exec('ALTER TABLE invites_new RENAME TO invites');
    db.exec('COMMIT');
    console.log('widened invites for the console');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrateInvites();

// Revoking a device is reversible now: the console offers restore, and the
// account model already means a device carries no data of its own.
addColumnIfMissing('devices', 'revoked', 'INTEGER NOT NULL DEFAULT 0');

// Off for everyone by default, and only ever turned on per account from the
// private listener. The invitation friends receive says the app tracks
// nothing; that has to stay true for them no matter what a build does.
addColumnIfMissing('accounts', 'tracking_enabled', 'INTEGER NOT NULL DEFAULT 0');

// How many times this entry's photograph has been read again. Capped, because
// a model that has twice failed to place the dish with the eater's own words
// in front of it will not place it on the third attempt either.
addColumnIfMissing('entries', 'corrections', 'INTEGER NOT NULL DEFAULT 0');

db.exec(`
  -- Interaction events, for usability testing on a consenting account.
  -- Deliberately small: a name, a few numbers, and never any food photograph
  -- or nutrition figure -- those are already in entries and do not need a
  -- second copy here.
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    session    TEXT NOT NULL,
    at         TEXT NOT NULL,
    name       TEXT NOT NULL,
    props_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_account ON events(account_id, at);
`);

db.exec(`
  -- One row per account per day, counting calls that reached the vision model.
  --
  -- Counted per account rather than per feature. Reading a photo and re-reading
  -- it after a correction cost the same, so a limit on either one alone just
  -- moves the traffic to the other door.
  CREATE TABLE IF NOT EXISTS ai_usage (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,
    calls      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, day)
  );

  -- What the model said about one photograph given one correction.
  --
  -- Keyed on the photograph and the exact words, so asking the same question
  -- twice is answered from here. That is the naive retry loop -- the same
  -- correction sent again because the answer was not liked -- and it should
  -- not cost anything the second time.
  CREATE TABLE IF NOT EXISTS analysis_cache (
    photo_id      TEXT NOT NULL,
    correction_key TEXT NOT NULL,
    result_json   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (photo_id, correction_key)
  );
`);

db.exec(`
  -- Weight readings, one per row. Kept as a series rather than overwriting
  -- profiles.weight_kg, because the trend is what the expenditure estimate
  -- consumes and a single scalar cannot express one.
  CREATE TABLE IF NOT EXISTS weights (
    id          TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    kg          REAL NOT NULL,
    measured_at TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (account_id, day)
  );
  CREATE INDEX IF NOT EXISTS idx_weights_account ON weights(account_id, day);

  -- Short-lived codes that add a second device to an existing account. Minted
  -- only from a device already signed in, so possession of a working device is
  -- the authority for adding another.
  CREATE TABLE IF NOT EXISTS device_links (
    code_hash   TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
  );
`);

export const nowIso = () => new Date().toISOString();
