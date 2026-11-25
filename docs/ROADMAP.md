# Roadmap

Solo build, phased so there's a working end-to-end demo as early as possible. Tick items as they land.
Each phase ends with a short demo you could show someone.

## Phase 1 — Infrastructure skeleton ✅ (2026-11-16)
- [x] `docker-compose.yml` with MongooseIM 6.2.1, PostgreSQL 16, MongoDB 7 (healthchecks, named volumes)
- [x] MongooseIM config: domain `chaterl.localhost`, `mod_muc`, `mod_websockets`, PostgreSQL auth/MAM
- [x] Load MongooseIM PostgreSQL schema on first start
- [x] MongoDB collections + indexes (`infra/mongo/init-indexes.js`)
- [x] Test users + one MUC room (`infra/mongooseim/dev-seed.sh`); two tabs chatting via `tools/xmpp-smoke`
- **Demo:** two tabs chatting through your own XMPP server

Learned in Phase 1 (carry into Phase 2):
- Stream management keeps a dropped session resumable (default 10 min), so a reload without a clean
  disconnect leaves the old nickname in the room and rejoining fails with `<conflict/>`. The real client
  must close the stream on `pagehide` *and* handle `conflict` (retry with a suffixed nick, or resume the session).
- Messages from the room itself (no resource in `from`, e.g. the subject) must be handled separately.
- MUC join `<history/>` is held in memory by mod_muc and is lost when MongooseIM restarts; the durable
  copy is the MAM archive in PostgreSQL. The real client should load room history via MAM (XEP-0313).

## Phase 2 — Web client foundation
- [x] Vite + React + TS + Tailwind scaffold, ESLint, Vitest (slice 2a)
- [x] `xmpp/` module: connect, reconnect with backoff, join/leave MUC, send/receive groupchat
      (2a done: connect, join/leave, send/receive, nick-conflict retry, connection-lost; 2b-1 done: reconnect with
      backoff, keepalive, liveness probe; 2b-2a done: room history from MAM; 2b-2b done: "Load earlier messages")
- [x] Chat page: MessageList, Composer, OccupantList (slice 2a)
- [x] Branding & UI polish: product name "Nearby", design tokens, dark mode, chat bubbles, plain-language UI (slice 2a+, ADR-009)
- [x] `geo/useLocation` with permission/error states; dev-mode map location picker
      (2c-1 done: location states, own geohash encoder, keyboard dev picker, temporary client-side area room, ADR-013;
      2c-2 done: dev-only Leaflet map picker, ADR-014, verified live 2026-11-19)
- [x] **Demo:** client-side geohash → join room → chat (temporary, before geo_service). Verified live 2026-11-19 (ADR-013).

Carry-forward for the next slices (from the 2a/2a+ reviews):
- **2b (RESOLVED in 2b-1, except the AC14 diagnosis pending a real background drop):** sessions drop while the tab is in the background ("Connection lost"). Every observed drop happened while the
  page was backgrounded or hidden, which points to the browser freezing it rather than a server idle timeout. First log
  the WebSocket close code and reason in `web/src/xmpp/`, then design keepalive and reconnect (XEP-0199 ping or
  `mod_websockets` `ping_rate`; possibly XEP-0198 resumption, which the server already enables). Check option names
  against the MongooseIM 6.2.1 docs.
- **2b (RESOLVED in 2b-1; Probe A: history copies on rejoin carry the same stanza-id, so `historyMaxStanzas` is kept):** clear the room timeline on sign-out/disconnect, but keep it across nick-conflict retries (regression test
  first). This fixes the stale "bob joined" notice after signing in again.
