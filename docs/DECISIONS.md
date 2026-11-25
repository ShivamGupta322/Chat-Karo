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
**Status:** Accepted. Amended by ADR-019 D3 (landed in 3e-3): the client sends its precision-7 cell centre, not its raw fix.
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
**Status:** Accepted (Phase 2, slice 2a). Amended by ADR-020 (3f-1): the client no longer creates rooms; the instant-room (201 + `muc#owner`) path is removed and a 201 is a failed join.
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
**Status:** Accepted (Phase 2, slice 2a+, 2026-11-17). Amended by ADR-019 (3e-2): the dev username login and `ui/addresses.ts` are removed.
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
this ADR's catch-up and initial-load live evidence. **Access to the archive is narrowed by ADR-020 (3f-1):** in members-only rooms only owner, admin and member read the MAM archive, so a non-member can no longer read it without joining.
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
**Status:** Accepted (Phase 2, slice 2c-1, 2026-11-19). A **temporary deviation from ADR-005** until Phase 3. **Partly superseded by ADR-019 (3e-3):** the client no longer assigns rooms (`roomJidForCell` deleted); section 2: the cell centre leaves `geo/` via `api/locate.ts`; section 3: the triggers now drive `/api/locate`; section 4: the controller consumes the server's `room_jid`. Sections 1 and 5-8 stand; "anyone can join any `g7_` room" is resolved by ADR-020 (3f-1; residuals listed there: after a MongooseIM restart disco lists stored room names, room disco#info shows the occupant count, and join errors reveal whether a room exists; slice 3g closes them). Builds on
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
  are Phase 3 cleanup candidates (addresses cleanup done in 3e-2: the whole file is deleted).
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

## ADR-019 — Session renewal (POST /api/session/renew) and the client switch design
**Status:** Accepted. Server part 3e-1. Client identity 3e-2: D1, D2 (token manager; first use in 3e-3), D4 (network, storage and xmpp guards; the locate guard comes in 3e-3), D5, D6, D7. D3 confirmed 2026-11-21; D3 and D4 landed in 3e-3.
**Context:** A returning device holds `{jid, xmpp_password}` (ADR-017) but its 1 h API token is gone. It needs a way to get a
fresh token without a second identity, an email or a cookie. The request body carries a live credential, so the handler
must not let it reach a log or a crash report (ADR-018 section 4b reasoning). Probed live on MongooseIM 6.2.1 by the
supervisor (one throwaway user, created and deleted; no credentials printed).
**Decision (server, built in 3e-1):**
1. **Contract.** `POST /api/session/renew`, `content-type: application/json`, body at most 1024 bytes, exactly
   `{"jid": string, "xmpp_password": string}` (any other shape is 400 `invalid_request`). `200 {"nickname","token",
   "token_type":"Bearer","expires_in":3600}` in that order. 400 `invalid_json` / `invalid_request`; 401
   `invalid_credentials`; 405 + `allow: POST`; 413; 415; 503 `service_unavailable` + `retry-after: 5` (Mongo or MongooseIM
   unavailable or timed out); 500 `internal_error` (admin 401 or unparsable answer, a bad profile document, a crash).
   `cache-control: no-store` on every reply.
2. **One 401.** A malformed jid or password, an unknown, pending or deleted profile, a wrong password and an unknown XMPP
   account all return the same constant body `{"error":"invalid_credentials","message":"These credentials are not valid."}`.
   There is no `www-authenticate` header: the credentials travel in the body, not in an HTTP auth scheme.
3. **Order.** `geo_session:parse_credentials/3` (total; jid exactly `u` + 32 lowercase hex + `@` + the XMPP domain, no
   resource, no case folding; password exactly `xp1_` + 32 base64url characters), then `geo_store:get_profile/1`
   (an ACTIVE profile is required), and only then the MongooseIM admin `checkPassword`. Junk and deleted accounts therefore
   never cost a SCRAM check. The nickname comes from the profile. The token is `geo_auth:issue/3` (1 h, `sub` = localpart).
4. **Verified admin facts (6.2.1).** Query
   `query CheckPassword($user: JID!, $password: String!) { account { checkPassword(user: $user, password: $password) { correct } } }`:
   the right password is 200 `{"correct":true}`; a wrong or empty password is 200 `{"correct":false}`; an unknown user (any
   domain) is 200 with `errors[0].extensions.code = "user_does_not_exist"` and `data.account.checkPassword = null`; an
   unparsable JID is 400 `input_coercion`. Selecting only `{ correct }` removes the echoed password from the success and wrong
   bodies, but the `user_does_not_exist` error message STILL echoes the password. So no admin body is ever logged.
   `geo_xmpp_admin:parse_check_password/2` maps true to `ok`, false and `user_does_not_exist` to `{error, invalid}`, 401 to
   `unauthorized`, 5xx and transport failures to `unavailable`, everything else to `bad_response`.
5. **Crash safety.** `geo_http_session_renew` runs everything after decoding inside one try/catch (like `geo_http_locate`):
   a crash replies 500 and logs only `renew_crashed` with `geo_crash:summary/3` (class, atom reason, frame arities). The read
   phase is outside the try, there is no `terminate/3`, the reply is the last expression of the try, and the password is never
   matched in a function head outside the try. `geo_log_redact`'s `xp1_` pattern is only the backstop. Nothing is logged per
   request on success or 4xx; the only other events are the existing `xmpp_admin_unauthorized` / `xmpp_admin_bad_response`
   (status only).
**Decision (client, lands in 3e-2 / 3e-3):**
- **D1 Device credential.** localStorage key `nearby.identity.v1`, JSON `{"v":1,"jid","xmppPassword","nickname"}`, validated
  on read (malformed means absent). IndexedDB has the same XSS exposure with more complexity; sessionStorage loses the
  identity on tab close; WebCrypto cannot help (SASL needs the plaintext). XSS exposure is accepted for a portfolio project
  (no third-party scripts, React escaping, no `dangerouslySetInnerHTML`, CSP in Phase 6). The JWT is memory-only. If a write
  fails the credential stays in memory and the UI says "This name won't be remembered on this device." Copy: "Nearby gives you
  a name on this device only. There's no email or password. If you clear this browser's data or switch devices, you'll start
  again with a new name." The credential is never deleted without an explicit user action (auth-failed or a renew 401 offers
  "Try again" / "Start over"). Sign out is an XMPP disconnect plus the Welcome page with "Continue as {nickname}" / "Start over
  with a new name"; Start over asks for confirmation ("Your current name can't be recovered."). No server-side `removeUser` in 3e.
- **D2 Token lifecycle** (`web/src/api/`, injected clock, timers and fetch). `expiresAt = now + expires_in*1000`; proactive
  renew at 80% plus a lazy check before a locate (renew if there is no token or less than 60 s left); single-flight renew; a
  locate 401 gets one renew and one retry, a second 401 is an error state; a renew 401 `invalid_credentials` is
  identity-invalid (offer Start over, nothing wiped); renew 503, timeout or network error keeps XMPP and retries after
  max(retry-after, backoff 5 s up to 30 s), none while offline, retry on `online`. Fetch timeouts: `/api/session` 15 s, renew
  15 s, locate 10 s. After onboarding the 201 token is used; on reload the XMPP connect and the renew start in parallel.
