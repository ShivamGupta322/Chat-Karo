# Plan: Phase 2c-1 — Location, cell and temporary area room (the Phase 2 demo, no map)

Status: PLANNED by the supervisor on 2026-11-19 (HEAD 7f6b3f6). 2c is split: **2c-1** (this plan) and **2c-2** (the Leaflet map
picker, outline at the end). The ADR is **ADR-013**.

## Goal
Signed-in users get placed automatically in the room for their precision-7 cell, `g7_<geohash>@muc.<domain>`.
- The cell comes from the device location (full permission/error states), or in dev from a keyboard-accessible test spot.
- Coordinates never leave `web/src/geo/`; other modules only ever see a cell.
- The room assignment is client-side and TEMPORARY: Phase 3 replaces it with geo_service `/api/locate`.

## Context
- Roadmap phase 2, last item. Also the 2c carry-forward: the chat card fills the remaining height. Hysteresis and auto-switching stay
  Phase 4; server assignment and the MUC lock-down stay Phase 3.
- ADRs:
  - ADR-001 (cells, precision 7 = Block)
  - ADR-005 (coordinates never stored; server assignment later; this slice is a documented temporary deviation)
  - ADR-008 (transport seam; instant-room creation TEMPORARY; React 18.3.1 → react-leaflet 4.x in 2c-2)
  - ADR-009 (tokens, text in ui/text.ts, no jargon)
  - ADR-010/011/012 (reconnect, suspend/rejoin, MAM history state, firstId/insertAt)
- Touched:
  - `web/src/pages/Chat.tsx`, `web/src/components/RoomForm.tsx` (DELETED), `web/src/components/MessageList.tsx` (height classes only),
    `web/src/ui/text.ts`, `web/eslint.config.js`
  - tests: `round2.test.tsx`, `brand.test.tsx`, `integration/chatFlow.test.tsx`, `fixtures/stanzas.ts`
  - docs: ARCHITECTURE, ROADMAP, DECISIONS, README
- Verified in code by the supervisor:
  - **Store reset on a new room:** `room-joining` with a different roomJid resets to `{...initialRoomState, roomJid, nick, status:'joining'}`
    (timeline, insertAt, earlier, canLoadEarlier). firstId, lastSeenId and initialDone live on the per-join TrackedRoom, created fresh by joinRoom.
    A→B→A also resets.
  - **Leaving a suspended room:** `leaveRoom` sends no presence, untracks it and emits room-left; rejoinRooms skips it.
  - **The gap:** `joinRoom` while reconnecting emits `room-join-failed{not-connected}`, which the store ignores (roomJid mismatch). So the page must
    DEFER the join until `connected`; that's the new controller hook's job.
  - **Retry:** failJoin and the join timeout untrack, so calling joinRoom again retries.
  - **Instant room:** a stale acceptInstantRoom result after a switch is ignored.
  - **Validation:** `isValidRoomJid` regex `^[a-z0-9][a-z0-9_.-]{0,63}$` always matches `g7_` + geohash (incl. g7_0000000, g7_zzzzzzz).
  - **No client "rooms list" exists** (the server disco listing is Phase 3).
- **Dependency decision: none for 2c-1.** Our own ~35-line pure encoder, not ngeohash: encode-only, fully testable, no @types or CJS
  interop, reusable for Phase 4 hysteresis.

## Steps
1. `web/src/geo/geohash.ts` (new): a pure standard geohash encoder.
   - Base32 `0123456789bcdefghjkmnpqrstuvwxyz`, interleaved bits with longitude first, `>= mid` rule (lat=90 / lng=180 → upper half).
   - Validates input and returns a tagged result; never throws. No TEMPORARY header (Phase 4 keeps it).
2. `web/src/geo/cell.ts` (new): `cellFor` (only precision 7: `CellPrecision = 7`) and `roomJidForCell` → `g${precision}_${geohash}@${mucDomain}`.
   - Header: `// TEMPORARY (Phase 3): client-side room assignment. Replaced by geo_service /api/locate; delete roomJidForCell and its single call
     site in pages/Chat.tsx when the client switches.` (cellFor stays.)
   - No imports from xmpp/.
