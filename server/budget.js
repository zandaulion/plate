// What an account is allowed to spend of someone else's money.
//
// The PWA is friends and family and none of this matters there. The Android
// app is a market product, where the vision model is a cost per call that a
// stranger controls the timing of, and the honest assumption is that somebody
// will eventually try to run it in a loop.

import { db, nowIso } from './db.js';

/**
 * Calls to the vision model, per account, per day.
 *
 * Counted per account and not per feature. Reading a photograph and reading it
 * again after a correction cost the same -- 1409 and 1502 prompt tokens on a
 * measured pair -- so capping one and not the other only decides which door
 * the traffic uses.
 *
 * The number is set well above honest use rather than close to it: six meals a
 * day with a couple of corrections is eight calls, so this is roughly six times
 * a heavy day. A limit that a real person can reach by using the app properly
 * is a bug that looks like a policy.
 */
export const DAILY_LIMIT = Number(process.env.PLATE_DAILY_AI_LIMIT) || 50;

/** How many times one photograph may be read again after a correction. */
export const MAX_CORRECTIONS = Number(process.env.PLATE_MAX_CORRECTIONS) || 2;

export class BudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 429;
  }
}

const today = () => nowIso().slice(0, 10);

/**
 * Claims one call against today's allowance, or refuses.
 *
 * Charged before the model is called, never after. A call that fails still
 * cost money and still has to count, or inducing failures becomes the cheap
 * way to loop. The only calls that go uncharged are the ones this server
 * declines before reaching the model at all, which is why `charge` sits after
 * validation at every call site rather than at the top of the handler.
 *
 * The insert and the check are one statement so two requests arriving together
 * cannot both read the same count and both decide there was room.
 */
export function charge(accountId) {
  const day = today();
  const row = db.prepare(`
    INSERT INTO ai_usage (account_id, day, calls) VALUES (?, ?, 1)
    ON CONFLICT (account_id, day) DO UPDATE SET calls = calls + 1
      WHERE calls < ?
    RETURNING calls
  `).get(accountId, day, DAILY_LIMIT);

  // No row means the guarded update did not fire: the allowance is used up.
  if (!row) {
    throw new BudgetError(
      'daily_limit',
      `That is ${DAILY_LIMIT} photo readings today, which is as far as a day goes. It starts again tomorrow.`
    );
  }
  return row.calls;
}

/** Hands a call back when the model was never reached. */
export function refund(accountId) {
  db.prepare(
    'UPDATE ai_usage SET calls = MAX(calls - 1, 0) WHERE account_id = ? AND day = ?'
  ).run(accountId, today());
}

export function usedToday(accountId) {
  return db.prepare('SELECT calls FROM ai_usage WHERE account_id = ? AND day = ?')
    .get(accountId, today())?.calls || 0;
}

/**
 * The words of a correction, reduced to what actually changes the answer.
 *
 * Case and spacing do not, so "Not chicken" and "not  chicken" are the same
 * question and deserve the same answer without a second call.
 */
export function correctionKey(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function cachedAnalysis(photoId, correction) {
  const row = db.prepare(
    'SELECT result_json FROM analysis_cache WHERE photo_id = ? AND correction_key = ?'
  ).get(photoId, correctionKey(correction));
  return row ? JSON.parse(row.result_json) : null;
}

export function cacheAnalysis(photoId, correction, result) {
  db.prepare(`
    INSERT INTO analysis_cache (photo_id, correction_key, result_json, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (photo_id, correction_key) DO UPDATE SET result_json = excluded.result_json
  `).run(photoId, correctionKey(correction), JSON.stringify(result), nowIso());
}

/**
 * Photographs are deleted with their entries, and the cache should not outlive
 * them -- both because it is dead weight and because it is a record of a meal
 * whose owner asked for it to be gone.
 */
export function forgetPhoto(photoId) {
  db.prepare('DELETE FROM analysis_cache WHERE photo_id = ?').run(photoId);
}