- **D3 Locate flow (confirmed by the user, 2026-11-21).** Send the CENTRE of the locally computed precision-7 cell, not the raw fix,
  and omit `accuracy`; the server answer is identical and the raw fix never leaves the device. This amends the
  ADR-005 wording ("the client sends its cell centre", not its coordinates). Phase 4 still works: hysteresis runs in the
  browser on the raw fix, and the impossible-jump check uses cell centres; Phase 5 place matching can run client-side if
  needed. Reversible: the server accepts any valid point. The Phase 4 jump threshold must allow for one p7 cell diagonal (about 215 m) of
  quantisation, so two quick legitimate cell changes never look like an impossible speed. The local geohash stays (dev map,
  de-duplication, snapping). Locate only on the ADR-013 section 3 room-change triggers plus a retry after an error; no `range`
  key. The response is validated: extra keys tolerated; `cell`, `precision` in {5,6,7}, `range` and `room_jid` matching
  `^g(5|6|7)_[0-9b-hjkmnp-z]{5,7}@<mucDomain>$` are required; precision equals the cell length equals the room prefix; for
  block the cell equals the local cell; a mismatch is bad-response and nothing is joined. The previous room is kept until
  the new assignment arrives; desired room is null on location loss or a locate failure. The MUC nick is the profile nickname.
  States: assigning, unavailable, offline, identity-invalid, bad-response.
- **D4 Boundaries.** `src/api/` is a leaf. The locate value is importable only from `src/geo/**`, `src/main.tsx` and tests
  (`**/api/locate`). `no-restricted-globals` for `fetch`, `XMLHttpRequest`, `navigator.sendBeacon` everywhere except
  `src/api/**`. localStorage/sessionStorage only in `src/api/deviceCredential.ts`. `xmpp/` also gets `**/api`. Guards are proven
  by lint fixture tests.
- **D5 Dev login.** Remove `pages/DevLogin.tsx`, `components/LoginForm.tsx` and `ui/addresses.ts` `toRoomJid`/`roomLabel` in 3e-2
  (alice and bob stay for `tools/xmpp-smoke` and the lobby). The two-window demo uses a DEV-only
  `?identity=<[a-z0-9]{1,16}>` storage slot (literal `import.meta.env.DEV`) or a private window.
- **D6 Onboarding.** `pages/Welcome.tsx`: a labelled nickname input mirroring `^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$`,
  `aria-invalid` + `aria-describedby`, `role=alert` for submit errors. 400 shows the rule; 409 "That name is taken. Try
  another."; 503, timeout or network error "Nearby can't create names right now. Try again in a few seconds."; 500 a generic
  message. Busy label "Creating...". The credential is stored before the XMPP connect. Tokens and `ui/text.ts` only.
- **D7.** `VITE_API_URL` is optional, default `/api`; a same-origin path only (one leading `/`, no `//`, query, hash or
  whitespace); read in `config.ts` and passed explicitly in `main.tsx`.
**Consequences:** Renew is a password oracle and costs one SCRAM check per call. Brute force is infeasible (192-bit
passwords), and the shape check plus the profile-first order keeps junk away from MongooseIM; there is no rate limit until
Phase 4 (`geo_rate`) and Phase 6, accepted while the service is localhost-only. An unknown localpart is answered faster than
a wrong password (timing oracle), accepted because localparts are 128-bit random. There is no revocation: the old token stays
valid until it expires (ADR-017). The handler blocks its request process for at most the admin client timeout (5 s).
**Follow-up (done, 2026-11-21):** `geo_http_session` (POST /api/session) holds a generated password too, so it now has the
same guarded try/catch: everything after the body is decoded runs in one section that logs only `session_crashed`
(geo_crash:summary/3). CT `session_crash_is_sanitised` covers it; with the guard disabled (the crash handler re-raising)
that case fails, so the test is not vacuous.

### Live evidence
**2026-11-21, Docker Desktop on Windows, rebuilt image** (credentials and tokens kept in files, never printed):
- All four services healthy, `/api/ready` 200. A fresh `POST /api/session` → its jid and password sent to
  `POST /api/session/renew` → 200 with exactly `nickname, token, token_type, expires_in` in that order, `cache-control:
  no-store`; the JWT has exactly the six claims, `exp - iat = 3600`, `sub` = the jid's localpart, nickname "Live3e1".
  The renewed token → `POST /api/locate` 200 (`g7_u4pruyd`).
- Through the Vite proxy (`http://localhost:5173/api/session/renew`) → the same 200; no `access-control-*` headers.
- A wrong `xp1_` password and alice's jid → 401 `{"error":"invalid_credentials","message":"These credentials are not
  valid."}` (one constant body); GET → 405 `allow: POST`; `text/plain` → 415.
- `docker compose stop mongooseim` → renew 503 `service_unavailable` + `retry-after: 5` in 4 s, `/api/ready` stayed 200;
  after `start mongooseim` → 200. `docker compose stop mongo` → renew 503 + `retry-after: 5`. geo_service RestartCount 0.
- Logs (scanned in a script): 0 occurrences of the six test secrets (the real and a wrong password, the issued and renewed
  tokens), of `is correct`, `is incorrect` and `does not exist`; 0 `renew_crashed`.
- Cleanup: the test account removed with `mongooseimctl account removeUser`, its profile and the test room deleted;
  `listUsers` shows only alice and bob.
- (A first run tested the stale image, every renew → 404, because the rebuild had not taken effect; the run above is on
  the rebuilt image.)

### Client implementation (3e-2)
- **MUC nick = profile nickname from 3e-2.** The server-made localpart `u<32 hex>` is 33 characters, over `MAX_NICK_LENGTH`
  (32), so every join would fail with `invalid-nick`. `Chat` takes `nickname` and `AppHeader` shows it; no jid or localpart
  is ever displayed.
- **Token manager lifetime.** It starts with the identity (reload, Continue, Try again, after onboarding) and stops on sign
  out, Start over and a terminal XMPP disconnect (auth-failed, connection-failed, conflict, pagehide). `reconnecting` is not
  terminal, and a renew failure never touches XMPP. `getToken` bypasses a backoff wait (it is user-driven and rare); the
  background loop alone obeys the backoff. Renew 400/404/405/413/415 is `failed` (terminal, no retry; 404 is what a stale
  geo_service image returns), a still-unexpired token is kept until it expires. A 401 is `identity-invalid`.
- **One returning view.** Sign out, an auth failure and a connection failure all land on the same "Welcome back" card
  ("Continue as X" or "Try again", plus "Start over with a new name"); a connecting card has a Cancel so a hung socket never
  traps the user.
- **`connectWhenIdle`.** `client.connect()` does nothing unless the state is `idle` or `disconnected`, so a fast Continue or
  Start over while the old session is still `disconnecting` would silently not connect. The controller connects on the first
  `idle`/`disconnected` state instead (one pending connect, cancelled by sign out and Start over). The connect runs in a
  microtask: connecting inside the client's own emit would deliver `connecting` to the other listeners before they saw
  `disconnected`. A `disconnected` that completes the previous session while a connect is pending is not terminal: the token
  manager keeps running.
- **`describeConnectionError` copy** no longer says "sign in again" (there is no password to retype): auth-failed "Nearby couldn't
  sign you in with this name.", connection-failed "Can't reach the chat server right now. Try again in a moment.",
  connection-lost "Connection lost. Try again.", error "Something went wrong. Try again."
- **Custom `alertdialog`** (`components/ConfirmDialog.tsx`): jsdom has no `HTMLDialogElement.showModal`. Focus starts on Cancel
  (the safe default), Tab is trapped between the two buttons, Escape and a backdrop click cancel, and focus returns to the opener.
- **Malformed or foreign-domain stored entries are ignored, not deleted** (nothing is deleted without a user action); the
  next onboarding overwrites the key. If `clear()` fails on Start over the next reload brings the old identity back; accepted.
- **`VITE_API_URL`** must match `^/(?:[A-Za-z0-9._~-]+/)*[A-Za-z0-9._~-]+$` with no `.` or `..` segment, and is checked untrimmed
  (a value with whitespace or a newline is rejected, only a blank value means the default `/api`). The error never echoes it.
- **Two tabs, one identity:** both connect with the same jid and join with the same nick; one becomes `Name-2` through the
  existing conflict retry. Accepted.