3. `web/src/geo/useLocation.ts` (new): wraps watchPosition, clearWatch and the Permissions API, returning a discriminated union holding ONLY a Cell.
   - Coordinates exist only as locals inside the success callback, converted with cellFor immediately; never in React state, refs or long-lived closures.
   - Deps injectable for tests (defaults read from globals inside the effect). Export a pure `reduceLocation` (or equivalent) for unit tests.
4. `web/src/geo/useArea.ts` (new): combines useLocation, a dev override (stored as a **Cell**, not a point) and the committed device cell into a
   coordinate-free `AreaState` + actions (rules below).
5. `web/src/geo/devPresets.ts` (new, dev only): three public sample points (below). Referenced only by the picker, so it tree-shakes out of production.
6. `web/src/geo/DevLocationPicker.tsx` (new, in geo/ on purpose because it handles raw numbers): a `<details>` with summary "Test locations (dev)".
   - Three preset buttons.
   - A form with labelled "Latitude"/"Longitude" text inputs: `inputMode="decimal"`, `autoComplete="off"`, `spellCheck={false}`; `onSubmit` with
     preventDefault (never GET); submit "Use this spot". Invalid → `role="alert"` and the area is unchanged.
   - "Use my real location" only while the override is active.
   - Rendered by Chat only behind `import.meta.env.DEV`.
7. `web/src/geo/index.ts` (new): the only public entry. Exports `useArea`, `DevLocationPicker`, `roomJidForCell` and the types `AreaState`,
   `AreaController`, `Cell`, `CellPrecision`, `DevOverride`, `GeoPoint`. Not useLocation, geohash or devPresets.
8. `web/src/state/useAreaRoom.ts` (new): the room controller. A pure `planRoomActions` plus a thin hook running the actions in a useEffect.
   - Handles: first join; switch (leave, then join); switch while reconnecting (leave now, join on connected); desired → null (leave); no auto-retry
     after a failure (exposes `retry`).
   - Talks to the client only through `XmppClient`.
9. `web/src/components/AreaPanel.tsx` (new): replaces RoomForm at the top of the left column. Takes AreaState + callbacks; one distinct message and
   action per state, the message in one `role="status"` region.
   - When a focused action button unmounts, focus moves to the panel container (`tabIndex={-1}`, `focus({preventScroll:true})`).
   - Shows "Area `<code>`" and, for the dev source, a "Test spot" badge. Never coordinates.
10. `web/src/pages/Chat.tsx`:
    - `const area = useArea();`
    - `desiredRoomJid = area.state.status === 'located' ? roomJidForCell(area.state.cell, mucDomain) : null`, via `useMemo` keyed on the geohash string.
    - `const { retry } = useAreaRoom(client, desiredRoomJid, localpartOf(jid));`
    - **Never show another room's data:** `const current = room.roomJid !== null && room.roomJid === desiredRoomJid;` If not current: timeline `[]`,
      occupants `[]`, no HistoryStatus, no "Load earlier", Composer disabled.
    - The status line uses `AREA_TEXT.areaLabel(code)` instead of roomLabel.
    - A "Join again" button when `current && (status === 'failed' || status === 'left')`.
    - `{import.meta.env.DEV && <DevLocationPicker override={area.dev} />}` under the panel.
    - Remove the RoomForm import and usage.
11. `web/src/components/RoomForm.tsx`: **delete.** No manual room entry; a dev toggle would fight the single-desired-room controller.
    `ui/addresses.ts` toRoomJid/roomLabel and the room branch of describeAddressError stay untouched (Phase 3 cleanup candidates).
