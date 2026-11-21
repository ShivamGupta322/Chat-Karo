# Architecture Decision Records

Append new decisions at the bottom. Format: context → decision → consequences. Never rewrite an
accepted ADR; supersede it with a new one.

---

## ADR-001 — Geohash cells instead of per-user radius
**Status:** Accepted
**Context:** "Chat with people within 500 m" can mean a fixed grid or a radius around each user.
A radius gives every user a different audience, which doesn't map onto XMPP MUC rooms.
**Decision:** Use geohash cells; a room per cell. Range levels map to precisions 7 / 6 / 5.
**Consequences:** Simple, deterministic room JIDs. Boundary effect mitigated with hysteresis and an
optional neighbour view later.

## ADR-002 — MongooseIM on PostgreSQL; MongoDB for application data
**Status:** Accepted
**Context:** MongooseIM's supported backends are RDBMS (PostgreSQL/MySQL), Cassandra, Elasticsearch,
Redis etc. — not MongoDB. Writing a custom MongoDB backend for MongooseIM would be a large detour.
**Decision:** MongooseIM uses PostgreSQL for users and MAM. MongoDB stores app data owned by
geo_service: rooms, places, profiles, reports.
**Consequences:** Two databases to run (both in Docker Compose). Clear ownership boundary: XMPP
internals vs product data.

## ADR-003 — React + TypeScript + Vite for the web client
**Status:** Accepted
**Context:** Need a mobile-friendly web client with XMPP over WebSocket and a map.
Options considered: React, Vue, Svelte, Converse.js (pre-built XMPP UI).
**Decision:** React 18 + TypeScript + Vite, Strophe.js, react-leaflet, Zustand, Tailwind.
**Consequences:** Largest ecosystem and most recognisable for a resume; custom UI (not Converse.js)
so the location experience can be designed properly. We own the XMPP client layer — keep it isolated in `web/src/xmpp/`.

## ADR-004 — Ephemerality via TTL and archive limits
**Status:** Accepted
**Context:** Messages should feel local and temporary (24 h).
**Decision:** Client and API only request the last 24 h from MAM; a scheduled purge removes older
archive rows in PostgreSQL. MongoDB `rooms.lastActiveAt` and `reports.createdAt` use TTL indexes.
**Consequences:** Simple; no per-message timers.

## ADR-005 — Server-side room assignment; coordinates never stored
**Status:** Accepted
**Context:** Computing the geohash on the client is most private but gives no spoofing control.
**Decision:** Client sends coordinates to geo_service over HTTPS; geo_service validates, rate-limits,
computes the cell, then discards coordinates. Only the last cell centre + timestamp is kept in ETS
for jump detection.
**Consequences:** Room assignment can be enforced later (members-only rooms). Privacy claim is
"we never store or share your location", which must be upheld in code review.

## ADR-006 — Supervisor/coder agent workflow
**Status:** Accepted
**Context:** Solo developer using Claude Code; want planning and review separate from implementation.
**Decision:** `supervisor` agent (Opus) plans and reviews; `coder` agent (Sonnet) implements; the
main session orchestrates the loop via `/feature`, max 3 review rounds.
**Consequences:** Higher quality and a review trail; more tokens per feature, so trivial changes skip the loop.

## ADR-007 — MongooseIM 6.2.1, templated config, no in-band registration
**Status:** Accepted
**Context:** 6.2.1 is the newest release image on Docker Hub. MongooseIM's TOML has no env-var
interpolation and the image has no `envsubst`, but secrets must stay in `.env`.
**Decision:** Pin `mongooseim/mongooseim:6.2.1`. Keep config as `infra/mongooseim/mongooseim.toml.tmpl`;
a small `entrypoint.sh` renders it with `sed` from env vars into `/member/mongooseim.toml` (where the
image's `/start.sh` picks it up) and fails fast on missing variables. Drop `mod_register`, BOSH, s2s,
the client REST API and the domain/user GraphQL endpoints; accounts are created only through the admin
GraphQL API (dev: `mongooseimctl` in `dev-seed.sh`; later: geo_service). The admin API is not
published to the host. Usage-metrics reporting is disabled.
XMPP ports 5280/5222 bind to `127.0.0.1` by default (`XMPP_BIND_ADDR` opts in to LAN access for phone testing).
**Consequences:** Smaller attack surface and no open sign-ups. Config values may not contain `"`, `\`,
`{{`, `}}` or control characters — the entrypoint rejects them, and on failure prints only placeholder
names, never config lines. Upgrading MongooseIM means re-diffing the template against the new image's default config.

## ADR-008 — Web XMPP layer design
**Status:** Accepted (Phase 2, slice 2a)
**Context:** The web client needs a robust, testable XMPP layer, and components must never touch Strophe directly.
**Decision:**
- All XMPP logic lives in `web/src/xmpp/client.ts`, written against an `XmppTransport` interface. Strophe.js
  3.1.1 is the only adapter (`xmpp/strophe/stropheTransport.ts`), and ESLint `no-restricted-imports` forbids
  importing `strophe.js` anywhere else. Unit tests run the client against a fake transport with captured stanzas.
- Strophe 3.1.1's source has Node-only `require('ws'/'jsdom')` fallbacks. The `stropheNodeShims` Vite
  transform neutralises them. It is tied to the exact pin and warns if it stops matching after an upgrade.
- React stays on 18.3.1 per ADR-003, so the map in 2c uses react-leaflet 4.x.
- No optimistic rendering: the MUC echo is the source of truth for your own messages, so there are no duplicates.
- Client-side instant-room creation (`xmpp/roomCreation.ts`, marked TEMPORARY) is removed in the Phase 3 MUC lock-down.
- **MongooseIM 6.2.1 quirk:** self-presence status codes (110/201) arrive inside `<x xmlns="http://jabber.org/protocol/muc">`,
  not `muc#user`, so the parser accepts both namespaces (never `jabber:x:data`). MUC messages carry `<stanza-id by=room>`.
- Connection semantics: a user-initiated disconnect (button or `pagehide`) ends with no error. An unexpected drop
  ends with `connection-lost`. This is the hook slice 2b uses for reconnect. A failed or replaced Strophe
  connection is always closed, so sockets don't leak.
- Vite `envDir: '..'` reads the repo-root `.env`. This is safe only because Vite exposes `VITE_*` variables alone,
  so `envPrefix` must never be changed and `loadEnv(…, '')` must never be used.
**Consequences:** The XMPP logic is fully unit-testable (138 tests in 2a). Upgrading Strophe means re-checking
the shim warning and the status mapping in the adapter.

## ADR-009 — Product name "Nearby" and UI design tokens
**Status:** Accepted (Phase 2, slice 2a+, 2026-11-17)
**Context:** The UI needed a user-facing identity. The 2a screens used XMPP jargon ("JID", "Room JID") and default
browser styling. Nothing about branding had been decided before.
**Decision:**
- The product is called **Nearby** in every user-facing surface (UI, page title, README headline). **chatErl** stays the
  codebase name (repo, `web/package.json` name, Erlang apps, XMPP domain, env vars).
- Visual direction is "clean & calm": one teal accent (`#0f766e`), slate neutrals, automatic dark mode via
  `prefers-color-scheme` (no manual toggle).
- Colours exist only as semantic Tailwind v4 `@theme` tokens in `web/src/index.css`; raw palette classes are banned. Every
  token pair is documented at ≥ 4.5:1 (text) / ≥ 3:1 (UI boundaries) in both modes. Meta text on `surface-sunken`
  uses its own `bubble-meta` token, because `ink-muted` on that background is only 4.04:1 in dark mode.
- System font stack (no web fonts, which also keeps visitors' IPs away from third parties) and inline SVG for the logo and icons.
- User-facing text lives in `web/src/ui/text.ts` with no protocol jargon. The dev UI takes a username
  (`alice` → `alice@<domain>`) and a room name (`lobby` → `lobby@<muc domain>`) via `web/src/ui/addresses.ts`. Full
  addresses are never shown to users.
**Consequences:**
- A new colour means a new token plus a contrast check.
- The codename/product-name mismatch is deliberate and documented.
- Disabled controls may fall below 4.5:1; WCAG 1.4.3 exempts inactive components.
- The store binding moved from `xmpp/XmppProvider` to `state/useXmppStoreBinding` (called in `App`), so `xmpp/` no
  longer imports from `state/`.

## ADR-010 — Web client resilience: reconnect and keepalive
**Status:** Accepted (Phase 2, slice 2b-1, 2026-11-18). Amended by ADR-011: joins no longer request MUC history;
history comes from MAM.
**Context:** Sessions dropped on network blips, server restarts and backgrounded tabs. The 2a client then sent users back
to the login form, lost their room and left ghost occupants holding their nickname on the server.
**Decision:**
- **Backoff:** exponential, base 1 s, cap 30 s applied before ±20% jitter on every delay (24–36 s at the cap), reset after
  60 s of stable connection.
- **Wake triggers:**
  - `wake('visible')` (tab became visible) while reconnecting fires the pending retry early, at most once per 5 s.
  - An early attempt refunds its backoff step, so wakes never escalate the backoff.
  - `wake('user')` ("Try now") and `wake('online')` skip both throttles (the 5 s retry throttle while reconnecting and
    the 30 s probe throttle while connected). They still respect the in-flight guards (no fire while an attempt is in
    flight, one probe at a time) and the refund.
  - Live evidence:
    - With the browser pane flapping visibility every ~6 s and MongooseIM down for 30 s, the countdown went
      ~1, ~2–4, ~8, ~16 s and then held. Before the throttle and refund it reached 26 s after ~10 s.
    - "Try now" clicked with 4 s left started an attempt at once. After it failed, the retry was rescheduled at the
      same ~16 s step (17 s with jitter), not escalated.
- **Liveness probe:** on online/visible/"Try now" while connected, a XEP-0199 ping to the domain with a 5 s timeout.
  - `visible` probes are throttled to one per 30 s; the throttle resets on each connect; one probe in flight at a time.
  - Any reply means alive; only a timeout counts as stale (→ reconnect).
  - Live: pings at t=19 s and t=53 s over 75 s idle, versus every ~6 s before the throttle.
- **Credentials:** the password is kept in an in-memory closure only, so drops can be retried. It is never persisted,
  logged or emitted, and it is dropped on every terminal path. This supersedes ADR-008's "password not kept" bullet.
- **Connection semantics:**
  - A drop after a successful sign-in → `reconnecting`, with the Chat page kept and a banner.
  - Terminal only for: auth failure, stream conflict (session replaced), user sign-out, pagehide (including during a
    pending or in-flight retry).
  - Failures of the initial sign-in are not retried.
  - A transient auth failure during a full-stack restart is terminal; Strophe can't tell it from a revoked password.
- **No client XEP-0198 (stream management):** Strophe 3.1.1 lacks it, SM is opt-in per stream, and MongooseIM resumption
  doesn't survive a server restart (the main outage we handle). Reconnect + rejoin with history (and the MAM gap fill in
  2b-2) is simpler. Revisit only if MAM catch-up proves insufficient.
- **Server `mod_ping`:** `send_pings`, 60 s inactivity interval, `timeout_action = "kill"`, 32 s ping timeout. It reaps
  dead or frozen sessions in ~92 s and frees their nicknames. The client answers XEP-0199 pings with `type='result'`.
  - Live: a non-answering session was reaped in ~2 min, versus ghost occupants lasting 99 s+ (Probe A) and >241 s
    without mod_ping.
  - Caveat: the server's own ping to our app wasn't observable in testing, because client probes kept traffic inside
    the 60 s window.
- **Resources:** server-assigned resources are kept. A stable per-tab resource would turn a ghost session into a
  terminal stream conflict, and the replaced session's MUC `unavailable` would be routed to the new session.
- **`mod_websockets` `ping_rate`:** deferred to Phase 6 (reverse-proxy idle timeouts).
- **Rooms during an outage:**
  - Rooms become `suspended` (`room-suspended`; store status `reconnecting`).
  - After reconnect they are rejoined with the base nick; the nick-conflict retry is unchanged.
  - `historyMaxStanzas` (20) is kept on rejoin. Probe A showed history copies carry the same `stanza-id by=room`
    (e.g. `1G1`) as the live copy, so the store de-dupes them.
  - While reconnecting, the message list shows "Reconnecting… messages will appear here."
- **Timeline:** cleared only on a terminal disconnect; kept across reconnects and nick-conflict retries.
- **Close diagnostics:**
  - `console.warn('xmpp socket closed', {code, reason≤123, wasClean, hidden, hiddenForMs, msSinceVisible})`.
  - Logged only for connections that reached CONNECTED and that we didn't close ourselves. No JIDs, stanzas or
    coordinates.
  - Live: `{"code":1006,"reason":"","wasClean":false,"hidden":true,"hiddenForMs":4450,"msSinceVisible":5336}`, one
    record per outage.
  - The root cause of background-tab drops is still open until a real long-background drop is captured.
**Consequences:**
- Users ride out outages without re-entering credentials. The password lives in memory for the session.
- The close listener reads Strophe's private `_proto.socket`, which ties it to the strophe.js 3.1.1 pin alongside the
  ADR-008 shim. It is guarded, with a one-time warning if the field is missing. Re-check on any Strophe upgrade.
- Under continuous visibility flapping the countdown keeps restarting, while real attempts happen at most every 5 s.
  That's acceptable load, but the countdown can mislead.

## ADR-011 — Room history via MAM
**Status:** Accepted (Phase 2, slice 2b-2a, 2026-11-18). Amends ADR-010. **Extended by ADR-012**, which also corrects
this ADR's catch-up and initial-load live evidence.
**Context / root cause (MongooseIM 6.2.1):**
- `mod_muc_room:broadcast_room_packet` passes `timestamp => Activity#activity.message_time` to the MAM archive hook.
- `store_user_activity` only keeps the sender's activity record when a MUC rate limit is configured (non-zero
  `min_message_interval`/`min_presence_interval`, or a user shaper other than `none`). Ours had none.