- **A 201 that fails client validation** leaves an orphan identity, consistent with ADR-017's accepted orphan case.
- **Test timeout.** Vitest `testTimeout` is 20 s: the userEvent component tests flaked at the 5 s default under load at 4d90200.
- **Focus after a view change.** When a view change unmounts the focused button (confirming Start over, Sign out, the connecting
  card's Cancel), focus would fall to `<body>`. `NewView` and `ReturningView` therefore focus their heading on mount, but only
  if focus is on `<body>` or detached (never stealing it). The heading has `tabIndex={-1}` (programmatic only, not a tab stop):
  it announces the context, raises no mobile keyboard, and one Tab reaches the first control. `ConfirmDialog` is unchanged
  (restore-to-opener stays right for Cancel and Escape).
- **Bundle size.** JS is +15 505 B raw / +5.0 kB gzip against the 4d90200 baseline, over the +8 000 B estimate. Accepted: the
  estimate missed about 1 350 lines of first-party validation, token manager, credential store, controller and three UI components
  against about 2 kB removed. No dependency was added and dev code is verified absent. The baseline for 3e-3 is the final 3e-2 bundle, JS 267 841 B (round 2 included), with
  a budget of +4 000 B raw.
- **Not in 3e-2:** `/api/locate` calls and the `roomJidForCell` removal (3e-3).

### Live evidence (3e-2)
**2026-11-21, in-app browser pane, `npm run dev`, geo_service at 4d90200:**
- Fresh visit with empty storage → Welcome ("Pick a name", the device-only explanation). Keyboard only: one Tab lands on
  "Your name", type `LiveA3e`, Enter → Online, header shows `LiveA3e`. Storage holds exactly `nearby.identity.v1` with keys
  `v, jid, xmppPassword, nickname` (`v` 1, jid `u<32 hex>@chaterl.localhost`). Test spot A → join presence
  `g7_u4pruyd@muc.chaterl.localhost/LiveA3e` (the nickname is the MUC nick).
- Reload → no form, signed straight back in as `LiveA3e`; one `POST /api/session/renew` → 200.
- Second tab `?identity=b`: `livea3e` → field error "That name is taken. Try another." (`aria-invalid`, described by the
  hint and the error); `LiveB3e` → Online, stored as `nearby.identity.v1.b`. Both at test spot A: "People here · 2" and
  messages delivered both ways.
- Sign out → "Welcome back / Continue as LiveA3e / Start over with a new name", credential kept → Continue → Online as
  `LiveA3e`. Start over by keyboard: `role=alertdialog` titled "Start over with a new name?", described "Your current name
  can't be recovered.", focus on Cancel; Escape closes it, focus returns to the trigger, nothing wiped; confirming removed
  `nearby.identity.v1` and showed the form; `LiveC3e` → Online. (Round 1 finding: after confirming, focus fell to `<body>`; fixed in round 2, see below.)
- `docker compose stop mongooseim`, new slot `?identity=c`, `LiveD3e` → "Nearby can't create names right now. Try again in a
  few seconds." after 8 s; nothing stored for slot c. MongooseIM restarted.
- `docker compose stop mongo`, reload `?identity=b` → Online as `LiveB3e`, no notice; renew → 503 four times with growing
  gaps, then 200 after `start mongo`; XMPP never dropped.
- Storage: only `nearby.identity.v1` and `nearby.identity.v1.b`; sessionStorage and cookies empty; no JWT-shaped string in
  any stored value. Console in both tabs: 0 hits for `xp1_` and `eyJ`.
- 360×640, round 1: Welcome (new) and Chat → `scrollWidth` 360 (no horizontal overflow).
- Production build (re-run by the orchestrator): one JS (267 578 B, gzip 84.23 kB) and one CSS (16 699 B); 0 hits for the
  dev-login terms, `alice`, and `dev identity slot|Test spot A|Test locations|leaflet|openstreetmap`; 1 hit each for
  `nearby.identity.v1` and `That name is taken. Try another.`. JS +15 505 B vs the 4d90200 baseline (plan budget +8 000 B).
- Cleanup: LiveA3e, LiveB3e, LiveC3e removed with `mongooseimctl account removeUser`, their profiles deleted; `listUsers`
  shows only alice and bob; browser storage cleared.
- Round 2 (after the token-race and focus fixes), 360×640, slot `?identity=e`: sign out → focus on the "Welcome back"
  heading, returning view `scrollWidth` 360; Start over dialog 360 (dialog box 16–344 px); confirm → focus on the "Pick a
  name" heading, one Tab reaches "Your name"; the returning view with a connection error ("Can't reach the chat server right
  now…", MongooseIM stopped) 360; Chat with the identity-invalid notice (profile deleted, renew 401: "Nearby can't confirm
  your name anymore…", still Online, nothing wiped) 360. The connecting view was not measured: with MongooseIM stopped it
  passes too quickly to sample. Cleanup: LiveE3e and LiveF3e removed; `listUsers` shows only alice and bob.

### Client implementation (3e-3)
- **The assigner.** `geo/roomAssigner.ts` is framework-free and built once in `main.tsx` (like the token manager); `useRoomAssignment(cell)`
  in `geo/RoomAssignment.tsx` points it at the committed cell (keyed on the geohash string) and reads its state through
  `useSyncExternalStore` (`getState` returns the same object until something changes). States: `none`, `assigning` (carries the
  previous room, kept), `assigned`, `failed` (reason; room always null, so the client leaves). The same geohash as the current target
  is a no-op in any state; a different cell aborts the in-flight request, bumps a generation counter and starts one new request;
  a result from an older generation is ignored. `assign(null)` aborts, cancels the retry timer and goes to `none`. The cell centre is
  a local inside the request function; state holds only the Cell and `{jid, cell}`.
- **What leaves the browser.** `api/locate.ts` posts exactly `{"lat","lng"}` (built from the two fields, never spread; no accuracy, no
  range) and it is the centre of the local precision-7 cell (`cellCentre`), never the raw fix. Tests use hard-coded oracle centres
  (u4pruyd 57.64869689941406, 10.407485961914062 equals the Erlang-computed value in the ADR-018 live evidence), never values derived
  from `cellCentre` itself. The request goes through `tokens.withToken` with a 10 s timeout and the abort signal.
- **Validation by equality, not a regex.** A 200 answer is accepted only if `cell` matches `^[0-9b-hjkmnp-z]{5,7}$`, `precision` is an
  integer 5, 6 or 7 equal to `cell.length`, `range` is block/neighbourhood/area (US spelling invalid) with 7/6/5 matching, and
  `room_jid` equals "g" + precision + "_" + cell + "@" + mucDomain by exact string equality (no resource, no foreign domain, no look-alike). Equality
  is stricter than any room-address regex and means the client never builds room addresses: it only checks the server's. The assigner
  then also requires `block`, 7 and the requested geohash, else `bad-response` (nothing joined).
- **Error mapping.**

  | Outcome | Result | Reason |
  |---|---|---|
  | http 500/502/503/504 | unavailable (carries retry-after) | transient server side |
  | timeout, network | unavailable | transient |
  | token reason unavailable or stopped | unavailable | transient, or terminal on the token side; the assigner backs off to 30 s and sends no request until a token is available |
  | token reason offline | offline | resumes on the online event |
  | token reason identity-invalid | identity-invalid | the banner offers Start over; a retry cannot help |
  | `{kind:'unauthorized'}` (second 401 after one renew and one retry) | bad-response | the server rejects a freshly renewed token; retrying the same way cannot help |
  | any other http status (400, 404, 405, 413, 415...), a non-200 2xx, an http bad-response | bad-response | a client or contract bug, not transient |
  | aborted | aborted | our own cancel |

  `api/locate.ts` never throws and never logs.
- **Keep-room and null-on-failure.** A switch keeps the old room while the new answer is pending (the composer stays usable, the label
  uses the room's own cell). A failure or lost location makes the desired room null, so `useAreaRoom` leaves; `failed.room` is always null.
- **Retry policy.** unavailable retries automatically after `max(retryAfterMs ?? 0, min(5000 * 2^attempt, 30000))` (attempt resets on success
  and on a new cell). If `online.isOnline()` is false when a request would start or when an unavailable returns, the state is
  `failed: offline` with no request and no timer; the online event retries a failed offline/unavailable at once. identity-invalid and
  bad-response never retry by themselves; `retry()` ("Find my area chat") is immediate in any failed state and cancels a pending timer.
  `browserOnline` is exported from `api/` and reused (no second copy).
- **Aborted requests can still touch the room.** A fetch abort does not stop the server, so an abandoned cell can still be upserted by
  `touch_room`. Accepted: it is a cell, not a position.
- **Lint guards (ADR-019 D4, extended).** `api/locate` may only be imported by `src/geo/`, `src/main.tsx` and tests, and `api/index.ts` must
  not re-export it; `src/state/` cannot import `geo/`; `WebSocket` and `EventSource` only in `src/xmpp/strophe/`; no `caches`,
  `cookieStore` or `document.cookie` anywhere. Each guard and each allowed place is proven by a fixture test in
  `tests/lint/boundaries.test.ts`. `no-restricted-imports` does not see a dynamic `import('../api/locate')`, so the guard
  is a strong default, not airtight; review catches the rest.
- **Dropped.** `roomJidForCell`, the geo_service drift guard on it (`cell_guard`), and `LOCATE_TIMEOUT_MS` in `session.ts` (now in `locate.ts`).
  `isRecord` and `statusError` moved to `api/http.ts` (not re-exported).
- **Bundle.** JS 273 163 B raw (85.98 kB gzip by vite), CSS 16 769 B; +5 322 B against the 267 841 B baseline, 1 322 B over the +4 000 B budget. Reported, not trimmed (the plan said not to cut copy or accessibility to fit): the new code is the locate API client with validation and error mapping, the room assigner with its retry policy, and the extra AreaPanel states. No dependency was added; the dev-only strings and Leaflet are absent from the build. The supervisor accepted the overrun (2026-11-22); **273 163 B is the new baseline**, so the next slice's +4 000 B budget gives a ceiling of 277 163 B.

### Live evidence (3e-3)
**2026-11-22, in-app browser pane, `npm run dev`, geo_service image at 4d90200 (source unchanged in 3e-3), all four services healthy:**
- Recording: page-level wrappers stored every `fetch` (url, body, status) and every WebSocket frame both ways; values were
  checked in the page as booleans and counts, never printed.
- Two pseudonymous users, `?identity=a` (`tester_a`) and `?identity=b` (`tester_b`), both at test spot A: each sent one
  `POST /api/locate` → 200 and joined `g7_u4pruyd@muc.chaterl.localhost/<nick>`, the room the server returned. Messages delivered
  both ways.
- Mongo `rooms` doc `g7_u4pruyd`: exactly six keys (`_id, center, createdAt, geohash, lastActiveAt, precision`), precision 7,
  `center.coordinates` `[10.407485961914062, 57.64869689941406]`; `lastActiveAt` advanced 14:04:58 → 14:07:05 after spot B and back to A.
- One request per cell change: A → B gave 1 locate, 1 unavailable presence to the old room and 1 join of `g7_u4pruye`; B again
  gave 0 locates and 0 stanzas; B → A gave 1 locate. The locate bodies in tab A equal exactly
  `[A centre, B centre, A centre]` (the oracle strings above); no body matches `57\.64911|10\.40744|10\.4087\b|accuracy|range`.
- Reconnects do not locate: both tabs dropped and reconnected while in the background (the known hidden-tab drop, see ADR-010),
  at least twice in tab A, and the locate count stayed one per move. The reconnects left stream-management ghosts (`tester_a-2`,
  `tester_b-2` in the occupant list until the old session times out). Same behaviour as before 3e-3, not caused by this slice.
- No coordinates outside `/api/locate`: 0 hits for `57\.6|10\.40|51\.50|-0\.12|\b(lat|lng|lon|latitude|longitude)\b` in 252 WS
  frames and in the console of both tabs; geo_service logs (224 lines, after all tests) 0 hits for the cell-centre digits of
  A/B/C, the raw spot values, `locate_`, `tampered`, `eyJ` and `xp1_`.
- Mongo outage: `docker compose stop mongo`, spot C → 503, retried after 5 s → "Nearby can't reach your area chat right now. We'll
  keep trying." with "Find my area chat", the old room left, composer disabled. `start mongo` → 503 ×4 in total, then 200 and a
  join of `g7_gcpvj0d` with no click; geo_service RestartCount 0.
- Token path: the first locate after arming a wrapper carried `Bearer tampered.tampered.tampered` (only that header replaced) →
  `/api/locate` 401, `/api/session/renew` 200, retried `/api/locate` 200, joined `g7_u4pruyd`, no error text.
- Identity invalid: `tester_b`'s profile deleted in Mongo, reload → renew 401 → "Nearby can't confirm your name anymore…" (still
  Online); spot A → "Nearby can't find your area chat because it can't confirm your name. To chat here, start over with a new
  name." with no retry button, 0 `/api/locate`, 0 joins.
- Storage: localStorage only `nearby.identity.v1.a` and `.b`; sessionStorage and cookies empty; no JWT-shaped or coordinate value stored.
- 360×640, Chat in the unavailable state (Mongo stopped): `scrollWidth` 360.
- Production build (re-run by the orchestrator): JS 273 163 B (gzip 85 853 B by `gzip -c | wc -c`), CSS 16 769 B; 0 hits for
  `Test spot A|Test locations|leaflet|openstreetmap|57\.64911|10\.40744|roomJidForCell`, 1 for `Find my area chat`. Over the
  271 841 B ceiling by 1 322 B (see Bundle above).
- Cleanup: `tester_a` and `tester_b` removed with `mongooseimctl account removeUser`, their profiles and the three test rooms deleted
  (`rooms` empty); `listUsers` shows alice, bob and two accounts created by the owner outside this test (kept); browser storage cleared.

---

## ADR-020 — MUC lockdown: server-created, members-only, unlisted rooms
**Status:** Accepted (Phase 3, slice 3f-1, 2026-11-23). Amends ADR-008 (no client room creation), ADR-011 (MAM access in members-only rooms) and ADR-013 ("anyone can join any `g7_` room" and the room-disco leak). **Amended by ADR-021 (3f-2): the previous room's membership is revoked on a move (D3-A resolved).**
**Context:** Until now any client could create and join any `g7_*` room: `access_create` allowed every local user, rooms were public and listed, and the web client sent the instant-room `muc#owner` IQ on a 201. MAM of an open room is readable by anyone not outcast without joining. The location product needs "you can only be in the room of the cell you located into".

**Decisions (user, 2026-11-23):**
- **D1-A members-only.** Rooms are members-only; geo_service grants `member` per successful `POST /api/locate`. (B, open but unlisted, would let anyone join any cell and read its 24 h MAM.)
- **D2-A persistent rooms** (as before). Temporary rooms are fragile (`exitRoom` destroys them) and are revisited with Phase 4.
- **D3-A no membership revoke in this slice.** Revoke-on-move (supervised ETS owner of user to last room, set the old room NONE after the new grant) is slice 3f-2, right after. Memberships accumulate in PostgreSQL until then. **Resolved by ADR-021 (3f-2).**
- **D4-A keep `g7_<geohash>` names** for now. Opaque HMAC-derived names are slice 3g, before Phase 3 closes.
- **D5-A delete the 10 existing MUC rooms and their affiliations** (done by the orchestrator before this slice; lobby is re-seeded; MAM rows stay). Counts are recorded under Live evidence.
- **D6-A accept MongooseIM warning logs in dev** (a denied creation logs `check_user_can_create_room_failed` with the JID and room at warning); `loglevel = "error"` in Phase 6 production.

**Decision:**
1. **Only geo_service creates rooms.** `access_create = "muc_create"` allows only the ACL `muc_room_owner` (`{user = "{{XMPP_ROOM_OWNER}}"}`, default `nearby-rooms`, a localpart `^[a-z][a-z0-9-]{2,31}$` that cannot collide with `u` + 32 hex; `geo_config:parse_room_owner/1`). The account is registered lazily on the first `user_not_found` from `createInstantRoom`, with a random password from `geo_session:new_password/0` that is discarded and never logged. The same variable is passed to the mongooseim and geo_service containers.
2. **Room options** (`[modules.mod_muc]` `default_room.*` in the template, and the constant `geo_xmpp_admin:room_config/0` re-applied by geo_service): `public=false`, `public_list=false`, `members_only=true`, `persistent=true`, `anonymous=true`, `allow_private_messages=false`, `allow_query_users=false`, `allow_change_subj=false`, `allow_user_invites=false`, `maygetmemberlist=[]`. `max_users` stays 200; title and description stay empty: never put a place or cell there. `access_create` stays `muc_create`; do not re-enable client room creation, `public`/`public_list`, private messages or `allow_query_users` without a new ADR.
3. **`POST /api/locate` grants access before answering 200** (`geo_room_access:grant/3`, no processes, one hard 8 s deadline, each admin call `min(5000, time left)` and none started with under 250 ms left). Order: validate, Mongo `touch_room` (Mongo down gives 503 and no admin call), then access, then the reply. The 200 body is unchanged. Only pseudonymous subjects (`u` + 32 lowercase hex) may locate; any other valid-signature subject gets the same 401 `invalid_token`.
   - Fast path (room loaded): one call, `setUserAffiliation MEMBER`.
   - Slow path (`room_not_found`, e.g. a new cell or after a MongooseIM restart): `createInstantRoom` with the owner full JID `<owner>@<domain>/geo_service` and nick `Nearby` (on `user_not_found`: register the owner, then create once more) → `changeRoomConfiguration` with the constant config (every field of the answer must equal the request, else failure and nobody is granted) → `exitRoom` for the owner's ghost occupant (best effort) → `setUserAffiliation MEMBER`.
   - Failure mapping: MongooseIM unreachable, 5xx or deadline gives 503 `service_unavailable` + `retry-after: 5`; an admin 401, unexpected answer or uncreatable room gives 500 `internal_error` and one `room_access_failed` warning with atoms only (step, reason). The GraphQL documents are constants with variables only; bodies, passwords and room JIDs together with a subject are never logged.
4. **Web client.** It never creates a room: a join answered with status 201 sends a leave presence and fails with reason `other`, condition `room-created`; no `muc#owner` IQ exists any more (`roomCreation.ts`, `NS_MUC_OWNER`, `room-config-failed` and the `iqTimeoutMs` option removed). `not-allowed` joins the known failure reasons. A join refused with `registration-required` or `not-allowed` for the assigned room locates once more (`roomAssigner.refresh()`) and rejoins once (`useAccessRecovery`); a second refusal before a successful join shows "Nearby couldn't let you into this area's chat." with a manual "Try again". There is no loop.
5. **dev-seed.sh** registers the owner account, creates `lobby` through it, applies the config, and makes alice and bob members. **Re-run it after restarting MongooseIM.**

**Verified facts (MongooseIM 6.2.1)** (release source in the container, `/usr/lib/mongooseim/lib/mongooseim-6.2.1/{src,include,priv}`, and https://esl.github.io/MongooseDocs/6.2.1/modules/mod_muc/):
- Config keys: `access_create` (default `all`) and `default_room.{public, public_list, persistent, members_only, anonymous, allow_private_messages, allow_query_users, allow_change_subj, allow_user_invites, maygetmemberlist, max_users, title, description}` exist (`mod_muc.erl` `config_spec/0`, `default_room_config_spec/0`); ACL `[acl] name = [{user = "x"}]` matches the current domain (`mongoose_config_spec.erl`); a rule with no matching clause denies (`acl.erl`).
- **Stored options override the template defaults**, and a room restored from the database keeps its old options. Every slow path therefore re-applies the config; a future config change needs reconfigure-on-load or a migration.
- `load_permanent_rooms_at_startup` is ignored in 6.2.1; `hibernated_room_check_interval` / `hibernated_room_timeout` default to `infinity` and must stay so, otherwise rooms would unload while in use.
- **Restart trap** (`mod_muc.erl` `route_to_room`): a join presence to an unloaded room checks `access_create` before restoring from the database, so after any restart members get `not-allowed` until something allowed (geo_service as the owner) loads the room; MongooseIM logs `check_user_can_create_room_failed` at warning. IQs restore without that check. This is why the client recovers by locating again.
- Service disco#items lists loaded rooms only if `public` or the asker is an occupant/admin, but **persistent unloaded rooms are listed to everyone by name**. Room `disco#info` is answered to anyone (title, `muc#roominfo_occupants`); room `disco#items` is forbidden to non-occupants only when `public_list = false`.
- Members-only: a non-member join gets `<registration-required/>`; MAM (`can_read_conference/2`) is readable by owner, admin and member only; an open room's archive is readable by anyone not outcast. Setting the same affiliation again is an ok no-op.
- Admin GraphQL (`priv/graphql/schemas/admin/muc.gql`, resolver `mongoose_graphql_muc_admin_mutation.erl`, `extensions.code` = reason atom): `createInstantRoom(room, owner: JID!, nick)` joins as the owner (checks `access_create` against the owner), restores a stored room or loads it; `setUserAffiliation` acts as the room's first owner and needs the room loaded (`room_not_found` otherwise); `changeRoomConfiguration` needs the room loaded; `exitRoom(room, user: FullJID!, nick)` is fire-and-forget. `createInstantRoom` leaves the owner as an occupant without a session (the room expels it after the subject bounce), hence `exitRoom`.

**Residuals (do not claim "cells are hidden" until slice 3g):**
- With deterministic `g7_<geohash>` names: after a MongooseIM restart disco#items lists the stored room names; room disco#info exposes the live occupant count; whether a cell room exists is an oracle.
- ~~Memberships accumulate in PostgreSQL until slice 3f-2~~: **see ADR-021** (the previous room is revoked on a move; the residual there is a restart of geo_service until slice 3f-3). MAM keeps the sender JID per room for 24 h (Phase 4 purge).
- Concurrent first locates of one cell may double-create; the owner's join and expulsion are briefly visible. Accepted.
- MUC nickname registration (`jabber:iq:register` to `muc.<domain>`) blocks a nick in every room, so the client falls back to `Name-2`. Follow-up (Phase 5).
- MongooseIM logs the JID and room on a denied creation (D6).

**Consequences:**
- A 200 from `/api/locate` now means the caller is a member of that cell's room; `/api/locate` depends on MongooseIM (503 when it is down), where before it needed Mongo only. The locate handler receives the admin client; it still has no profile access.
- After a MongooseIM restart members cannot rejoin until they locate again (automatic, once) or `dev-seed.sh` is re-run for the lobby.
- `geo_xmpp_admin` gains `set_member/4`, `create_room/5`, `configure_room/3`, `exit_room/5` and `register_user/5` (timeout argument); `geo_room_access` is new.
- Bundle: JS 274 536 B raw (86 405 B by `gzip -c | wc -c`), +1 373 B against the 273 163 B baseline; the ceiling for this slice was 277 163 B. **New baseline 274 536 B** (next ceiling 278 536 B).
- Config is applied only on the slow path. If `create_room` succeeds and `configure_room` then fails or times out, the room stays loaded with the template defaults and later locates take the fast path without re-applying the constant. Harmless today (the template defaults equal the constant, old rooms were deleted under D5), but the first future room-config change needs reconfigure-on-load or a migration.
- Review fix (round 1): `useAccessRecovery` gives the attempt back after any failed or superseded refresh, even when the assigner's `fail()` already cleared the desired room; otherwise the assigner's own retry after a 503 brought the same room back and the client showed "couldn't let you in" although the server would admit it (regression test in `tests/state/useAccessRecovery.test.tsx`).

### Probe (AC6)
**2026-11-23, `mongooseimctl` inside the recreated mongooseim container (new template), before the new geo_service image was deployed:**
- Rendered config (grep of the four relevant line groups only): `access_create = "muc_create"`, the nine `default_room.*` values from the
  template, `muc_room_owner = [{user = "nearby-rooms"}]`, `muc_create = [{acl = "muc_room_owner", value = "allow"}]`. MongooseIM
  accepted `maygetmemberlist = []` and started healthy.
- `account registerUser nearby-rooms` (random password, never printed) → registered.
- `muc createInstantRoom --room probe3f@… --owner nearby-rooms@chaterl.localhost/geo_service --nick Nearby` → `jid probe3f@muc.chaterl.localhost`.
- `getRoomConfig` → public false, publicList false, persistent true, membersOnly true, anonymous true, allowPrivateMessages false,
  allowQueryUsers false, allowChangeSubject false, allowUserInvites false, mayGetMemberList [], title "", description "" (also
  moderated true, membersByDefault true, maxUsers 200).
- `exitRoom` → "Exiting room message sent successfully"; `listRoomUsers` 2 s later → `[]` (the owner is gone).
- `setUserAffiliation alice MEMBER` twice → "Affiliation set successfully" both times; `listRoomAffiliations` → alice MEMBER,
  nearby-rooms OWNER.
- `changeRoomConfiguration --config '<the constant JSON>'` (the dev-seed form) → accepted, values echoed.
- `deleteRoom` → deleted; `muc_rooms`/`muc_room_aff` back to 0/0. No deviation from the plan.
- Step 0 (user-approved D5-A), before the probe: with mongooseim stopped, one transaction deleted 10 `muc_room_aff` and 10
  `muc_rooms` rows on `muc.chaterl.localhost` (10/10 → 0/0). MAM rows untouched.

### Live evidence (3f-1)
**2026-11-23, rebuilt geo_service image, recreated mongooseim, `npm run dev` in the in-app browser pane (the pane ran as a
background page, so actions were driven by in-page script), all four services healthy:**
- `dev-seed.sh`: owner "already exists — skipped", lobby created, configured, alice and bob made members.
  `listRoomAffiliations lobby` → alice MEMBER, bob MEMBER, nearby-rooms OWNER; `getRoomConfig lobby` equals the constant.
- AC8: two new identities (`lock_a`, `lock_b`) at test spot A → one `/api/locate` 200 each, joined `g7_u4pruyd` with no presence
  error, "People here · 2", messages delivered both ways, and after reloading B both messages came back from MAM.
  `listRoomAffiliations g7_u4pruyd` → nearby-rooms OWNER plus exactly the two pseudonymous accounts as MEMBER;
  `getRoomConfig` equals the constant.
- AC9: raw XMPP-over-WebSocket script as alice (not a member; password read from `.env`, never printed):
  (a) disco#items on `muc.chaterl.localhost` while `g7_u4pruyd` was loaded → 0 items;
  (b) join `g7_u4pruyd` → `registration-required`;
  (c) MAM query to `g7_u4pruyd` → `not-allowed`, 0 messages returned;
  (d) join `probe-<random>` → `not-allowed`, `muc_rooms` count 2 before and after;
  (e) room disco#items → `forbidden`;
  (f) room disco#info → answered, identity name `g7_u4pruyd`, `muc#roominfo_occupants` 4 (two users plus two stream-management
  ghosts from reloads), features `muc_hidden, muc_membersonly, muc_moderated, muc_persistent, muc_semianonymous`. This is the D4
  residual that slice 3g closes.
- AC11: the same script right after `docker compose restart mongooseim` (35 s) → service disco#items listed `lobby` (stored, not
  loaded) and no `g7_` room, because the clients had already reloaded `g7_u4pruyd` through `/api/locate`. The residual is real
  (unloaded stored rooms are listed by name to anyone) and is closed by 3g.
