import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanBatch, summariseEvents, EVENTS } from './events.js';

test('unknown event names are dropped, not stored', () => {
  const out = cleanBatch([
    { name: 'entry_start', at: '2026-08-31T10:00:00Z', session: 's1' },
    { name: 'made_up_event', at: '2026-08-31T10:00:00Z', session: 's1' }
  ]);
  assert.equal(out.length, 1, 'a typo in the client must not create a new event type');
  assert.equal(out[0].name, 'entry_start');
});

test('properties are bounded so a log cannot become a data dump', () => {
  const [row] = cleanBatch([{
    name: 'search', at: '2026-08-31T10:00:00Z', session: 's1',
    props: {
      chars: 7.987654,
      ok: true,
      long: 'x'.repeat(500),
      'bad key!': 1,
      nested: { a: 1 },
      arr: [1, 2, 3]
    }
  }]);
  assert.equal(row.props.chars, 7.99, 'numbers are rounded');
  assert.equal(row.props.ok, true);
  assert.equal(row.props.long.length, 60, 'strings are truncated');
  assert.ok(!('bad key!' in row.props), 'odd keys are refused');
  assert.ok(!('nested' in row.props), 'objects are not stored');
  assert.ok(!('arr' in row.props), 'nor arrays');
});

test('a batch is capped and a bad timestamp becomes now', () => {
  const many = Array.from({ length: 500 }, () => ({ name: 'day_nav', at: 'nonsense', session: 's' }));
  const out = cleanBatch(many);
  assert.equal(out.length, 200);
  assert.ok(!Number.isNaN(Date.parse(out[0].at)));
});

test('completion rate is the headline: starting an entry versus finishing one', () => {
  const s = summariseEvents([
    { name: 'entry_start', session: 'a', props: {} },
    { name: 'entry_start', session: 'a', props: {} },
    { name: 'entry_start', session: 'a', props: {} },
    { name: 'entry_saved', session: 'a', props: {} },
    { name: 'entry_abandoned', session: 'a', props: {} }
  ]);
  assert.equal(s.completion.started, 3);
  assert.equal(s.completion.saved, 1);
  assert.equal(s.completion.abandoned, 1);
  assert.equal(s.completion.completedPct, 33);
});

test('a search that returns results and is then ignored is a ranking failure', () => {
  const s = summariseEvents([
    { name: 'search', session: 'a', props: { results: 12 } },
    { name: 'search', session: 'a', props: { results: 8 } },
    { name: 'search', session: 'a', props: { results: 0 } },
    { name: 'search_empty', session: 'a', props: {} },
    { name: 'search_pick', session: 'a', props: { rank: 1 } }
  ]);
  assert.equal(s.search.queries, 3);
  assert.equal(s.search.cameBackEmpty, 1);
  assert.equal(s.search.pickRatePct, 33);
});

test('screen time is reported as a median, so one long session cannot skew it', () => {
  const s = summariseEvents([
    { name: 'screen_close', session: 'a', props: { screen: 'review', seconds: 10 } },
    { name: 'screen_close', session: 'a', props: { screen: 'review', seconds: 20 } },
    { name: 'screen_close', session: 'a', props: { screen: 'review', seconds: 600 } }
  ]);
  assert.equal(s.screenSeconds.review, 20);
});

test('scanning counts the ways it can fail, not only the way it succeeds', () => {
  const s = summariseEvents([
    { name: 'scan_start', session: 'a', props: {} },
    { name: 'scan_start', session: 'a', props: {} },
    { name: 'scan_start', session: 'a', props: {} },
    { name: 'scan_ok', session: 'a', props: { seconds: 3 } },
    { name: 'scan_fail', session: 'a', props: {} },
    { name: 'scan_cancel', session: 'a', props: {} }
  ]);
  assert.equal(s.scanning.opened, 3);
  assert.equal(s.scanning.found, 1);
  assert.equal(s.scanning.gaveUp, 2);
  assert.equal(s.scanning.medianSeconds, 3);
});

test('an empty log summarises to zeroes rather than throwing', () => {
  const s = summariseEvents([]);
  assert.equal(s.events, 0);
  assert.equal(s.completion.completedPct, null);
  assert.deepEqual(s.screenSeconds, {});
  assert.deepEqual(s.errorsShown, {});
});

test('every event the client can send is in the accepted list', () => {
  // The vocabulary is shared, so a name used in the app but missing here would
  // be silently discarded by the server.
  for (const n of ['entry_start', 'analyse_fail', 'scan_ok', 'weigh_saved', 'error_shown']) {
    assert.ok(EVENTS.includes(n), n);
  }
});