12. **Layout carry-forward** (Chat.tsx, MessageList.tsx): on md+ the page fills the viewport with no vertical page scroll, and the message list scrolls
    inside the card. Below md, keep the current flow layout.
    - Root: `flex min-h-dvh flex-col md:h-dvh`.
    - `<main>`: replace `md:items-start` with `md:flex-1 md:min-h-0 md:items-stretch`.
    - Left column: `md:flex md:min-h-0 md:flex-col`.
    - Chat `<section>`: `md:flex md:min-h-0 md:flex-1 md:flex-col`.
    - MessageList scroll container: `h-[55dvh] md:h-auto md:min-h-0 md:flex-1` (remove `md:h-[62dvh]`).
    - Occupant column: `md:min-h-0 md:overflow-y-auto`; the card keeps `self-start`.
    - Do NOT change which element owns scrolling (scrollAnchor and stick-to-bottom stay the same).
13. `web/src/ui/text.ts`: add `AREA_TEXT` and `DEV_LOCATION_TEXT` (exact strings below). No "geohash", "JID", "MUC" or "cell" in UI text.
14. `web/eslint.config.js`: structural privacy guards. Flat config redeclares the whole rule per files-block, so re-list the patterns in each block,
    with a one-line comment why.
    - **Everywhere:** keep the strophe restriction; also ban deep geo imports (`**/geo/*`), so only `…/geo` (the index) may be imported.
    - **`src/xmpp/**`:** also ban any geo import (`**/geo`, `**/geo/*`).
    - **`src/geo/**`:** deep imports inside geo allowed; strophe still banned; `no-console: 'error'` with NO allow list.
    - **`src/xmpp/strophe/**`:** strophe allowed; geo still banned.
    - **`tests/**`:** geo deep imports allowed; keep the `tests/xmpp/strophe/**` strophe exemption.
15. Tests: see below.
16. Docs:
    - `docs/DECISIONS.md`: append **ADR-013 "Temporary client-side cell assignment and location states"**:
      - own encoder (not ngeohash); precision 7 only
      - coordinates stay transient in geo/ (cell-only state, the ESLint guards)
      - when rooms switch: first fix, dev spot, explicit "Switch to my new area"; never automatically
      - the useAreaRoom reconcile rules, incl. a switch while reconnecting; RoomForm removed
      - `enableHighAccuracy:false`, timeout 20 s, maximumAge 60 s
      - known dev-only leaks: `default_room.public = true` lists active cell rooms via disco; `persistent = true` keeps every visited cell room in
        PostgreSQL; the area code on screen shows up in screenshots/GIFs; in 2c-2, map tile requests reveal the viewed area
      - a temporary deviation from ADR-005 until Phase 3
    - `docs/ARCHITECTURE.md` Frontend tree: `geo/` = `geohash.ts` (own encoder), `cell.ts`, `useLocation.ts`, `useArea.ts`,
      `DevLocationPicker.tsx`, `index.ts` (only public entry); `state/useAreaRoom.ts`. Replace "(ngeohash)".
    - `docs/ROADMAP.md`: note 2c-1 progress; mark the 2c carry-forward resolved; add "2c-2: Leaflet map picker". Tick the Demo line ONLY after the
      orchestrator's live verification.
    - `README.md`: a "Phase 2 demo" section (steps under the manual ACs).
    - **Do not edit CLAUDE.md** (its stack row says "ngeohash"; the orchestrator raises it with the user).

