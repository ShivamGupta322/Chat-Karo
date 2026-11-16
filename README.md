# chatErl

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

*(The React client in `web/` arrives in Phase 2.)*

## Project docs

- [Project overview](docs/PROJECT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Design decisions](docs/DECISIONS.md)
- [CLAUDE.md](CLAUDE.md) — conventions for AI-assisted development
