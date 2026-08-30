'use strict';
/* Offline unit checks for the pure logic in scan.js — no network, no Firebase.
   Run:  npm test   (also runs in CI on every push). */
const assert = require('assert');
const { nameFor, otherInPair, tsToMillis, categoryMuted, windowStart, isStale, mapLimit,
        MAX_LOOKBACK_MS, MAX_EVENT_AGE_MS, OVERLAP_MS } = require('./scan');

let n = 0;
function ok(desc, fn) { fn(); n++; console.log('  ✓ ' + desc); }

console.log('scan.js pure-logic self-test');

// otherInPair — recover the OTHER member from a sorted "uidA_uidB" pairId.
ok('otherInPair returns the partner uid', () => {
  assert.strictEqual(otherInPair('aaa_bbb', 'aaa'), 'bbb');
  assert.strictEqual(otherInPair('aaa_bbb', 'bbb'), 'aaa');
});
ok('otherInPair returns null when uid is not in the pair', () => {
  assert.strictEqual(otherInPair('aaa_bbb', 'zzz'), null);
});
ok('otherInPair returns null for a malformed pairId', () => {
  assert.strictEqual(otherInPair('nounderscorehere', 'aaa'), null);
  assert.strictEqual(otherInPair('a_b_c', 'a'), null);   // 3 parts → ambiguous → refuse
});

// nameFor — denormalized names{} lookup with a safe fallback.
ok('nameFor reads names{} and falls back', () => {
  assert.strictEqual(nameFor({ names: { u1: 'Jeff' } }, 'u1'), 'Jeff');
  assert.strictEqual(nameFor({ names: {} }, 'u1'), 'Someone');
  assert.strictEqual(nameFor(null, 'u1'), 'Someone');
});

// tsToMillis — accept Firestore Timestamp, raw ms number, or fall back.
ok('tsToMillis handles Timestamp, number, and fallback', () => {
  assert.strictEqual(tsToMillis({ toMillis: () => 1234 }, 9), 1234);
  assert.strictEqual(tsToMillis(5678, 9), 5678);
  assert.strictEqual(tsToMillis(undefined, 9), 9);
  assert.strictEqual(tsToMillis(null, 9), 9);
});

// categoryMuted — opt-out is ONLY the explicit false; absent/true → send.
ok('categoryMuted is true only for an explicit false', () => {
  assert.strictEqual(categoryMuted({ notify: { messages: false } }, 'messages'), true);
  assert.strictEqual(categoryMuted({ notify: { messages: true } }, 'messages'), false);
  assert.strictEqual(categoryMuted({ notify: {} }, 'messages'), false);       // default = on
  assert.strictEqual(categoryMuted({}, 'messages'), false);
  assert.strictEqual(categoryMuted(null, 'feed'), false);
});

// windowStart — a stalled cursor can never reach further back than the clamp.
ok('windowStart applies the overlap and the lookback clamp', () => {
  const now = 1000 * MAX_LOOKBACK_MS;                 // "now", comfortably large
  // Fresh cursor (15 min ago): overlap applies, clamp does not.
  const fresh = now - 15 * 60 * 1000;
  assert.strictEqual(windowStart(fresh, now), fresh - OVERLAP_MS);
  // Cursor stalled for a year: clamped to exactly MAX_LOOKBACK_MS back — this is
  // what stops one broken step degrading into an unbounded full-table scan.
  const stalled = now - 365 * 24 * 3600 * 1000;
  assert.strictEqual(windowStart(stalled, now), now - MAX_LOOKBACK_MS);
  // Cursor in the future (clock skew) → still just the overlap, never > now.
  assert.ok(windowStart(now, now) <= now);
});

// isStale — the outage-backlog guard.
ok('isStale suppresses old events but never events without a timestamp', () => {
  const now = 1000 * MAX_EVENT_AGE_MS;
  assert.strictEqual(isStale(now - 60 * 1000, now), false);            // a minute old → send
  assert.strictEqual(isStale(now - MAX_EVENT_AGE_MS + 1000, now), false);  // just inside → send
  assert.strictEqual(isStale(now - MAX_EVENT_AGE_MS - 1000, now), true);   // just outside → silent
  assert.strictEqual(isStale(undefined, now), false);                  // no ts → unchanged behaviour
  assert.strictEqual(isStale(0, now), false);                          // falsy ts → unchanged
});

// mapLimit — order preserved, concurrency actually bounded. Async, so it runs
// after the synchronous checks above and prints the final tally itself.
(async () => {
  let live = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, async (v) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    live--; return v * 2;
  });
  assert.deepStrictEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18]);
  assert.ok(peak <= 3, 'concurrency exceeded the limit: ' + peak);
  assert.deepStrictEqual(await mapLimit([], 4, async () => 1), []);
  n++; console.log('  \u2713 mapLimit is bounded (peak ' + peak + ') and order-preserving');
  console.log(`\nAll ${n} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
