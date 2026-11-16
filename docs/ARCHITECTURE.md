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
1. Client `POST /api/session {nickname}` → geo_service creates/fetches profile in MongoDB, registers the
   XMPP user via MongooseIM's admin API if new, returns `{jid, xmpp_password_or_token, api_jwt}`.
2. Client connects to `wss://…/ws-xmpp` with Strophe.js and authenticates (SASL).

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
├── geo_mongo_pool            # mongodb-erlang connection pool
├── geo_rate                  # owns ETS table: user → {last_cell_centre, last_ts, tokens}
├── geo_room_sup (simple_one_for_one)
│   └── geo_room  ×N          # one gen_server per active cell; idle timeout → stop
├── geo_room_registry         # local cell → pid registry (ETS owned by this process, monitors rooms)
└── geo_http                  # Cowboy listener (ranch) — handlers are short-lived per request
```

### Modules

| Module | Responsibility |
|---|---|
| `geo_service_app` / `geo_service_sup` | Application start, top supervisor |
| `geohash` | Pure encode/decode/neighbours — fully unit-tested, property-tested |
| `geo_cell` | Range → precision, cell → room JID, cell centre |
| `geo_rate` | Token-bucket rate limit + impossible-jump check (ETS) |
| `geo_room` | Per-cell gen_server: activity tracking, idle shutdown, slow-mode settings |
| `geo_room_sup` | Starts/stops `geo_room` children on demand |
| `geo_http_*` | Cowboy handlers: `session`, `locate`, `places`, `report` |
| `geo_auth` | JWT issue/verify |
| `geo_xmpp_admin` | Calls MongooseIM admin API (register user, set room affiliation) |
| `geo_store` | All MongoDB access (rooms, places, profiles, reports) |

### HTTP API (v1)

| Method | Path | Body → Response |
|---|---|---|
| POST | `/api/session` | `{nickname}` → `{jid, xmpp_credentials, token}` |
| POST | `/api/locate` | `{lat, lng, accuracy, range}` → `{cell, room_jid, places}` |
| GET | `/api/rooms/nearby?cell=…` | → active rooms in neighbouring cells |
| GET | `/api/places?cell=…` | → named places in/near cell |
| POST | `/api/report` | `{room_jid, message_id, reason}` → `204` |
| GET | `/api/health` | → `{status:"ok"}` |

Errors: `{error: "<code>", message: "<human text>"}` with proper HTTP status.

## MongoDB data model

```js
// rooms — one per cell that has ever been active
{ _id: "g7_gcpvj0e", precision: 7, geohash: "gcpvj0e",
  center: { type: "Point", coordinates: [lng, lat] },   // cell centre, not a user position
  placeId: ObjectId | null, slowModeSec: 0,
  createdAt: ISODate, lastActiveAt: ISODate }
// indexes: center 2dsphere; lastActiveAt TTL (e.g. 7 days idle → removed)

// places — seeded points of interest
{ _id, name: "Central Library", kind: "library",
  location: { type: "Point", coordinates: [lng, lat] }, radiusM: 80 }
// indexes: location 2dsphere

// profiles
{ _id: "<xmpp localpart>", nickname, status: "just arrived", createdAt, blocked: ["<localpart>"] }
// indexes: nickname unique, case-insensitive (collation en/strength 2)

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
├── xmpp/        client.ts (connect, reconnect w/ backoff), muc.ts (join/leave/send), types.ts
├── geo/         useLocation.ts (watchPosition + hysteresis), geohash helpers (ngeohash)
├── api/         geoService.ts (typed fetch wrapper)
├── state/       Zustand stores: session, room, messages, presence
├── components/  MessageList, Composer, OccupantList, RangeSlider, RoomMap, ReportDialog
└── pages/       Onboarding, Chat, Map
```

State flow: `useLocation` → `/api/locate` → room store updates `currentRoomJid` → xmpp `muc` effect
leaves old / joins new → incoming stanzas dispatched to message & presence stores.

## Security

- TLS everywhere outside the Docker network.
- JWT (short-lived) for geo_service; XMPP SASL for MongooseIM.
- Input validation at every HTTP handler; message length limits enforced in MongooseIM config + client.
- Rate limits: per-user locate (token bucket), per-room slow mode, MongooseIM traffic shaping.
- No coordinates in logs, DB, or XMPP stanzas.

## Observability

- Structured logging via OTP `logger` (JSON formatter) in geo_service.
- `/api/health`; MongooseIM metrics endpoint (Prometheus) if time allows.