- AC10: after the restart, tab A: rejoin → `not-allowed` → exactly one `/api/locate` 200 → rejoined, no error text. Tab B
  (throttled background tab) reconnected later and joined at once without a refusal, since A had reloaded the room. After the
  second restart (AC12) tab B showed the designed path too: `not-allowed` → one locate → joined (its old nickname was held by a
  stream-management ghost, so it joined as `lock_b-2`, the known ADR-010 carry-forward). Over the following 2 minutes: 0 new
  `/api/locate` in either tab. geo_service RestartCount 0.
- AC12: `docker compose stop mongooseim`, tab A picks spot B → `/api/locate` 503 after 3.5 s, "Nearby can't reach your area chat
  right now. We'll keep trying." with "Find my area chat"; `POST /api/session` also 503. After `start`: 503 ×3 in total, then 200
  and a join of `g7_u4pruye` with no click. (The `retry-after: 5` header is asserted in CT; no token was at hand to curl it live.)
- AC13: geo_service logs (78 lines) → 0 hits for the A/B cell-centre digits, raw spot values, `eyJ`, `xp1_`, `g7_u4pruy`,
  `room_access_failed` and `locate_`; the two subs appear only in the existing `session_created` lines (ADR-017), never with a room.
  MongooseIM logged `check_user_can_create_room_failed` 4 times (two outsider probes, two refused rejoins), as D6 expects.