- So `message_time` stayed 0, and `mod_mam_utils:generate_message_id(0)` (via the `mongoose_mam_id:next_unique` NIF)
  produced counter-like ids that restart from zero after every server restart.
- Symptoms: 1970 `<delay>` stamps; `start` filters matched nothing; after a restart, `duplicate_key` collisions
  (`archive_muc_single_message_failed`) silently dropped new messages from the archive.
**Decision:**
1. **Workaround: a mod_muc user message shaper.**
   - `user_message_shaper = "muc_user_msg"` in `[modules.mod_muc]`, plus `[shaper.muc_user_msg] max_rate = 100_000` (bytes/s).
   - Any configured user shaper makes `mod_muc_room` keep each sender's activity record, so `message_time` is the real
     send time and MAM ids and stamps come from real time.
   - This is a per-occupant rate limit on *room messages*, deliberately generous so it never throttles real chat. It
     does **not** change MAM query limits: `mam_shaper` (1 query/s per user) is untouched.
   - Risks:
     - Removing it or setting it to `none` brings the bug back.
     - Rooms now keep an activity record per active occupant (bounded by occupants).
     - Re-check `store_user_activity`/`broadcast_room_packet` on any MongooseIM upgrade. Track an upstream issue
       (not yet filed).
2. **Synchronous MUC archive writes** (`[modules.mod_mam.muc] async_writer.enabled = false`).
   - The room process is serial and archives each message before broadcasting it, so a message is either already in
     MAM when our join is processed or delivered live after it, never neither.
   - The default async writer flushes every 2 s, which left a window where a message could be in neither.
   - Cost: each room message waits for a PostgreSQL insert. Fine at our scale.
3. **History semantics:**
   - **No MUC join history:** every join and rejoin sends `<history maxstanzas="0"/>` (supersedes ADR-010's
     "`historyMaxStanzas` is kept on rejoin"). MAM is the only history source; mod_muc's in-memory history is lost on
     restart and races with MAM.
   - **Initial load:** MAM v2, `start` = now−24 h, RSM max 50 with `<before/>` (the newest ≤ 50), marked as history,
     with the "Earlier messages" divider.
   - **Reconnect catch-up:** `<after>lastSeenId</after>` paging forward (no `<before/>`), capped at 5 pages × 50. If the
     cap is hit before `complete`, keep what was fetched and show "Some messages from while you were away couldn't be
     loaded." No backward re-query.
   - **Missing anchor:** `item-not-found` on the first catch-up page falls back to the initial load, once.
   - **initialDone rule:** a catch-up runs only after a successful initial load. Until then every retry or rejoin is an
     initial load, even if live messages set the last-seen id. An initial query never carries `<after>`.
   - **Throttle:** a global client throttle of ≥ 1100 ms between MAM queries (the server's `mam_shaper` was seen to
     delay rather than reject). At most one query queued or in flight per room. `resource-constraint` →
     `history-failed`.
   - **Anti-spoof:** a result is accepted only if the outer `from` is exactly the room bare JID and the queryid
     matches. Stamps older than the 24 h start are dropped. Results never produce live `message` events.
   - **De-dupe:** by id (the live `<stanza-id by=room>` equals MAM `result@id`), and within batches.
   - **Ordering by position, not clock:**
     - Live messages are stamped with the client clock and MAM with the server `<delay>`, so a cross-clock sort would
       misorder on skewed devices.
     - History is inserted at an anchor: the timeline length at the latest `room-joined`, advanced per insert.
     - Live messages received after the join stay below it.
     - Accepted edge: if the initial load failed and the connection then drops, the rejoin's initial load lands at
       the new anchor, below the pre-drop live messages. No duplicates, but the order can look inverted.
   - **Errors:** `history-failed` with "Couldn't load recent messages." and a manual "Try again" (`retryHistory`).
     Never auto-retry, never throw.
   - **isOwn** in history is nick-based: a user who rejoined as `alice-2` sees older `alice` messages as not-own. Accepted.
   - **Window:** history is bounded to 24 h (ADR-004). Purging archive rows older than 24 h is Phase 4.
4. **Legacy rows:** 11 MUC archive rows with 1970 stamps remain (lobby 7, test1 2, test3 2; counted, not deleted).
   Deleting them needs the user's OK; the Phase 4 purge will remove them anyway. The client doesn't depend on deleting
   them: the server `start` filter and the client's stamp floor keep them from rendering.
**Live evidence (2026-11-18):**
- **Archive fix:**
  - ids are time-based after the fix (`CO4EUIA5RT81`, `CO4G5LO56CG1`, `CO4G5NLBN081`) with correct UTC stamps
  - the 24 h `start` query count rose by one per message, and the live stanza-id equals `result@id`
  - no `duplicate_key`/`archive_muc_single_message_failed` after a force-recreate, a restart and 9+ messages
  - `async_writer.enabled = false` accepted at boot
