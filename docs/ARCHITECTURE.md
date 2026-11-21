# Architecture

## System diagram

```
┌──────────────────────────── Browser ────────────────────────────┐
│ React + TS (Vite)                                                │
│  geo/  (Geolocation API, hysteresis)   xmpp/ (Strophe.js client) │
│  state/ (Zustand)   components/  pages/   Leaflet map            │
└───────┬───────────────────────────────────────────┬──────────────┘
        │ HTTPS  /api/*  (JSON, JWT)                │ WSS /ws-xmpp (XMPP over WebSocket, RFC 7395)
        ▼                                           ▼
┌──────────────────────┐   admin API     ┌──────────────────────────┐
│ geo_service          │ ──────────────► │ MongooseIM 6.x           │
│ Erlang/OTP + Cowboy  │ (GraphQL admin) │ c2s, mod_muc, mod_mam,   │
│ cells, rooms, places,│                 │ mod_websockets, presence │
│ rate limits, mod.    │                 └────────────┬─────────────┘
└──────────┬───────────┘                              │
           ▼                                          ▼
┌──────────────────────┐                 ┌──────────────────────────┐
│ MongoDB 7            │                 │ PostgreSQL 16            │
│ rooms, places,       │                 │ XMPP users, roster,      │
│ profiles, reports    │                 │ MAM message archive      │
└──────────────────────┘                 └──────────────────────────┘
```

In production a reverse proxy (Caddy or nginx) terminates TLS and routes `/api` → geo_service,
`/ws-xmpp` → MongooseIM, `/` → static web build.

## Why this split

- **MongooseIM owns XMPP**: auth, connections, MUC, presence, delivery, archive. We configure it, not fork it.
- **MongooseIM uses PostgreSQL** for its internals because MongoDB is not one of its supported backends
  (see DECISIONS.md ADR-002). This keeps us on well-trodden paths.
- **geo_service owns the product logic**: location → cell → room, room lifecycle, places, moderation.
  This is where the custom Erlang lives and is the main portfolio showcase.
- **MongoDB owns app data** where its document model, `2dsphere` and TTL indexes fit naturally.

## Key flows

### Login
1. Client `POST /api/session {nickname}` (ADR-017). geo_service validates the nickname, reserves it in
   `profiles` (the unique case-insensitive index is the claim), generates a random localpart `u<32 hex>` and a
   random password `xp1_…`, registers that account in MongooseIM through the admin GraphQL API (a real rdbms user,
   SCRAM-hashed there), activates the profile and returns `{nickname, jid, xmpp_password, token, token_type,
   expires_in}` once. The token is a 1 h HS256 JWT for geo_service only. The client keeps `{jid, xmpp_password}`
   as its long-lived device credential. Renewal (`POST /api/session/renew {jid, xmpp_password}`, checked with the
   admin `checkPassword`) is designed now and built in 3e. A lost device is a new identity.
2. Client connects to `wss://…/ws-xmpp` with Strophe.js and authenticates (SASL) with `jid` + `xmpp_password`.

### Locate & join
1. Client gets `{lat, lng, accuracy}` from `navigator.geolocation.watchPosition`.
2. Client `POST /api/locate {lat, lng, accuracy, range}` (JWT auth).
3. geo_service:
   - validates input (lat ∈ [-90,90], lng ∈ [-180,180], accuracy sane);
   - checks rate limit + impossible-jump against the user's *last cell centre and timestamp* (ETS — no raw coords kept);
   - encodes geohash at the range's precision; computes the room JID;
   - ensures a `geo_room` process exists for the cell (starts it on demand);
   - upserts the `rooms` document; returns `{cell, room_jid, neighbours?, places_nearby}`.
   - **discards lat/lng.**
4. Client joins the MUC room via presence to `room_jid/nick`, leaves the old one if the cell changed.

### Moving
Client-side `geo/` applies hysteresis: it only calls `/api/locate` when the device is ≥ a margin inside
a different cell (or every N minutes as a heartbeat). Server rate-limits regardless.

### Messaging
Pure XMPP: `groupchat` messages to the room JID; MongooseIM fans out. History via MAM (MUC archive),
limited to 24 h by query and periodic purge (see ADR-004).

