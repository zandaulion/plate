import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
export const PHOTO_DIR = path.join(DATA_DIR, 'photos');
for (const dir of [DATA_DIR, PHOTO_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export const db = new DatabaseSync(path.join(DATA_DIR, 'plate.db'));

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
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
    updated_at  TEXT NOT NULL
  );

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

export const nowIso = () => new Date().toISOString();