## Interfaces
```ts
// geo/geohash.ts
export type GeohashError = 'invalid-precision' | 'lat-out-of-range' | 'lng-out-of-range';
export type GeohashResult = { ok: true; geohash: string } | { ok: false; error: GeohashError };
/** precision: integer 1..12. lat in [-90, 90], lng in [-180, 180], both finite (NaN/±Infinity → out-of-range). */
export function encodeGeohash(lat: number, lng: number, precision: number): GeohashResult;
export function isValidLatLng(lat: number, lng: number): boolean;

// geo/cell.ts
export type CellPrecision = 7;
export interface Cell { readonly precision: CellPrecision; readonly geohash: string }
export type CellResult = { ok: true; cell: Cell } | { ok: false; error: GeohashError };
export function cellFor(lat: number, lng: number, precision: CellPrecision): CellResult;
/** TEMPORARY (Phase 3). 'g7_u4pruyd@muc.chaterl.localhost' */
export function roomJidForCell(cell: Cell, mucDomain: string): string;

// geo/useLocation.ts  (internal: NOT exported from geo/index)
export type LocationState =
  | { status: 'unsupported' }        // no navigator.geolocation
  | { status: 'insecure-context' }   // window.isSecureContext === false (strict; undefined counts as secure)
  | { status: 'checking' }           // initial while a Permissions API query is pending
  | { status: 'idle' }               // ready; waiting for the user to tap "Share my location"
  | { status: 'requesting' }         // watch active, no fix yet
  | { status: 'watching'; cell: Cell } // latest device cell (no coordinates)
  | { status: 'denied' }
  | { status: 'unavailable' }
  | { status: 'timeout' };
export interface GeolocationLike {
  watchPosition(ok: PositionCallback, err: PositionErrorCallback, opts: PositionOptions): number;
  clearWatch(id: number): void;
}
export interface PermissionsLike { query(d: { name: 'geolocation' }): Promise<PermissionStatus> }
export interface LocationDeps {
  geolocation: GeolocationLike | null;
  permissions: PermissionsLike | null;
  isSecureContext: boolean | undefined;
}
export const WATCH_OPTIONS: PositionOptions = { enableHighAccuracy: false, timeout: 20_000, maximumAge: 60_000 };
export function useLocation(precision: CellPrecision, deps?: LocationDeps): { state: LocationState; start: () => void };
```
useLocation transitions:
- **Mount:**
  - order: unsupported → insecure-context → (permissions present ? `checking` : `idle`)
  - query `granted` → `start()`; `denied` → `denied` with NO watchPosition; `prompt` or a rejected query → `idle`
  - subscribe to PermissionStatus `change`: granted while idle/denied → `start()`; denied → clearWatch + `denied`; prompt while denied → `idle`
- **`start()`:** clear any existing watch, set `requesting`, `watchPosition(…, WATCH_OPTIONS)`.
- **Success:** cellFor ok → `watching{cell}` (same state object if the geohash is unchanged); not ok → treat as error code 2.
- **Error before the first fix:** clearWatch in every case. Code 1 → `denied`, 2 → `unavailable`, 3 → `timeout`.
- **Error after a fix:** code 1 → clearWatch + `denied`; codes 2/3 ignored (keep `watching` with the last cell, keep the watch).
- **Unmount:** clearWatch, remove the change listener; ignore query results/callbacks after unmount (cancelled flag). StrictMode ends with exactly one active watch.
- NEVER log, store or put error objects/messages anywhere.

```ts
// geo/useArea.ts
export interface GeoPoint { readonly lat: number; readonly lng: number }
export interface DevOverride {
  readonly active: boolean;
  /** Validates via cellFor and stores ONLY the resulting Cell. The point is not retained. */
  set(point: GeoPoint): { ok: true } | { ok: false; error: GeohashError };
  clear(): void;
}
export type AreaState =
  | { status: 'located'; cell: Cell; source: 'device' | 'dev-pin'; moved: boolean }
  | { status: Exclude<LocationState['status'], 'watching'> };
export interface AreaController {
  state: AreaState;
  start: () => void;        // "Share my location" / "Try location again"
  commitMove: () => void;   // "Switch to my new area"
  dev: DevOverride;
}
export function useArea(): AreaController;
```
useArea rules. Internal: `devCell: Cell | null`, `committed: string | null` (a device geohash).
- **committed is set** on the first device fix (when null), on `commitMove()` (to the latest device cell), and on `dev.clear()` (to the latest device cell, if watching).
- **committed resets to null** whenever the device isn't `watching`.
- **Derived:**
  - devCell set → `located{cell: devCell, source:'dev-pin', moved:false}`
  - else device watching and committed set → `located{cell: committed cell, source:'device', moved: latest.geohash !== committed}`
  - else the device status passes through
- **Room switches only on:** the first fix, a dev `set` to a different cell, `commitMove`, `dev.clear`, and location lost (desired=null → leave).
  Background device fixes NEVER switch (Phase 4).
