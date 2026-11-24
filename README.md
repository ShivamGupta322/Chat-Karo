# Nearby

_Location-based chat (codebase: chatErl)_

**Chat with the people around you.** Open the app and you're in a live chat for the area you're standing
in — a campus, a café, a conference hall. No friend list, no invites. Walk away and you leave the room.

Built with **Erlang/OTP**, **MongooseIM (XMPP)**, **MongoDB** and a **React + TypeScript** client.

> Status: 🚧 in development. Phase 1 (XMPP infrastructure) is done; see [docs/ROADMAP.md](docs/ROADMAP.md)

## How it works

1. The browser gets your position from the Geolocation API and snaps it to your ~150 m area.
2. It sends only that area's centre to the Erlang **geo_service**, which picks the room and discards the coordinates.
3. You join the XMPP multi-user chat room for that cell (and optionally its neighbours).
4. Move into a new cell and the client switches rooms automatically.

Other users only ever see which *room* you're in — never your coordinates.

## Features (planned)

- Automatic area rooms at three ranges: **Block** (~150 m), **Neighborhood** (~1 km), **Area** (~5 km)
- Ephemeral messages that expire after 24 h
- Named places ("Central Library", "Food Court")
- Rich presence ("just arrived", "leaving soon")
- Moderation: report, mute, block, slow mode
- Live map of nearby active rooms

## Architecture

```
 Browser (React + Strophe.js)
   │  HTTPS: POST /api/locate          │  WebSocket: XMPP
   ▼                                   ▼
 geo_service (Erlang/OTP, Cowboy) ──► MongooseIM (XMPP, MUC)
   │                                   │
   ▼                                   ▼
 MongoDB (rooms, places, profiles)   PostgreSQL (XMPP users, archive)
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Running locally

Prerequisites: Docker Desktop, Node 20+, Git Bash (on Windows).

```bash
cp .env.example .env          # then replace every "change-me" with a random value; JWT_SECRET: openssl rand -hex 32
docker compose up -d          # MongooseIM, PostgreSQL, MongoDB, geo_service — wait until `docker compose ps` shows 4 healthy
curl http://127.0.0.1:8080/api/health    # geo_service liveness (first start builds the image): {"status":"ok"}
curl http://127.0.0.1:8080/api/ready     # readiness, 200 once Mongo answers: {"status":"ready","mongo":"up"}
# after changing geo_service code, rebuild: plain `up -d` does not rebuild an existing image
docker compose up -d --build geo_service
bash infra/mongooseim/dev-seed.sh   # alice, bob, the room-owner account and the members-only lobby; re-run it after restarting MongooseIM
node tools/xmpp-smoke/serve.mjs
```

MUC rooms are created only by geo_service through the room-owner account (`XMPP_ROOM_OWNER` in `.env`, default `nearby-rooms`,
shared by the mongooseim and geo_service containers) and are members-only (ADR-020). After `docker compose restart mongooseim`
the rooms are unloaded: members get `not-allowed` on rejoin until the web client locates again (it does so once by itself), and
the dev lobby needs `bash infra/mongooseim/dev-seed.sh` again.

Create a pseudonymous session (reserves the nickname, registers a random XMPP account, returns its password
once plus a 1 h API token; `201` with `nickname`, `jid`, `xmpp_password`, `token`, `token_type`, `expires_in`):

```bash
curl.exe -X POST http://127.0.0.1:8080/api/session -H "content-type: application/json" -d "{\"nickname\":\"Zed\"}"
```

Locate: turn a position into a room (the coordinates become a geohash cell and are discarded, never logged or stored).
Put the body in a file (`body.json`: `{"lat":57.6491137,"lng":10.4074419}`; optional `"range"`: `block` (default),
`neighbourhood` or `area`, optional `"accuracy"` in metres, ignored), and use the token from `/api/session`:

```bash
curl.exe -X POST http://127.0.0.1:8080/api/locate -H "authorization: Bearer <token>" -H "content-type: application/json" --data-binary @body.json
# 200 {"cell":"u4pruyd","precision":7,"range":"block","room_jid":"g7_u4pruyd@muc.chaterl.localhost"}
```

Errors: `401` (missing or invalid token, with `www-authenticate`), `400 invalid_json / invalid_request / invalid_location`,
`405`, `413` (body over 256 bytes), `415`, `503` (+ `retry-after: 5`), `500`. The token goes in the header only, never in the query string.

While `npm run dev` is running, the same API is reachable same-origin at `http://localhost:5173/api/...` (Vite proxies
`/api/` to geo_service on `127.0.0.1:GEO_HTTP_PORT`). Never paste the response into issues or logs: it holds a password.

