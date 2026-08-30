import crypto from 'node:crypto';
import { db, nowIso } from './db.js';

export const COOKIE_NAME = 'plate_token';

// Tokens and invite codes are stored as SHA-256 hashes. A stolen database
// then yields nothing usable: there is no reversible secret at rest, and the
// admin listing can still identify a device by id and label.
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/** Unambiguous alphabet: no O/0, no I/1/l. Invite codes get read aloud. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/**
 * Crude global throttle on code redemption.
 *
 * Invite, link and recovery codes are the only credentials in the system, so
 * they are the only thing worth guessing. The codes are long enough that
 * enumeration is impractical -- a 12-character recovery code from a 31-symbol
 * alphabet is about 59 bits -- but a throttle costs nothing and turns a
 * distributed guessing attempt into an obvious failure rather than a quiet
 * one. It is global rather than per-IP on purpose: the reverse proxy
 * deliberately does not pass a client address through, so there is no
 * per-client key to throttle on and none should be introduced for this.
 */
const failures = [];
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 20;

function tooManyFailures() {
  const cutoff = Date.now() - FAIL_WINDOW_MS;
  while (failures.length && failures[0] < cutoff) failures.shift();
  return failures.length >= FAIL_LIMIT;
}

function recordFailure() {
  failures.push(Date.now());
}

export class ThrottledError extends Error {
  constructor() {
    super('Too many attempts. Wait a few minutes and try again.');
    this.code = 'throttled';
    this.status = 429;
  }
}

export function createInvite(label = null) {
  const code = randomCode();
  db.prepare('INSERT INTO invites (code_hash, label, created_at) VALUES (?, ?, ?)')
    .run(hash(code.replace(/-/g, '')), label, nowIso());
  // The only moment the plaintext exists. It is never stored.
  return code;
}

export function listInvites() {
  return db.prepare(`
    SELECT i.code_hash, i.label, i.created_at, i.redeemed_at, i.redeemed_by, d.label AS device_label
    FROM invites i LEFT JOIN devices d ON d.id = i.redeemed_by
    ORDER BY i.created_at DESC
  `).all();
}

const normaliseCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Creates a device row and returns its plaintext token. Caller owns the transaction. */
function insertDevice(accountId, label) {
  const deviceId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare(`
    INSERT INTO devices (id, account_id, token_hash, label, created_at, last_seen)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(deviceId, accountId, hash(token), label, nowIso(), nowIso());
  return { deviceId, token };
}

/**
 * Exchanges an invite code for a new account and its first device.
 *
 * Everything is written inside one transaction: invites.redeemed_by is a
 * foreign key onto devices, so the device must exist before the claim, and if
 * the claim then finds the code already used the speculative account and
 * device are rolled back rather than left orphaned. The UPDATE is guarded on
 * redeemed_at IS NULL so two requests racing on one code cannot both win.
 */
export function redeemInvite(code, label = null) {
  const normalised = normaliseCode(code);
  if (!normalised) return null;
  if (tooManyFailures()) throw new ThrottledError();

  const codeHash = hash(normalised);
  const accountId = crypto.randomUUID();
  const recoveryCode = randomCode(12);

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO accounts (id, created_at, recovery_hash, recovery_set_at) VALUES (?, ?, ?, ?)')
      .run(accountId, nowIso(), hash(normaliseCode(recoveryCode)), nowIso());

    const { deviceId, token } = insertDevice(accountId, label);

    const claimed = db.prepare(
      'UPDATE invites SET redeemed_at = ?, redeemed_by = ? WHERE code_hash = ? AND redeemed_at IS NULL'
    ).run(nowIso(), deviceId, codeHash);

    if (claimed.changes !== 1) {
      db.exec('ROLLBACK');
      recordFailure();
      return null;
    }

    db.exec('COMMIT');
    // The only moment the recovery code exists in plaintext.
    return { token, deviceId, accountId, recoveryCode };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const LINK_TTL_MS = 10 * 60 * 1000;

/**
 * Mints a short-lived code that adds another device to this account.
 *
 * Only a signed-in device can mint one, so holding a working device is the
 * authority for adding a second. Short and single-use because it is read aloud
 * or typed across the room, and its lifetime is the security margin rather
 * than its length.
 */
export function createLinkCode(accountId) {
  const code = randomCode(8);
  db.prepare('INSERT INTO device_links (code_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hash(normaliseCode(code)), accountId, nowIso(), new Date(Date.now() + LINK_TTL_MS).toISOString());
  return { code, expiresInMs: LINK_TTL_MS };
}

export function redeemLinkCode(code, label = null) {
  const normalised = normaliseCode(code);
  if (!normalised) return null;
  if (tooManyFailures()) throw new ThrottledError();

  db.exec('BEGIN IMMEDIATE');
  try {
    // Consumed by the same guarded UPDATE pattern as an invite: expiry and
    // single use are both enforced in the WHERE clause, so a race cannot
    // produce two devices from one code.
    const row = db.prepare('SELECT account_id FROM device_links WHERE code_hash = ?').get(hash(normalised));
    const claimed = db.prepare(`
      UPDATE device_links SET used_at = ?
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
    `).run(nowIso(), hash(normalised), nowIso());

    if (claimed.changes !== 1 || !row) {
      db.exec('ROLLBACK');
      recordFailure();
      return null;
    }

    const { deviceId, token } = insertDevice(row.account_id, label);
    db.exec('COMMIT');
    return { token, deviceId, accountId: row.account_id };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Last resort when no device survives: the code written down at signup.
 *
 * Deliberately does not consume the code. Someone recovering a lost phone may
 * well have to do it again, and invalidating their only route on first use
 * would strand them permanently. `resetRecovery` is how a compromised code is
 * retired.
 */
export function redeemRecovery(code, label = null) {
  const normalised = normaliseCode(code);
  if (!normalised) return null;
  if (tooManyFailures()) throw new ThrottledError();

  const account = db.prepare('SELECT id FROM accounts WHERE recovery_hash = ?').get(hash(normalised));
  if (!account) {
    recordFailure();
    return null;
  }

  const { deviceId, token } = insertDevice(account.id, label);
  return { token, deviceId, accountId: account.id };
}

/** Issues a fresh recovery code, retiring the previous one. */
export function resetRecovery(accountId) {
  const recoveryCode = randomCode(12);
  db.prepare('UPDATE accounts SET recovery_hash = ?, recovery_set_at = ? WHERE id = ?')
    .run(hash(normaliseCode(recoveryCode)), nowIso(), accountId);
  return recoveryCode;
}

export function listDevices(accountId) {
  return db.prepare(`
    SELECT id, label, created_at, last_seen FROM devices
    WHERE account_id = ? ORDER BY created_at
  `).all(accountId);
}

/**
 * Removes one device's access. History is untouched: entries belong to the
 * account, so revoking a lost phone costs nothing but that phone's session.
 * Under the old device-scoped schema this was impossible without deleting the
 * log along with it.
 */
export function revokeDevice(accountId, deviceId) {
  return db.prepare('DELETE FROM devices WHERE id = ? AND account_id = ?')
    .run(deviceId, accountId).changes === 1;
}

export function deviceForToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(hash(token));
  if (!row) return null;
  // A device with no account predates the migration and cannot be scoped
  // safely; refusing it is better than serving another account's history.
  if (!row.account_id) return null;
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(nowIso(), row.id);
  return row;
}

function extractToken(req) {
  const bearer = req.headers.authorization;
  if (bearer?.startsWith('Bearer ')) return bearer.slice(7).trim();
  const cookie = req.headers.cookie || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function requireDevice(req, res, next) {
  const device = deviceForToken(extractToken(req));
  if (!device) {
    return res.status(401).json({ error: 'not_registered', message: 'This device needs an invite code.' });
  }
  req.device = device;
  next();
}

/**
 * Admin routes are gated on a header that only the private Caddy listener
 * injects; the public listener strips it. There is deliberately no
 * environment-variable bypass -- that is one stray variable away from an open
 * admin API.
 */
export function requireAdmin(req, res, next) {
  if (req.headers['x-admin'] !== '1') {
    return res.status(403).json({ error: 'admin_only', message: 'Available on the private listener only.' });
  }
  next();
}

export function setTokenCookie(res, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${60 * 60 * 24 * 365 * 5}`
  ];
  if (process.env.COOKIE_INSECURE !== '1') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