- **2b-2:** MongooseIM adds `<stanza-id by=room>` to MUC messages, so de-duplicate MAM history against live messages by stanza-id.
- **2b-2 BLOCKER (RESOLVED in 2b-2a, ADR-011):** the MongooseIM 6.2.1 room archive was broken in our setup.
  - Root cause: with no MUC rate limit configured, `mod_muc_room` does not keep the sender's activity record, so MAM gets timestamp 0.
  - Workaround: a generous `user_message_shaper` on `mod_muc`, plus `async_writer.enabled = false` for the MUC archive. Re-check on any MongooseIM upgrade.
  - Original symptoms (Probe B, 2026-11-17):
  - MUC MAM ids are tiny and counter-like (257, 513, … = microseconds 1, 2, … << 8), so result `<delay>` stamps read 1970-01-01.
  - A `start` = now−24h filter returns `count 0`.
  - After a restart, new messages collide with existing ids (`archive_muc_single_message_failed reason=duplicate_key`) and are silently dropped.
  - The container clock is correct.
  - Also confirmed: `urn:xmpp:mam:2` is supported; `result@id` uses the live stanza-id format; a bogus `<after>` gives `item-not-found`.
- **2c (RESOLVED in 2c-1):** once the dev room form is gone, make the chat card fill the remaining height (`flex-1 min-h-0`), so the
  desktop page stops scrolling vertically.

## Phase 3 — geo_service
- [x] rebar3 app, supervision tree, sys.config, Dockerfile (slice 3a, ADR-015)
- [x] `geohash` module with EUnit + PropEr tests (encode/decode round-trip, neighbours) (slice 3a)
- [x] Cowboy: `/api/health`, `/api/session`, `/api/locate` (3a `/api/health`; 3c `/api/session`; 3d `/api/locate`, ADR-018, verified live 2026-11-21)
- [x] MongoDB pool + `geo_store`; `init-indexes.js` (slice 3b, ADR-016: supervised driver topology, `/api/ready`, rooms upsert)
- [x] Slice 3b.1: reap leaked Mongo heartbeat connections on a hung server (ADR-016 quirk 10, verified live 2026-11-21)
- [x] MongooseIM admin API integration: register users (slice 3c, ADR-017, verified live 2026-11-21)
- [x] Lock down MUC: `default_room.public = false` (a public disco listing of geohash rooms would reveal
      which cells are active, a location leak) and restrict room creation to geo_service/admin
      (slice 3f-1, ADR-020, verified live 2026-11-23: members-only rooms, membership granted by `/api/locate`)
- [x] Slice 3f-2: revoke the old room's membership on move (supervised ETS owner of user → last room; set the old
      room to NONE after the new grant), and decide what to do with memberships already in `muc_room_aff`
      (ADR-021, verified live 2026-11-25; none existed in dev, manual cleanup SQL in ADR-021)
- [ ] Slice 3f-3: membership reconciliation on start (Mongo `rooms` × `listRoomAffiliations` → pending revokes), so a
      geo_service restart no longer leaves one stale membership per user who moves afterwards (ADR-021 residual)
- [ ] Slice 3g: opaque room names (keyed hash of the cell) to close the ADR-020 residuals: stored room names listed
      by disco after a MongooseIM restart, occupant counts via room disco#info, the room-existence oracle
- [x] Slice 3e-1: `POST /api/session/renew` (server, ADR-019, verified live 2026-11-21)
- [x] Slice 3e-2: client identity (Welcome, device credential, token manager; verified live 2026-11-21)
- [x] Client switches to `/api/locate` for room assignment (3e-3: only the cell centre is sent, server-assigned rooms, ADR-019, verified live 2026-11-22)
- **Demo:** rooms assigned by the server, recorded in MongoDB. Verified live 2026-11-22 (ADR-019 "Live evidence (3e-3)");
  the phase closes once the MUC lockdown follow-ups (3f-3, 3g) land.

Carry-forward from 3e-3:
- Hidden-tab reconnects leave stream-management nick ghosts (`name-2`) until the old session times out. Resume the
  XEP-0198 stream on reconnect, or shorten the resumption timeout (reconnect area, ADR-010).
