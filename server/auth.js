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

export const INVITE_TTL_DAYS = 7;

/**
 * Where an invite link points. Left empty unless configured, so the public
 * repo carries no hostname; the console then shows the code without a link
 * rather than inventing one.
 */
const publicBase = () => (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');

export function createInvite(label = null) {
  const code = randomCode();
  const base = publicBase();
  const url = base ? `${base}/?invite=${encodeURIComponent(code)}` : null;
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString();

  const out = db.prepare(`
    INSERT INTO invites (code_hash, code, label, url, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(hash(normaliseCode(code)), code, label, url, nowIso(), expiresAt);

  return {
    id: out.lastInsertRowid,
    code,
    url,
    label,
    expires_at: expiresAt,
    expires_in_days: INVITE_TTL_DAYS
  };
}

/**
 * Invites as the console expects them.
 *
 * `code` and `url` are returned only while the invite can still register
 * something. They are cleared in the database at that moment too, so this is
 * reporting the absence rather than hiding a value that is still on disk.
 */
export function listInvites() {
  const rows = db.prepare(`
    SELECT id, label, code, url, created_at, expires_at, used_at, revoked, device_id
    FROM invites ORDER BY created_at DESC
  `).all();

  return {
    ttl_days: INVITE_TTL_DAYS,
    invites: rows.map((r) => ({
      id: r.id,
      label: r.label,
      code: r.code,
      url: r.url,
      created_at: r.created_at,
      expires_at: r.expires_at,
      used_at: r.used_at,
      revoked: Boolean(r.revoked),
      device_id: r.device_id
    }))
  };
}

/** Cancels an unused invite and drops its plaintext. */
export function revokeInvite(id) {
  return db.prepare(
    'UPDATE invites SET revoked = 1, code = NULL, url = NULL WHERE id = ? AND used_at IS NULL'
  ).run(id).changes === 1;
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

    // Expiry, revocation and single use are all enforced in this one guarded
    // UPDATE, so none of them can be raced. The plaintext is cleared in the
    // same statement: once an invite has registered a device it can never
    // register another, so keeping the code would be storing a spent secret.
    const claimed = db.prepare(`
      UPDATE invites SET used_at = ?, device_id = ?, code = NULL, url = NULL
      WHERE code_hash = ? AND used_at IS NULL AND revoked = 0 AND expires_at > ?
    `).run(nowIso(), deviceId, codeHash, nowIso());

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
    SELECT id, label, created_at, last_seen, revoked FROM devices
    WHERE account_id = ? AND revoked = 0 ORDER BY created_at
  `).all(accountId);
}

/** Every device, for the console. Revoked ones are included so they can be restored. */
export function listAllDevices() {
  return db.prepare(`
    SELECT id, account_id, label, created_at, last_seen, revoked
    FROM devices ORDER BY created_at DESC
  `).all().map((d) => ({
    id: d.id,
    account_id: d.account_id,
    label: d.label,
    created_at: d.created_at,
    last_seen: d.last_seen,
    revoked: Boolean(d.revoked)
  }));
}

export function setDeviceRevoked(id, revoked) {
  return db.prepare('UPDATE devices SET revoked = ? WHERE id = ?')
    .run(revoked ? 1 : 0, id).changes === 1;
}

export function setDeviceLabel(id, label) {
  return db.prepare('UPDATE devices SET label = ? WHERE id = ?')
    .run(String(label).slice(0, 60), id).changes === 1;
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
  // A revoked device keeps its row so the console can restore it, but must not
  // authenticate in the meantime.
  if (row.revoked) return null;
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
/**
 * Admin access, proved by a shared secret rather than asserted by a header.
 *
 * This used to be `X-Admin: 1` -- a constant any caller could set. It was not
 * reachable from outside, because the public listener strips it and the
 * listener that injects it is bound to the tailnet, but that made the whole
 * admin surface rest on two lines of proxy configuration with nothing behind
 * them. Anything that reached the port directly was admin.
 *
 * Now the proxy passes a secret this process also knows, so being on the right
 * listener is no longer the same thing as being trusted.
 *
 * Fails closed. If ADMIN_TOKEN is missing the answer is no, because the
 * alternative -- treating an unconfigured server as an open one -- is exactly
 * how this kind of gate quietly stops working.
 */
function adminTokenOk(supplied) {
  const expected = (process.env.ADMIN_TOKEN || '').trim();
  if (!expected) return false;
  const given = Buffer.from(String(supplied || ''));
  const want = Buffer.from(expected);
  // timingSafeEqual demands equal lengths, so compare those first. It leaks
  // the length of the secret and nothing else.
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

export function requireAdmin(req, res, next) {
  if (!adminTokenOk(req.headers['x-admin-token'])) {
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
