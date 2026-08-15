'use strict';
/*
 * scan.js — Cook with Friends push scanner (runs free on GitHub Actions cron).
 *
 * Delivers background FCM push — while the app is CLOSED — for the social events
 * CWF already records in Firestore: friend requests, request-accepted, new chat
 * messages (DM + group), friend-feed cooks/recipes, club posts, and being added
 * to a club. Mirrors the Clawback / Tabby scanner stack: Firebase Admin SDK +
 * FCM, NO Cloud Functions, NO Blaze plan — stays $0 on the Spark plan.
 *
 * ── SPARK-FRUGAL DESIGN (the whole point) ─────────────────────────────────────
 * A naive scanner re-reads every friendship/chat/club every run and would burn
 * Spark's 50k-reads/day quota as data grows. This one is INCREMENTAL: it keeps a
 * cursor (pushState/_meta.lastRunAt) and only queries docs whose timestamp is
 * newer than the last run (minus a small overlap for clock-skew / late crons).
 * So reads scale with ACTIVITY since the last run, not with total data. Writes
 * are just one dedupe marker per genuinely-new push, plus the cursor.
 *
 *  • Messages are detected from the chat doc's own lastMsg preview + reads{} map
 *    — the scanner NEVER reads the messages subcollection (zero extra reads).
 *  • Feed/club posts use collection-group queries on their timestamp (one query
 *    each, returning only new posts). The recipient of a feed post is derived
 *    from the friendship pairId in the doc path — no parent read needed.
 *  • users/{uid} (tokens + opt-out) is read at most once per user per run (cache).
 *
 * ── IDEMPOTENCY ───────────────────────────────────────────────────────────────
 * Each notification is keyed in pushState/{key} (the scanner owns this
 * collection; the client never touches it). We get→send→set: a marker already
 * present means "already pushed", so a missed/overlapping cron never double-sends.
 * Keys embed the event timestamp, so a genuinely new event (a later message, a
 * re-friend) is a new key and re-notifies. If the recipient has no token yet we
 * leave it UNrecorded so it retries once they register.
 *
 * ── FIRST RUN (seed) ──────────────────────────────────────────────────────────
 * On the very first run the cursor is planted at "now" and current club
 * memberships are recorded, and NOTHING is sent — so deploying the scanner does
 * not fire a notification for every pre-existing friend/message/club in the app.
 *
 * Opt-out: users/{uid}.notify.{feed|friends|messages} === false suppresses that
 * category (the app mirrors its Settings toggles there — see client patch). A
 * muted event is still marked done so un-muting doesn't unleash a backlog storm.
 */
// Lazy so the offline self-test (pure helpers) needs no node_modules; the real
// scan loads firebase-admin on first use.
let admin = null;
function fb() { return admin || (admin = require('firebase-admin')); }

// Re-examine a short window before the last cursor so a late/skipped cron or a
// little client/server clock skew never drops an event; pushState de-dupes the
// overlap so nothing is sent twice.
const OVERLAP_MS = 2 * 60 * 1000;

function initAdmin() {
  const a = fb();
  if (a.apps.length) return;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (saJson && saJson.trim()) {
    a.initializeApp({ credential: a.credential.cert(JSON.parse(saJson)) });
  } else {
    a.initializeApp();   // GOOGLE_APPLICATION_CREDENTIALS / ADC (local runs)
  }
}

// ── small pure helpers (exported for tests) ──────────────────────────────────
function nameFor(f, uid) { return (f && f.names && f.names[uid]) || 'Someone'; }
function tsToMillis(v, fallback) { return (v && typeof v.toMillis === 'function') ? v.toMillis() : (typeof v === 'number' ? v : fallback); }

// A friendship pairId is the two auth uids joined by '_' (uids are alphanumeric,
// no '_'), so we can recover the OTHER member without reading the parent doc.
function otherInPair(pairId, uid) {
  const p = String(pairId).split('_');
  if (p.length !== 2) return null;
  if (p[0] === uid) return p[1];
  if (p[1] === uid) return p[0];
  return null;
}

// Read a user doc at most once per run: tokens + per-category opt-out.
function makeUserCache(db) {
  const cache = new Map();
  return async function getUser(uid) {
    if (cache.has(uid)) return cache.get(uid);
    let u = {};
    try { const s = await db.collection('users').doc(uid).get(); u = s.exists ? (s.data() || {}) : {}; } catch (e) { u = {}; }
    cache.set(uid, u);
    return u;
  };
}

