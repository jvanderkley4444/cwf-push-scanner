'use strict';
/* Offline unit checks for the pure logic in scan.js — no network, no Firebase.
   Run:  npm test   (also runs in CI on every push). */
const assert = require('assert');
const { nameFor, otherInPair, tsToMillis, categoryMuted } = require('./scan');

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

console.log(`\nAll ${n} checks passed.`);