- AC14: after re-running `dev-seed.sh` (the restarts unloaded the lobby), bob and then alice (scratchpad XMPP script) joined the
  members-only lobby and sent a message; alice's MAM query returned both. The smoke page itself was not driven, to avoid typing the
  dev password from `.env` into a page.
- Also seen: after a Docker Desktop restart, MongooseIM crashed twice on cold boot (`mongoose_wpool_rdbms_mgr` start_pool timeout
  while Postgres was still starting) and came up on the third start. A pre-existing startup race, not caused by 3f: compose's
  `depends_on: service_healthy` is already set, but Docker's restart policy brings containers back without that ordering. The
  restart policy recovers it; a longer RDBMS pool start timeout would be the follow-up if it matters for deployment.
- AC15: `g7_u4pruyd` and `g7_u4pruye` loaded through the owner and deleted; the three test accounts removed; their profiles and
  the two Mongo room docs deleted. Left: `muc_rooms` = lobby (alice, bob members; nearby-rooms owner); `listUsers` = alice, bob,
  nearby-rooms and the owner's two own accounts; browser storage empty.

## ADR-021 — Revoke the old room's membership on move
**Status:** Accepted (Phase 3, slice 3f-2, 2026-11-24). Resolves ADR-020 decision D3-A and its "memberships accumulate" residual. Builds on ADR-016 (supervision), ADR-017 (admin client: constant documents, bodies never logged), ADR-018 (guarded handler), ADR-019 (keep-room window, bundle) and ADR-020 (grant, deadline, failure mapping).
**Context:** Rooms are members-only and every successful `POST /api/locate` made the caller a `member` of the cell's room, but nothing took the membership away. A user who walked through ten cells stayed a member (and could rejoin, and read the 24 h MAM) of all ten. The product rule is "you are in the room of the cell you are in".