- **Catch-up:** alice's socket closed, then 3 messages sent 12 ms later → the rejoin sent one
  `<after>CO4G5NLBN081</after>` query. All 3 arrived only via MAM and rendered exactly once, in order. They were sent
  ~1.2 s before the query, inside the old async writer's window.
  - **Correction (found in slice 2b-2b):** this evidence did not actually exercise `<after>`, `<before/>` or `<max>`.
    The 2b-2a `buildMamQuery` gave the RSM children their own `xmlns` attribute (a coder deviation, "RSM children
    carry explicit xmlns", which was wrong), and MongooseIM 6.2.1 ignores RSM children that carry attributes.
    - So the server returned the oldest page from the window start every time, and de-dupe plus < 50 messages in
      the room hid it.
    - The initial load likewise showed the oldest ≤ 50 messages, not the newest.
    - The fix and the re-verified live evidence are recorded in ADR-012.
- **Restart:** after `docker compose restart mongooseim` the app reconnected and rejoined within 20 s. After signing
  in again, 6 messages rendered once each with real times and no 1970 stamps.
- **Failure and retry:** a dropped initial query timed out (15 s) and showed the failure notice. "Try again" sent a
  fresh `<before/>` query, and history rendered above a live message that had arrived meanwhile, without duplicates.
- **Throttle:** no `resource-constraint` in normal use (minimum 30.9 s between MAM queries). The ≥ 1100 ms throttle
  itself is covered by unit tests only.
**Consequences:**
- Phase 3 (private rooms, `default_room.public = false`): make sure the mod_mam_muc access rules still let occupants
  query their room.
- 2b-2b "Load earlier messages" builds on the RSM `first` id and the same throttle and one-in-flight guard.

## ADR-012 — Load earlier messages
**Status:** Accepted (Phase 2, slice 2b-2b, 2026-11-19). Extends ADR-011.
**Context:** A joined user can page back through the room's last 24 h (ADR-004), 50 per click. ADR-011's anti-spoof rules,
the ≥ 1100 ms global throttle and one query per room are unchanged.
**Decision:**
1. **Where earlier pages go:** directly before the timeline message whose id is the `<before>` anchor (the client's
   `firstId`), or at index 0 if it is absent.
   - This keeps Leave → Join of the same room correct (gap pages land between the old session and the new initial page).
   - `insertAt` moves up by the inserted count when the insertion index ≤ `insertAt`.
2. **firstId lifecycle (`TrackedRoom.firstId`, the `<before>` cursor):**
   - Set by an initial load only while null, to `fin.first ?? buffer[0]?.id` (null if that page is complete).
   - Replaced by each earlier page; null on complete or `item-not-found`.
   - Survives suspend/rejoin; never touched by gap pages or live messages.
   - "Only while null" because a gap `item-not-found` falls back to a new initial page that sits below the pre-drop messages.
3. **Earlier pages never change `lastSeenId`, `liveSinceHistory` or `initialDone`**, otherwise the next catch-up would
   start from an old id. Regression-tested.
4. **`item-not-found` on `<before>firstId</before>` means "nothing earlier"**, not a failure: loaded
   `{earlier, messages: [], done: true, complete: true}`. Other conditions → `history-failed {earlier}`.
5. **Complete** = `fin.complete || buffer.length === 0 || nextFirst === null`, for earlier and initial pages. An empty
   initial page with `complete='false'` now counts as complete, which keeps `canLoadEarlier` consistent with
   `firstId !== null`.
6. **Retry:** the button retries itself ("Try again", described by "Couldn't load earlier messages.") with the same
   `firstId`.
   - `history.failed` and the recent-history banner stay initial/gap only.
   - The store tracks `history.earlier: 'idle' | 'loading' | 'failed'`. Never an auto-retry.
7. **Cap (MAX_TIMELINE = 500):**
   - An earlier page is never trimmed from either end; only the newest part that fits (`500 − length`) is inserted.
   - When anything is dropped, or the timeline reaches 500 by any path, `canLoadEarlier` becomes false for that room
     session (invariant `canLoadEarlier ⇒ length < 500`).
8. **Visibility:** the button shows only when `joined && canLoadEarlier && !history.loading && !history.failed`. The
   client also rejects `loadEarlier` while any history query for the room is queued or in flight.
9. **Divider unchanged:** it stays after the same last history message.
10. **Layout and a11y:**
    - The button and its `role="status"` line sit inside the scroll container but outside `role="log"`; the `<ol>` no
      longer scrolls itself.
    - While loading: `aria-disabled` (not `disabled`) on the button and `aria-busy` on the log.
    - When the focused button disappears, focus moves to the log with `preventScroll`.
    - After a non-final page focus stays on the button, which has scrolled above the viewport (deliberate).
11. **Scroll preservation keeps the old first row in place, not a scrollHeight delta** (`components/scrollAnchor.ts`,
    pure `nextScrollTop`).
    - A snapshot of the first row's key and offsetTop is taken, refreshed at click time. After an earlier load, the
      change in that row's offsetTop is added to `scrollTop`; for that render this beats stick-to-bottom.
    - It is robust when an earlier page and a live message arrive in one batched render.
    - When a final empty or `item-not-found` page removes the button without a prepend, content shifts up by the
      button's height. The user is at the top, so the browser clamps it.
12. **No-progress guards:**
    - Earlier: `nextFirst === cursor.before` → complete, so it can't loop on the same page.
    - Gap: `fin.last === cursor.after` → done and `complete: true`, with no next page and no "couldn't be loaded" notice.
13. **Accepted implementation deviations:**
    - A complete initial page sets `firstId` to null.
    - The always-present status line reserves its height (`min-h-4`) so a failure doesn't shift rows.
    - The button's `onBlur` only forgets focus while the button is still in the DOM.
    - The gap-continue guard is `!done && fin.last !== null`.
**Root cause found in this slice (RSM children namespace):**
- The 2b-2a `buildMamQuery` passed `{xmlns: NS_RSM}` to `<max>`, `<before>` and `<after>`. `xmlEl` turns that into a
  real `xmlns` attribute and `Strophe.serialize` writes attributes verbatim, so the wire carried
  `<max xmlns="http://jabber.org/protocol/rsm">`.
- **MongooseIM 6.2.1 ignores RSM children that carry attributes.** A raw-XMPP A/B with otherwise identical queries:
  bare children → first index 77 of 127; attributed children → first index 0 (cursor ignored).
- Effect on 2b-2a: the initial load returned the *oldest* ≤ 50 in the window; `<after>` catch-up and `max` were never
  really exercised. De-dupe and rooms under 50 messages hid it. ADR-011's live evidence is corrected (see its
  Correction bullet).
- **Fix:** only `<set>` carries the RSM xmlns; the children are bare and inherit it. Rule (commented on `xmlEl`): pass
  xmlns only where the namespace changes.
- **Regression guards (12 of them failed against the old code):**
  - `tests/xmpp/mam.test.ts`: bare children, exact names, all 3 page variants.
  - `tests/xmpp/client.test.ts` `expectBareSet`: initial, gap and earlier IQs as sent through the fake transport.
  - `tests/xmpp/wireShape.test.ts`: no builder repeats its ancestor's xmlns.
  - `tests/xmpp/strophe/wire.test.ts`: real `Strophe.serialize` bytes. It is the only test importing strophe.js (ESLint
    override scoped to that folder) and must be carried over if the transport's serializer ever changes, because
    `XMLSerializer` would emit `xmlns=""` on the bare children.
- **Process lesson:** wire-level XMPP changes need a live A/B probe or a real-serializer test. DOM-level
  `namespaceURI` assertions cannot catch attribute-level problems.
**Live evidence (2026-11-19, MongooseIM 6.2.1, lobby seeded with 120 messages by a raw-XMPP probe; frames captured in the app):**
- **Probes:**
  - after the fix, `<max>5</max><before/>` → exactly 5 results, first index 122 of 127
  - `<before>bogus</before>` and `<before>1G1</before>` (a 1970 id outside the window) → `item-not-found`
- **2b-2a initial load re-verified:** `<before/>` max 50 → first index 77, count 127; seed 071–120 shown, one divider,
  button outside `role=log`.
- **Paging:**
  - click 1: `<before>` = initial fin first → 50 results, first index 27
  - click 2: `<before>` = previous fin first → 27 results, `complete='true'`, first index 0
  - all 127 shown once, ascending, one divider; button gone; focus on the log
- **Scroll:** click 2 top row 246.4 → 246.7 px; a fresh first click (keyboard) 352 → 352 px. An earlier −106 px reading
  was a stale manual measurement; the app's click-time snapshot matched the layout.
- **Keyboard:** one Tab from Leave reaches the button; a rapid double Enter → exactly one query; focus stays on the
  button after a non-final page and moves to the log after the final page.
- **Drop during a load:** click then socket close in one tick.
  - While reconnecting the button was hidden (with the banner).
  - After the rejoin the catch-up `<after>` ran and the button returned; the lost page did not appear.
  - The next Enter reused the same `<before>` (first index 40), then `complete='true'` at first index 0.
  - Final: 190 messages, each once and in order.
- **2b-2a catch-up re-verified:** `<after>` her last seen id → exactly 3 results, first index 127, `complete='true'`;
  each shown once, none live.
- **Multi-page catch-up:**
  - 60 messages sent while offline → 2 queries, the second `<after>` = the first fin's `last`, sent **1111 ms apart**
    (throttle observed live)
  - fins at first index 130 (not complete) then 180 `complete='true'`
  - all 60 shown once and in order, no notice
