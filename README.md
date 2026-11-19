# Nearby

_Location-based chat (codebase: chatErl)_

**Chat with the people around you.** Open the app and you're in a live chat for the area you're standing
in — a campus, a café, a conference hall. No friend list, no invites. Walk away and you leave the room.

Built with **Erlang/OTP**, **MongooseIM (XMPP)**, **MongoDB** and a **React + TypeScript** client.

> Status: 🚧 in development. Phase 1 (XMPP infrastructure) is done; see [docs/ROADMAP.md](docs/ROADMAP.md)

## How it works

1. The browser gets your position from the Geolocation API.
2. The Erlang **geo_service** converts it to a geohash cell and discards the coordinates.
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
cp .env.example .env          # then replace every "change-me" with a random value
docker compose up -d          # MongooseIM, PostgreSQL, MongoDB — wait until `docker compose ps` shows healthy
bash infra/mongooseim/dev-seed.sh
node tools/xmpp-smoke/serve.mjs
```

Open http://localhost:8000/?user=alice in one tab and http://localhost:8000/?user=bob in another, log in
with `DEV_USER_PASSWORD` from `.env`, join `lobby@muc.chaterl.localhost` and chat.

### Web client (dev)

```bash
cd web
npm ci
npm run dev      # http://localhost:5173
```

Sign in as `alice` with `DEV_USER_PASSWORD` from your own `.env`. Nearby puts you in the chat for the area you are in.
The browser asks for permission to use your location; the chat room is named after your area code (for example
`Area u4pruyd`). Your exact location is turned into that code inside the browser and is never sent or stored.
Optional, dev only: set `VITE_MAP_TILE_URL` in `.env` (the line in `.env.example` uses OpenStreetMap tiles; copy it if
your `.env` predates this) to get a map in the "Test locations (dev)" panel. Leave it empty for no map; the test spots
and fields still work. The map is never part of a production build. Each tile request tells the tile server which area
you are viewing, plus your IP, and OpenStreetMap's tile policy asks for light interactive use with the attribution kept
visible (see `.env.example`).
Location needs a secure page: `localhost` works, but a LAN IP over plain http (for example from a phone) is
treated as insecure and shows a message instead.

### Phase 2 demo: two people, one area, then moving

Room assignment is client-side and temporary here (ADR-013); the server takes over in Phase 3.

1. `cp .env.example .env` and replace every `change-me`, then `docker compose up -d` and wait until
   `docker compose ps` shows all three healthy.
2. `bash infra/mongooseim/dev-seed.sh` to create the `alice` and `bob` test users.
3. `cd web && npm ci && npm run dev`, then open http://localhost:5173.
4. Open a second window (a private one) so you have two sessions. Sign in as `alice` in one and `bob` in the other.
5. In each window open "Test locations (dev)" and choose "Test spot A" (or click the map, if you set `VITE_MAP_TILE_URL`). Both are now in `Area u4pruyd`; send messages
   both ways. (Or allow your real location in both windows.)
6. In `bob`'s window choose "Test spot B (next to A)". Bob leaves the first room (alice sees "bob left") and lands
   in an empty chat for `Area u4pruye`, with its own history.
7. Choose "Test spot A" again in bob's window: the first room's recent history comes back from the archive.
   "Use my real location" returns to the device location.

The test-location panel only exists in the dev server, not in a production build.

## Project docs

- [Project overview](docs/PROJECT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Design decisions](docs/DECISIONS.md)
- [CLAUDE.md](CLAUDE.md) — conventions for AI-assisted development
