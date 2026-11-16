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