- **Stable identity:** AreaState keeps its identity when nothing visible changed; `JSON.stringify(state)` never contains coordinates.

```ts
// state/useAreaRoom.ts
export type RoomAction = { kind: 'leave'; roomJid: string } | { kind: 'join'; roomJid: string };
export function planRoomActions(input: {
  desired: string | null;
  connected: boolean;                                  // session connection.status === 'connected'
  current: { roomJid: string | null; status: RoomState['status'] };
}): RoomAction[];
export function useAreaRoom(client: XmppClient, desired: string | null, nick: string): { retry: () => void };
```
planRoomActions rules, in order:
1. `current.roomJid !== null && current.roomJid !== desired && status ∈ {joining, joined, reconnecting}` → `leave(current.roomJid)`.
2. `desired !== null && connected && current.roomJid !== desired` → `join(desired)`.
   - No action when `current.roomJid === desired`, whatever the status: the client rejoins suspended rooms itself, and failed/left wait for `retry`.

Hook:
- A useEffect keyed on `[client, desired, connected, current.roomJid, current.status, nick]` runs the actions in order (`client.leaveRoom` / `client.joinRoom(desired, nick)`).
- `retry()` calls joinRoom(desired, nick) only if desired is set and connected.

```ts
// ui/text.ts (exact; tests rely on them)
export const AREA_TEXT = {
  heading: 'Your area',
  areaLabel: (code: string): string => `Area ${code}`,
  testSpotBadge: 'Test spot',
  checking: 'Checking location access…',
  idle: 'Nearby uses your location to put you in a chat with people around you. Your exact location is never shared or stored.',
  share: 'Share my location',
  requesting: 'Finding your location… Your browser may ask for permission.',
  denied: "Location is off for this site. If you dismissed the prompt, try again. If you blocked it, allow location in your browser's site settings, then try again.",
  deniedDevHint: 'Or choose a test location below.',
  unavailable: "We couldn't find your location. Check that location services are on, then try again.",
  timeout: 'Finding your location took too long.',
  unsupported: "This browser can't share your location, so we can't find people nearby.",
  insecure: 'Location only works on a secure (https) page.',
  tryAgain: 'Try location again',
  moved: 'You seem to have moved.',
  switchArea: 'Switch to my new area',
  joining: (label: string): string => `Joining ${label}…`,
  rejoin: 'Join again',
  emptyNoArea: 'Share your location to chat with people nearby.',
  emptyJoining: 'Getting your area chat ready…',
} as const;
export const DEV_LOCATION_TEXT = {
  summary: 'Test locations (dev)',
  presetA: 'Test spot A',
  presetB: 'Test spot B (next to A)',
  presetC: 'Test spot C (far away)',
  latitude: 'Latitude',
  longitude: 'Longitude',
  use: 'Use this spot',
  invalid: 'Enter a latitude between -90 and 90 and a longitude between -180 and 180.',
  useReal: 'Use my real location',
} as const;
```
Status line: joined → "You're in **Area u4pruyd** as alice"; desired set but not current → `AREA_TEXT.joining(label)`, or
`CONNECTION_TEXT.roomReconnecting` while reconnecting.

**Presets** (geo/devPresets.ts; public sample points):
- A `{57.64911, 10.40744}` → `u4pruyd`
- B `{57.64911, 10.4087}` → `u4pruye` (neighbour)
- C `{51.5074, -0.1278}` → `gcpvj0d`

**Geohash vectors (precision 7):**
| lat, lng | geohash |
|---|---|
| 57.64911, 10.40744 | u4pruyd (precision 12: u4pruydqqvj8) |
| 57.6492, 10.4075 | u4pruyd (same cell) |
| 57.6488, 10.4069 | u4pruyd (same cell) |
| 57.64911, 10.4087 | u4pruye (neighbour) |
| 57.64911, 10.4 | u4pruwt |
| 0, 0 | s000000 |
| -90, -180 | 0000000 |
| 90, 180 | zzzzzzz |
| 90, 0 | upbpbpb |
| -90, 0 | h000000 |
| 89.9999, 10 | upzpgxc |
| -89.9999, 10 | h0p0581 |
| 0, 179.9999 | xbpbpbp |
| 0, 180 | xbpbpbp |
| 0, -179.9999 | 8000000 |
| 0, -180 | 8000000 |
| 51.5074, -0.1278 | gcpvj0d |