**Decisions (user, 2026-11-24):**
- **U1-A restart residual: ETS now.** The user to room mapping lives in ETS. A restart of geo_service forgets it; slice 3f-3 ("membership reconciliation on start": Mongo `rooms` x `listRoomAffiliations`, pending revokes, loaded rooms only) follows right after. Until then at most one stale membership per user who moves after a restart. Do not claim "one membership per user" unconditionally before 3f-3.
- **U2-A last membership kept.** The membership of the room the user is in stays after sign-out, location off or "Start over", until their next move. Phase 4 adds membership expiry (N hours after the last locate) and idle room deletion. No `POST /api/leave` now.
- **U3-A same identity, two tabs, different cells (dev picker only).** Last locate wins. The older tab shows "removed" plus "Join again"; there is no automatic re-locate (an automatic re-locate would ping-pong between the tabs).

**Decision:**
1. **`geo_membership` (new, supervised) owns the mapping and the per-user lock.** A `gen_server` under `geo_service_sup` (child between `geo_mongo_sup` and `geo_http`, `permanent`, shutdown 5000, registered name `geo_membership`) owns the ETS table `geo_membership` (`protected, named_table, set, {read_concurrency, true}`) with rows `{UserJid, Current, Pending}`. `Current` is the room of the user's last successful locate; `Pending` are rooms whose revoke failed (no duplicates, never `Current`, at most 16 per user: the oldest is dropped with one atom-only `membership_pending_dropped` warning carrying a count). Rejected: MongooseIM (no per-user room query exists, see facts), reading Postgres directly (new dependency, internal credentials and schema coupling), a field on the Mongo profile (U1-C: a durable user-to-cell link in the application database).
2. **`geo_room_access:assign/3` replaces `grant/3` in the locate handler** (`grant/3` is unchanged and is called by `assign/3`). Under the existing 8 s deadline: acquire the user's lock (waiting counts against the deadline; no lock in time is `{error, unavailable}`, so 503 with `retry-after: 5`) -> grant (unchanged) -> `geo_membership:settle/2` (records the new room, returns old current plus pending, minus the new room) -> revoke each -> requeue the failures -> release (in an `after`) -> reply. A grant failure does no settle and no revoke.
   - **Revoke before the reply** ("200 means the old membership is revoked or queued for retry"). Setting the affiliation to NONE makes the room kick the user with status 321, so the 321 can reach the client in its keep-room window.
   - **A revoke failure never changes the response.** The room is requeued and retried on the user's next locate. `unavailable` (MongooseIM down, timeout, deadline nearly spent) is requeued silently; anything else logs one `room_revoke_failed` with atoms only (`step`, `reason`).
   - **An unloaded old room** (`room_not_found`, e.g. after a MongooseIM restart): load it exactly like the grant slow path (create as the owner, configure, owner exits) and revoke again; a second `room_not_found` is a failure. Below `MIN_CALL_MS` (250 ms) no call is made and the room goes back to pending.
   - **Same-room locate** revokes nothing but retries pending revokes.