geo_service integration tests (`cd geo_service && rebar3 ct`) need the dev MongoDB up on `127.0.0.1:27018`
(override with `GEO_CT_MONGO_HOSTS`); they only use the database `chaterl_ct`. To (re-)apply the collection indexes to
a running Mongo (idempotent; needed once on Atlas):

```bash
MSYS_NO_PATHCONV=1 docker compose exec -T mongo mongosh --quiet chaterl /docker-entrypoint-initdb.d/init-indexes.js
```

Open http://localhost:8000/?user=alice in one tab and http://localhost:8000/?user=bob in another, log in
with `DEV_USER_PASSWORD` from `.env`, join `lobby@muc.chaterl.localhost` and chat.

### Web client (dev)

```bash
cd web
npm ci
npm run dev      # http://localhost:5173
```

Open http://localhost:5173 and pick a name. Nearby creates a pseudonymous identity for this browser (there is no email or
password), stores it on this device only, and puts you in the chat for the area you are in. Reloading signs you back in
automatically; "Sign out" keeps the name ("Continue as ..."), and "Start over with a new name" asks first and forgets it.
The `alice` and `bob` users from the dev seed are only for the smoke page above.
The browser asks for permission to use your location; the chat room is named after your area code (for example
`Area u4pruyd`). Only the centre of your area is sent to geo_service, which picks the room; your exact position never leaves the browser and nothing is stored.
Optional, dev only: set `VITE_MAP_TILE_URL` in `.env` (the line in `.env.example` uses OpenStreetMap tiles; copy it if
your `.env` predates this) to get a map in the "Test locations (dev)" panel. Leave it empty for no map; the test spots
and fields still work. The map is never part of a production build. Each tile request tells the tile server which area
you are viewing, plus your IP, and OpenStreetMap's tile policy asks for light interactive use with the attribution kept
visible (see `.env.example`).
Location needs a secure page: `localhost` works, but a LAN IP over plain http (for example from a phone) is
treated as insecure and shows a message instead.

Dev only: `http://localhost:5173/?identity=b` keeps a separate stored name for that window (the slot is 1-16 of
`a-z0-9`), so two windows can be two people. A private window works too. `VITE_API_URL` (optional, default `/api`) is
the same-origin path of the geo_service API.

#### Removing test names

Every test name creates a real account and profile. To remove them (replace the names):

```bash
MSYS_NO_PATHCONV=1 docker compose exec -T mongo mongosh --quiet chaterl --eval 'db.profiles.find({nickname:{$in:["Alice_1"]}},{_id:1}).toArray()'
MSYS_NO_PATHCONV=1 docker compose exec mongooseim mongooseimctl account removeUser --user <localpart>@chaterl.localhost
MSYS_NO_PATHCONV=1 docker compose exec -T mongo mongosh --quiet chaterl --eval 'db.profiles.deleteMany({_id:{$in:["<localpart>"]}})'
```

### Demo: server-assigned rooms (two people, one area, then moving)

1. `cp .env.example .env` and replace every `change-me`, then `docker compose up -d` and wait until
   `docker compose ps` shows all four healthy (geo_service is built from `geo_service/` on first start).
2. No dev seed is needed for the web app: it creates its own names.
3. `cd web && npm ci && npm run dev`, then open http://localhost:5173 and pick a name (for example `Alice_1`).
4. Open a second window with `http://localhost:5173/?identity=b` (dev only: a separate stored name) or a private window,
   and pick another name (for example `Bob_1`).
5. In each window open "Test locations (dev)" and choose "Test spot A" (or click the map, if you set `VITE_MAP_TILE_URL`). Both are now in `Area u4pruyd`; send messages
   both ways. (Or allow your real location in both windows.)
6. In Bob's window choose "Test spot B (next to A)". Bob leaves the first room (Alice sees "Bob_1 left") and lands
   in an empty chat for `Area u4pruye`, with its own history.
7. Choose "Test spot A" again in Bob's window: the first room's recent history comes back from the archive.
   "Use my real location" returns to the device location.
8. See the room geo_service made: `MSYS_NO_PATHCONV=1 docker compose exec -T mongo mongosh --quiet chaterl --eval 'db.rooms.find({_id:"g7_u4pruyd"}).toArray()'`

The test-location panel only exists in the dev server, not in a production build.

## Project docs

- [Project overview](docs/PROJECT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Design decisions](docs/DECISIONS.md)
- [CLAUDE.md](CLAUDE.md) — conventions for AI-assisted development
