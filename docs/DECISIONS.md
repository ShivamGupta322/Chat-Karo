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
**Status:** Accepted (Phase 2, slice 2b-1, 2026-11-18)
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
