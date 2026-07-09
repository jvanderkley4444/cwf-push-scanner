# Cook with Friends — Push Scanner

Free, **app-closed** push notifications for Cook with Friends' social events, on
the **Spark plan** (GitHub Actions cron + Firebase Admin SDK + FCM — **no Cloud
Functions, no Blaze, no Firebase cost**). Same stack as `clawback-push-scanner`
and `tabby-trade-scanner`.

## What it pushes

| # | Event | Firestore source | Who gets it | Category |
|---|-------|------------------|-------------|----------|
| 1 | New **friend request** | `friendships/{pair}` `status:'pending'` | the member who isn't `requestedBy` | `friends` |
| 2 | Friend request **accepted** | `friendships/{pair}` `acceptedAt` set | the original `requestedBy` | `friends` |
| 3 | New **chat message** (DM + group) | `chats/{id}.lastMsg` + `reads{}` | members who haven't read it | `messages` |
| 4 | Friend shared a **cook / recipe** | `friendships/{pair}/feed/{post}` | the other member of the pair | `feed` |
| 5 | New **club post** | `clubs/{id}/posts/{post}` | all club members except the author | `feed` |
| 6 | **Added to a club** | `clubs/{id}.memberUids` | the newly-added member | `friends` |

Each maps to the in-app `notifyPref('friends'|'messages'|'feed', …)` categories the
app already has — so `users/{uid}.notify.<category> === false` mutes that category
(the client patch mirrors the Settings toggles up to Firestore).

## Why it's cheap (the Spark-frugal bit)

The scanner is **incremental**, not a full scan. It keeps a cursor in
`pushState/_meta.lastRunAt` and every run only queries docs whose timestamp is
newer than the last run (minus a 2-minute overlap for clock-skew / late crons):

```
GitHub Actions cron (every 15m)
  read pushState/_meta.lastRunAt                       (1 read)
  friendships where ts        > since                  (only NEW requests)
  friendships where acceptedAt> since                  (only NEW accepts)
  chats       where lastMsg.ts> since                  (only chats w/ a new msg — NO message reads)
  feed  (collection-group) where timestamp > since     (only NEW feed posts)
  posts (collection-group) where ts        > since     (only NEW club posts)
  clubs where ts              > since                  (only roster changes)
  → per new event: 1 pushState read (dedupe) + FCM send + 1 pushState write
  write pushState/_meta.lastRunAt                       (1 write)
```

So **reads scale with activity since the last run, not with total data.** Messages
are detected from the chat doc's own `lastMsg` preview + `reads{}` watermark, so the
`messages` subcollection is never read. A quiet app costs a handful of reads per run —
far inside Spark's **50k reads / 20k writes per day**. `users/{uid}` (tokens +
opt-out) is read at most once per user per run.

**Idempotency:** each push is keyed in `pushState/{key}` (get→send→set), so an
overlapping or late cron never double-sends. Keys embed the event timestamp, so a
genuinely new event re-notifies. No token yet → left unrecorded so it retries.

**First run is a no-op send:** it plants the cursor and records current club
memberships, then sends **nothing** — deploying the scanner never fires a
notification for the pre-existing backlog of friends/messages/clubs.

## Latency caveat (messages)

GitHub cron is best-effort at ~15-min granularity, which is great for friend
requests, accepts, feed and club posts. **New DMs can therefore arrive up to ~15
min late** — fine as a "you have messages" nudge, but not instant chat. Truly
instant message push needs a Firestore `onCreate` Cloud Function (Blaze). This
scanner is the $0 path; it delivers the message as a digest from `lastMsg`.

## Files

`scan.js` · `selftest.js` (`npm test`) · `package.json` ·
`.github/workflows/push.yml` (cron) · `.github/workflows/test.yml` ·
`firestore.indexes.json` · this README.

---

## ✅ One-time setup

### A. Firebase console (project `cookwithfriends-3b40e`)
1. **Cloud Messaging → Apple app config → APNs Authentication Key** → upload your
   **`.p8`**. ♻️ Reuse the same key from Tabby/Clawback — an APNs key is per Apple
   *team*. (Native push already works in the app; this is only needed if it wasn't
   uploaded for this project yet.)
2. **Cloud Messaging → Web configuration → Generate key pair** → copy the **Web
   Push certificate (VAPID public key)**. Put it in the app's `firebase-config.js`
   as `vapidKey` (the web-push client patch reads it). *(Skip if native-only.)*

### B. Firestore indexes
The two **collection-group** queries (`feed.timestamp`, `posts.ts`) need
collection-group indexes. Either deploy `firestore.indexes.json`
(`firebase deploy --only firestore:indexes`) **or** just run the scanner once —
the first such query prints a one-click console link to build each index. The
single-collection cursors (`friendships.ts`, `friendships.acceptedAt`, `clubs.ts`,
`chats.lastMsg.ts`) are auto-indexed and need nothing.

### C. Deploy the poller
3. Firebase console → Project settings → **Service accounts** → **Generate new
   private key** for `cookwithfriends-3b40e`.
4. Create a **new private GitHub repo** `cwf-push-scanner`, push the contents of
   `apps/CookWithFriendsPushScanner/` to its root.
5. Repo → Settings → Secrets and variables → Actions → **New secret**
   `FIREBASE_SERVICE_ACCOUNT` = the entire service-account JSON (one line).
6. Actions tab → enable → **Run workflow** once (this is the seed run) → then it
   runs every 15 min.

### D. Client patches (in the app repo — `apps/CookWithFriends`)
Push only works if the app **writes device tokens** and the scanner can read
opt-out. These ship with the scanner work:
- **`acceptedAt`** stamped on accept (enables event #2).
- **`notify` prefs** mirrored to `users/{uid}.notify` (enables per-category opt-out).
- **FCM token deleted on sign-out** (so pushes don't follow a signed-out device).
- **Web push**: `getToken()` with the VAPID key on web + a `push` /
  `notificationclick` handler in `sw.js` (native already registered tokens).

## Local testing
```bash
npm test                                            # offline pure-logic checks (no creds)
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scan.js   # real run
```
First real run seeds and sends nothing; the second onward delivers new events.

## Dependency chain
A push reaches a user only if they (1) signed in, (2) registered a device token
(native: automatic on sign-in; web: after granting permission with a VAPID key),
and (3) haven't muted that category. Until a second real user is signed in with a
token, the scanner will simply find 0 reachable recipients.