- No `duplicate_key` in the MongooseIM logs.
**Caveats:**
- A live message arriving during an earlier load was not verified live (loads finish in ~120 ms; the second test
  client's background connection kept dropping). Covered by the scrollAnchor unit and jsdom tests.
- The "Loading…"/`aria-disabled` state was not observable live (~120 ms). Covered by component tests.
- Screen readers may announce prepended messages once `aria-busy` clears (accepted, same as 2b-2a).
**Consequences:**
- Auto-load on scroll, a "start of last 24 h" marker and virtualising the 500 cap are out of scope.
- The 120 seeded rows stay in the lobby's window until the Phase 4 purge. The legacy 1970 rows remain (delete only with
  the user's OK).

## ADR-013 — Temporary client-side cell assignment and location states
**Status:** Accepted (Phase 2, slice 2c-1, 2026-11-19). A **temporary deviation from ADR-005** until Phase 3. Builds on
ADR-001 (cells), ADR-008 (transport seam, instant rooms) and ADR-009 (tokens, plain-language text).
**Context:** Phase 2 ends with "client-side geohash, join room, chat" before geo_service exists. ADR-005 says the server
assigns rooms and coordinates are never stored; this slice has to compute the cell in the browser.
**Decision:**
1. **Own encoder, not ngeohash.** `geo/geohash.ts` is a ~60-line pure, encode-only function with a tagged result that
   never throws. It needs no `@types`, no CommonJS interop and no new dependency, and Phase 4 hysteresis reuses it.
   Only precision 7 (the "Block" cell, ADR-001) is used: `CellPrecision = 7`.
2. **Coordinates stay transient inside `web/src/geo/`.**
   - A position exists only as a local inside the `watchPosition` success callback and is converted with `cellFor`
     immediately. The dev picker's two input fields are the only other place raw numbers live, and they are cleared once a
     spot is applied.
   - Everything else (state, props, stores, stanzas, room names) holds a `Cell` (`{precision, geohash}`) or an area code.
   - Guards: `geo/index.ts` is the only public entry; ESLint bans deep `geo/*` imports from outside `geo/`, bans any geo
     import from `src/xmpp/**` (including the Strophe adapter), and sets `no-console` with no allow list inside `src/geo/**`.
     Note: a bare `'error'` would inherit the base `allow: ['warn','error']`, so the geo block passes explicit empty options.
   - Never stored, logged or put in an error object (`GeolocationPositionError.message` is never read).
3. **When the room changes:** only on the first device fix, on a dev spot in a different cell, on an explicit
   "Switch to my new area", on "Use my real location" (back to the device cell), or when location is lost (leave the
   room). Later device fixes only raise a "You seem to have moved" prompt. They never switch rooms on their own
   (hysteresis and auto-switching are Phase 4).
4. **Room controller (`state/useAreaRoom.ts`)** reconciles the desired room (or none) with the client:
   - leave the current room if it is active (joining, joined, reconnecting) and differs from the desired one, then join
     the desired room once connected;
   - a switch while reconnecting leaves the old room with no stanza (it is untracked, so it is not rejoined) and the new
     room is joined once on `connected`;
   - the same room is never touched: the client rejoins suspended rooms itself, and a failed or left room waits for the
     user's "Join again" (no automatic retry);
   - the effect re-reads the stores, so StrictMode and quick re-renders cannot join twice.
   - The page never shows another room's data. Until the room store's `roomJid` equals the desired room (`current`), the
     timeline and occupants render empty, history status and "Load earlier" are hidden, and the composer is disabled.
   The manual room form (`RoomForm`) is removed: a manual toggle would fight a single desired room.
5. **Geolocation options:** `enableHighAccuracy: false`, `timeout: 20 s`, `maximumAge: 60 s`. A ~150 m cell does not need
   GPS, but desktop browsers may then give an IP-based position kilometres off (accepted; Phase 3 validates server-side).
   Permission states use the Permissions API when present (Safari below 16 has none), and an insecure context is
   checked first because it can expose `geolocation` yet fail with code 1.
6. **Dev picker:** a keyboard-accessible "Test locations (dev)" panel (three presets plus latitude/longitude), rendered
   only behind a literal `import.meta.env.DEV`, so the picker, its strings and the presets tree-shake out of production
   builds (checked by grepping `dist/` for the preset labels, picker strings and preset coordinates; the "Test spot" badge
   in `AREA_TEXT` ships on purpose). Its strings live in `geo/devLocationText.ts` so the "no coordinate words outside
   geo/" grep stays clean. This is a deliberate, narrow exception to ADR-009 (UI text in `ui/text.ts`); every other
   string, including `AREA_TEXT`, stays in `ui/text.ts`. The Leaflet map picker is slice 2c-2.
7. **Layout carry-forward:** on md and wider the page is viewport-height (`md:h-dvh`), `<main>` is a grid with
   `md:grid-rows-[minmax(0,1fr)]` (needed so the row has a definite height), and the message list is the flex-1 scroll
   container inside the card. The scroll owner and scrollAnchor are unchanged; below md the flow layout is kept.
8. **Accepted implementation deviations:**
   - `useArea` adjusts `committed` during render (no extra effect).
   - The dev picker accepts plain decimals only and clears its fields after applying.
   - "Join again" sits in the status line.
   - A failed or left current room shows an empty message list (the status line explains).
**Known leaks (dev only, accepted until Phase 3):**
- Anyone can join any `g7_` room: there is no client-side spoofing control.
- `default_room.public = true` lists active cell rooms through disco, which reveals which cells are active.
- `persistent = true` keeps every visited cell room in PostgreSQL.
- The area code on screen shows up in screenshots and GIFs.
- Being in a cell room tells co-occupants your ~150 m cell. That is the product, but it is worth saying plainly.
- In 2c-2, map tile requests will reveal the viewed area (see ADR-014).
**Consequences:**
- Signing out unmounts the chat, which clears the watch and forgets any dev spot; after signing in again a granted
  permission starts the watch automatically.
- Phase 3 deletes `roomJidForCell` and its single call site in `pages/Chat.tsx` when `/api/locate` assigns rooms;
  `cellFor` and the encoder stay.
- `ui/addresses.ts` (`toRoomJid`, `roomLabel`) and the room branch of `describeAddressError` are now unused by the UI and
  are Phase 3 cleanup candidates.
**Live evidence (2026-11-19, `npm run dev`, MongooseIM 6.2.1):**
- **Denied state (AC14):** the browser pane had geolocation blocked → the denied text plus "Or choose a test location
  below.", a "Try location again" button and the "Test locations (dev)" panel; composer disabled; no join presence sent.
- **Keyboard only:** "Try location again" → Tab → summary (Enter opens) → Tab → "Test spot A" → Enter → exactly one
  `<presence to="g7_u4pruyd@muc.chaterl.localhost/alice">` with `<history maxstanzas="0"/>`, one MAM query to the same
  room, "You're in Area u4pruyd as alice", "No messages yet. Say hello!".
- **Two people, one area, then moving (AC13):**
  - alice and bob on spot A → both in `g7_u4pruyd`, "People here · 2", messages delivered both ways.
  - bob → spot B → `g7_u4pruye`, empty log, "People here · 1"; alice saw "bob left".
  - bob → spot A again → both earlier messages back from the archive above "Earlier messages ↑", People · 2.
- **Privacy (AC8):**
  - All 33 WebSocket frames in alice's tab contained no coordinate values (57.6…, 10.40…, 51.507…, -0.127…) and none of
    lat/lon/lng/latitude/longitude/coord(s).
  - Only `g7_u4pruyd` was joined; localStorage and sessionStorage were empty; no URL query or hash.
- **Layout (AC10):** with 102 messages in `g7_u4pruyd`:
  - At 1280×800 the page did not scroll (scrollingElement 800/800) and had no horizontal scroll. The message list
    scrolled internally (4490/234 with the dev panel open) and stayed at the bottom while 100 live messages arrived.
  - At 360×640 there was no horizontal overflow (360/360).
- **Production bundle (AC9):** no preset labels, picker strings or preset coordinates in `web/dist`.
**Caveats:**
- "Switch to my new area" needs real movement and was not verified live (unit-tested).
- A switch while reconnecting was not verified live (hook and integration tests).
- Load-earlier scroll preservation was not re-measured live after the layout change (ADR-012 tests pass; scroll container
  unchanged).
- The README demo was not run from a clean checkout.

## ADR-014 — Dev-only Leaflet map picker
**Date:** 2026-11-19 · **Status:** accepted
**Context:** The dev "Test locations" panel only had presets and typed fields. A map makes testing neighbouring cells quicker.
It must never reach a production build and must not show or keep the exact clicked point.
**Decisions:**
1. **Dependencies (exact pins):**
   - `leaflet` 1.9.4 (BSD-2-Clause) and `react-leaflet` 4.2.1 (Hippocratic-2.1) in `dependencies`; `@types/leaflet` 1.9.22 (MIT)
     in `devDependencies`. Transitive: `@react-leaflet/core` 2.1.0, `@types/geojson`.
   - react-leaflet 5 needs React 19, which ADR-008 rules out. `@types/leaflet` is needed because leaflet 1.9.4 ships no types
     and react-leaflet's declarations import from it (otherwise the types become `any` and the no-unsafe lint rules fail).
   - Hippocratic-2.1 is "ethical source" and **not OSI-approved**. That is fine for a portfolio, but some employers disallow
     non-OSI licences. It is mitigated because nothing from react-leaflet ships in production.
   - They are `dependencies` because they are browser runtime code and the future product map (ADR-003) will use them.
     Keeping them out of production is enforced by the DEV guard and the dist grep below.
2. **Lazy and dev-only mechanism:**
   - `DevLocationPicker` creates the lazy component only behind a literal `import.meta.env.DEV ? lazy(...) : null`
     ternary. A bare top-level `lazy()` call is not provably pure, so Rollup would keep the dynamic import and emit a chunk.
   - The Leaflet CSS is imported only in `DevMap.tsx`, so it travels with the lazy chunk.
   - The map mounts only while the `<details>` panel is open and unmounts on close: no chunk load or tile request until
     asked, and Leaflet never initialises in a zero-size hidden container.
   - `main.tsx` passes explicit env keys to `parseConfig`, with `VITE_MAP_TILE_URL` behind `import.meta.env.DEV`.
     Passing the whole env object made Rollup keep every key that `parseConfig` reads as a literal, so the tile URL
     would have shipped.
   - An ESLint `LEAFLET` restriction allows only `src/geo/DevMap.tsx` to import leaflet or react-leaflet.
   - The check that counts is the production build grep (see Live evidence): no leaflet, tile host or map strings in `dist`.
     The validator's own error text and `{z}` still ship; that is config validation, not map code.
3. **A cell rectangle, not a point marker.** `DevMap` draws only the whole cell (from `decodeGeohashBounds`) and has no
   state, no marker and no `locate`. It is centred on the dev cell, or on test spot A when none is set, never on the device.
   A clicked point exists only in the Leaflet event, then `onPick`, then `override.set`, then a `Cell`. A world-wrapped
   click longitude goes through `wrapLng` first, or `cellFor` would reject it.
4. **Tile privacy and the OSM policy.** Each tile request tells the tile server the viewed area plus the IP (dev only).
   Keep the on-map attribution, no `no-referrer` policy (OSM requires a Referer), no prefetching or offline caching.
   The attribution is **fixed in code** (`DEV_MAP_TEXT.attribution`): Leaflet renders it as HTML, so an env-supplied value
   would be an injection path. Anyone switching tile providers edits that constant.
5. **Accessibility.** The map is optional, last in the panel, and has `role="region"`, a label and a described-by hint.
   The presets and typed fields are the complete keyboard path (arrow keys and +/- also work when the map is focused).
   Wheel zoom is off so the page still scrolls. Loading and failure are `role="status"` text; an error boundary keeps a
   failed chunk from taking down the chat.
6. **`optimizeDeps.include`** for `leaflet` and `react-leaflet`: without it the first map open would trigger a Vite
   re-optimise and a page reload, losing the dev spot.
7. **Fold-ins from 2c-1:** `desiredRoomJid` is computed directly (a string, so effect deps compare by value); the
   `useMemo` is dropped (keying it on `cell?.geohash` while reading `cell` fails exhaustive-deps). "Join again" moved out of the status
   paragraph with focus handed to the status line; no empty `<li>` for an empty message-list text; `AREA_TEXT.left`.
**Live evidence (2026-11-19, `npm run dev`, MongooseIM 6.2.1, OSM tiles; frames captured in the app):**
- Opening the panel lazy-loaded the map without a page reload. The page had just re-optimised dependencies after the
  lockfile change, and no second reload happened. OSM tiles loaded and the attribution was visible. The container had
  `role="region"`, the label "Test location map" and `aria-describedby` pointing at the hint. No markers were drawn.
- A click near test spot A joined `g7_u4pruyd`: one join presence (`maxstanzas="0"`) plus one MAM query. One rectangle
  (`stroke-accent fill-accent`) covered the cell and the "Test spot" badge showed.
- A click in the cell to the east switched to `g7_u4pruye`: exactly one `unavailable` presence plus one join. A second
  click inside the same cell sent zero stanzas.
- Test spot C recentred the map on London (`g7_gcpvj0d`) with the cell rectangle fully in view.
- Closing the panel unmounted the map (no `.leaflet-container` left); reopening remounted it with the rectangle. There was
  no "Map container is already initialized" error under StrictMode.
- Two users: bob (second tab) chose spot C and saw alice in `g7_gcpvj0d`, then clicked the neighbour on his map and
  landed in `g7_gcpvj0e`. Alice saw "bob left" from a single unavailable presence.
- Privacy: the captured WebSocket frames contained no `lat|lng|latitude|longitude|coord` and no `-?\d{1,3}\.\d{4,}` numbers.
- 360×640 with the panel open: `scrollWidth` 360 (no horizontal overflow), map 309×192. The map scrolls under the sticky
  header (z-10) because its wrapper has `isolation: isolate`.
- Keyboard: with the map focused, ArrowLeft panned it, and Tab moved through the map's own controls and then out of
  the map (no focus trap). A focused-map keydown of `-` (keyCode 189) zoomed from 16 to 15 and `+` (187) back to 16.
  These were dispatched with real key codes, because the test harness sends `keyCode 0` for `-`/`+`; arrow keys used
  real key presses.
- 1280×800: panel closed `scrollHeight` 800/800; panel open 858/800, with the chat card squeezed to a sliver. This is
  accepted for a dev-only panel, and a nested scroll container was rejected (AC9 amended: with the panel open the page
  may scroll by the excess; with it closed it does not).
- Dark mode (emulated `prefers-color-scheme: dark`): tiles stay light (no filter), the frame uses the dark `line` token
  (rgb(51, 65, 85)) and the cell outline keeps the accent teal. Leaflet's own zoom buttons stay white (Leaflet default,
  not overridden on purpose).