3. **Per-user lock** held across grant, settle and revoke (otherwise A then B then A could kick the user from the room they just entered). FIFO per user, at most 4 waiters (a 5th gets `{error, busy}` at once), the holder is monitored (a crash releases the lock), a waiter whose call timed out sends a `cancel` (which also releases the lock if it was granted at that very moment). Different users never block each other. `handle_call` does only map and ETS work; every admin call is made by the request process.
4. **Tracking failures are not locate failures.** `acquire` failing (owner down, timeout, deadline) is `busy`, answered as `unavailable`. `settle` or `requeue` failing (owner down) means tracking is lost: the locate still answers 200, no revoke is attempted, and one `membership_tracking_failed` warning (no fields) is logged. Restarting the owner empties the table (the same residual as U1-A).
5. **The lobby and any other non-cell room are never touched.** The tracker records only `/api/locate` rooms, and `geo_room_access:revoke/3` refuses any room whose local part fails `geo_cell:parse_room_id/1` or whose domain is not the MUC domain: no admin call, one `room_revoke_failed` with `step => guard`, `reason => not_a_cell_room`. The locate handler already admits only `u` + 32 hex subjects, so alice, bob and the room owner are excluded.
6. **Privacy of the owner process.** Its state and messages hold user to room links, which are as sensitive as user to cell. Nothing in it logs, its public functions wrap `gen_server:call/3` in `try ... catch exit:_` (the exit reason of a failed call embeds the request, so it is never logged), every callback is wrapped so an unexpected failure exits with the bare atom `membership_failed` (no arguments, no stack with values), and it implements `format_status/1` (the OTP 25+ status-map form): the state becomes counts (`rows`, `locks`), `message` and `reason` become `redacted`, `log` is empty. Tests: `sys:get_status/1` and a forced crash contain no user JID and no room.
7. **Web client.** The 321 is part of moving, never a failure. `LeaveReason` gains `removed`. A self presence of type unavailable with status 321 (the kick has no status 110, so self is recognised by the nick) in a joined room emits `room-left` with reason `removed`, and the same presence while joining emits `room-left` `removed` instead of `room-join-failed`. `Chat` shows "Moving you to your new area's chat…" without a button while a new assignment is pending (the old room is kept in the window), otherwise "You're no longer in this area's chat. Nearby may be open in another tab." with the existing "Join again". Nothing else triggers a locate: `useAccessRecovery` is unchanged (a `removed` leave is not an access failure), and a refused "Join again" goes through its existing single refresh and join.
8. **Existing memberships.** None in dev (`muc_room_aff` held the lobby's three rows and no `g7_` rows), so no migration. If a database ever holds old cell-room memberships, remove them by hand: stop mongooseim, run `DELETE FROM muc_room_aff WHERE aff = 2 AND room_id IN (SELECT id FROM muc_rooms WHERE muc_host = 'muc.<domain>' AND room_name LIKE 'g7\_%');` (`aff = 2` is member), start mongooseim.
9. **Long-term cleanup is Phase 4:** membership expiry (supervised worker, needs timestamps in the table), idle room deletion (also purges MAM; it must drop the room from every tracker entry, otherwise load-to-revoke would recreate it), account deletion must revoke before `removeUser`, and `geo_rate` should align with this table.

**Verified facts (MongooseIM 6.2.1; release source in the container, read-only psql):**
1. There is no per-user room-affiliation query: `priv/graphql/schemas/admin/muc.gql` has `listRooms`, `getRoomConfig`, `listRoomUsers`, `listRoomAffiliations(room, affiliation)` and `getRoomMessages`; `listUserRooms` exists only in `admin/muc_light.gql` (unused module). `listRoomAffiliations` sees loaded rooms only (`mod_muc_api.erl:305-314`, `room_users_aff/1` :555).
2. `NONE` is a `MUCAffiliation` (`global/muc.gql`). `setUserAffiliation` calls `mod_muc_api:set_affiliation/3` (:316-338) as the room's first owner and works on loaded rooms only (`mod_muc:room_jid_to_pid/1`, `mod_muc.erl:920-929`, no restore): an unloaded room answers `room_not_found`.
3. member to none in a members-only room (`mod_muc_room.erl:2832-2841`) calls `safe_send_kickban_presence(JID, Reason, <<"321">>, none, SD)`, removes the affiliation and the role. none to none is an ok no-op (`can_change_aff/3` :3033).
4. The kick presence (:3114-3170) comes from `room/<nick>`, `type="unavailable"`, `<x xmlns=muc#user><item affiliation="none" role="none"/><status code="321"/></x>`, **without status 110**; it goes to every occupant including the removed one, and a bare JID matches all of that user's sessions (`foreach_matched_user/3` :2181-2196), so session-management ghosts are removed too.
5. `set_affiliation(_, none, _)` removes the entry (:1406-1414); `save_persistent_room_state/1` (:966) calls `mod_muc_rdbms:store_room/4` (:126-135), which rewrites the room and all its affiliations in one transaction, so NONE deletes the `muc_room_aff` row (and each revoke changes the room's `muc_rooms.id`; MAM is keyed by JID).
6. A membership in an unloaded room is inert but persisted: MAM `can_access_room` answers `{error, not_found}` (false), a join hits the restart trap (`not-allowed`), and it revives when geo_service loads the room.
7. `removeUser` keeps MUC affiliations (mod_muc has `remove_domain` hooks, no `remove_user`; `mod_muc_rdbms` deletes per domain only).
8. `process_admin_items_set/4` logs `muc_admin_query` at **info** with the from JID and the target JID. `loglevel = "warning"` suppresses it; never lower it.
9. `deleteRoom` runs `forget_room`, which deletes the room's MAM (`mod_mam_muc.erl:242-248`); `createInstantRoom` on a missing room creates it (Phase 4 relevance).
10. Mongo: only pending profiles expire (`expiresAt`); active profiles never do. `rooms` documents expire 7 days after `lastActiveAt`; MUC rooms persist.

**Admin HTTP client (decision):** `geo_xmpp_admin` uses its own `httpc` profile (`geo_xmpp_admin`), started by `geo_service_app` with `max_keep_alive_length 0` and `max_sessions 8`, so no admin request waits behind another one. On the default profile (keep-alive, `max_keep_alive_length` 5, `max_sessions` 2) a new POST is queued behind a hung in-flight request on the same session (OTP 28 inets-9.6.2: `httpc_manager.erl:763-865`, `httpc_handler.erl:398-418`, `610-641`, `1179-1190`, `httpc_internal.hrl:37-42`), which delayed every other user by up to the 5 s call timeout (measured 2744 ms vs 9 ms). Regression case: `geo_locate_SUITE:slow_user_does_not_block_others`. `max_sessions 8` limits only the persistent connections; beyond it httpc opens extra one-off `Connection: close` connections, without a limit (`httpc_manager.erl:776-782`).

**Residuals:**
- The profile options live only in the running `httpc_manager`; inets restarts a crashed manager without them (`httpc_profile_sup.erl:107`), so after such a crash the profile falls back to the defaults and the cross-user queuing returns (still bounded by the 5 s call timeout) until geo_service restarts. Follow-up: re-apply the options when the manager restarts.
- A restart of geo_service forgets the table: at most one stale membership per user who moves afterwards, until slice 3f-3.
- The last membership stays until the next move (U2-A); Phase 4 expiry.
- Same identity in two tabs with different dev-picker cells: the last locate wins (U3-A).
- Each revoke rewrites the room row and its affiliations. A revoke after a MongooseIM restart adds up to four admin calls (load, then set NONE), all within the 8 s deadline; lock waits end in 503, not in a hang.
- The ETS table grows by one row (about 200 bytes) per user since start; Phase 4 expiry bounds it.
- "Join again" after `removed` may briefly show "You can't open this room." (known carry-forward from ADR-020).
- Opaque room names (3g) and the disco/occupant-count oracle are unchanged.

**Consequences:**
- `/api/locate` can now wait up to the 8 s deadline for the user's own earlier locate, and answers 503 when it cannot get the lock. The 200 body and the 401/400/500 shapes are unchanged.
- New files: `geo_membership.erl`; `geo_xmpp_admin` gains `set_none/4` (+ `set_none_request/3`, `parse_set_none/2`); `geo_room_access` gains `assign/3`, `revoke/3` and the extracted `load_room/3`; `geo_http_locate` calls `assign/3` and passes `muc_domain` in the context. New log events (atoms and counts only): `room_revoke_failed`, `membership_tracking_failed`, `membership_pending_dropped`.
- Test double: `geo_fake_mim` handles `setUserAffiliation` NONE, keeps affiliations across `reset/0` (a MongooseIM restart), and has the modes `none_503`, `slow_member` and `{slow_for, UserJid}`.
- Proposed CLAUDE.md additions (user-owned): "A user is a member of at most one cell room; every path that grants MUC membership goes through `geo_room_access:assign/3`." "MongooseIM `loglevel` must stay `warning` or stricter: at info it logs user JID and room on affiliation changes." "`removeUser` does not remove MUC affiliations in 6.2.1: revoke memberships before deleting an account." "Processes whose state or messages hold user-to-room or user-to-cell data implement `format_status/1`."

### Live evidence (3f-2)
**2026-11-25, rebuilt geo_service image, all four services healthy; API + XMPP driven by a scratchpad script with a fresh
`/api/session` identity (credentials in a scratchpad file, never printed, deleted afterwards), browser checks in the in-app pane
driven by in-page script (the pane ran as a background page):**
- AC7 (old room is shut): locate A → 200, join A, message echoed; locate B → 200 in 1.4 s (B was new, slow path). The script then
  received, for its A nick: `<presence from='<roomA>/mover_a' to='<user>@chaterl.localhost/mover' type='unavailable'><x
  xmlns='http://jabber.org/protocol/muc#user'><item affiliation='none' role='none'/><status code='321'/></x></presence>` (no
  110, as fact 4 says). MAM query to A → `not-allowed`, 0 messages; join A → `registration-required`.
- AC6 (one membership): after A → B, `listRoomAffiliations` A = nearby-rooms OWNER only; B = nearby-rooms OWNER + the user
  MEMBER; `muc_room_aff` rows for that user = 1. After A → B → B again: still 1. Round 2 (2026-11-25, image with the dedicated
  httpc profile), a fresh identity A → B → A → B: after every step exactly one room lists the user and its `muc_room_aff` count is 1.
- AC10 (geo_service restart, the U1 residual): user a member of B; `docker compose restart geo_service`; move to C → 200, B still
  lists the user (2 rows: B and C), as expected until 3f-3; move to A → C revoked, B still listed. RestartCount 0, 0 `locate_crashed`.
- AC11 (MongooseIM restart, load-to-revoke): user a member of A (and the stale B); `docker compose restart mongooseim` → all three
  rooms unloaded; locate B with the same token → 200; A was loaded through the owner and revoked (`listRoomAffiliations` A = owner
  only), `listRoomUsers` A = `[]` (no owner ghost); the user is back to 1 row (B is the current room, so the stale B became current).
- AC8 (keep-room window, two identities `move_one`/`move_two` at A): tab 1 picks B → exactly 1 `/api/locate` 200, received the 321
  for A, sent no stanza to A afterwards (its only presence was the join of `g7_u4pruye`). Every `role=status` text seen during the
  move: "Finding the chat for Area u4pruye…", "You're in Area u4pruyd as move_one", "Moving you to your new area's chat…",
  "Joining Area u4pruye…", "You're in Area u4pruye as move_one", "Loading recent messages…": no "Join again", no "You left the
  room". Tab 2 showed "move_one left". 0 new locates in either tab over the next 2 minutes.
- AC9 (same identity `m1` in a second tab, picks C): the older tab showed "You're no longer in this area's chat. Nearby may be open
  in another tab." with "Join again"; 0 automatic locates in any tab over 2 minutes (no ping-pong). "Join again" → join refused
  `registration-required` → exactly one `/api/locate` 200 → joined B; the newer tab then showed the removed text, with no locate.
- AC5 / lobby: `muc_room_aff` for `lobby` unchanged after all tests (alice member, bob member, nearby-rooms owner).
- AC12 (logs): geo_service (155 lines) 0 hits for the A/B/C cell-centre digits, `g7_`, `eyJ`, `xp1_`, `room_revoke_failed`,
  `membership_`, `locate_crashed`; the test localpart appears only in its `session_created` line (ADR-017). MongooseIM:
  `muc_admin_query` 0, `muc_send_kickban_presence_failed` 0.
- AC13 (cleanup): the three test rooms loaded through the owner and deleted, the three test accounts removed, their profiles and the
  Mongo room docs deleted; `muc_room_aff` = the three lobby rows; `listUsers` = alice, bob, nearby-rooms and the owner's two own
  accounts; browser storage empty.
