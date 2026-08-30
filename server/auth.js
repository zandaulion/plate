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

/**
 * Exchanges an invite code for a device token.
 *
 * The device row is written before the invite is claimed, because
 * invites.redeemed_by is a foreign key onto devices -- claiming first fails
 * the constraint. Both statements run inside one transaction so the reverse
 * hazard is covered too: if the claim finds the code already used, the
 * speculative device is rolled back rather than left orphaned.
 *
 * The UPDATE is guarded on redeemed_at IS NULL, so two requests racing on the
 * same code cannot both succeed; SQLite serialises them and the loser sees
 * zero changed rows.
 */
export function redeemInvite(code, label = null) {
  const normalised = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!normalised) return null;

  const codeHash = hash(normalised);
  const deviceId = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('base64url');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO devices (id, token_hash, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
      .run(deviceId, hash(token), label, nowIso(), nowIso());

    const claimed = db.prepare(
      'UPDATE invites SET redeemed_at = ?, redeemed_by = ? WHERE code_hash = ? AND redeemed_at IS NULL'
    ).run(nowIso(), deviceId, codeHash);

    if (claimed.changes !== 1) {
      db.exec('ROLLBACK');
      return null;
    }

    db.exec('COMMIT');
    return { token, deviceId };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function deviceForToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(hash(token));
  if (!row) return null;
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