- The "pane flips visibility every ~6 s" noise was not specifically observed this run. One background-tab socket drop
  and reconnect happened, noted below.
- Production build with `VITE_MAP_TILE_URL` set in the shell: still one JS and one CSS file. JS was 252 073 B (+940 vs the
  d50b137 baseline) and CSS 16 171 B (+280). A grep for `leaflet|openstreetmap|tile\.|Loading map|Test location map|show a map here|Test locations|Test spot A`
  found nothing, and neither did a case-sensitive `L\.map`. The plan's case-insensitive `L\.map` also matched a minified
  `l.map(` array call, which is a false positive that is in the baseline too.
- Seen but not caused by this slice:
  - At a 1.25 device-pixel ratio, faint seams can show between tiles (Leaflet sub-pixel rendering). Tile `max-width` is
    `none`, so the Tailwind preflight is not involved.
  - When the background tab's socket dropped, the reconnect rejoined as `alice-2` until the old occupant timed out.
    That is the existing reconnect and ghost-occupant behaviour (ADR-010).

## ADR-015 — geo_service foundation
**Status:** Accepted
**Context:** Phase 3 needs a supervised Erlang service that serves HTTP, takes its config from the environment and
computes geohash cells. Slice 3a delivers only the skeleton: `GET /api/health`, validated config and a pure `geohash`
module. Mongo, auth and `/api/locate` come in 3b-3d.
**Decision:**
- **OTP 27+ (pinned image 28.4.2)**, so the stdlib `json` module replaces a third-party JSON dependency. This supersedes
  CLAUDE.md's "Erlang/OTP 26+" (the CLAUDE.md edit is pending with the user). `rebar.config` has `minimum_otp_vsn "27"`.
- **Pins:** cowboy 2.21.0 (ISC), cowlib 2.22.0 (ISC, transitive), ranch 2.4.0 (ISC, transitive), all locked in
  `rebar.lock`. PropEr 1.5.0 (GPL-3.0) is in the **test profile only**, so it never ships in the release. erlfmt 1.9.0
  (Apache-2.0) is a `project_plugin`. `plt_extra_apps [cowlib]` lets Dialyzer resolve the cowlib types that `cowboy_req` references (ranch is a declared application, so it is in the PLT already).
- **Embedded listener:** `geo_http:child_spec/1` uses `ranch:child_spec/5` with `cowboy_clear`, and `connection_type
  => supervisor` in both option maps (as `cowboy:start_clear/3` does). The listener lives under `geo_service_sup`;
  `geo_http_SUITE` kills it and checks that it restarts.
- **Config:** `config/sys.config.src` holds quoted env strings (`"${GEO_HTTP_PORT}"`), so an unset variable becomes `""`.
  `geo_config` (the only module reading app env) rejects bad values, and `geo_service_app` logs only the key name
  (`event => bad_config, key => http_port`), never the value.
- **Port:** 8080, published on `127.0.0.1` only; `GEO_HTTP_PORT` is both the container and the host port, and
  `VITE_API_URL` must match.
- **Image:** multi-stage build, `erlang:28.4.2-slim` runtime with curl for the healthcheck, non-root user `geo`, no baked-in
  port. `vm.args.src` has only `-sname geo_service`: no cookie until clustering in Phase 6. The release bundles ERTS
  (relx `mode prod`) from the build stage; the build and runtime images share the OTP 28.4.2 tag and Debian release, so
  the bundled ERTS is ABI-compatible. Later hardening can move the runtime to a plain Debian slim base to shrink the
  image (555 MB today). The runtime sets `ERL_CRASH_DUMP_SECONDS=0` because crash dumps can contain app env, which will
  hold secrets from 3c on.
- **Geometric neighbours:** `geohash:neighbour/2` steps from the cell centre by one cell height/width, wraps longitude
  at ±180, omits directions past a pole and re-encodes. There are no border lookup tables. Cell sizes are dyadic, so the
  floats are exact; PropEr properties and the published vectors back this.
- **3b driver finding:** the hex `mongodb_erlang` 3.4.0 has only the legacy opcodes that MongoDB 6+ removed. Slice 3b
  must use comtihon/mongodb-erlang master (v3.6.10, OP_MSG) as a pinned git dep, with emqx/mongodb-erlang as the
  fallback, and stop and escalate if neither works with Mongo 7.

**Consequences:** `rebar3 as prod release` is only run inside Docker (not on Windows). `.gitattributes` forces LF for Erlang
files, the Dockerfile and config. Health is liveness only; readiness of Mongo is added in 3b.

### Live evidence
**2026-11-20, Docker Desktop on Windows, image `chaterl/geo_service:dev`:**
- `docker compose build geo_service` succeeded. `/opt/geo_service` contains `bin`, `erts-16.3.1`, `lib` and `releases`,
  with no `_build` or `test/`. The process runs as uid 1000 (`geo`). The image is 555 MB.
- `docker compose ps`: all four services healthy; geo_service is published as `127.0.0.1:8080->8080/tcp`
  (`docker compose port geo_service 8080` → `127.0.0.1:8080`).
- `curl -i http://127.0.0.1:8080/api/health` → `200`, `content-type: application/json`, `cache-control: no-store`,
  `x-content-type-options: nosniff`, body `{"status":"ok"}`, in 11–34 ms. HEAD → 200. POST → `405` with
  `allow: GET, HEAD` and `{"error":"method_not_allowed",...}`. `/nope` → `404` `{"error":"not_found",...}`.
- `docker compose run --rm -e GEO_HTTP_PORT=abc geo_service` exited 1 with
  `application_start_failure ... {bad_config,http_port}`; `abc` appeared 0 times in the output. An empty
  `GEO_HTTP_PORT` failed the same way. Each run took 19–31 s wall time, mostly Docker Desktop container creation; the
  node itself fails at boot, so the "~10 s" criterion is accepted (it means fail fast, not hang). Round 1 wrote an `erl_crash.dump` on a failed boot; after round 2 (`ERL_CRASH_DUMP_SECONDS=0`) a failed boot in a kept (non-`--rm`) container left no `/opt/geo_service/erl_crash.dump`.
- `docker compose stop geo_service` took 3 s (log: `SIGTERM received - shutting down`) and exited with code 0.
- `MSYS_NO_PATHCONV=1 docker compose exec geo_service /opt/geo_service/bin/geo_service ping` → `pong` (no committed cookie).
- Round 2 rebuild: still healthy, health 200, `pong`, `/opt/geo_service` still has `erts-16.3.1` (bundled by relx `mode prod`, now stated in the config and above). The 555 MB size is accepted for 3a; a slimmer runtime base is deferred to hardening.

---

## ADR-016 — MongoDB driver, readiness and Atlas-ready config
**Status:** Accepted
**Context:** Slice 3b connects geo_service to MongoDB. The hex `mongodb_erlang` 3.4.0 only speaks the legacy opcodes
that MongoDB 6+ removed (ADR-015), so a supervisor spike tested comtihon/mongodb-erlang master against Mongo 7.0.48 on
OTP 28.4.2 (OP_MSG).
**Decision:**
- **Driver and pins** (all in `rebar.lock`): `mongodb` comtihon/mongodb-erlang master @
  `b17302e7f4f128cf2113a665a5d300b66829cd5d` (3.6.10, Apache-2.0); transitive `bson` v0.2.4 @
  `f5a8c7030dd0107d2eed99059bc09c53ebe5e5dd` (Apache-2.0), `poolboy` 1.6.1 (comtihon fork) @
  `6b5212c4cb20b85e57c9627bb0940c126f4e0766` (ISC), `pbkdf2` @ `5201a735639496fc595061160117e4ec155d73f5` (Apache-2.0;
  dead code on OTP 24+, its three removed-crypto compile warnings are expected). Forbidden: hex `mongodb_erlang`, the
  emqx fork, an own OP_MSG client. No `rebar3 upgrade` of the poolboy fork branch without review. `plt_extra_apps` gains
  `bson` and `poolboy`.
- **Spike evidence:** connect and ping; update with upsert; find_one; createIndexes (2dsphere, TTL); `$near`;
  `erlang:timestamp()` dates (ms precision); GeoJSON `[lng, lat]` round trip; 50 concurrent calls on a pool of 3; Mongo
  down at start gives `{ok, Pid}` and `{error, timeout}` calls; self-recovery after a late Mongo start; a killed topology
  cleans up its processes and the name can be re-registered; SCRAM with `auth_source` works for SHA-1 users (SHA-256-only
  users fail); TLS `verify_peer` with a CA file and the https hostname match fun works, an unknown CA or a hostname
  mismatch is rejected.
