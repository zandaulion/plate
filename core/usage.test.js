import test from 'node:test';
import assert from 'node:assert/strict';
import { summariseUsage, entryPath, longestStreak } from './usage.js';

const NOW = Date.parse('2026-08-31T12:00:00Z');
const day = (back) => new Date(NOW - back * 86400000).toISOString().slice(0, 10);
const at = (back, hour) => new Date(Date.parse(`${day(back)}T00:00:00Z`) + hour * 3600000).toISOString();

test('the entry path is read from the shape of its items', () => {
  assert.equal(entryPath({ items: [{ source: 'photo' }, { barcode: '1' }] }), 'photo',
    'a photograph anywhere makes it a photo entry');
  assert.equal(entryPath({ items: [{ source: 'manual', barcode: '1' }] }), 'barcode');
  assert.equal(entryPath({ items: [{ source: 'manual' }] }), 'manual');
  assert.equal(entryPath({}), 'manual');
});

test('longestStreak counts consecutive days only', () => {
  assert.equal(longestStreak(['2026-08-01', '2026-08-02', '2026-08-03']), 3);
  assert.equal(longestStreak(['2026-08-01', '2026-08-03', '2026-08-04']), 2);
  assert.equal(longestStreak(['2026-08-01', '2026-08-01']), 1, 'a repeat is not a streak');
  assert.equal(longestStreak([]), 0);
});

test('it reports which of the three ways in actually gets used', () => {
  const u = summariseUsage({ now: NOW, entries: [
    { day: day(1), createdAt: at(1, 8), items: [{ source: 'photo' }] },
    { day: day(1), createdAt: at(1, 13), items: [{ source: 'photo' }] },
    { day: day(2), createdAt: at(2, 9), items: [{ source: 'manual', barcode: '1' }] },
    { day: day(3), createdAt: at(3, 20), items: [{ source: 'manual' }] }
  ]});
  assert.deepEqual(u.paths.map((p) => [p.key, p.n]), [['photo', 2], ['barcode', 1], ['manual', 1]]);
  assert.equal(u.paths[0].pct, 50);
});

test('it separates photo entries whose portion was never corrected', () => {
  const u = summariseUsage({ now: NOW, entries: [
    { day: day(1), createdAt: at(1, 8), portionSource: 'model', items: [{ source: 'photo' }] },
    { day: day(1), createdAt: at(1, 9), portionSource: 'estimated', items: [{ source: 'photo' }] },
    // A barcode entry left at 'model' is not a failure: nothing needed correcting.
    { day: day(2), createdAt: at(2, 9), portionSource: 'model', items: [{ barcode: '1' }] }
  ]});
  assert.equal(u.portion.photoEntries, 2);
  assert.equal(u.portion.photoLeftUncorrected, 1, 'only the photo one counts');
});

test('weighing reports the gap that stops a trend forming', () => {
  const u = summariseUsage({ now: NOW, entries: [], weights: [
    { day: day(10), kg: 80 }, { day: day(9), kg: 80 }, { day: day(2), kg: 79 }
  ]});
  assert.equal(u.weighing.count, 3);
  assert.equal(u.weighing.longestStreak, 2);
  assert.equal(u.weighing.biggestGapDays, 7, 'the week nothing was recorded');
});

test('same-day logging is distinguished from catching up later', () => {
  const u = summariseUsage({ now: NOW, entries: [
    { day: day(1), createdAt: at(1, 13), items: [{}] },        // during that day
    { day: day(2), createdAt: at(1, 10), items: [{}] }         // written the day after
  ]});
  assert.equal(u.logging.sameDayPct, 50);
});

test('repeat foods are measured, because that is what recents exist for', () => {
  const u = summariseUsage({ now: NOW, entries: [
    { day: day(1), createdAt: at(1, 8), items: [{ name: 'Porridge' }] },
    { day: day(2), createdAt: at(2, 8), items: [{ name: 'porridge' }] },
    { day: day(3), createdAt: at(3, 8), items: [{ name: 'Steak' }] }
  ]});
  assert.equal(u.foods.distinct, 2, 'case does not make a different food');
  assert.equal(u.foods.repeatedFoods, 1);
  assert.equal(u.foods.repeatSharePct, 33);
});

test('history outside the window is ignored', () => {
  const u = summariseUsage({ now: NOW, days: 7, entries: [
    { day: day(2), createdAt: at(2, 8), items: [{}] },
    { day: day(40), createdAt: at(40, 8), items: [{}] }
  ]});
  assert.equal(u.entries, 1);
  assert.equal(u.logging.daysLogged, 1);
});

test('an empty account reports zeroes rather than throwing', () => {
  const u = summariseUsage({});
  assert.equal(u.entries, 0);
  assert.equal(u.logging.coveragePct, 0);
  assert.deepEqual(u.paths, []);
  assert.equal(u.weighing.biggestGapDays, 0);
});
