'use strict';
/*
 * test-push.js — manual end-to-end push check ("Run workflow" → test-push.yml).
 *
 * Sends ONE real FCM banner to every registered device of a single user (looked
 * up by email — defaults to the owner), using the exact payload shape of
 * scan.js sendToUser. Proves the whole chain: service account → FCM → APNs key
 * → device. Prints FCM's per-token verdict; exits non-zero if nothing sent.
 * Never touches pushState, never reads other users.
 */
const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length) return;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saJson && saJson.trim()) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)) });
  } else {
    admin.initializeApp();   // GOOGLE_APPLICATION_CREDENTIALS / ADC (local runs)
  }
}

async function main() {
  initAdmin();
  // No default address: this repo is public, and a hard-coded personal email
  // would be permanently published and scraped. Pass one in:
  //   Actions  → "Run workflow" → Account email
  //   locally  → TEST_EMAIL=you@example.com node test-push.js
  const email = String(process.env.TEST_EMAIL || '').trim();
  if (!email) {
    console.error('Set TEST_EMAIL to the account you want to push to (workflow input "email").');
    process.exit(1);
  }
  const user = await admin.auth().getUserByEmail(email);
  const doc = await admin.firestore().collection('users').doc(user.uid).get();
  const fcmTokens = (doc.data() || {}).fcmTokens || {};
  const tokens = Object.keys(fcmTokens);
  console.log(`user ${email} (${user.uid}) — ${tokens.length} registered device(s):`,
    tokens.map((t) => (fcmTokens[t] || {}).platform).join(', ') || '(none)');
  if (!tokens.length) {
    console.log('NO TOKENS — open the app signed-in on the device first.');
    process.exit(1);
  }
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title: '✅ CookwithFriends push works!', body: 'APNs key verified — friend & message banners are live. 🌱' },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    webpush: { notification: { title: '✅ CookwithFriends push works!', body: 'APNs key verified.', icon: '/icon-512.png' } },
    data: { kind: 'test', cat: 'feed', url: '/' }
  });
  res.responses.forEach((r, i) => {
    console.log(`token[${i}] (${(fcmTokens[tokens[i]] || {}).platform}):`,
      r.success ? 'SENT ✅' : (r.error && r.error.code));
  });
  console.log(`success ${res.successCount} / failure ${res.failureCount}`);
  process.exit(res.successCount > 0 ? 0 : 1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