## Room naming

```
<prefix><precision>_<geohash>@muc.<domain>
e.g.  g7_gcpvj0e@muc.chaterl.localhost
```

Room JIDs are deterministic from the cell so any node can compute them; no lookup needed to join.

## geo_service (Erlang/OTP)

### Supervision tree

```
geo_service_sup (one_for_one)
├── geo_mongo_sup (rest_for_one)   # everything the mongodb driver needs; the driver app itself is never started
│   ├── mongo_id_server       # driver ETS/id owner
│   ├── mc_worker_pid_info    # driver ETS owner
│   ├── mc_pool_sup           # = geo_mongo_pool_sup: simple_one_for_one, TEMPORARY pool children (ADR-016 quirk 9)
│   ├── geo_mongo             # mongodb-erlang topology (registered geo_mongo_topology)
│   └── geo_mongo_probe       # pings Mongo every 5 s, publishes up/down in ETS (readiness), reaps abandoned heartbeat connections
├── geo_rate                  # owns ETS table: user → {last_cell_centre, last_ts, tokens}
├── geo_room_sup (simple_one_for_one)
│   └── geo_room  ×N          # one gen_server per active cell; idle timeout → stop
├── geo_room_registry         # local cell → pid registry (ETS owned by this process, monitors rooms)
└── geo_http                  # Cowboy listener (ranch) — handlers are short-lived per request
```

**Status (Phase 3b):** `geo_mongo_sup` and `geo_http` exist under `geo_service_sup` (one_for_one, intensity
5 / period 10, started in that order); `geo_mongo_sup` (rest_for_one, intensity 5 / period 10) holds the driver's service
processes, the topology and the readiness probe. The `mongodb` driver is an included application (loaded and shipped,
never started), so its own supervision tree is replaced by ours and pool children are temporary; the other
`geo_service_sup` children arrive in later slices. Mongo may be down at boot: the app
still starts (degraded), `/api/ready` answers 503 and the driver reconnects by itself (ADR-016). The listener is embedded with `ranch:child_spec/5` (`cowboy_clear` protocol), so it lives
under our supervisor and a crash restarts it; `cowboy:start_clear/3` is deliberately not used. JSON is encoded
with OTP's stdlib `json` (OTP 27+, pinned 28.4.2; see ADR-015). `geo_config` is the only module that reads the application
environment: `GEO_HTTP_IP` / `GEO_HTTP_PORT` and the `MONGO_*` variables flow in through `config/sys.config.src` and are validated at
start. A bad value stops the application and logs only the key name. A logger filter (`geo_log_redact`) is installed
before the supervisor and replaces the Mongo password, the MongooseIM admin password (and its base64 form in the
`Authorization` header) and the JWT secret with `[REDACTED]` in every log event. Two patterns also catch secrets minted at
run time: XMPP passwords (`xp1_` + 32 characters) and JWT-shaped strings.

**Status (Phase 3c):** `POST /api/session` is live. `inets` (OTP `httpc`, default profile, per-request options only) is the
admin API client. New environment keys, validated by `geo_config:session/0` (key name only in errors): `JWT_SECRET`
(32..512 printable ASCII, at least 10 distinct characters, not starting with `change-me`), `XMPP_DOMAIN`,
`MONGOOSEIM_ADMIN_URL` (http only), `MONGOOSEIM_ADMIN_USER`, `MONGOOSEIM_ADMIN_PASSWORD`. `/api/ready` does not depend on
the admin API: a MongooseIM outage only makes session requests answer 503. The request runs in the Cowboy request
process (no gen_server). Rate limiting is deferred (Phase 4 and 6 in the roadmap).

`geohash` API (pure; no logging, no processes; matches `web/src/geo/geohash.ts`):

| Function | Returns |
|---|---|
| `encode(Lat, Lng, Precision)` | `{ok, Hash}` or `{error, invalid_precision \| lat_out_of_range \| lng_out_of_range}` (precision checked first; never raises) |
| `bounds(Hash)` | `{ok, #{south, west, north, east}}` or `{error, invalid_geohash}` |
| `centre(Hash)` | `{ok, {Lat, Lng}}` (cell centre) or `{error, invalid_geohash}` |
| `neighbour(Hash, Dir)` | `{ok, Hash2}` or `{error, invalid_geohash \| beyond_pole}`; `Dir` is `n ne e se s sw w nw` |
| `neighbours(Hash)` | `{ok, #{Dir => Hash2}}`; directions past a pole are omitted; longitude wraps at ±180 |