function categoryMuted(user, cat) {
  return !!(user && user.notify && user.notify[cat] === false);
}

// Send one event's push to every device of a user. Returns:
//   'sent'    ≥1 device accepted it
//   'muted'   the user opted this category out (treated as handled → mark done)
//   'notoken' user has no registered device (leave UNrecorded → retry next run)
//   'error'   FCM rejected every token (leave UNrecorded → retry)
async function sendToUser(db, messaging, user, uid, ev) {
  if (categoryMuted(user, ev.cat)) return 'muted';
  const tokens = user.fcmTokens ? Object.keys(user.fcmTokens) : [];
  if (!tokens.length) return 'notoken';
  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: ev.title, body: ev.body },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    // Web (custom service worker) reads these from the raw push event; iOS reads
    // the notification/apns block above. url drives the tap deep-link.
    webpush: { notification: { title: ev.title, body: ev.body, icon: '/icon-512.png' }, fcmOptions: { link: ev.url || '/' } },
    data: { kind: String(ev.kind || ''), cat: String(ev.cat || ''), url: String(ev.url || '/') }
  });
  // Prune dead tokens — but ONLY on token-specific error codes (NOT
  // 'invalid-argument', which FCM also returns for a malformed payload — pruning
  // on that would wipe every healthy token). Delete via FieldPath(), not a dotted
  // string, because FCM tokens contain ':' and '/' (illegal in string paths).
  const dead = [];
  res.responses.forEach((r, i) => {
    if (!r.success && r.error) {
      const code = r.error.code || '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
        dead.push(new (fb().firestore.FieldPath)('fcmTokens', tokens[i]), fb().firestore.FieldValue.delete());
      } else {
        console.warn(`send ${ev.kind} → ${uid} token[${i}]: ${code}`);
      }
    }
  });
  if (dead.length) await db.collection('users').doc(uid).update(dead[0], dead[1], ...dead.slice(2)).catch(() => {});
  return res.successCount > 0 ? 'sent' : 'error';
}

// Dedupe + deliver one event. Returns true only when a push was newly sent.
async function deliver(db, messaging, getUser, key, uid, ev) {
  if (!uid) return false;
  const psRef = db.collection('pushState').doc(key);
  if ((await psRef.get()).exists) return false;                 // already handled
  const user = await getUser(uid);
  const status = await sendToUser(db, messaging, user, uid, ev);
  if (status === 'sent' || status === 'muted') {
    await psRef.set({ at: Date.now(), kind: ev.kind, uid, status }).catch(() => {});
    return status === 'sent';
  }
  return false;                                                 // notoken/error → retry next run
}

// Record a dedupe marker WITHOUT sending (used to seed existing club memberships
// on the first run so they never fire a retroactive "added to club" push).
async function markSeen(db, key) {
  await db.collection('pushState').doc(key).set({ at: Date.now(), kind: 'seed' }).catch(() => {});
}