- **Driver quirks and their handling:**
  1. A failed write returns `{true, #{<<"writeErrors">> := [...]}}`: `geo_mongo:classify_write/1` always checks
     `writeErrors` and `writeConcernError`.
  2. The `mongo_api:command/3` spec is wrong for Dialyzer: ping uses `mongoc:transaction/4` with
     `mc_worker_api:command/2`.
  3. There is no call timeout by default: `mc_utils:get_timeout/0` reads `mc_worker_call_timeout` from the CALLING
     process's application, so geo_service's app env sets `{mc_worker_call_timeout, 5000}` (it only applies to processes
     of this application; CT processes have none, which is fine).
  4. The password leaks into poolboy/supervisor/mc_server crash reports: the `geo_log_redact` primary filter.
  5. The driver logs through `error_logger` and may include the command document: only cell data reaches `geo_store`.
  6. A missing topology raises `exit:{noproc, _}` in the caller: every `geo_mongo` wrapper catches `exit:_` and returns
     `{error, mongo_unavailable}`.
  7. `mc_server` and `mc_monitor` processes are still not OTP-supervised by the driver (they stop with the topology,
     verified): accepted. The driver's service processes (`mongo_id_server`, `mc_worker_pid_info`, the pool supervisor)
     are no longer started by `mc_super_sup`; they run under `geo_mongo_sup` (see quirk 9).
  8. SRV works only for a single connection (random host, no TXT): see the Atlas section.
  9. **Orphan pools after a Mongo outage.** `mc_pool_sup` makes its `worker_pool` child TRANSIENT (intensity
     1000/3600). When Mongo goes away poolboy cannot start a worker and crashes, and `mc_pool_sup` retries in a tight
     loop (4 crash reports per retry) while `mc_server` has already dropped that pool and later starts a new one. When
     Mongo returns, the retried pool is an orphan holding `pool_size` connections: measured +5 connections per outage
     (a `docker compose pause` of Mongo did the same in round 1: `mc_server`'s `update_unknown` killed the pool with
     `exit(Pool, kill)`, and the transient spec restarted it as an orphan), and round 1 logged 2873 lines in ~45 s. Handling: `mongodb` is an
     included application (loaded and in the release, never started, so `mongo_app` and `mc_super_sup` do not run);
     `geo_mongo_sup` runs the driver's service processes, with `geo_mongo_pool_sup` registered as `mc_pool_sup`
     (`mc_pool_sup:start_pool/2` finds it by name, `mongoc:connect/3` sees `already_started`) and its pool children
     TEMPORARY, so `mc_server` alone owns each pool's lifecycle. The driver is not patched.
  10. **Heartbeat connection leak on a hung server (fixed in slice 3b.1).** `mc_monitor:check/2` opens a
     connection per heartbeat (`mc_worker_api:connect/1`, linked to the monitor) and only calls `disconnect` after a
     successful `hello`. When TCP connects but Mongo does not answer within 5 s (a stalled mongod: `docker pause`,
     SIGSTOP, disk or VM freeze), `hello` exits, the monitor's `catch _:_` swallows it, and the worker stays alive
     (hibernating, socket open): the monitor traps exits and ignores that worker. Rate: about one leaked connection per
     10–11 s of hang; mongod never closes idle client connections, so they persist until Mongo, the topology or
     geo_service restarts (restarting geo_service clears them). Observed 5 → 6 → 8 → 10 connections over three 20 s
     pauses. A refused connect (Mongo stopped, most partitions) and server-side closes (Atlas failover/maintenance) do
     not leak. No data or privacy impact. **Fix (slice 3b.1):** `geo_mongo_probe` runs a reaper on its 5 s probe tick.
     `geo_mongo_reaper:candidates/0` lists the `mc_worker` processes linked to the `mc_monitor` (identified by initial
     call, so a driver upgrade must re-verify it); `select/4` picks those first seen at least 30 s ago (a live heartbeat
     check lasts at most ~20 s (2 × connectTimeoutMS + 2 × call timeout), so none in progress is touched); the probe stops them with the public
     `mc_worker_api:disconnect/1` (the monitor ignores that normal exit) and logs `mongo_heartbeat_reaped` at notice
     level with a count only. Checked by `proxy_blackhole_no_heartbeat_leak`: the proxy blackholes traffic for 35 s (at
     least 1 abandoned worker must exist, so the test cannot pass vacuously), then forwards again, and within 90 s,
     polled every second, there must be 0 abandoned workers and at most pool size + 1 upstream sockets, with one pool.
     Without the reaper the case fails with 2 abandoned workers and 7 sockets; with it, three runs converged after 20,
     6 and 15 s (5 sockets). `{use_legacy_protocol, false}` in the worker options was not adopted: `mc_monitor` builds the heartbeat
     connection args from host, port, timeout and TLS only, so the option would not reach the heartbeat workers.
- **Topology placement:** a permanent worker child of `geo_mongo_sup` (`rest_for_one`, intensity 5 / period 10),
  registered as `geo_mongo_topology` (`geo_mongo:child_spec/1`: `{mongoc, connect, [Seed, TopologyOpts, WorkerOpts]}`).
  Child order: `mongo_id_server`, `mc_worker_pid_info`, `geo_mongo_pool_sup` (as `mc_pool_sup`), the topology,
  `geo_mongo_probe`; `geo_service_sup` runs `geo_mongo_sup` then `geo_http`. Pool size comes from `MONGO_POOL_SIZE` (default 5, `max_overflow` 0), `serverSelectionTimeoutMS` 2000.
- **Liveness vs readiness:** `/api/health` stays pure liveness (200 whatever Mongo does). `/api/ready` reads the
  `geo_mongo_status` ETS table written by `geo_mongo_probe` (ping every 5 s; a transition is logged once as
  `mongo_ready` or `mongo_unavailable`, never with a reason). The compose healthcheck uses `/api/ready`: Docker does not
  restart unhealthy containers, so a Mongo outage cannot cause a crash loop. The app boots degraded when Mongo is down
  and reconnects by itself; configuration errors, by contrast, fail fast at start (key name only logged).
  `depends_on: mongo: service_healthy` in compose is dev start ordering only.
- **Atlas-ready, env only:** Docker Mongo stays the dev and Phase 6 VPS database; Atlas becomes an env-only switch via
  `MONGO_HOSTS` (host list), `MONGO_REPLICA_SET`, `MONGO_USER`/`MONGO_PASSWORD`, `MONGO_AUTH_SOURCE`, `MONGO_TLS`,
  `MONGO_TLS_CA_FILE`. Limits: SCRAM-SHA-1 only (a SHA-256-only user fails), no `mongodb+srv://` (the SRV/TXT records
  must be resolved by hand into a host list), and replica-set mode was not verified against a real replica set. Checklist
  for an Atlas user: create a user with SCRAM-SHA-1 and an alphanumeric password; resolve SRV/TXT into `MONGO_HOSTS`,
  `MONGO_REPLICA_SET`, `MONGO_AUTH_SOURCE=admin`, `MONGO_TLS=true`; add the VPS IP to Atlas' IP access list; run
  `init-indexes.js` once; then check `/api/ready` = 200 and that the password is absent from the logs.
- **Redaction and password charset:** `geo_log_redact:install/1` runs before the supervisor starts and replaces the
  password (binary or char list, anywhere inside tuples/lists/maps/binaries) with `[REDACTED]`. The password may only
  contain printable ASCII (32..126), no `"` and no `\`, so that it survives the rendered `sys.config` string unchanged; an alphanumeric
  password is the safest choice (avoid `$` too, since compose and shells expand it).
- **No code-created indexes:** `infra/mongo/init-indexes.js` is the single source; the code only relies on `_id`,
  `center_2dsphere` and `lastActiveAt_ttl` (`geo_mongo_SUITE` has a drift guard on the script). Atlas needs a one-time
  manual run.
- **Privacy:** `geo_store` has no latitude/longitude parameters; a rooms document has exactly the keys `_id`,
  `precision`, `geohash`, `center` (the cell centre, not a user position), `createdAt`, `lastActiveAt`.

**Consequences:** the first geo_service module that talks to a database; the Docker image needs `ca-certificates` for TLS;
a topology crash loop would stop the application (supervisor intensity 5/10), which the spike never triggered.
Log noise while Mongo is down: the driver's own reports are not rate-limited (round 1 measured thousands of lines before
quirk 9 was fixed); with temporary pool children the outage log is bounded (checked by `proxy_outage_no_leak_no_flood`,
at most 40 events in the down window), plus one `mongo_unavailable` / `mongo_ready` line per transition.
A hung (not stopped) Mongo used to leak one heartbeat connection per ~10 s of hang (quirk 10); the reaper in
`geo_mongo_probe` (slice 3b.1) now stops them once they are 30 s old, so during a hang at most about 3–4 extra heartbeat connections exist (one per ~10 s, each living 30–40 s); they are gone about 40 s after the hang ends.

### Live evidence
**2026-11-20, Docker Desktop on Windows, round 1:**
- `docker compose build geo_service` succeeded; `/etc/ssl/certs/ca-certificates.crt` exists in the container; all four
  services healthy. `/api/ready` → 200 `{"status":"ready","mongo":"up"}`, `/api/health` → 200, POST `/api/ready` → 405.
- Indexes: `rooms` has `_id_, center_2dsphere, lastActiveAt_ttl`. Re-running
  `MSYS_NO_PATHCONV=1 docker compose exec -T mongo mongosh --quiet chaterl /docker-entrypoint-initdb.d/init-indexes.js`
  exited 0 ("indexes ensured"). Without `-T` the exec hangs from a non-interactive shell.
- `docker compose stop mongo`: ready → 503 after 7 s, health 200 (0.22 s); `start mongo` → ready 200 after 38 s; geo_service
  RestartCount stayed 0; exactly one `mongo_unavailable` and one `mongo_ready` event. Round 1 also produced 2873 log lines
  in ~45 s from driver pool restart loops, and the supervisor measured +5 Mongo connections per outage (orphan pools);
  fixed in round 2 (quirk 9).
- Boot with Mongo down (`up -d --no-deps --force-recreate geo_service`): running, health 200, ready 503 (71 log lines in
  15 s); `start mongo` → ready 200 after 14 s, no restart.
- `docker compose pause mongo`: ready → 503 after 10 s; health stayed 200 with a max of 0.28 s; 4 log lines while paused;
  `unpause` → ready 200 after 2 s, no restart (Mongo itself reports unhealthy for a while after unpause, as expected).
- Bad config: `MONGO_HOSTS=` → exit 1, `{bad_config,mongo_hosts}`; `MONGO_USER=x` with no password → exit 1,
  `{bad_config,mongo_password}`.
- Secret redaction: a container run with `MONGO_USER=ghost MONGO_PASSWORD=live-sentinel-9z9z` for 25 s logged the sentinel
  0 times and `[REDACTED]` 3 times; ready 503 inside.

**Round 2 (2026-11-21, rebuilt image, container recreated):**
- Start: ready 200 after 11 s; exactly 5 Mongo connections from the geo_service IP (`db.currentOp(true)` filtered by client).
- Two `docker compose stop mongo` / `start mongo` outages in a row: ready 503 after 4 s / 1 s, back to 200 after 14 s / 8 s;
  20 and 17 geo_service log lines per outage, 0 `start_error` lines; 5 connections after each recovery; RestartCount 0.
- Boot with Mongo down: running, health 200, ready 503; start mongo → ready 200 after 9 s; 5 connections.
- Redaction: `MONGO_USER=ghost MONGO_PASSWORD=live-sentinel-9z9z` for 25 s → sentinel 0, `[REDACTED]` 3, ready 503.
  `MONGO_HOSTS=` → `{bad_config,mongo_hosts}`.
- `docker compose pause mongo`: ready 503 after 5 s, health 200 (0.34 s), ready 200 4 s after unpause, 9 log lines, no
  restart. **But each pause leaves extra connections:** 5 → 6 → 8 → 10 over three pauses (stable for 2 min after each).
  In the node: 1 `mc_monitor`, 1 `poolboy`, 10 `mc_worker`. 5 are pool workers; 5 are hibernating workers linked only to
  the `mc_monitor` (heartbeat connections it opened after timed-out checks and never closed). See quirk 10.

**3b.1 live evidence (rebuilt image, container recreated):**
- Start: ready after 7 s; 5 Mongo connections from the geo_service IP.
- Three `docker compose pause mongo` cycles (20 s pause, then unpause): ready 200 after 5 s / 2 s / 2 s; connections
  6 at +10 s and back to exactly 5 at +60 s after every cycle (before 3b.1: 5 → 6 → 8 → 10); RestartCount 0.
- Five `notice: count: 1, event: mongo_heartbeat_reaped` lines over the three cycles; nothing else was added to the log.
- No regression of quirk 9: two `stop mongo` / `start mongo` outages → ready 503 after 1 s / 3 s, 200 after 12 s / 8 s,
  16 log lines each, 0 `start_error`, 5 connections after each.
- Round 2 rebuild (initial_call pre-check in the reaper): three pauses → 5/6/5 connections at +10 s and exactly 5 at
  +60 s each time; 4 `mongo_heartbeat_reaped` lines; RestartCount 0; two stop/start outages → 16 / 18 log lines,
  0 `start_error`, 5 connections.

## ADR-017 — Pseudonymous sessions: POST /api/session, XMPP provisioning and API tokens
**Status:** Accepted
**Context:** Slice 3c gives the client an identity. geo_service must reserve a nickname, create an XMPP account in
MongooseIM 6.2.1 and issue an API token, without storing anything beyond the nickname, and without a MongooseIM config
change. Probed live on 6.2.1 by the supervisor (throwaway users deleted).
**Decision:**
1. **Session model.** `POST /api/session {"nickname"}` only. geo_service generates the localpart and the password and
   returns the password exactly once. The client keeps `{jid, xmpp_password}` as its long-lived device credential; the JWT
   lives 1 h. Renewal `POST /api/session/renew {jid, xmpp_password}` is designed now (admin `checkPassword`, body never
   logged) and built in 3e. A lost device is a new identity; the old nickname stays reserved until the abandonment cleanup
   (Phase 4/5); recovery is a v1 non-goal.
   - JWT: header exactly `{"alg":"HS256","typ":"JWT"}`; claims exactly `iss=chaterl-geo`, `aud=chaterl-api`, `sub=<localpart>`,
     `iat`, `exp=iat+3600`, `jti` (128-bit random base64url, reserved for revocation); no nickname in the token.
   - Verification: HS256 only; `alg:none`, other algs, header keys besides alg/typ, padded or non-canonical base64url are
     rejected; the signature is compared with `crypto:hash_equals/2` before the payload is parsed; unknown or missing claims
     are rejected; skew 30 s (valid iff `Now < exp + 30` and `iat =< Now + 30`); `exp - iat > 3600` is rejected; a token over
     4096 bytes is invalid.
   - `JWT_SECRET`: 32..512 printable ASCII, no `"` or `\`, at least 10 distinct characters, not starting with `change-me`
     (any case). On failure the app does not start and logs only the key name. The HMAC key is the raw string bytes;
     generate with `openssl rand -hex 32`.
