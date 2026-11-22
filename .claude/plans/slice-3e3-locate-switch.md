## Plan: Slice 3e-3, the locate switch (server-assigned rooms via POST /api/locate)

Status: PLANNED by the supervisor on 2026-11-22 (HEAD 88e26f0). ADR: update ADR-019 (and mark ADR-013/ADR-005); no ADR-020.
CLAUDE.md is user-owned: never edit it.

### Baseline (measured at 88e26f0, clean tree)
- `npm run typecheck` and `npm run lint` are clean.
- `npx vitest run`: 44 files and 1054 tests, all passing, in 479 s (plan ~8 min per full run).
- Bundle baseline (ADR-019): JS 267 841 B; budget +4 000 B raw → ceiling 271 841 B.
- Cell-centre oracle values (computed with the repo's decode algorithm):

  | Spot | Raw point | Cell | Centre | Body JSON |
  |---|---|---|---|---|
  | A | 57.64911, 10.40744 | u4pruyd | 57.64869689941406, 10.407485961914062 | `{"lat":57.64869689941406,"lng":10.407485961914062}` |
  | B | 57.64911, 10.4087 | u4pruye | 57.64869689941406, 10.408859252929688 | `{"lat":57.64869689941406,"lng":10.408859252929688}` |
  | C | 51.5074, -0.1278 | gcpvj0d | 51.50733947753906, -0.1284027099609375 | (same pattern) |

  The u4pruyd centre equals the Erlang-computed value in the ADR-018 live evidence (Mongo rooms.center): an independent cross-language oracle.

### Goal
The browser stops naming rooms itself. On a committed cell change (the ADR-013 §3 triggers, plus a retry after an error), `geo/`:
- sends only the centre of the local precision-7 cell to `POST /api/locate`, through `tokenManager.withToken`
- validates the answer and joins the server's `room_jid`, keeping the previous room until the new assignment arrives

`roomJidForCell` is deleted. New guards keep coordinates in `geo/` → `api/locate.ts`, sockets in `xmpp/strophe/`, and ban cookies and Cache Storage.

### Context
- Roadmap Phase 3, item "Client switches to `/api/locate`" (3e-3). It depends on 3d, 3e-1 and 3e-2 (done).
- ADRs: ADR-005 (amended by D3), ADR-013 (partly superseded here), ADR-014 (dev picker, dist grep), ADR-018 (the locate contract and error codes), ADR-019 D2/D3/D4 and "Client implementation (3e-2)".
- Touched:
  - `web/src/geo/{cell.ts,useArea.ts,index.ts,devPresets.ts,DevLocationPicker.tsx}` (the last two: the GeoPoint import path only)
  - `web/src/api/{session.ts,http.ts,index.ts}`; `web/src/state/useAreaRoom.ts` (comment only)
  - `web/src/pages/Chat.tsx`, `components/AreaPanel.tsx`, `App.tsx`, `main.tsx`, `ui/text.ts`, `eslint.config.js`
  - tests in web/tests/{geo,api,state,components,integration,lint,ui}; `geo_service/test/geo_locate_tests.erl`; docs/*, README.md
- Dependencies: none new.

### Steps
1. **`web/src/api/http.ts`:** move `isRecord` and `statusError(res, expected)` here from `session.ts` and export them (NOT via index.ts). `session.ts` imports them; behaviour unchanged.
2. **`web/src/api/session.ts` and `web/src/api/index.ts`:** delete `LOCATE_TIMEOUT_MS` from session.ts and the index re-export (it moves to locate.ts). `index.ts` must NOT re-export anything from `./locate` (lint-enforced, step 12).
3. **`web/src/api/locate.ts` (new; interfaces below):**
   - Request: `http.postJson('/locate', { lat: point.lat, lng: point.lng }, { timeoutMs: LOCATE_TIMEOUT_MS, token, signal })` inside `tokens.withToken(call)`. Build the body literally from the two fields; never spread the input. No accuracy key, no range key.
   - In `call(token)`, a non-200 → `{ ok: false, error: statusError(res, 200) }` (required: withToken only sees a 401 as an ApiError of kind http).
   - Validation after withToken returns 200 (extra keys tolerated):
     - `cell` matches `^[0-9b-hjkmnp-z]{5,7}$`
     - `precision` is an integer in {5,6,7} and equals cell.length
     - `range` ∈ block/neighbourhood/area (US spelling invalid) and `RANGE_PRECISION[range] === precision` (7/6/5)
     - `room_jid === \`g${precision}_${cell}@${mucDomain}\`` by exact string equality
     - anything else → bad-response
   - Error mapping:

     | Outcome | Result |
     |---|---|
     | http 500/502/503/504 | unavailable (carries retryAfterMs) |
     | timeout, network | unavailable (retryAfterMs null) |
     | token reason unavailable or stopped | unavailable (null) |
     | token reason offline | offline |
     | token reason identity-invalid | identity-invalid |
     | `{kind:'unauthorized'}` (a second 401 after one renew + one retry) | bad-response (no auto retry) |
     | any other http status (400/404/405/413/415…), a non-200 2xx, http bad-response | bad-response |
     | aborted | aborted |

   - Never throws, never logs.
4. **`web/src/geo/cell.ts`:**
   - delete `roomJidForCell` and its TEMPORARY comment
   - move `GeoPoint` here from useArea.ts (useArea.ts, devPresets.ts and DevLocationPicker.tsx import it from ./cell)
   - add `cellCentre(cell)`: the midpoint of decodeGeohashBounds, as a tagged result
5. **`web/src/geo/roomAssigner.ts` (new, framework-free, built once in main.tsx like the token manager):**
   - Flow: `assign(cell)` → cellCentre → `locate.locate(centre, signal)`. The centre exists only as a local inside the request function; state holds only the Cell and `{jid, cell: geohash}`.
   - De-dup: assign with the same geohash as the current target is a no-op in any state (assigning/assigned/failed). A different cell aborts the in-flight request (AbortController), bumps a generation counter and starts one new request; a result from an older generation is ignored.
   - Keeping the room: `assigning.room` = the previous state's room (from assigned, or the room an earlier assigning kept); after failed/none it is null.
   - `failed.room` is always null (desired becomes null and the client leaves).
   - `assign(null)` aborts, cancels the retry timer and goes to none.
   - Local check on success: `value.range === 'block' && value.precision === 7 && value.cell === cell.geohash`, else failed: bad-response (nothing joined).
   - Retries:
     - unavailable schedules an automatic retry after `max(retryAfterMs ?? 0, min(5000·2^attempt, 30000))`; attempt resets on success and on a new cell
     - if `online.isOnline()` is false when a request would start or when an unavailable returns → failed: offline, no request, no timer; the online event retries a failed offline/unavailable at once
     - identity-invalid and bad-response never auto-retry
     - `retry()` is immediate in any failed state and cancels a pending timer
   - `getState()` returns the same object reference until something changes (useSyncExternalStore).
   - `dispose()` clears the timer, the online subscription and the listeners.
6. **`web/src/geo/RoomAssignment.tsx` (new):** a context + `RoomAssignerProvider({assigner, children})` + `useRoomAssignment(cell)`.
   - Throws outside the provider.
   - `useEffect(() => assigner.assign(geohash ? {precision:7, geohash} : null), [assigner, geohash])`, keyed on the geohash string.
   - A second effect does `assign(null)` on unmount.
   - Returns `{ assignment: useSyncExternalStore(assigner.subscribe, assigner.getState), retry: assigner.retry }`.
7. **`web/src/geo/index.ts`:** export useRoomAssignment, RoomAssignerProvider, createRoomAssigner and the types RoomAssignment, AssignFailure, AssignedRoom, RoomAssigner. Remove the roomJidForCell and GeoPoint exports. Header comment: coordinates leave geo/ only as a cell centre through api/locate.ts.
8. **`web/src/pages/Chat.tsx`:**
   - drop the mucDomain prop and the roomJidForCell import
   - `const { assignment, retry: retryAssign } = useRoomAssignment(cell)`; `desiredRoomJid = assignment.room?.jid ?? null`
   - `label = assignment.room ? AREA_TEXT.areaLabel(assignment.room.cell) : ''` (the room's own cell, so the label stays correct during a switch)
   - emptyText: none → emptyNoArea; assigning with no room → emptyJoining; failed → AREA_TEXT.emptyUnassigned; otherwise the current logic
   - the status line stays empty while there is no room (AreaPanel announces assigning/failures; no duplicate live regions)
   - pass `assignment` and `onRetryAssign={retryAssign}` to AreaPanel
9. **`web/src/App.tsx`:** drop the mucDomain prop and stop passing it to Chat.
10. **`web/src/components/AreaPanel.tsx`:**
    - new props `assignment: RoomAssignment`, `onRetryAssign(): void`
    - `describe` for located, in order:
      1. failed: identity-invalid → locateIdentityInvalid, no action (the IdentityNotice banner has Start over); otherwise the reason text + action retry-assign
      2. assigning → `AREA_TEXT.assigning(areaLabel(area.cell.geohash))`, no action
      3. moved → current behaviour
      4. otherwise ''
    - Same single button (PRIMARY, label AREA_TEXT.retryAssign); the existing "focused action unmounts → focus the panel" logic covers retry → assigning. Text stays in the existing role="status" region.
11. **`web/src/main.tsx`:**
    - `import { createLocateApi } from './api/locate'`
    - `const locate = createLocateApi({ http, tokens, mucDomain: config.mucDomain })`; `const assigner = createRoomAssigner({ locate })`
    - wrap `<App mapTileUrl=…/>` in `<RoomAssignerProvider assigner={assigner}>`, inside IdentityProvider
12. **`web/eslint.config.js` (exact constants):**
    ```js
    const API_LOCATE = { group: ['**/api/locate', '**/api/locate.*'], message: 'Only src/geo/ and src/main.tsx may import api/locate: a location leaves geo/ only through it.' };
    const API_LOCATE_SIBLING = { group: ['./locate', './locate.*'], message: 'api/locate is never re-exported: only src/geo/ and src/main.tsx import it directly.' };
    const GEO_STATE = { group: ['**/geo', '**/geo/*'], message: 'src/state/ must not depend on geo/: stores never hold a location.' };
    const SOCKET_MESSAGE = 'Only src/xmpp/strophe/ may open WebSockets or event streams.';
    const SOCKET_GLOBALS = ['WebSocket', 'EventSource'];
    const BROWSER_STATE_MESSAGE = 'No cookies or Cache Storage: the only browser storage is src/api/deviceCredential.ts.';
    const BROWSER_STATE_GLOBALS = ['caches', 'cookieStore'];
    const SOCKET_PROPERTIES = propertiesRule(SOCKET_GLOBALS, SOCKET_MESSAGE);
    const BROWSER_STATE_PROPERTIES = [...propertiesRule(BROWSER_STATE_GLOBALS, BROWSER_STATE_MESSAGE), { property: 'cookie', message: BROWSER_STATE_MESSAGE }];
    ```
    - `{property:'cookie'}` with no object catches document.cookie and window.document.cookie.
    - Base block: globals NET + STORAGE + SOCKET + BROWSER_STATE; properties NET + STORAGE + SOCKET + BROWSER_STATE; imports `restrict(STROPHE, GEO_DEEP, LEAFLET, API_LOCATE)`.
    - `src/state/**` (new block): `restrict(STROPHE, GEO_STATE, LEAFLET, API_LOCATE)`.
    - `src/geo/**`: unchanged (STROPHE, LEAFLET), so api/locate is allowed there.
    - `src/api/**`: imports `restrict(STROPHE, LEAFLET, API_LEAF, API_LOCATE_SIBLING)`; globals and properties STORAGE + SOCKET + BROWSER_STATE.
    - `src/api/deviceCredential.ts`: add SOCKET + BROWSER_STATE to both lists.
    - `src/main.tsx` (new block): `restrict(STROPHE, GEO_DEEP, LEAFLET)`.
    - `src/xmpp/strophe/**`: add globals and properties NET + STORAGE + BROWSER_STATE (leaving SOCKET out permits WebSocket; stropheTransport.ts uses `typeof WebSocket` / `instanceof WebSocket`).
    - `src/xmpp/**` unchanged (API_ANY already covers api/locate). Tests unchanged (off).
    - Keep the "flat config replaces a rule wholesale" comment. Adapt the constant/helper names to what the file actually has; report differences.
13. **`web/src/state/useAreaRoom.ts`:** comment only. No longer TEMPORARY: it keeps the client in the server-assigned room. Logic unchanged.
14. **`web/src/ui/text.ts`:** the AREA_TEXT additions below; they must pass the jargon test `/geohash|jid|muc|cell|coordinate/i`.
15. **`geo_service/test/geo_locate_tests.erl`:**
    - delete `cell_guard/0` and its entry in the drift_guard_test_ list
    - fix the comment (~lines 271–273): the room id format must match ROOM_LOCALPART in web/src/xmpp/jid.ts and the muc.<domain> default in web/src/config.ts; the client no longer builds room JIDs, it checks the server's by equality
    - run `rebar3 eunit`, `rebar3 fmt --check`, `rebar3 dialyzer` (OTP 28 at "/c/Program Files/Erlang OTP/bin", rebar3 at ~/.local/bin)
16. **Docs:**
    - ADR-013 status line: "Partly superseded by ADR-019 (3e-3): the client no longer assigns rooms (roomJidForCell deleted); §2: the cell centre leaves geo/ via api/locate.ts; §3: the triggers now drive /api/locate; §4: the controller consumes the server's room_jid. §1, 5–8 stand; 'anyone can join any g7_ room' stays until 3f."
    - ADR-005 status: "Amended by ADR-019 D3 (landed in 3e-3)".
    - ADR-019:
      - status "…D3 and D4 landed in 3e-3"
      - add `### Client implementation (3e-3)`: the assigner design; the error-mapping table (incl. unauthorized and other 4xx → bad-response, with the reason); equality validation instead of the regex; keep-room and null-on-failure; the auto-retry policy; aborted requests may still touch_room the abandoned cell (accepted: a cell, not a position); the guards (sockets, cookies, caches, state↛geo, no re-export); bundle numbers
      - add `### Live evidence (3e-3)` (orchestrator)
    - ARCHITECTURE:
      - rewrite "Locate & join" steps 1, 2, 4: the fix → cellFor (raw fix discarded) → on a committed cell change geo/roomAssigner posts {lat,lng} = the cell centre via api/locate + withToken → validates → joins room_jid, leaving the old room only after the new assignment
      - frontend tree: geo/ + roomAssigner.ts, RoomAssignment.tsx; cell.ts = cellFor, cellCentre; api/ + locate.ts (imported only by geo/ and main.tsx); state/ cannot import geo; sockets only in xmpp/strophe
      - State flow: `useLocation → useArea (committed Cell) → roomAssigner → POST /api/locate (cell centre) → validated room_jid → useAreaRoom leave/join → stanzas → stores`
      - "Room naming": the client never builds room JIDs, it validates the server's; Login step 5: /api/locate now calls withToken
    - README:
      - How it works steps 1–2: the browser snaps the position to its ~150 m area and sends only that area's centre
      - replace "never sent or stored" with "Only the centre of your area is sent to geo_service, which picks the room; your exact position never leaves the browser and nothing is stored."
      - rename the demo section "Demo: server-assigned rooms (two people, one area, then moving)", drop "client-side and temporary", add a step to see the room in Mongo: `MSYS_NO_PATHCONV=1 docker compose exec -T mongo mongosh --quiet chaterl --eval 'db.rooms.find({_id:"g7_u4pruyd"}).toArray()'`
    - ROADMAP: the coder does NOT tick. The orchestrator ticks after the live checks:
      - "Client switches to /api/locate…" (dated)
      - the Phase 3 demo line, with the note "(verified <date> after 3e-3; until 3f locks MUC down anyone can still join any g7_ room directly)"
      - the Phase 3 header gets no ✅ until "Lock down MUC" (3f)

### Interfaces
```ts
// api/locate.ts — imported ONLY by src/geo/**, src/main.tsx, tests (lint-enforced)
export const LOCATE_TIMEOUT_MS = 10_000;
export interface LocatePoint { readonly lat: number; readonly lng: number }
export type LocateRange = 'block' | 'neighbourhood' | 'area';
export interface LocateAnswer { cell: string; precision: 5 | 6 | 7; range: LocateRange; roomJid: string }
export type LocateFailure =
  | { kind: 'unavailable'; retryAfterMs: number | null }
  | { kind: 'offline' } | { kind: 'identity-invalid' } | { kind: 'bad-response' } | { kind: 'aborted' };
export type LocateResult = { ok: true; value: LocateAnswer } | { ok: false; error: LocateFailure };
export interface LocateApi { locate: (point: LocatePoint, signal: AbortSignal) => Promise<LocateResult> } // never rejects
export function createLocateApi(o: { http: Http; tokens: TokenAccess; mucDomain: string }): LocateApi;
// wire: POST {apiUrl}/locate, authorization: Bearer <token>, body exactly {"lat":<centre lat>,"lng":<centre lng>}

// api/http.ts (not in index)
export function isRecord(v: unknown): v is Record<string, unknown>;
export function statusError(res: HttpResponse, expected: number): ApiError | null;

// geo/cell.ts
export interface GeoPoint { readonly lat: number; readonly lng: number }
export function cellCentre(cell: Cell): { ok: true; point: GeoPoint } | { ok: false; error: 'invalid-geohash' };

// geo/roomAssigner.ts
export type AssignFailure = 'unavailable' | 'offline' | 'identity-invalid' | 'bad-response';
export interface AssignedRoom { readonly jid: string; readonly cell: string /* geohash, for the label */ }
export type RoomAssignment =
  | { status: 'none'; room: null }
  | { status: 'assigning'; cell: Cell; room: AssignedRoom | null }   // room = previous room, kept
  | { status: 'assigned'; cell: Cell; room: AssignedRoom }
  | { status: 'failed'; cell: Cell; reason: AssignFailure; room: null };