async function main() {
  initAdmin();
  const db = fb().firestore();
  const messaging = fb().messaging();
  const getUser = makeUserCache(db);
  const runAt = Date.now();

  const curRef = db.collection('pushState').doc('_meta');
  const cur = (await curRef.get().catch(() => null));
  const meta = (cur && cur.exists) ? (cur.data() || {}) : {};

  // ── First run: plant the cursor + record current club memberships (and each
  // club's roster signature), send none.
  if (!meta.seeded) {
    const clubs = await db.collection('clubs').get();
    let seeded = 0;
    for (const d of clubs.docs) {
      const mu = (d.data() || {}).memberUids || [];
      for (const uid of mu) { await markSeen(db, `clubmember_${d.id}_${uid}`); seeded++; }
      await db.collection('pushState').doc(`clubroster_${d.id}`).set({ sig: mu.slice().sort().join(','), at: runAt }).catch(() => {});
    }
    await curRef.set({ seeded: true, lastRunAt: runAt }, { merge: true });
    console.log(`First run — seeded cursor + ${seeded} existing club membership(s); sent nothing.`);
    return;
  }

  const sinceMs = (meta.lastRunAt || runAt) - OVERLAP_MS;
  const sinceTs = fb().firestore.Timestamp.fromMillis(sinceMs);
  let pushed = 0, hadError = false;

  // Run one event type in isolation: if its query fails (e.g. a collection-group
  // index isn't built yet, or a transient error), log it and mark hadError so we
  // DON'T advance the cursor — the whole window retries next run and dedupe stops
  // double-sends. One failing event can never abort the others or lose events.
  async function step(label, fn) {
    try { await fn(); }
    catch (e) { hadError = true; console.error(`[${label}] failed — cursor held, will retry: ${(e && e.message) || e}`); }
  }

  // 1) New friend requests → notify the recipient (the member who didn't ask).
  await step('friend_requests', async () => {
    const snap = await db.collection('friendships').where('ts', '>', sinceTs).get();
    for (const d of snap.docs) {
      const f = d.data() || {};
      if (f.status !== 'pending' || !f.requestedBy || !Array.isArray(f.members)) continue;
      const to = f.members.find(m => m && m !== f.requestedBy);
      const from = nameFor(f, f.requestedBy);
      const tsMs = tsToMillis(f.ts, runAt);
      if (await deliver(db, messaging, getUser, `fr_${d.id}_${tsMs}`, to, {
        cat: 'friends', kind: 'friend_request', url: '/?tab=friends',
        title: '👋 New friend request', body: `${from} wants to connect on Cook with Friends`
      })) pushed++;
    }
  });

  // 2) Accepted requests → notify the original requester. (Needs the acceptedAt
  //    client field; until that ships this query simply returns nothing.)
  await step('friend_accepts', async () => {
    const snap = await db.collection('friendships').where('acceptedAt', '>', sinceTs).get();
    for (const d of snap.docs) {
      const f = d.data() || {};
      if (f.status !== 'accepted' || !f.requestedBy) continue;
      const accepter = Array.isArray(f.members) ? f.members.find(m => m && m !== f.requestedBy) : null;
      const who = nameFor(f, accepter);
      const aMs = tsToMillis(f.acceptedAt, runAt);
      if (await deliver(db, messaging, getUser, `fa_${d.id}_${aMs}`, f.requestedBy, {
        cat: 'friends', kind: 'friend_accept', url: '/?tab=friends',
        title: '🎉 Friend request accepted', body: `${who} accepted your friend request`
      })) pushed++;
    }
  });

  // 3) New chat messages (DM + group). Detected purely from the chat doc's
  //    lastMsg preview + reads{} watermark — zero message-subcollection reads.
  await step('chat_messages', async () => {
    const snap = await db.collection('chats').where('lastMsg.ts', '>', sinceMs).get();
    for (const d of snap.docs) {
      const c = d.data() || {};
      const lm = c.lastMsg || {};
      if (!lm.ts || !lm.authorUid || !Array.isArray(c.members)) continue;
      const reads = c.reads || {};
      // 2026-08-15: the app now alerts in-app for closed threads while it's
      // OPEN, and stamps chats/{id}.seen{uid:ts} for what it already surfaced.
      // Skipping those stops the same message arriving twice (in-app banner
      // now + push 15 min later). Absent on older clients → unchanged behavior.
      const seen = c.seen || {};
      const sender = lm.userName || 'Someone';
      const group = c.kind === 'group';
      const title = group ? `💬 ${c.name || 'Group chat'}` : `💬 ${sender}`;
      const preview = lm.text || 'New message';
      const body = group ? `${sender}: ${preview}` : preview;
      for (const to of c.members) {
        if (!to || to === lm.authorUid) continue;               // don't ping the sender
        if ((reads[to] || 0) >= lm.ts) continue;                // already read on some device
        if ((seen[to] || 0) >= lm.ts) continue;                 // already alerted in-app
        if (await deliver(db, messaging, getUser, `msg_${d.id}_${to}_${lm.ts}`, to, {
          cat: 'messages', kind: 'chat_message', url: '/?tab=messages', title, body
        })) pushed++;
      }
    }
  });

  // 4) New friend-feed posts (a friend shared a cook, or sent you a recipe).
  await step('friend_feed', async () => {
    const snap = await db.collectionGroup('feed').where('timestamp', '>', sinceMs).get();
    for (const d of snap.docs) {
      const p = d.data() || {};
      if (!p.authorUid) continue;
      const pairId = d.ref.parent.parent ? d.ref.parent.parent.id : '';
      const to = otherInPair(pairId, p.authorUid);
      const who = p.userName || 'A friend';
      const recipe = p.kind === 'recipe';
      if (await deliver(db, messaging, getUser, `feed_${d.id}`, to, {
        cat: 'feed', kind: recipe ? 'feed_recipe' : 'feed_cook', url: '/?tab=feed',
        title: recipe ? '🍳 A recipe just for you' : '🍽️ New cook from a friend',
        body: recipe ? `${who} sent you “${p.recipeTitle || 'a recipe'}”` : `${who} shared what they cooked`
      })) pushed++;
    }
  });

  // 5) New club posts → notify every club member except the author.
  await step('club_posts', async () => {
    const snap = await db.collectionGroup('posts').where('ts', '>', sinceMs).get();
    const clubCache = new Map();
    for (const d of snap.docs) {
      const p = d.data() || {};
      if (!p.authorUid) continue;
      const clubId = d.ref.parent.parent ? d.ref.parent.parent.id : '';
      if (!clubId) continue;
      let club = clubCache.get(clubId);
      if (!club) {
        const cs = await db.collection('clubs').doc(clubId).get().catch(() => null);
        club = (cs && cs.exists) ? (cs.data() || {}) : {};
        clubCache.set(clubId, club);
      }
      const members = Array.isArray(club.memberUids) ? club.memberUids : [];
      const who = p.userName || 'A member';
      const clubName = club.name || 'your club';
      const body = p.kind === 'recipe' ? `${who} shared a recipe in ${clubName}`
        : p.kind === 'cook' ? `${who} posted a cook in ${clubName}`
        : `${who} posted in ${clubName}`;
      for (const to of members) {
        if (!to || to === p.authorUid) continue;
        if (await deliver(db, messaging, getUser, `club_${d.id}_${to}`, to, {
          cat: 'feed', kind: 'club_post', url: '/?tab=clubs', title: `👩‍🍳 ${clubName}`, body
        })) pushed++;
      }
    }
  });

  // 6) Added to a cooking club. Club docs bump their serverTimestamp `ts` on any
  //    sync (not only roster changes), so first compare the roster to the last
  //    signature we stored — unchanged → skip with a single read, no per-member
  //    lookups. When it changed, a member with no clubmember marker (and who
  //    isn't the owner or the one who made the change) is newly added → notify.
  await step('club_added', async () => {
    const snap = await db.collection('clubs').where('ts', '>', sinceTs).get();
    for (const d of snap.docs) {
      const club = d.data() || {};
      const members = Array.isArray(club.memberUids) ? club.memberUids : [];
      const sig = members.slice().sort().join(',');
      const rosterRef = db.collection('pushState').doc(`clubroster_${d.id}`);
      const prev = await rosterRef.get();
      if (prev.exists && (prev.data() || {}).sig === sig) continue;   // roster unchanged → nothing to do
      const clubName = club.name || 'a cooking club';
      for (const to of members) {
        if (!to || to === club.owner || to === club.lastBy) continue;
        if (await deliver(db, messaging, getUser, `clubmember_${d.id}_${to}`, to, {
          cat: 'friends', kind: 'club_added', url: '/?tab=clubs',
          title: '👥 Added to a cooking club', body: `You were added to ${clubName}`
        })) pushed++;
      }
      await rosterRef.set({ sig, at: runAt }).catch(() => {});
    }
  });

  // Advance the cursor only if EVERY event succeeded; otherwise keep the old one
  // so the window is fully retried next run (dedupe prevents double-sends).
  if (!hadError) {
    await curRef.set({ seeded: true, lastRunAt: runAt }, { merge: true });
    console.log(`Scan complete — pushed ${pushed} new notification(s). Cursor → ${new Date(runAt).toISOString()}`);
  } else {
    console.log(`Scan finished WITH ERRORS — pushed ${pushed}; cursor NOT advanced (retries next run). If a "create index" link appears above, open it once to build the index.`);
  }
}

module.exports = { nameFor, otherInPair, tsToMillis, categoryMuted, sendToUser, deliver, main };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(err => { console.error('SCAN FAILED:', err); process.exit(1); });
}