2. **XMPP credentials: a real rdbms account with a random password (option a).** No MongooseIM config change; SCRAM keeps
   working (dev alice/bob and the Phase 2 login are untouched); the JWT secret stays in geo_service; real accounts enable
   affiliations, bans and removeUser (3f); reconnect (ADR-010) keeps a stable password. Localpart `u` + 32 lowercase hex
   (nodeprep-safe, never the nickname); password `xp1_` + base64url of 24 random bytes (the prefix enables pattern
   redaction). Rejected: `[auth.jwt]` (exists in 6.2.1, but the XMPP password would become a 1 h bearer token so
   reconnect breaks after exp, the secret would be shared, the auth chain changes, and jwt users are not real accounts);
   `mod_auth_token` (same complexity).
3. **Nicknames.** ASCII `^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$`, case preserved. Uniqueness is the existing `nickname_unique_ci`
   index (en, strength 2): the insert is the claim, no find-then-insert. A reserved list (admin, moderator, system, nearby,
   chaterl, geo_service, ...) is matched case-insensitively and answered 409 `nickname_taken`, indistinguishable from a
   taken name.
4. **profiles.** Pending: `{_id: <localpart>, nickname, state: "pending", createdAt, expiresAt: createdAt + 600 s}`; active:
   `$set state "active"`, `$unset expiresAt`. No coordinates, IP or PII. New index `expiresAt_ttl` (`expireAfterSeconds: 0`)
   frees an orphaned reservation's nickname within ~11 min (the TTL monitor runs every 60 s). Active profiles have no TTL
   in 3c.
5. **Admin client.** OTP `httpc` (`inets`), default profile, per-request options only (`timeout 5000`, `connect_timeout 2000`,
   no redirects), precomputed `Authorization: Basic`. Constant GraphQL documents, all values as variables. The URL must be
   `http://`. Request and response bodies are never logged: the register request carries the new password and
   `checkPassword` echoes the plaintext password in its `message`. `/api/ready` does not depend on the admin API.
   Redaction adds the admin password, the base64 basic credential and the JWT secret, plus patterns for `xp1_` + 32
   characters and JWT-shaped strings.
6. **Rate limiting deferred.** Per-IP limiting needs a trusted-proxy X-Forwarded-For policy and the stack is localhost-only
   until Phase 6. Roadmap: Phase 4 (`geo_rate` also limits POST /api/session) and Phase 6 (session rate limit plus
   `auth.max_users_per_domain` backstop before going public). Sign-ups are unlimited until then.
7. **Vite proxy, no CORS.** `server.proxy` and `preview.proxy` send `/api/` to `http://127.0.0.1:<GEO_HTTP_PORT|8080>`
   (127.0.0.1 because Node on Windows resolves localhost to ::1), `changeOrigin: false`, `xfwd: false`. The port comes from
   `loadEnv(mode, '..', 'GEO_HTTP_PORT')`: a narrow exception to ADR-008 that loads one variable, exposes nothing to the
   client and leaves `envPrefix` unchanged (`loadEnv(..., '')` stays banned). `VITE_API_URL=/api` is read from 3e on. No CORS
   headers anywhere.
8. **Request validation.** POST only (405 + `allow: POST`); content-type `application/json` (charset, if any, utf-8) else 415;
   body cap 1024 bytes (413 by content-length before reading, or while reading chunked); invalid JSON or not an object is
   400 `invalid_json`; anything but exactly the key `nickname` with a string value is 400 `invalid_request`; a rule violation
   is 400 `invalid_nickname`; taken or reserved is 409; Mongo or XMPP unavailable is 503 + `retry-after: 5`; else 500
   `internal_error`. `cache-control: no-store` on every response.

**Verified facts (MongooseIM 6.2.1):** `account { registerUser(domain, username, password) { jid message } }`; success 200
with the jid; duplicate is 200 with `errors[0].extensions.code = "exists"`; unknown domain or empty password is 200
`"cannot_register"`; an invalid UserName is 400 `"input_coercion"`; wrong basic auth is 401 `"wrong_credentials"`; no auth is
401 `"no_permissions"`; mixed-case usernames are lowercased; `removeUser(user: JID!)` succeeds, or answers 200 `"not_allowed"`
for a missing user. `password.format = "scram"`: MongooseIM stores only hashes, so the plaintext exists only in our single
response.

**Rollback order and the accepted orphan case.** Flow: validate, generate, insert the pending profile (the claim), register.
- A 409 never calls MongooseIM.
- `exists` deletes the profile, answers 500 and NEVER removes the account (it is not ours).
- Unavailable, rejected or bad_response: best-effort `removeUser` (a timeout can hide a success), delete the profile, answer 503
  (unavailable) or 500.
- Unauthorized (401): delete the profile only; the request was refused before it ran, so there is nothing to remove.
- Activation failure: best-effort `removeUser` + delete the profile, log `session_rollback` (localpart and step only), 503.
- If MongooseIM hangs or is slow, the register can commit after we gave up: the best-effort remove may time out too, or
  run before the late registration commits. An orphan account is then possible and accepted. Nobody can sign in to it
  (its random password was never returned and MongooseIM stores only SCRAM hashes), it has no profile, it still counts
  as a user and can be removed with the admin API; the abandonment cleanup (Phase 4/5) reconciles accounts without a
  profile. A refused connection (MongooseIM stopped) runs nothing and leaves no orphan.
- A hung MongooseIM makes a failing request take up to ~10 s (5 s register timeout + 5 s best-effort remove).

**Consequences:** new inets dependency (OTP); five required env keys; unlimited sign-ups until Phase 4/6; the client is not
switched over until 3e.

### Live evidence
**2026-11-21, Docker Desktop on Windows, rebuilt image:**
- The local `.env` `JWT_SECRET` already met the rules (checked without printing it). After the rebuild all four services
  were healthy and `/api/ready` returned 200. Re-running `init-indexes.js` (`exec -T`) gave profiles indexes
  `_id_, nickname_unique_ci, expiresAt_ttl`.
- `POST /api/session {"nickname":"Live3c"}` → 201 with exactly `nickname, jid, xmpp_password, token, token_type,
  expires_in`; jid matched `u[0-9a-f]{32}@chaterl.localhost`, the password matched `xp1_[A-Za-z0-9_-]{32}`; JWT header
  `{"alg":"HS256","typ":"JWT"}`, claims exactly `iss, aud, sub, iat, exp, jti` (`chaterl-geo` / `chaterl-api`), `sub`
  = the jid's localpart, `exp - iat = 3600`; `cache-control: no-store`. The Mongo profile had exactly `_id` (the
  localpart), `nickname: "Live3c"`, `state: "active"`, `createdAt`.
- The returned localpart and `xmpp_password` signed in on the dev login form (status Online). After signing out, dev
  `alice` signed in as before.
- `LIVE3C` → 409 `nickname_taken`; `admin` → 409 `nickname_taken`; `a` → 400 `invalid_nickname`; `text/plain` → 415.
- Vite proxy: `http://localhost:5173/api/health` → 200 `{"status":"ok"}`; `POST http://localhost:5173/api/session` → 201
  with the same shape; no `access-control-*` headers. Vite listens on `localhost`, which is `::1` on this machine, so
  `127.0.0.1:5173` refuses connections; browsers use `localhost`, so this only affects hand-written curl commands.
- `docker compose stop mongooseim`: a session request → 503 `service_unavailable` with `retry-after` after 7 s; no profile
  left for that nickname; `/api/ready` stayed 200; geo_service RestartCount 0. After `start mongooseim` the same nickname
  → 201.
- Logs: 0 occurrences of `JWT_SECRET`, `MONGOOSEIM_ADMIN_PASSWORD`, the Basic credential, and each of the three returned
  `xmpp_password` and token values (compared inside a script, values never printed); the 3 `session_created` lines carry
  localparts only.
- `run --rm -e JWT_SECRET=short` and `-e JWT_SECRET=<the .env.example placeholder>` → exit 1, `{bad_config,jwt_secret}`,
  the value absent from the output.
- Cleanup: the three test accounts were removed with `mongooseimctl account removeUser`, their profiles deleted;
  `listUsers` shows only alice and bob (no orphan account from the MongooseIM-down attempt).

---