export interface RoomAssigner {
  assign: (cell: Cell | null) => void;     // same geohash as target = no-op
  retry: () => void;                       // immediate, only in 'failed'
  getState: () => RoomAssignment;          // stable reference between changes
  subscribe: (l: () => void) => () => void;
  dispose: () => void;
}
export function createRoomAssigner(o: {
  locate: LocateApi; timers?: Timers; online?: OnlineSource;
  backoffBaseMs?: number /*5_000*/; backoffMaxMs?: number /*30_000*/;
}): RoomAssigner;
// OnlineSource/Timers types come from '../api'. Default online = window online event + navigator.onLine
// (export the tokenManager default as `browserOnline` from api/index and reuse it; no duplicate).

// geo/RoomAssignment.tsx
export function RoomAssignerProvider(p: { assigner: RoomAssigner; children: ReactNode }): React.JSX.Element;
export function useRoomAssignment(cell: Cell | null): { assignment: RoomAssignment; retry: () => void };

// components/AreaPanel.tsx
export interface AreaPanelProps { area: AreaState; assignment: RoomAssignment; onShare(): void; onSwitchArea(): void; onRetryAssign(): void; devHint?: boolean }
// pages/Chat.tsx: props { mapTileUrl, nickname, onSignOut, banner? }   (mucDomain removed)
// App.tsx: AppProps { mapTileUrl }                                      (mucDomain removed)
```
AREA_TEXT additions (exact strings):
```ts
assigning: (label: string): string => `Finding the chat for ${label}…`,
locateUnavailable: "Nearby can't reach your area chat right now. We'll keep trying.",
locateOffline: "You're offline. We'll find your area chat when you're back online.",
locateIdentityInvalid: "Nearby can't find your area chat because it can't confirm your name. To chat here, start over with a new name.",
locateBadResponse: 'Something went wrong while finding your area chat.',
retryAssign: 'Find my area chat',
emptyUnassigned: 'Your area chat will show up here.',
```

### Tests required
- **tests/api/locate.test.ts** (new; fake Http + fake TokenAccess, or the real token manager with a fake renew):
  - Request: path /locate, timeoutMs 10_000, the signal passed, the token in the header; the body exactly {lat, lng} (Object.keys equals ['lat','lng']) even when the input carries extra accuracy/range keys (cast).
  - Validation table:
    - valid; extra keys tolerated; each of the 4 keys missing
    - precision 4, 8, '7', 7.5
    - range 'neighborhood'; a range/precision mismatch (area with 7)
    - cell with a/i/l/o, uppercase, length ≠ precision
    - room_jid with a foreign domain, with /resource, with a g6_ prefix for precision 7, with a different cell, with domain `mucXchaterl.localhost`
    - body null/array/string; status 201
  - Error mapping: every row, incl. retryAfterMs 5000 from 503 retry-after: 5.
  - 401 path (real token manager): 401 → renew → 200 → ok (2 locate calls, 1 renew); 401 twice → bad-response, no third call; a renew 401 → identity-invalid.
  - No console.* calls (spy).
- **tests/geo/cell.test.ts:**
  - remove the roomJidForCell cases
  - `cellCentre({7,'u4pruyd'})` equals exactly {lat: 57.64869689941406, lng: 10.407485961914062}
  - for every vector (incl. 0000000/zzzzzzz pole and antimeridian corners) cellFor(centre) gives the same geohash
  - the centre of spot A's cell ≠ the raw spot A
  - {geohash:'u4prA'} → error
- **tests/geo/roomAssigner.test.ts** (new; fake LocateApi with deferred promises, manual timers, fake online):
  - one call with exactly the centre; assigning(room null) → assigned
  - the same cell again (assigning/assigned/failed) → no new call
  - a switch keeps the old room during assigning
  - a fast switch aborts the first signal and ignores its late result; A → B (pending) → A sends a new request and ends assigned A
  - assign(null) aborts → none, a late result is ignored
  - local check: cell ≠ local, precision 6, range area → bad-response, room null
  - unavailable retries at 5, 10, 20, 30, 30 s; retryAfterMs 8000 beats 5000; success resets the backoff
  - retry() immediate and cancels the timer
  - offline: no call; online → call; unavailable while offline → offline, no timer
  - identity-invalid / bad-response: no timer
  - getState() same reference across a no-op assign; dispose() stops everything
  - `JSON.stringify(state)` never matches `/\d+\.\d{3,}|"(lat|lng)"/`
- **tests/geo/useRoomAssignment.test.tsx** (new): throws outside the provider; a re-render with a new-but-equal Cell → no call; unmount → assign(null); a StrictMode mount with a cell → at most one non-aborted request.
- **tests/components/AreaPanel.test.tsx:**
  - each failure text with the button "Find my area chat" calling onRetryAssign; identity-invalid has no button
  - the assigning text; a failure takes precedence over moved
  - focus goes to the panel when the focused retry button disappears; never renders a room address
- **tests/components/brand.test.tsx:** wrap Chat in RoomAssignerProvider with a fake assigner; drop mucDomain.
- **tests/ui/text.test.ts:** the new AREA_TEXT strings pass the jargon check; exact `assigning('Area u4pruyd')`.
- **tests/integration/chatFlow.test.tsx:**
  - Setup:
    - mountApp builds createLocateApi + createRoomAssigner({ locate, timers, online: fakeOnline }) + the provider
    - the default /api/locate route answers from a table keyed by the exact centre body (u4pruyd, u4pruye, gcpvj0d); any other body → 400 invalid_location (so a raw point fails the test)
    - the locate() helper flushes microtasks after the fix; drop mucDomain from <App>
  - Existing area tests keep passing (joins now wait for the locate reply).
  - New cases:
    - (a) after spot A, exactly one locate request; body string === `'{"lat":57.64869689941406,"lng":10.407485961914062}'`; authorization `Bearer tokenRenew…`; a same-cell device fix → no new request, no stanza; spot B → exactly one more request with the u4pruye centre body, one leave and one join
    - (b) a pending locate route → no join; resolve → the join goes to the returned room_jid
    - (c) in A, pick B with the route pending → no leave, still "You're in Area u4pruyd", composer enabled, AreaPanel "Finding the chat for Area u4pruye…"; resolve → one leave, one join
    - (d) B pending, then C → B's request signal aborted, B's late reply ignored; leaves = [A]; joins = [A, C]
    - (e) 503 retry-after: 5 → locateUnavailable + the button, the room left, composer disabled; timers.advance(5000) → 200 → joined
    - (f) fakeOnline offline → locateOffline, no request; online → request + join
    - (g) a 401 on the first token → renew → retry 200 → joined, no error text
    - (h) a renew 401 before locate → identity-invalid → locateIdentityInvalid + the IdentityNotice; zero locate requests; no join
    - (i) a foreign-domain room_jid → locateBadResponse, no join
    - (j) denied while located → leave
    - (k) privacy:
      - the XMPP wire as today
      - JSON.stringify of useRoomStore/useSessionStore/useIdentityStore state has no `57.64|10.40|lat|lng`
      - a console.* spy over the whole flow has 0 calls whose args match `/57\.6|10\.40|"lat"|"lng"/`
      - locate bodies never equal the raw spot values
- **tests/lint/boundaries.test.ts** (extend):
  - Errors:
    - `import { createLocateApi } from '../api/locate'` in src/components/F.tsx, src/state/f.ts, src/pages/F.tsx, src/xmpp/client.ts; `./api/locate` in src/App.tsx
    - `export { createLocateApi } from './locate'` in src/api/index.ts
    - `import { useArea } from '../geo'` in src/state/f.ts
    - `new WebSocket('ws://x')` in src/xmpp/client.ts, src/components/F.tsx, src/api/http.ts (globals); `window.WebSocket` in src/state/f.ts (properties); `new EventSource('/x')` in src/geo/f.ts
    - `document.cookie = 'a=b'` and `window.document.cookie` in src/components/F.tsx and src/api/deviceCredential.ts (properties)
    - `caches.open('x')` in src/api/http.ts; `self.caches` in src/state/f.ts; `cookieStore.get('x')` in src/pages/F.tsx
    - `fetch('/x')` in src/xmpp/strophe/s.ts
  - Allowed ([]):
    - `../api/locate` in src/geo/f.ts; `./api/locate` in src/main.tsx; `../src/api/locate` in tests/x.test.ts
    - `new WebSocket('ws://x'); new EventSource('/x')` in src/xmpp/strophe/s.ts
    - all existing allowed cases still pass
- **geo_service:** rebar3 eunit still passes after cell_guard is removed (the drift guard keeps its jid.ts/config.ts checks).

### Acceptance criteria ([LIVE] = orchestrator)
- AC1: roomJidForCell and its export gone (`grep -rn roomJidForCell web/src geo_service` = 0, docs/history excepted); cell_guard removed; rebar3 eunit / fmt --check / dialyzer clean.
- AC2: api/locate.ts sends exactly {lat, lng} (the cell centre) with Bearer auth via withToken and a 10 s timeout, validates by exact equality, maps every error per the table; unit tests cover every row.
- AC3: locate only on a committed cell change (first fix, a dev spot in another cell, Switch to my new area, Use my real location) and a retry after an error; never on a same-cell fix, an XMPP reconnect or a token renew (integration tests).
- AC4: the previous room is kept until the new assignment arrives; failure or location loss → desired null (leave); a fast switch aborts/ignores stale replies.
- AC5: the states assigning, unavailable (auto backoff + "Find my area chat"), offline (resumes on online), identity-invalid (no button; the banner offers Start over) and bad-response (manual retry) render in AreaPanel's status region with the exact copy; focus is kept when the button disappears.
- AC6: ESLint guards as in step 12, each guard and each allowed place proven by fixture tests.
- AC7: privacy tests: the locate body equals the hard-coded geo_service centre, never the raw fix; no accuracy/range keys; no coordinates in Zustand, stanzas or console.
- AC8: npm typecheck, lint, test clean (baseline 1054; the count rises).
- AC9: docs per step 16; the coder does not tick ROADMAP.
- AC10 [LIVE]: 4 healthy; two pseudonymous users at spot A in a server-assigned g7_u4pruyd (join presence `g7_u4pruyd@muc.chaterl.localhost/<nick>`, "People here · 2", messages both ways).
- AC11 [LIVE]: Mongo rooms g7_u4pruyd has exactly six keys and center.coordinates `[10.407485961914062, 57.64869689941406]`; lastActiveAt advances after a new locate into that cell (spot B, then A again).
- AC12 [LIVE]: instrument fetch (store, never print):
  ```js
  (() => { const o = window.fetch; window.__api = [];
    window.fetch = (u, i) => { window.__api.push({ url: String(u), body: typeof i?.body === 'string' ? i.body : '' }); return o(u, i); }; })();
  ```
  Spot A then B → exactly one new /api/locate entry and one unavailable presence + one join in the WS frames; spot B again or a same-cell click → 0 new locate entries and 0 stanzas.
- AC13 [LIVE]: the locate bodies equal `['{"lat":57.64869689941406,"lng":10.407485961914062}', '{"lat":57.64869689941406,"lng":10.408859252929688}', …]`, and `!bodies.some(b => /57\.64911|10\.40744|10\.4087\b|accuracy|range/.test(b))` (booleans only, never printed).
- AC14 [LIVE]: no coordinate values or keys in WS frames (`57\.6|10\.40|51\.50|-0\.12|\b(lat|lng|lon|latitude|longitude)\b` → 0) or the console; geo_service logs (script) 0 × 57.6486968, 10.4074859, 10.4088592 and 0 locate_* lines.
- AC15 [LIVE]: stop mongo, pick another spot → "Nearby can't reach your area chat right now. We'll keep trying.", the room left, composer disabled; start mongo → automatic recovery within ~30 s (or at once via "Find my area chat") and a join; RestartCount 0.
- AC16 [LIVE] token path (no .env / JWT secret changes):
  - (a) wrap fetch so the first /api/locate gets `authorization: 'Bearer tampered.tampered.tampered'` (copy init.headers, replace only that key, never print the real token), pick a new spot → one 401, one /api/session/renew 200, one retried /api/locate 200, joined, no error text
  - (b) delete the test identity's profile in Mongo, reload → renew 401 → banner; pick a spot → locateIdentityInvalid, 0 /api/locate, no join
  - double-401 → bad-response is unit/integration only
- AC17 [LIVE]: npm run build: one JS ≤ 271 841 B; 0 hits for `Test spot A|Test locations|leaflet|openstreetmap|57\.64911|10\.40744|roomJidForCell`; ≥1 hit for `Find my area chat`; report gzip.
- AC18 [LIVE]: localStorage only nearby.identity.v1[.slot]; sessionStorage and cookies empty; no JWT-shaped values.
- AC19 [LIVE]: cleanup (test accounts removed, profiles and test rooms deleted, listUsers = alice, bob; browser storage cleared; fetch wrapper gone after reload).
- AC20 optional [LIVE]: 360×640 Chat in the unavailable state → scrollWidth 360.

### Risks / watch-outs
- **useSyncExternalStore:** getState must return a cached object (a fresh one loops: "getSnapshot should be cached").
- **StrictMode:** double effects at mount give one aborted + one real request if a cell exists at mount; today the cell is null at mount. Don't "fix" this with module flags.
- **Aborts:** fetch abort doesn't stop the server, so an abandoned cell can still be upserted (accepted; record in ADR-019).
- **Token interplay:** getToken bypasses the renew backoff, so with renew failing each assigner retry costs one renew (bounded 5→30 s). Expected.
- **Privacy regressions to watch:** spreading the point into the body; logging a LocateResult; the centre in state or a thrown Error; adding accuracy; tests deriving the expected centre from cellCentre itself (tautology; use the hard-coded values).
- **Flat config:** every block redefining no-restricted-globals/-properties must re-list all bans (base, api, deviceCredential, strophe); the strophe fetch fixture catches omissions.
- **no-restricted-imports** also matches `import type` (intended).
- **Windows:**
  - the full vitest run ~8 min; lint fixtures ~16 s cold
  - MSYS_NO_PATHCONV=1 for docker compose exec in Git Bash
  - navigator.onLine is unreliable with virtual adapters (offline verified in tests)
  - rerun rebar3 for the test edit; if rebar3 isn't on PATH, report it
- **Bundle:** if over +4 000 B, report the numbers rather than trimming copy or a11y.
- **Vite proxy:** when geo_service is down, the proxy answers 5xx or the request fails; both map to unavailable.

### Out of scope
- MUC lockdown and room creation by geo_service (3f)
- hysteresis/automatic switching (Phase 4); geo_rate; the range slider/any range key (Phase 5)
- client-side assignment caching
- any geo_service source change (only the test edit); server-side removeUser
- new deps; editing CLAUDE.md

### Proposed CLAUDE.md changes (for the user)
- Privacy: "The browser sends geo_service only the centre of its precision-7 cell (ADR-019 D3). The raw fix never leaves web/src/geo/, and coordinates leave geo/ only through web/src/api/locate.ts."
- Frontend: "Network only in web/src/api/; WebSocket/EventSource only in web/src/xmpp/strophe/; browser storage only in api/deviceCredential.ts (no cookies or Cache Storage); state/ never imports geo/. All lint-enforced."
