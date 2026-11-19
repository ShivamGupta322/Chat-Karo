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
- In 2c-2, map tile requests will reveal the viewed area.
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
