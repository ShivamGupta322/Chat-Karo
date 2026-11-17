# CLAUDE.md

Guidance for Claude Code working in this repository. Read this first, every session.

## Project in one line

**chatErl** (product name: **Nearby**) — a location-based real-time chat: users are automatically placed into chat rooms for
the geohash cell they are standing in ("chat with people within ~500 m"). Solo portfolio project.

Full context: [docs/PROJECT.md](docs/PROJECT.md) · Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
Plan: [docs/ROADMAP.md](docs/ROADMAP.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18 + TypeScript + Vite, Strophe.js (XMPP over WebSocket), Leaflet (map), ngeohash, Zustand (state), Tailwind CSS |
| XMPP server | MongooseIM 6.x (Erlang) — auth, MUC rooms, presence, message delivery, WebSocket endpoint |
| Geo service | Erlang/OTP 26+ application built with rebar3, Cowboy HTTP API, mongodb-erlang driver |
| App data | MongoDB 7 — rooms, places, profiles, moderation (2dsphere + TTL indexes) |
| XMPP internals | PostgreSQL 16 — MongooseIM's own RDBMS backend (users, MAM archive) |
| Local infra | Docker Compose |

## Repository layout (target)

```
chatErl/
├── CLAUDE.md                 # this file
├── README.md
├── docker-compose.yml        # mongooseim, postgres, mongodb, geo_service, web
├── infra/
│   ├── mongooseim/           # mongooseim.toml, certs, init scripts
│   ├── postgres/             # MongooseIM schema (pg.sql from upstream)
│   └── mongo/                # init-indexes.js, seed-places.js
├── geo_service/              # Erlang/OTP app (rebar3)
│   ├── rebar.config
│   ├── config/sys.config, vm.args
│   ├── src/                  # see docs/ARCHITECTURE.md for module list
│   └── test/                 # EUnit + Common Test suites
├── web/                      # React + Vite client
│   ├── src/{xmpp,geo,state,components,pages}/
│   └── tests/
├── docs/
└── .claude/{agents,commands}/
```

## Commands

```bash
cp .env.example .env                       # first time only; then replace every change-me
docker compose up -d                       # start whole stack (mongooseim, postgres, mongo)
docker compose ps                          # all three should be "healthy"
docker compose logs -f mongooseim          # debug XMPP server
bash infra/mongooseim/dev-seed.sh          # create alice/bob test users + lobby room
node tools/xmpp-smoke/serve.mjs            # Phase 1 smoke page: http://localhost:8000/?user=alice
docker compose down -v                     # stop and WIPE all data (re-runs DB init scripts next start)
cd geo_service && rebar3 compile           # build
cd geo_service && rebar3 eunit             # unit tests
cd geo_service && rebar3 ct                # integration tests (needs mongo up)
cd geo_service && rebar3 dialyzer          # type check — must be clean
cd geo_service && rebar3 fmt --check       # formatting (erlfmt)
cd web && npm ci                           # install client deps (first time)
cd web && npm run dev                      # client dev server (http://localhost:5173)
cd web && npm run build                    # typecheck + production build
cd web && npm run test                     # Vitest
cd web && npm run lint && npm run typecheck
```

Update this section when commands change.

## Agent workflow (supervisor ↔ coder)

Non-trivial work goes through `/feature <description>` (see `.claude/commands/feature.md`):

1. **supervisor** (Opus) reads the docs + code and writes a plan with acceptance criteria.
2. **coder** (Sonnet) implements the plan, runs tests, and reports back.
3. **supervisor** reviews the diff against the plan, finds bugs/flaws, and either approves or returns
   a numbered list of required changes.
4. Loop steps 2–3, max 3 review rounds, then escalate to the user.

The main session orchestrates — subagents cannot call each other directly. Small edits (typos,
one-line fixes, doc tweaks) can be done directly without the loop. Use `/review <intent>` to have the
supervisor review uncommitted changes made outside the loop.

## Non-negotiable rules

### Privacy (core to the product)
- **Never** broadcast raw coordinates to other users. Other users see only the cell/room.
- **Never** persist raw lat/lng or location history. geo_service computes the cell and discards coordinates.
- Never log coordinates, even at debug level. Log the geohash cell if needed.

### Erlang / OTP
- Every long-lived process lives under a supervisor. No bare `spawn` for anything that matters.
- Use `gen_server` / `gen_statem` behaviours; keep `handle_call` fast, move slow work out.
- "Let it crash" for unexpected states; validate and return `{error, Reason}` at system boundaries (HTTP input).
- Tagged tuples (`{ok, V} | {error, R}`) for fallible functions. No exceptions for control flow.
- `-spec` on every exported function; Dialyzer must pass with zero warnings.
- Config via `application:get_env/2` from `sys.config` — no hard-coded hosts, ports, or secrets.
- ETS tables owned by a supervised process. Rate-limit state lives in ETS, not in a gen_server's state.

### Frontend
- TypeScript `strict: true`. No `any` without a comment explaining why.
- All XMPP logic lives in `web/src/xmpp/` behind a typed interface — components never touch Strophe directly.
- Geolocation logic lives in `web/src/geo/`; components consume hooks (`useLocation`, `useRoom`).
- Handle every async state: loading, error, permission denied, offline/reconnecting.
- Accessibility: semantic HTML, keyboard reachable, labelled inputs. Mobile-first layout.

### MongoDB
- Every collection's indexes are defined in `infra/mongo/init-indexes.js` — the code never assumes an index it didn't declare.
- `places.location` and `rooms.center` use GeoJSON Points with `2dsphere` indexes. GeoJSON order is `[lng, lat]`.
- Ephemeral data uses TTL indexes, not cron cleanup.

### General
- Secrets come from `.env` (gitignored); `.env.example` documents every variable.
- Write the test with (or before) the code. Bug fix = regression test first.
- Small, focused commits in Conventional Commits style (`feat(geo): ...`, `fix(web): ...`).
- Don't add dependencies without saying why in the plan; prefer the standard library / OTP.
- When a design decision is made, append an entry to `docs/DECISIONS.md`.
- Verify MongooseIM config keys and module options against the docs for the installed version —
  they changed between 4.x/5.x/6.x. Don't guess config syntax. The pinned version is **6.2.1**
  (docs: https://esl.github.io/MongooseDocs/6.2.1/). Edit `infra/mongooseim/mongooseim.toml.tmpl`,
  never a rendered file; secrets are `{{PLACEHOLDERS}}` filled from `.env` by `entrypoint.sh`.
- Host ports: XMPP WebSocket 5280, c2s 5222, MongoDB 27018 (localhost only). Postgres and the
  MongooseIM admin API (5551) are reachable only inside the Docker network.

## Definition of done

- [ ] Acceptance criteria in the plan are met
- [ ] Tests added and passing (`rebar3 eunit`, `rebar3 ct`, `npm run test`)
- [ ] `rebar3 dialyzer`, `npm run lint`, `npm run typecheck` clean
- [ ] No coordinates logged or stored; no secrets committed
- [ ] Docs updated (README / ARCHITECTURE / DECISIONS / this file's Commands) if behaviour changed
- [ ] Supervisor approved