- Antimeridian: points 0.0002° apart across it get different cells (standard behaviour, ADR-001); the test documents it.
- Rejected: lat ±90.0001, lng ±180.0001, NaN, ±Infinity, precision 0/13/7.5.

## Tests required
- `web/tests/geo/geohash.test.ts`:
  - the vector table
  - prefix property (precision 12 starts with precision 7 for every vector)
  - exact boundaries ±90/±180 accepted
  - every rejection with its specific error
- `web/tests/geo/cell.test.ts`:
  - cellFor vectors; the three same-cell points → an equal Cell; the neighbour differs
  - roomJidForCell exact
  - `isValidRoomJid(roomJidForCell(c,'muc.chaterl.localhost'),'muc.chaterl.localhost')` true for every vector incl. 0000000/zzzzzzz
- `web/tests/helpers/fakeGeolocation.ts`:
  - a controllable GeolocationLike capturing watches and counting active ones; `emit(lat,lng)`, `fail(code)`
  - a fake PermissionStatus with `state` and `change` dispatch
  - `installGeo({geolocation, permissions, secure})` / `uninstallGeo()` via Object.defineProperty on navigator/window, restored in afterEach
- `web/tests/geo/useLocation.test.ts` (renderHook, injected deps):
  - unsupported; insecure (strict false); no permissions API → idle
  - checking → idle on prompt; granted → auto-start → requesting → watching{cell}
  - denied at mount → no watchPosition
  - errors 1/2/3 before a fix → the right state + clearWatch
  - after a fix: 3 and 2 ignored, 1 → denied + clearWatch
  - out-of-range fix → unavailable
  - `start()` from timeout clears the old watch and creates exactly one new one
  - permission change: granted starts, denied clears, prompt-while-denied → idle
  - query rejecting → idle; query resolving after unmount → no watch, no update
  - unmount → 0 active watches and the listener removed
  - StrictMode → exactly 1 active watch
  - a same-cell second fix keeps the state reference
  - the state never holds a number (`JSON.stringify` has no `57.6`)
- `web/tests/geo/useArea.test.ts`:
  - the first fix commits
  - another-cell fix → moved:true with the cell unchanged; commitMove → new cell, moved:false
  - dev.set valid → dev-pin; invalid → error result with state unchanged; same-cell set → same reference
  - dev.clear → the latest device cell, or the device status (e.g. denied)
  - device denied while located → denied
  - no coordinates in `JSON.stringify(state)` after dev.set
- `web/tests/geo/DevLocationPicker.test.tsx`:
  - presets → the right cell (via a real useArea harness → state geohash)
  - manual valid/invalid input (alert, not applied)
  - inputs labelled with `autocomplete="off"`
  - keyboard only: Tab to a preset + Enter; Tab to the inputs, type, Enter submits
  - "Use my real location" only while active
- `web/tests/state/useAreaRoom.test.ts`:
  - planRoomActions table, every rule: reconnecting + same desired → []; failed/left same → []; failed other + connected → join only; desired null + joined → leave only
  - Hook with a real client over the fake transport:
    - first join → exactly one join presence to `g7_u4pruyd@…/alice`
    - switch → one unavailable presence to the old room, then one join to the new, in order
    - switch while reconnecting → no stanza and the old room untracked (no rejoin of it after reconnect; exactly one join to the new)
    - retry after a timeout failure rejoins
    - StrictMode → one join presence
    - same desired re-render → no stanzas
- `web/tests/components/AreaPanel.test.tsx`:
  - each AreaState renders its distinct text and action (role=status)
  - the denied dev hint only with the `devHint` prop
  - moved → "Switch to my new area"
  - focus moves to the panel when the focused action unmounts
  - no address or room JID ever rendered (no `@muc`)