### Modules

| Module | Responsibility |
|---|---|
| `geo_service_app` / `geo_service_sup` | Application start, top supervisor |
| `geo_mongo_sup` | rest_for_one supervisor for the driver's service processes, the topology and the probe |
| `geo_mongo_pool_sup` | Registered as `mc_pool_sup`; simple_one_for_one with temporary poolboy children (replaces the driver's transient one) |
| `geohash` | Pure encode/decode/neighbours — fully unit-tested, property-tested |
| `geo_cell` | Pure: range → precision, point → cell, cell ↔ room id, room JID, GeoJSON cell centre |
| `geo_mongo` | Driver topology child spec, `ready/0`, `ping/0`, `update_one/4`, `find_one/3`, write-result classification |
| `geo_mongo_probe` | gen_server owning the `geo_mongo_status` ETS table (up/down), probes every 5 s, reaps abandoned heartbeat connections |
| `geo_mongo_reaper` | Pure: finds the driver monitor's abandoned heartbeat `mc_worker` processes and picks those older than 30 s (ADR-016 quirk 10) |
| `geo_log_redact` | Logger primary filter that redacts the configured secrets plus run-time patterns (xp1_ passwords, JWTs) |
| `geo_rate` | Token-bucket rate limit + impossible-jump check (ETS) |
| `geo_room` | Per-cell gen_server: activity tracking, idle shutdown, slow-mode settings |
| `geo_room_sup` | Starts/stops `geo_room` children on demand |
| `geo_config` | The only reader of app env; validates `http_ip` / `http_port`, the `mongo_*` keys and `session/0` (JWT secret, XMPP domain, admin API) |
| `geo_http` | Embedded ranch listener and routes |
| `geo_http_reply` | JSON replies and security headers |
| `geo_http_*` | Cowboy handlers: `health`, `ready`, `not_found`, `session`, and later `locate`, `places`, `report` |
| `geo_http_json` | Reads a small JSON-object body: content type, size cap, decoding |
| `geo_auth` | Pure HS256 JWT issue/verify (HS256 only, constant-time signature check before the payload is parsed) |
| `geo_nickname` | Pure nickname rules and the reserved list |
| `geo_session` | Creates a session: reserve the nickname, register the XMPP account, activate, issue the JWT, roll back on failure |
| `geo_xmpp_admin` | MongooseIM admin GraphQL client (`registerUser`, `removeUser`); later room affiliations. Never logs bodies |
| `geo_store` | All MongoDB access: rooms (`touch_room/1,2`, `get_room/1`) and profiles (`create_pending_profile/3`, `activate_profile/1`, `delete_profile/1`, `get_profile/1`); places and reports later. Takes cells, never coordinates |

### HTTP API (v1)

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/session` | `{nickname}` → `201 {nickname, jid, xmpp_password, token, token_type:"Bearer", expires_in:3600}`; errors `400 invalid_json / invalid_request / invalid_nickname`, `405`, `409 nickname_taken` (also for reserved names), `413`, `415`, `503` (+ `retry-after: 5`), `500`. Body cap 1024 bytes. Never logged |
| POST | `/api/locate` | `{lat, lng, accuracy, range}` → `{cell, room_jid, places}` |
| GET | `/api/rooms/nearby?cell=…` | → active rooms in neighbouring cells |
| GET | `/api/places?cell=…` | → named places in/near cell |
| POST | `/api/report` | `{room_jid, message_id, reason}` → `204` |
| GET | `/api/health` | → `{status:"ok"}` (liveness: 200 whatever Mongo's state) |
| GET | `/api/ready` | → `200 {"status":"ready","mongo":"up"}` or `503 {"status":"unavailable","mongo":"down"}` (readiness; GET/HEAD only; used by the compose healthcheck) |

Errors: `{error: "<code>", message: "<human text>"}` with proper HTTP status.

## MongoDB data model

```js
// rooms — one per cell that has ever been active
{ _id: "g7_gcpvj0e", precision: 7, geohash: "gcpvj0e",
  center: { type: "Point", coordinates: [lng, lat] },   // cell centre, not a user position
  placeId: ObjectId | null, slowModeSec: 0,
  createdAt: ISODate, lastActiveAt: ISODate }
// indexes: center 2dsphere; lastActiveAt TTL (e.g. 7 days idle → removed)
// Phase 3b writes exactly: _id, precision, geohash, center, createdAt, lastActiveAt. placeId / slowModeSec arrive in
// Phase 5; readers must treat a missing placeId as null and a missing slowModeSec as 0.

// places — seeded points of interest
{ _id, name: "Central Library", kind: "library",
  location: { type: "Point", coordinates: [lng, lat] }, radiusM: 80 }
// indexes: location 2dsphere

// profiles
{ _id: "u<32 hex> (random XMPP localpart)", nickname, state: "pending" | "active", createdAt,
  expiresAt (pending only: createdAt + 600 s) }   // status / blocked: later slices
// indexes: nickname_unique_ci (nickname, unique, collation en/strength 2),
//          expiresAt_ttl (expireAfterSeconds 0: orphaned pending reservations free their nickname)

// reports
{ _id, roomId, messageId, reporter, reason, createdAt }
// indexes: createdAt TTL 30 days
```

All indexes are created by `infra/mongo/init-indexes.js`.

## Frontend (React + TypeScript)

**Why React + TS + Vite:** best ecosystem for XMPP (Strophe.js), maps (react-leaflet), and testing;
TypeScript makes the XMPP stanza layer much safer; Vite is fast and simple; widely recognised by recruiters.

```
web/src/
├── xmpp/        client.ts (connect, reconnect w/ backoff), muc.ts (join/leave/send), types.ts,
│                reconnect.ts (backoff + retry scheduler), lifecycle.ts (online/visible wake), socketClose.ts (close diagnostics),
│                mam.ts (MAM history query builder + result/fin parsers, pure)
├── geo/         geohash.ts (own encoder, no ngeohash), cell.ts (cellFor; roomJidForCell is TEMPORARY until Phase 3),
│                useLocation.ts (watchPosition + Permissions API, cell-only state), useArea.ts (device cell + dev spot),
│                DevLocationPicker.tsx (dev only), DevMap.tsx (dev only, lazy, the only Leaflet importer; shades the whole
│                cell, never the clicked point), DevMapBoundary.tsx (error boundary), decodeGeohashBounds/wrapLng in
│                geohash.ts, index.ts (the only public entry; coordinates never leave geo/;
│                hysteresis arrives in Phase 4)
├── api/         geoService.ts (typed fetch wrapper)
├── state/       Zustand stores: session, room, messages, presence; useAreaRoom.ts (keeps the client in the one desired room)
├── components/  MessageList (+ scrollAnchor.ts: keeps scroll position when earlier messages load above),
│                Composer, OccupantList, AreaPanel, RangeSlider, RoomMap, ReportDialog
└── pages/       Onboarding, Chat, Map
```

State flow: `useLocation` → `/api/locate` → room store updates `currentRoomJid` → xmpp `muc` effect
leaves old / joins new → incoming stanzas dispatched to message & presence stores.

## Security

- TLS everywhere outside the Docker network.
- JWT (1 h, HS256, claims iss/aud/sub/iat/exp/jti, no nickname) for geo_service; XMPP SASL for MongooseIM. The XMPP
  password is returned once and never logged; bodies of `/api/session` and of the admin API are never logged.
- No CORS: the client calls `/api/` same-origin (Vite proxy in dev, reverse proxy in production).
- Input validation at every HTTP handler; message length limits enforced in MongooseIM config + client.
- Rate limits: per-user locate (token bucket), per-room slow mode, MongooseIM traffic shaping.
- No coordinates in logs, DB, or XMPP stanzas.

## Observability

- Structured logging via OTP `logger` (JSON formatter) in geo_service.
- `/api/health` (liveness) and `/api/ready` (readiness); MongooseIM metrics endpoint (Prometheus) if time allows.