- Non-blocking review suggestions: make the unreachable `aborted` branch in `geo/roomAssigner.ts` a plain return; key Chat's
  "Share your location" empty text on `cell === null` (one-frame flicker); export `browserTimers` from `api/` like `browserOnline`.

Carry-forward from 3f-1 (ADR-020):
- Reconfigure-on-load before any future MUC room-config change (stored room options override `default_room`).
- Phase 4: MAM purge (sender JID per room for 24 h), idle room deletion, revisit temporary rooms.
- Phase 5: MUC nickname registration (`jabber:iq:register` to `muc.<domain>`) can block a nick in every room.
- Phase 6: MongooseIM `loglevel = "error"` (it logs JID + room on a denied creation); MongooseIM cold-boot race when the
  Docker daemon restarts containers (RDBMS pool start timeout); automatic lobby reload instead of re-running `dev-seed.sh`.
- Small cleanups: run the access-recovery trigger in a layout effect (one frame of "You can't open this room." before
  "Joining…"); validate `XMPP_ROOM_OWNER` in `entrypoint.sh`; map a rejected `locate()` to `unavailable` in `roomAssigner`;
  drop the always-false `created` on `room-joined`; the dead 201 branch in `tools/xmpp-smoke`; stream-management ghosts
  inflate occupant counts and hold nicknames.

Carry-forward from 3f-2 (ADR-021):
- Phase 4: expire the last membership N hours after the last locate (tracker rows need timestamps; supervised worker) and
  bound the `geo_membership` ETS table; idle `deleteRoom` must drop the room from every tracker entry (else load-to-revoke
  recreates it); align `geo_rate` with the tracker.
- Any account-deletion flow must revoke memberships before `removeUser` (MongooseIM 6.2.1 keeps MUC affiliations).
- MongooseIM `loglevel` must stay `warning` or stricter (at info it logs user JID + room on affiliation changes).
- Re-apply the admin httpc profile options when inets restarts its `httpc_manager`; add
  `geo_xmpp_admin:stop_http_profile/0` so the profile name lives in one place; a unit test with a raising `settle/2`.
- Investigate the intermittent `mc_server` noproc crash report seen once by `logs_contain_no_coordinates` (round 1 of 3f-2).

## Phase 4 — Room lifecycle & movement
- [ ] `geo_room` process per active cell with idle shutdown under `geo_room_sup`
- [ ] Client hysteresis + automatic room switching + "you entered …" notice
- [ ] `geo_rate`: token bucket + impossible-jump rejection; `geo_rate` also limits POST /api/session and POST /api/session/renew per client IP (trusted-proxy XFF)
- [ ] Ephemeral history: MAM limited to last 24 h; idle rooms TTL'd in MongoDB
- **Demo:** walk (or drag the dev pin) across cells and watch rooms switch

## Phase 5 — Differentiators
- [ ] Range slider (Block / Neighborhood / Area)
- [ ] Named places: seed script + `/api/places` + place-labelled rooms
- [ ] Rich presence statuses
- [ ] Moderation: block, report, mute room, per-room slow mode
- **Demo:** the full product story

## Phase 6 — Polish & ship
- [ ] Deploy (single VPS + Docker Compose + Caddy for TLS)
- [ ] README with architecture diagram, screenshots, demo GIF, live link
- [ ] CI (GitHub Actions): rebar3 eunit/ct/dialyzer, npm lint/typecheck/test
- [ ] Production hardening: random Erlang distribution cookie (`CLUSTER_COOKIE`), TLS-only XMPP behind
      the reverse proxy, real certificates instead of the image's fake ones
- [ ] Greeter bot for cold start
- [ ] Session rate limit + MongooseIM `auth.max_users_per_domain` backstop before going public (unlimited sign-ups until then, ADR-017)
- **Demo:** public URL on your resume

## Stretch
- [ ] Map heat-view of activity
- [ ] Pinned messages / polls
- [ ] Neighbour-cell reading mode
- [ ] Federation between two MongooseIM nodes