- `web/tests/integration/chatFlow.test.tsx` (update in place):
  - install fake geolocation (granted, fix A) in beforeEach; every existing test joins through it instead of the "Join" button
  - fixtures: `export const CELL_ROOM = 'g7_u4pruyd@muc.chaterl.localhost'`, plus an optional trailing `room = ROOM` param on presence/groupchat (client unit tests keep ROOM)
  - New cases:
    1. Located → join to `CELL_ROOM/alice`; status "You're in Area u4pruyd as alice".
    2. Dev spot B → leave CELL_ROOM, join `g7_u4pruye`; timeline and occupants empty; no "Load earlier messages" until the new room's initial load completes; the new room's MAM IQ targets the new room.
    3. A switch during reconnecting → after connected, exactly one join, to the new room only.
    4. Permission denied → the denied text + dev hint, Composer disabled, no join stanza.
    5. **Privacy:** after cases 1–3, no serialized stanza in `t.sent`/`t.iqs` contains `57.6`, `10.40`, `10.408`, `lat` or `lon`.
- `web/tests/components/brand.test.tsx`: the room-status test uses a located area ("You're in Area u4pruyd as alice"; still no `@muc`).
- `web/tests/components/round2.test.tsx`: remove the two RoomForm describe blocks with the component. Their intent is re-covered by useAreaRoom (switch → exactly one leave + one join) and DevLocationPicker (invalid → alert, no join).
  **Total test count ≥ 475 + new, no net loss**; report before/after counts.
- `web/tests/ui/text.test.ts`: AREA_TEXT/DEV_LOCATION_TEXT contain none of /geohash|jid|muc|cell|coordinate/i.

