# chatErl — Project Overview

## Concept

You open the app and see a live chat for the area around you. Nobody needs a friend list or an invite.
Walk into a college campus, a café or a conference and you're in that area's conversation. Walk out and
you leave it.

**Naming:** the product is called **Nearby**; **chatErl** is the codebase name (repo, package, Erlang
apps, XMPP domain and env vars keep it).

**Goal:** a polished, deployable portfolio/resume project showing real backend skills — Erlang/OTP
process design, XMPP, geospatial queries and privacy-conscious system design — built solo with
Claude Code.

## Defining "nearby"

| Approach | Pros | Cons |
|---|---|---|
| **Fixed geohash cells** (chosen) | Simple, rooms are cheap to name and find, maps 1:1 onto XMPP MUC rooms | Boundary effect: two people 20 m apart across a cell edge are in different rooms |
| Radius per user | Accurate "within 500 m" | Every user has a different "room" — no natural MUC mapping, much harder |

**v1 uses geohash cells.** The boundary problem is softened by:
- **Range levels** — each is a geohash precision:

  | Range | Precision | Approx. cell size |
  |---|---|---|
  | Block | 7 | ~153 m × 153 m |
  | Neighborhood | 6 | ~1.2 km × 0.6 km |
  | Area | 5 | ~4.9 km × 4.9 km |

- **Neighbour view** (later phase) — optionally read the 8 neighbouring cells too.
- **Hysteresis** — only switch rooms after moving a margin into the new cell, to avoid join/leave flapping on an edge.

## Users and core flows

1. **First visit** — pick a display name (pseudonymous account, no email needed) → grant location → land in your Block room.
2. **Chatting** — send/receive messages in real time, see who's in the room, change range.
3. **Moving** — client notices the cell change, leaves the old room, joins the new one, shows a "You entered …" notice.
4. **Exploring** — map view of nearby active rooms and named places.
5. **Safety** — report a message, block a user, mute a room.

## Features

### MVP
- Pseudonymous register/login
- Detect location → join geohash room → real-time messaging
- Occupant list
- Automatic room switching on movement
- Dev-mode "pick location on map" for testing and demos

### Differentiators
- **Ephemeral rooms** — messages expire after 24 h (MongoDB TTL); idle rooms are cleaned up.
- **Range slider** — Block / Neighborhood / Area.
- **Named places** — rooms attached to points of interest from a seeded `places` collection.
- **Rich presence** — "just arrived", "leaving soon", short custom status (XMPP presence extension).
- **Moderation** — report / mute / block, per-room slow mode.

### Stretch
- Map heat-view of room activity
- Pinned messages and polls per room
- Federation between two MongooseIM nodes (e.g. two campuses)

## Hard problems (interview talking points)

| Problem | Approach |
|---|---|
| **Location privacy** | Coordinates go only to geo_service over HTTPS; it computes the cell and discards them. Never stored, logged, or broadcast. |
| **Location spoofing** | Can't be fully prevented. Rate-limit cell changes; reject impossible jumps (speed > ~300 km/h between updates); later, members-only rooms where geo_service grants membership. |
| **Boundary flapping** | Hysteresis margin before switching; optional neighbour cells. |
| **Cold start** | Seed named places, a greeter bot (XMPP component) and dev location picker for demos. |
| **Abuse between strangers** | Pseudonymous by default, block/report, slow mode, per-user rate limits. |

## Non-goals (v1)

- Native mobile apps (the web client is mobile-first instead)
- End-to-end encryption
- Media uploads beyond simple images
- Exact "within N metres" radius matching

## Resume description

> Built a real-time location-based chat platform using Erlang/OTP, MongooseIM (XMPP) and MongoDB, with a
> React/TypeScript client. Users are automatically placed into geohash-based rooms for their surroundings;
> implemented a supervised process-per-room lifecycle, geospatial indexing, ephemeral message expiry, and
> privacy-preserving location handling.