## ADR-018 — POST /api/locate: auth, validation and crash-safe coordinate handling
**Status:** Accepted
**Context:** Slice 3d is the first endpoint that receives raw coordinates. Privacy rules: they must never reach a log,
a crash report, an error value, a reply or a Mongo document, even when the handler crashes after decoding. Cowboy re-raises
handler exceptions and `cowboy_stream_h` then logs the exit reason and stack trace; `proc_lib` adds a crash report. A
`{badmatch, Map}` reason or a `function_clause` top frame would print the decoded map or the raw floats. Also: OTP
`json:decode/1` errors carry input bytes (`{unexpected_sequence, <<"1.0e400">>}`), and `cow_http_hd:parse_authorization/1`
crashes with `function_clause` on malformed input, with the header value in the stack arguments.
**Decision:**
1. **Auth.** Header only, parsed by our own total function (`geo_http_auth`), never cowlib. No header, an empty value or any
   non-Bearer scheme is `missing`; a value that is `bearer` (any case) or starts with `bearer` plus one space is a presented
   credential (only a single SP separates the scheme from the token; `Bearer<TAB>token` is treated as no bearer credential,
   i.e. missing). The token must be 1..4096 bytes of `[A-Za-z0-9._-]`; an empty token, a second space, a comma (duplicate
   headers arrive joined as "Bearer a, Bearer b") or any other character is `invalid`. Query-string tokens are not
   supported: no header plus `?access_token=` is 401 missing; a valid header plus any non-empty query string is 400
   `invalid_request`. 401 body `{"error":"unauthorized","message":"A valid bearer token is required."}`, with
   `www-authenticate: Bearer realm="chaterl-api"` (missing) or `..., error="invalid_token"` (malformed, bad signature,
   `alg:none`, wrong secret, expired; expired and invalid look the same). Order: 405, 401, query-string 400, then 415/413/400
   from the body; the body is never read for a 401. The JWT alone is enough (no profile lookup: nothing is revocable yet; a
   token stays valid at most 1 h after its profile is deleted, accepted).
2. **Request.** `lat` and `lng` required, `range` and `accuracy` optional, any other key (including `Lat`, `latitude`) is 400
   `invalid_request`. `lat`/`lng`/`accuracy` must be numbers (strings, booleans, `null`, arrays, objects are rejected);
   `1e400` fails decoding (400 `invalid_json`). `range` is exactly `block` (default), `neighbourhood` or `area`
   (`geo_cell:parse_range/1`; the US spelling is rejected, note for 3e). `accuracy` is validated (0..1000000 m) and then
   ignored: never stored or logged. Check order: key set and types, range, accuracy, then bounds; a body that is both
   malformed and out of range is `invalid_request`. Bounds lat [-90, 90], lng [-180, 180] inclusive give `invalid_location`
   (one code for both). lng 180 and -180 give different cells (accepted, documented). Body cap 256 bytes. Duplicate JSON keys
   are first-wins in OTP `json` (`{"a":1,"a":2}` gives `a => 1`): not a privacy issue.
3. **Response.** 200 with ordered keys `cell, precision, range, room_jid`, byte-identical for a created and an updated room
   (no activity oracle). The MUC domain is derived `muc.<XMPP_DOMAIN>` in `geo_config:session/0`, mirroring
   `host = "muc.@HOST@"` in the MongooseIM template (fails `{bad_config, xmpp_domain}` above 249 bytes so that the derived
   name stays within 253). No new env var; the unused `MUC_SUBDOMAIN` was removed from `.env.example`. The web keeps
   `VITE_XMPP_MUC_DOMAIN`; 3e validates `room_jid` against it. Later additive keys are possible, so the 3e parser tolerates
   extra keys.
4. **Privacy, two layers; the first is the guarantee.**
   - (b) **Guarded handler.** Everything after body decoding (`geo_locate:cell_for/1`, `geo_store:touch_room/1`, building
     the reply) runs in ONE `try ... catch Class:Reason:Stack`. A crash replies 500 `internal_error` and logs exactly one
     `#{event => locate_crashed, class, reason, where}` built by the pure `geo_crash:summary/3`: the reason is the atom
     itself or the leading atom of a tagged tuple (else `term`); `where` is the top 5 frames as `{M, F, Arity, Line}`, with
     argument lists reduced to arities and `error_info` dropped. So no `cowboy_stream_h` error and no `proc_lib` report is
     produced for this path. This is a deliberate, narrow exception to let-it-crash: a short-lived request process with
     nothing to restart whose reason and stack are exactly what can carry the user's position. The read and auth phases stay
     outside the try, so Cowboy's `{request_error, ...}` exits still produce its 400/408/413 (those carry no body). There is
     no `terminate/3` (Cowboy would pass it `{crash, Class, Reason}`). Calls into `geo_locate` and `geo_store` are fully
     qualified (the CT suite fault-injects them), and the reply is the last expression in the try. `geo_cell:from_point/3`
     and `geohash:encode/3` are total; a PropEr property (1000 cases) proves `cell_for/1` total. An unexpected return from the
     store (anything but `{ok, created | updated}`) is a case_clause that lands in the catch.
   - (a) **Logger backstop in `geo_log_redact`.** A map value under a key named lat, lng, lon, latitude, longitude or accuracy
     (binary in any case, or atom) becomes `[REDACTED]`, and two key-preserving text patterns mask the values in raw JSON
     bytes and in pre-formatted `~p` map text (`<<"lat">> => 1.5`), over binaries and char lists. **What this does not cover:** a coordinate that is not next to a coordinate-named key, i.e. bare floats anywhere in a term (stack arguments `[57.6, 10.4, block]`, exception reasons `{badarg, 57.6}`, tuples, lists); JSON that was already escaped into a formatted string (`<<"{\"lat\":57.6}">>`); and a body split across TCP packets. Hence (b) is the
     guarantee and (a) only a net. The filter fails closed: if redaction itself raises, that event's message is replaced
     by a fixed, value-free placeholder (`[REDACTED: log redaction failed, event dropped]`, level and time kept) instead
     of letting logger remove the filter; the placeholder keeps such a bug visible. Only `msg` is redacted, never `meta`
     (the default formatter template prints no arbitrary meta; a template that did would not be covered).
   - Error messages are constants, never echoing values or key names; no logger call receives the body, the request, the
     config or a coordinate.
5. **Mongo write.** `geo_store:touch_room(Cell)` on every successful locate. `{error, mongo_unavailable}` is 503
   `service_unavailable` with `retry-after: 5` ("return the room anyway" is rejected: from 3f geo_service owns room creation).
   `{error, write_failed}` is 500 plus one `#{event => locate_store_failed}` at warning (no cell, no sub). No MongooseIM room
   creation yet (3f). Rooms expire 7 days after `lastActiveAt` (TTL). The rooms document is unchanged: exactly `_id,
   precision, geohash, center` (the cell centre, `[lng, lat]`), `createdAt`, `lastActiveAt`; no index changes.
6. **Status codes.** 200; 400 `invalid_json` / `invalid_request` / `invalid_location`; 401 + `www-authenticate`; 405 + `allow:
   POST` (before auth); 413; 415; 503 + `retry-after: 5`; 500. All with `cache-control: no-store`.
7. **Logging.** Nothing per request on success, at any level. Auth failures and 4xx are not logged. Only `locate_crashed`
   (error) and `locate_store_failed` (warning), neither with a cell or a sub.
8. `/api/session/renew` stays in 3e.
9. **Test dependency.** meck 1.2.0 (Apache-2.0), test profile only, for fault injection without production test hooks; it
   never ships.
**Consequences:** abuse control is deferred: no rate limit and no impossible-jump check until Phase 4 (`geo_rate`), so any
valid token can locate any cell repeatedly; accepted while the service is bound to localhost. No profile lookup, so a
deleted profile's token works until it expires. The coordinate-key redaction is a net with known gaps (above); the try/catch
is what keeps coordinates out of crash output. One handler deliberately catches all exceptions after decoding.

### Live evidence
**2026-11-21, Docker Desktop on Windows, rebuilt image** (token from a fresh `/api/session`, kept in a file and never
printed; request bodies sent from files):
- All four services healthy, `/api/ready` 200.
- `POST /api/locate {"lat":57.6491137,"lng":10.4074419}` → 200
  `{"cell":"u4pruyd","precision":7,"range":"block","room_jid":"g7_u4pruyd@muc.chaterl.localhost"}` with
  `cache-control: no-store`; `"range":"area"` → 200 `{"cell":"u4pru","precision":5,"range":"area","room_jid":"g5_u4pru@muc.chaterl.localhost"}`.
- Mongo `rooms` `g7_u4pruyd`: exactly `_id, center, createdAt, geohash, lastActiveAt, precision`; precision 7;
  `center.coordinates` = `[10.407485961914062, 57.64869689941406]` (the cell centre, not the request point);
  `createdAt == lastActiveAt` on insert. A second point in the same cell → an identical 200 body; only `lastActiveAt`
  advanced. Indexes unchanged: `_id_, center_2dsphere, lastActiveAt_ttl`.
- No header → 401 `www-authenticate: Bearer realm="chaterl-api"`; a tampered token and an alg-none token → 401
  `Bearer realm="chaterl-api", error="invalid_token"`; the token in the query string with no header → 401 realm only;
  GET → 405 `allow: POST`; lat 90.0000173 → 400 `invalid_location` (the value not echoed); `text/plain` → 415.
- Vite proxy `POST http://localhost:5173/api/locate` → 200 with the identical body; no `access-control-*` headers.
- Logs (scanned in a script, values never printed): 0 occurrences of `57.6491137`, `10.4074419`, `57.6485531`,
  `10.4070917`, `90.0000173` and the token; 0 `locate_*` lines after the successful and 4xx requests.
- `docker compose stop mongo` → locate 503 `service_unavailable` with `retry-after: 5` in 3 s; after `start mongo` → 200;
  geo_service RestartCount 0; still 0 coordinate occurrences in the logs afterwards.
- Cleanup: the test account removed with `mongooseimctl account removeUser`, its profile and the two test rooms deleted;
  `listUsers` shows only alice and bob.
- Rounds 2–3 (rebuilt image): a valid token and a `bEaReR` scheme → 200; the header bytes that crashed the round-1
  parser (`\xff\xfe\xc3(\x80\x81` as the scheme) → 401 realm only, a token with invalid bytes → 401 `invalid_token`;
  `content-type: application/json; charset="\xff"` → 415 `unsupported_media_type` on `/api/session` (it crashed with 500
  before); 0 crash reports. In the running node (`bin/geo_service eval`), `logger:error(#{<<255>> => 1, <<"LAT">> => 1.5})`
  printed `LAT` as `[REDACTED]` and `geo_redact` stayed among the primary filters (before round 3 logger removed it and every
  later line went out unredacted); a following line with an `xp1_` test string came out `[REDACTED]`.