## Acceptance criteria
- AC1: encodeGeohash/cellFor match every vector (incl. poles, antimeridian, (0,0), corners). Out-of-range, non-finite and bad precision → the specific `{ok:false}` error; never throw.
- AC2: roomJidForCell → `g7_<geohash>@<mucDomain>`, passing isValidRoomJid. New cell rooms are created via the existing instant-room path (unit test: a 201 self-presence → acceptInstantRoom → joined for a g7_ room).
- AC3: every LocationState/AreaState has distinct text in a role=status region, with a keyboard-reachable action where applicable. Denied shows how to re-enable, plus "Or choose a test location below." in dev only.
- AC4: watchPosition is cleared on unmount, on denied, on every pre-fix error and before every restart. StrictMode leaves exactly one active watch. The Permissions API is used when present and its listener removed on unmount.
- AC5: the first located cell auto-joins its room. A dev spot in a different cell or "Switch to my new area" → leave the old room + join the new, exactly once each. Background fixes never switch. A same-cell spot → no stanzas.
- AC6: after a switch the new room starts fresh (timeline, occupants, insertAt, earlier, canLoadEarlier); old messages never show under the new area.
- AC7: a switch while reconnecting leaves the old room with no stanza and no rejoin after reconnect; the new room is joined exactly once on connected.
- AC8 (PRIVACY, blocking):
  - Coordinates only as transient values in web/src/geo/ (callback locals and the dev picker's input state). No React state outside geo/, no Zustand store, URL, storage, console, stanza or room name holds them.
  - These greps return nothing:
    - `grep -rnE "\b(lat|lng|latitude|longitude|coords)\b" web/src --include=*.ts --include=*.tsx | grep -v "^web/src/geo/"`
    - `grep -rnE "console\.|localStorage|sessionStorage|indexedDB|history\.|location\.(hash|search|href)|fetch\(" web/src/geo`
  - ESLint rejects a deep geo/* import from outside geo/ and any geo import from src/xmpp/ (verify by temporarily adding one; report the error output; revert).
  - Integration privacy case 5 passes.
- AC9: `npm run build` succeeds and the production bundle has no dev picker: `grep -rE "Test locations|Test spot|57\.64911|51\.5074" web/dist` returns nothing.
- AC10: on md+ (e.g. 1280×800) with 100 messages the page doesn't scroll vertically (`scrollHeight === clientHeight` on `document.scrollingElement`) and the message list scrolls internally. At 360×640 there's no horizontal scroll and everything is reachable. Stick-to-bottom and Load-earlier scroll preservation still work. [manual for the visual part]
- AC11: typecheck, lint and test clean; pre-existing tests green; RoomForm tests replaced as described with no net loss; no new dependencies.
- AC12: ADR-013 appended; ARCHITECTURE, ROADMAP and README updated per Step 16; CLAUDE.md untouched.
- AC13 [manual, live]: two sessions on spot A (alice, bob) → `g7_u4pruyd`, chatting both ways. bob → spot B (`g7_u4pruye`): leaves alice's room (alice sees "bob left") and lands in an empty new room with its own history. Back to A → A's history from MAM.
- AC14 [manual, live]: in the browser pane the device location ends in one of idle/requesting/timeout/denied/located with the right UI; the dev picker works by keyboard only.
- AC15 [manual]: the README "Phase 2 demo" steps reproduce AC13 from a clean checkout (`cp .env.example .env`, `docker compose up -d`, `bash infra/mongooseim/dev-seed.sh`, `cd web && npm ci && npm run dev`, two windows (normal + private) as alice and bob).

## Risks / watch-outs
- **Privacy:**
  - dev inputs `autoComplete="off"`, not in a GET form
  - never pass `GeolocationPositionError.message` or the position object anywhere
  - don't add accuracy/coords to AreaState "for later"
  - known dev-only leaks go into ADR-013 (disco listing, persistent rooms, the on-screen code)
  - being in a cell room tells co-occupants your ~150 m cell: that's the product, but note it in the ADR
- **ADR-005 deviation:** no spoofing control client-side (anyone can join any g7_ room). Accepted until Phase 3.
- **Effects:**
  - the useAreaRoom effect must not loop (joinRoom emits room-joining synchronously → current.roomJid === desired)
  - desiredRoomJid must be stable per cell (useMemo on the geohash)
  - never call joinRoom when not connected
- **StrictMode:** watches, permission listeners and joins must be idempotent or cleaned up.
- **Permissions API quirks:**
  - Safari < 16 has no query
  - a `prompt` after dismissal while watchPosition gives code 1 → shown as denied, and "Try location again" re-prompts
  - insecure contexts may expose geolocation but fail with code 1, so insecure is checked first
  - a LAN IP over http on phones → insecure-context (document it in the README)
- **Accuracy:** `enableHighAccuracy:false` can give IP-based locations km off on desktops. Accepted for 2c; Phase 3 validates server-side.
- **Sign-out** unmounts Chat (watch cleared, dev spot forgotten); on re-sign-in a granted permission auto-starts. Expected; mention it in the ADR.
- **Layout:** don't move the scroll container; re-run the earlier-load tests.
- **Tree-shaking:** the dev picker only behind a literal `import.meta.env.DEV`; DEV_LOCATION_TEXT/presets only from DevLocationPicker. AC9 is the check; if strings survive, move the check, not the strings.

## Out of scope
- **2c-2 (next slice; outline only):** a Leaflet map inside DevLocationPicker, lazy-loaded only in DEV.
  - Deps: `leaflet` 1.9.4, `react-leaflet` 4.2.1 (peer react ^18, leaflet ^1.9), `@types/leaflet` 1.9.22 (dev).
  - CircleMarker (no marker PNG handling); Leaflet CSS.
  - `VITE_MAP_TILE_URL` in .env.example and parseConfig, with OSM attribution and a tile-privacy note.
  - The 2c-1 keyboard picker stays as the accessible fallback.
- Hysteresis, auto-switching, "you entered …" notices (Phase 4); range slider/other precisions (Phase 5).
- geo_service, /api/locate, the MUC lock-down, default_room changes (Phase 3); no infra/ changes.
- Removing toRoomJid/address helpers; an onboarding display name; an accuracy indicator; a neighbour view.
- Any new npm dependency, any xmpp/ change, any CLAUDE.md edit.
