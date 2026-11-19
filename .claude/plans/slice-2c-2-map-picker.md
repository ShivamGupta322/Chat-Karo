# Plan: Phase 2c-2 — Leaflet map location picker (dev only), plus the 2c-1 review follow-ups

Status: APPROVED 2026-11-19 after review round 1 (AC9 amended: with the panel open at 1280×800 the page may scroll by the excess, dev only; closed it does not). Planned at HEAD d50b137. The ADR is **ADR-014** (a new ADR; ADR-013 is accepted and won't be rewritten).

## Goal
In the dev server, the "Test locations (dev)" panel gets an optional Leaflet map. Clicking it picks a test spot, and the map
shades the **whole cell** you are in, never the exact clicked point. Leaflet, react-leaflet, their CSS and the tile URL never
reach a production build. The four small 2c-1 follow-ups land in the same slice as separate steps.

## Context
- Roadmap phase 2, last open item ("geo/useLocation with permission/error states; dev-mode map location picker").
- ADRs:
  - ADR-003 (react-leaflet)
  - ADR-008 (React 18.3.1 pin → react-leaflet 4.x; envDir/`VITE_*` only)
  - ADR-009 (tokens, no raw palette, text in ui/text.ts)
  - ADR-013 §2 (geo/ privacy boundary + ESLint guards), §6 (dev picker behind a literal `import.meta.env.DEV`; dev strings in geo/) and its
    known-leaks list (already names 2c-2 tile requests)
- Verified by the supervisor at d50b137:
  - 696 tests green.
  - `main.tsx` passes the whole `import.meta.env` to `parseConfig`, and Rollup keeps **every `VITE_*` key parseConfig reads** as a literal
    (`ug={VITE_XMPP_DOMAIN:"chaterl.localhost",VITE_XMPP_WS_URL:"ws://…"}`). If parseConfig just reads `VITE_MAP_TILE_URL`, the tile
    URL ships to production. Step 6 fixes this.
  - `DevLocationPicker` tree-shakes today only because it has no top-level side effects. A plain top-level `lazy(() => import(...))` is
    not provably pure, so it would keep the dynamic import and emit a leaflet chunk. Step 5 fixes this.
  - `AppHeader` is `sticky top-0 z-10`; Leaflet panes use z-index 400–1000, so the map needs an isolated stacking context or it
    paints over the header.
  - react-leaflet 4 `MapContainer` forwards only className/id/style, not aria-*.
  - Vite pre-bundles on first discovery; without `optimizeDeps.include` the first map open would re-optimise and **reload the
    page** (losing the dev spot).
- Touched:
  - `web/package.json`/lock, `web/vite.config.ts`, `web/eslint.config.js`
  - `web/src/vite-env.d.ts`, `config.ts`, `main.tsx`, `App.tsx`, `pages/Chat.tsx`, `components/MessageList.tsx`, `ui/text.ts`
  - `web/src/geo/{geohash.ts,useArea.ts,DevLocationPicker.tsx,devLocationText.ts}`; new `web/src/geo/{DevMap.tsx,DevMapBoundary.tsx}`
  - `.env.example`, README, ARCHITECTURE, DECISIONS, ROADMAP; tests

## Dependencies (decided)
| Package | Exact pin | Section | License | Why |
|---|---|---|---|---|
| leaflet | 1.9.4 (npm latest; 2.0 alpha/beta only) | dependencies | BSD-2-Clause | map engine (ADR-003) |
| react-leaflet | 4.2.1 | dependencies | Hippocratic-2.1 | peers react ^18 / react-dom ^18 / leaflet ^1.9; 5.0 needs React 19 (ruled out by ADR-008); own types; sideEffects:false |
| @react-leaflet/core | 2.1.0 (transitive) | — | Hippocratic-2.1 | same peers |
| @types/leaflet | 1.9.22 (tag ts5.9/latest) | devDependencies | MIT | needed: leaflet 1.9.4 ships no types, react-leaflet's .d.ts import from 'leaflet' (otherwise `any` → no-unsafe-* lint fails) |
| @types/geojson | 7946.0.16 (transitive) | — | MIT | dependency of @types/leaflet |

- Install: `npm install --save-exact leaflet@1.9.4 react-leaflet@4.2.1` and `npm install --save-exact -D @types/leaflet@1.9.22`.
- They go in dependencies because they're runtime browser code and ADR-003's future product map will use them. Keeping them out of production is enforced by the DEV guard and the dist grep.
- Vite 7.3.8 pre-bundles the UMD leaflet with esbuild, so no plugin is needed. TS 5.9.3 matches @types/leaflet's ts5.9.
- Licenses:
  - BSD-2 and MIT are fine.
  - Hippocratic-2.1 is "ethical source", **not OSI-approved**. Fine for a portfolio; state it in the ADR (some employers disallow non-OSI). Mitigated because nothing from react-leaflet ships in production.
  - OSM tiles/data are ODbL / CC BY-SA, so attribution is required.
- No other new deps (no leaflet-defaulticon-compatibility, no marker images, no geohash lib).

## Steps
1. **Deps:** package.json/lock per the table. The lockfile diff touches only those five packages. `npm ls leaflet react-leaflet @react-leaflet/core @types/leaflet` shows exact versions with no peer warnings.
2. **`web/vite.config.ts`:** add `optimizeDeps: { include: ['leaflet', 'react-leaflet'] }` with the comment "pre-bundle at server start so opening the map doesn't trigger a re-optimise reload, which would lose the dev spot". Dev server only. Don't touch envDir/envPrefix/the strophe shim.
3. **`web/src/geo/geohash.ts`:** add two pure functions (Interfaces), neither of which throws.
   - `decodeGeohashBounds`: lowercase base32 only, length 1..12 (reject '', uppercase, a/i/l/o, 13 chars). Inverts the encoder's bit order, longitude first.
   - `wrapLng`: values in [-180,180] unchanged; other finite values wrap into [-180,180); non-finite returned unchanged (so cellFor rejects them).
   - Neither is exported from geo/index.ts.
4. **`web/src/geo/useArea.ts`:** `DevOverride` gains `readonly cell: Cell | null`. In the `dev` useMemo return `{ active: devCell !== null, cell: devCell, set, clear }` with devCell in the deps (devCell keeps its identity for a same-cell set, so the memo is stable). Update the test fakes of DevOverride.
5. **`web/src/geo/DevLocationPicker.tsx`:**
   - New REQUIRED prop `mapTileUrl: string | null` (update existing tests).
   - Module-level lazy component, EXACTLY this guard:
     ```ts
     // Dev only. The literal guard folds to `null` in production builds, so Rollup drops the dynamic import and
     // emits no map chunk (a bare top-level lazy() call is not provably pure and would keep it).
     const DevMap = import.meta.env.DEV
       ? lazy(() => import('./DevMap').then((m) => ({ default: m.DevMap })))
       : null;
     ```
   - Track the disclosure: `const [open, setOpen] = useState(false)` + `onToggle={(e) => { setOpen(e.currentTarget.open); }}` on `<details>`.
     The map **mounts only while open** and unmounts on close, so no chunk load or tile requests until a developer opens the panel, and
     Leaflet never initialises in a zero-size hidden container.
   - Placement: LAST in the panel, after "Use my real location" (the keyboard path never tabs through map controls).
     - `mapTileUrl === null` → `<p className="m-0 text-sm text-ink-muted">{DEV_MAP_TEXT.noTiles}</p>`, no map.
     - else if `DevMap !== null && open` → `<DevMapBoundary><Suspense fallback={<p role="status" …>{DEV_MAP_TEXT.loading}</p>}><DevMap tileUrl={mapTileUrl} cell={override.cell} onPick={pick} /></Suspense></DevMapBoundary>`.
   - `pick(point)` behaves exactly like a preset: `if (apply(point)) { setLat(''); setLng(''); }` (goes through override.set and clears any old invalid alert).
6. **`web/src/config.ts` + `web/src/main.tsx` + `web/src/vite-env.d.ts`:**
   - `AppConfig` gains `mapTileUrl: string | null`. parseConfig validates `VITE_MAP_TILE_URL` (rules below): unset/empty → null, no error; invalid → exactly
     `'VITE_MAP_TILE_URL must be an http(s) URL template with {z}, {x} and {y}'` (names the variable, never echoes the value). Invalid shows the
     existing ConfigError screen in dev (fail-fast like the other vars).
   - `main.tsx` must STOP passing the whole env object. Pass explicit keys:
     ```ts
     const result = parseConfig({
       VITE_XMPP_WS_URL: import.meta.env.VITE_XMPP_WS_URL,
       VITE_XMPP_DOMAIN: import.meta.env.VITE_XMPP_DOMAIN,
       VITE_XMPP_MUC_DOMAIN: import.meta.env.VITE_XMPP_MUC_DOMAIN,
       // Dev only: the literal DEV guard folds to undefined in production builds, so the tile URL never ships.
       VITE_MAP_TILE_URL: import.meta.env.DEV ? import.meta.env.VITE_MAP_TILE_URL : undefined,
     });
     ```
     then `<App … mapTileUrl={config.mapTileUrl} />`.
   - `vite-env.d.ts`: `readonly VITE_MAP_TILE_URL?: string;`.
   - The validator's own strings (the error text, `{z}`) still ship; they're config validation, not map code, and are excluded from the dist grep on purpose.
7. **`web/src/App.tsx` → `web/src/pages/Chat.tsx`:** thread `mapTileUrl: string | null` as a prop; render `{import.meta.env.DEV && <DevLocationPicker override={area.dev} mapTileUrl={mapTileUrl} />}`.
8. **`web/src/geo/DevMap.tsx` (new; the ONLY file allowed to import react-leaflet or leaflet):**
   - `import 'leaflet/dist/leaflet.css';` at the top of THIS file only (never index.css or main.tsx), so Vite attaches the CSS to the lazy chunk.
     Runtime imports come from `react-leaflet` only; `import type` from 'leaflet' is allowed. No runtime `'leaflet'` import (jsdom never loads Leaflet).
   - Wrapper: `<figure className="m-0 grid gap-2">` with `<figcaption id={hintId} className="text-sm text-ink-muted">{DEV_MAP_TEXT.hint}</figcaption>`, and
     around the map `<div className="isolate overflow-hidden rounded-lg border border-line">` (`isolate` gives its own stacking context → fixes the sticky-header overlap).
   - `<MapContainer>`:
     - `center` = the centre of `decodeGeohashBounds(cell.geohash)` if a cell is set, else `DEV_PRESETS[0].point` (preset A). **Never the device location.**
     - `zoom={16}`, `minZoom={3}`, `maxZoom={19}`
     - `scrollWheelZoom={false}` (a wheel scrolls the page; zoom via +/- or the keyboard)
     - `keyboard` default (true)
     - `className="h-48 w-full md:h-56"`
   - `<TileLayer url={tileUrl} attribution={DEV_MAP_TEXT.attribution} maxZoom={19} />`. Do NOT set `referrerPolicy: 'no-referrer'` (OSM needs a Referer).
   - `<Rectangle>` only when `cell !== null`:
     - `bounds={[[south, west], [north, east]]}` from decodeGeohashBounds
     - `pathOptions={{ className: 'stroke-accent fill-accent', weight: 2, fillOpacity: 0.15 }}` (CSS classes override SVG presentation attributes, so the token colour applies)
     - `accent` is used in both colour modes because tiles stay light (`accent-ink` turns light teal in dark mode and vanishes on light tiles)
     - **No CircleMarker, Marker or icon images; the device cell is never drawn.**
   - Inner `MapBehaviour` (useMap/useMapEvents):
     - `click(e)` → `onPick({ lat: e.latlng.lat, lng: wrapLng(e.latlng.lng) })`; nothing stored
     - effect on `[map, geohash]`: if the cell bounds aren't inside `map.getBounds()`, `map.setView(centre, map.getZoom())` (follows presets or keyboard spots off-screen, e.g. spot C)
     - effect on `[map, hintId]`: set `role="region"`, `aria-label={DEV_MAP_TEXT.label}`, `aria-describedby={hintId}` on `map.getContainer()`
   - Rules: NO `useState`, NO `useRef` (the map keeps no point in React state); NO `map.locate`/`locationfound`; no console.
   - Props: `{ tileUrl: string; cell: Cell | null; onPick: (point: GeoPoint) => void }`.
9. **`web/src/geo/DevMapBoundary.tsx` (new):** a minimal (~15 line) class error boundary; fallback `<p role="status" className="m-0 text-sm text-ink-muted">{DEV_MAP_TEXT.failed}</p>`.
   A failed chunk or a Leaflet error must never take down the chat. No logging. Imported only by DevLocationPicker (tree-shakes the same way).
10. **`web/src/geo/devLocationText.ts`:** add `DEV_MAP_TEXT` (exact strings below); it stays in geo/ per ADR-013 §6.
11. **`web/eslint.config.js`:**
    - add `const LEAFLET = { group: ['leaflet','leaflet/*','react-leaflet','react-leaflet/*','@react-leaflet/*'], message: 'Only src/geo/DevMap.tsx may import Leaflet: it is lazy-loaded in dev only and must never reach a production bundle.' }`
    - add it to the base block, `src/xmpp/**`, `src/geo/**` and `src/xmpp/strophe/**`
    - new block AFTER the geo block: `{ files: ['src/geo/DevMap.tsx'], rules: { 'no-restricted-imports': restrict(STROPHE) } }` (no-console stays inherited from the geo block)
    - tests keep `restrict(STROPHE)`, so they may mock react-leaflet
12. **`.env.example`** (web-client block):
    ```
    # Dev only: map tiles for the "Test locations (dev)" map. Empty = no map (the test spots and fields still work).
    # An http(s) URL template with {z}, {x} and {y} (optional {s} subdomain, {r} retina). Never included in production builds.
    # Privacy: each tile request tells the tile server (and its logs) which area you are viewing, plus your IP.
    # OpenStreetMap tile policy (https://operations.osmfoundation.org/policies/tiles/): keep the on-map attribution,
    # light interactive use only, no bulk or offline downloading. Browsers send a Referer, which the policy requires.
    VITE_MAP_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
    ```
    **Attribution is not configurable (decided):** Leaflet renders attribution as HTML (innerHTML), so an env-supplied value would be an injection path. Anyone switching providers edits `DEV_MAP_TEXT.attribution` (say so in the ADR).
13. **Fold-in A (Chat.tsx desiredRoomJid):** remove the useMemo and compute `desiredRoomJid` directly, with the comment "a string: useAreaRoom's effect deps compare it by value, so it is stable per cell". Keying the memo on cell?.geohash while reading cell would fail exhaustive-deps, and building a Cell outside geo/ is worse. Drop the unused useMemo import.
14. **Fold-in B ("Join again" out of the status paragraph):**
    - Wrap in `<div className="flex flex-wrap items-center gap-x-2 gap-y-1">`: `<p ref={statusRef} tabIndex={-1} role="status" className="m-0 text-sm text-ink-muted">{statusLine}</p>` + the button as a sibling.
    - If the button had focus when it unmounts (retry → joining), focus the status paragraph with `focus({preventScroll:true})`, using the same onFocus/onBlur `isConnected` + `useLayoutEffect` pattern as MessageList's Load-earlier button.
    - Update tests that find the button inside the status region.
15. **Fold-in C (MessageList.tsx):** render the empty `<li>` only when `rows.length === 0 && emptyText !== ''`.
16. **Fold-in D (ui/text.ts):** add `AREA_TEXT.left: 'You left the room'` (existing string, unchanged) and use it in Chat.tsx.
17. **Docs:**
    - `docs/DECISIONS.md`: append **ADR-014 "Dev-only Leaflet map picker"**. Cover:
      - deps, pins and licenses (with the Hippocratic note); why @types/leaflet is needed
      - the lazy + DEV-only mechanism: the ternary guard, CSS in the lazy module, mount on open, explicit env keys in main.tsx, the ESLint LEAFLET guard, the dist grep
      - the cell rectangle instead of a point marker; centring on the dev cell or preset A, never the device
      - tile privacy and the OSM policy; attribution fixed in code
      - the accessibility model (the keyboard picker is the accessible path)
      - `optimizeDeps`
      - the dropped fold-in useMemo
      - leave a "Live evidence" heading for the orchestrator
    - `docs/ARCHITECTURE.md` geo tree: `DevMap.tsx` (dev only, lazy, the only Leaflet importer, shows the cell not the point), `DevMapBoundary.tsx`, decodeGeohashBounds/wrapLng in geohash.ts.
    - `README.md`:
      - a paragraph on `VITE_MAP_TILE_URL` (optional, dev only, OSM default and attribution, tile privacy; copy the line from .env.example if your .env predates this)
      - demo step 5: "or click the map"
    - `docs/ROADMAP.md`: update the 2c note to say 2c-2 is done; **tick** only after the orchestrator's live verification.
    - **Do not edit CLAUDE.md.**

## Interfaces
```ts
// geo/geohash.ts (additions)
export interface GeohashBounds { readonly south: number; readonly west: number; readonly north: number; readonly east: number }
export type GeohashBoundsResult = { ok: true; bounds: GeohashBounds } | { ok: false; error: 'invalid-geohash' };
/** Lowercase base32 '0123456789bcdefghjkmnpqrstuvwxyz', length 1..12. Never throws. */
export function decodeGeohashBounds(geohash: string): GeohashBoundsResult;
/** In [-180, 180] → unchanged; other finite values wrap into [-180, 180); non-finite → returned unchanged. */
export function wrapLng(lng: number): number;

// geo/useArea.ts (change)
export interface DevOverride {
  readonly active: boolean;
  /** The dev cell (no coordinates), or null. */
  readonly cell: Cell | null;
  set(point: GeoPoint): { ok: true } | { ok: false; error: GeohashError };
  clear(): void;
}

// geo/DevLocationPicker.tsx
export function DevLocationPicker(props: { override: DevOverride; mapTileUrl: string | null }): React.JSX.Element;

// geo/DevMap.tsx (internal; not exported from geo/index)
export function DevMap(props: { tileUrl: string; cell: Cell | null; onPick: (point: GeoPoint) => void }): React.JSX.Element;

// config.ts
export interface AppConfig { xmppWsUrl: string; xmppDomain: string; mucDomain: string; mapTileUrl: string | null }
// App.tsx
export interface AppProps { xmppDomain: string; mucDomain: string; mapTileUrl: string | null }
// pages/Chat.tsx
export function Chat(props: { mucDomain: string; mapTileUrl: string | null }): React.JSX.Element;
```
`VITE_MAP_TILE_URL` rules: trim first; empty → null. Otherwise ALL must hold, or the result is the single error string from Step 6:
- it contains `{z}`, `{x}` and `{y}`
- the only `{…}` placeholders are `{s}`, `{z}`, `{x}`, `{y}`, `{r}` (after removing those, no `{` or `}` remains)
- after substituting `{s}`→`a`, `{z}`/`{x}`/`{y}`→`0`, `{r}`→`''`, `new URL()` parses it with protocol `http:` or `https:`, a non-empty hostname, and no username or password

On success the result is the trimmed template, unchanged.

```ts
// geo/devLocationText.ts (exact)
export const DEV_MAP_TEXT = {
  label: 'Test location map',
  hint: 'Click the map to move to that area. The shaded square is the whole area, not an exact spot. Keyboard users: use the test spots and fields above (arrow keys pan the map, plus and minus zoom).',
  loading: 'Loading map…',
  failed: "The map couldn't load. Use the test spots above.",
  noTiles: 'Set VITE_MAP_TILE_URL in .env to show a map here.',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
} as const;
```
decodeGeohashBounds vectors (exact doubles, `toBe`):
| geohash | south | west | north | east |
|---|---|---|---|---|
| u4pruyd | 57.64801025390625 | 10.40679931640625 | 57.649383544921875 | 10.408172607421875 |
| u4pruye | 57.64801025390625 | 10.408172607421875 | 57.649383544921875 | 10.4095458984375 |
| gcpvj0d | 51.50665283203125 | -0.12908935546875 | 51.508026123046875 | -0.127716064453125 |
| s000000 | 0 | 0 | 0.001373291015625 | 0.001373291015625 |
| 0000000 | -90 | -180 | -89.99862670898438 | -179.99862670898438 |
| zzzzzzz | 89.99862670898438 | 179.99862670898438 | 90 | 180 |
| u | 45 | 0 | 90 | 45 |

## Tests required
- **`web/tests/geo/geohash.test.ts`** (extend):
  - every bounds vector
  - `u4pruyd.east === u4pruye.west`
  - round trip: for every encode vector in tests/geo/vectors.ts the bounds contain the point, and encodeGeohash(centre, 7) gives the same geohash
  - rejections: '', 'U4PRUYD', 'u4pruya', 'u4prui', a 13-char string → invalid-geohash
  - wrapLng: 10→10, 180→180, -180→-180, 190→-170, -190→170, 370→10, -370→-10, 540→-180, NaN→NaN
- **`web/tests/config.test.ts`** (extend):
  - unset/''/whitespace → null, ok
  - accepted: OSM (also with spaces, trimmed); `https://{s}.tile.example.org/{z}/{x}/{y}{r}.png`; `http://localhost:8080/tiles/{z}/{x}/{y}.png`
  - rejected, each with exactly the one error: missing {y}; `ftp://h/{z}/{x}/{y}`; `javascript:{z}{x}{y}`; relative `/{z}/{x}/{y}.png`; `not a url {z}/{x}/{y}`; `{apikey}`; credentials `https://u:p@h/{z}/{x}/{y}.png`
  - a value with `SECRET123` never appears in any error
  - combined errors keep their order; existing cases unchanged
- **`web/tests/helpers/fakeReactLeaflet.tsx`** (new), a factory for `vi.mock('react-leaflet', …)`:
  - MapContainer renders a div (data attrs for center/zoom) + children
  - TileLayer records url/attribution
  - Rectangle records bounds/pathOptions
  - useMapEvents captures handlers (call `click({latlng:{lat,lng}})`)
  - useMap returns a fake map: `getContainer()` a real div, `getBounds()` → `{contains: vi.fn()}` (controllable), `setView: vi.fn()`, `getZoom: () => 16`
- **`web/tests/geo/DevMap.test.tsx`** (new, mocked):
  - initial centre is the dev cell's bounds centre when set, else preset A; zoom 16; scrollWheelZoom false
  - no Rectangle when the cell is null
  - the Rectangle's bounds equal decodeGeohashBounds(cell) exactly, with className containing `stroke-accent`
  - **a click calls onPick with the clicked lat and wrapped lng**: 370.4087 → 10.4087 (float tolerance)
  - an effect sets role region + label + aria-describedby on the container; the figcaption has the hint
  - attribution === DEV_MAP_TEXT.attribution
  - a cell change with contains→false calls setView once with the new centre; with contains→true it doesn't
- **`web/tests/geo/DevLocationPicker.test.tsx`** (extend; mock `../../src/geo/DevMap` with a factory setting a module-level `imported = true` and rendering a stub exposing onPick and cell):
  - **Lazy gate:**
    - mapTileUrl=null + opened (set `details.open = true`, fire `toggle`) → the noTiles text shows and imported stays false
    - URL + closed → imported false
    - open → loading text, then the stub; close → the stub unmounts
  - **Click to cell (real useArea harness):**
    - stub onPick({lat:57.64911,lng:10.4087}) → `located`, `u4pruye`, `dev-pin`
    - `JSON.stringify(state)` has no `57.649` or `10.408`
    - the stub then gets cell.geohash 'u4pruye'
    - typed fields are cleared
  - **Prod gate:** `vi.stubEnv('DEV', false)` + `vi.resetModules()`, dynamically import the picker, open with a URL → imported stays false and no loading text; `vi.unstubAllEnvs()`. If Vitest 3.2.4 can't stub DEV, say so (the build grep AC is authoritative).
  - **Boundary:** a throwing mocked DevMap → DEV_MAP_TEXT.failed, and the presets still work (silence the expected console.error with a spy in that test only).
  - Existing cases updated for the new prop; none removed.
- **`web/tests/geo/useArea.test.tsx`:** `dev.cell` is null initially, equals the cell after set, keeps the same ref on a same-cell set, and is null after clear.
- **`web/tests/ui/text.test.ts`:** DEV_MAP_TEXT (excluding attribution and noTiles) has none of /geohash|jid|muc|cell|coordinate/i; `AREA_TEXT.left` exists.
- **Fold-ins:**
  - A: a re-render with a new-but-equal AreaState sends no stanzas.
  - B: a failed join shows "Join again" OUTSIDE role=status (`within(status).queryByRole('button')` null); clicking sends exactly one join; `document.activeElement` becomes the status paragraph once the button is gone.
  - C: `emptyText=""` with no items → the log has zero listitems; a non-empty emptyText still renders.
  - D: after a self-leave the status line reads AREA_TEXT.left.
- **Totals:** ≥ 696 + new, no net loss; report before/after counts.

## Acceptance criteria
- AC1 (deps):
  - exact pins: leaflet 1.9.4 and react-leaflet 4.2.1 in dependencies; @types/leaflet 1.9.22 in devDependencies
  - `npm ci` and `npm ls leaflet react-leaflet @react-leaflet/core @types/leaflet` clean with no peer warnings
  - the lockfile adds only those plus @react-leaflet/core 2.1.0 and @types/geojson
- AC2 (map works in dev): with VITE_MAP_TILE_URL set, opening the panel lazy-loads the map. A click sets a dev spot for that cell, and the area/room switch via the existing controller (exactly one leave + one join; a same-cell click sends no stanzas). Off-screen spots recentre the map.
- AC3 (cell, not point): only the dev cell rectangle (from decodeGeohashBounds) is drawn; no marker, point or device cell.
  `grep -nE "useState|useRef|locate\(|locationfound|CircleMarker|Marker\b" web/src/geo/DevMap.tsx` returns nothing. The initial centre is the dev cell or preset A, never the device.
- AC4 (PRIVACY, blocking): the 2c-1 AC8 greps stay empty:
  - `grep -rnE "\b(lat|lng|latitude|longitude|coords)\b" web/src --include=*.ts --include=*.tsx | grep -v "^web/src/geo/"`
  - `grep -rnE "console\.|localStorage|sessionStorage|indexedDB|history\.|location\.(hash|search|href)|fetch\(" web/src/geo`
  - The DevLocationPicker click-to-cell test shows no coordinates in AreaState.
- AC5 (ESLint guard): temporarily add `import 'leaflet';` to src/pages/Chat.tsx, then to src/geo/DevLocationPicker.tsx → lint fails with the LEAFLET message both times; report it and revert. src/geo/DevMap.tsx lints clean.
- AC6 (prod bundle has no map):
  - **Baseline first:** at d50b137 before any change, `cd web && npm run build` and record `ls -l dist/assets` (the current dist is stale).
  - After: `VITE_MAP_TILE_URL='https://tile.openstreetmap.org/{z}/{x}/{y}.png' npm run build` (set it so the check isn't vacuous; the shell env overrides .env).
  - `grep -rliE "leaflet|openstreetmap|L\.map|Loading map|Test location map|show a map here|Test locations|Test spot A" web/dist` returns nothing.
  - dist/assets has the same file count as the baseline (one JS, one CSS).
  - JS ≤ baseline + 1.5 KB and CSS ≤ baseline + 0.5 KB raw bytes; report the exact numbers and deltas.
- AC7 (config): the rules behave as specified. Unset → no map, the noTiles hint, presets and fields still work. Errors name only the variable.
- AC8 (a11y):
  - the map is optional (closed panel, last in tab order)
  - the container has role region, label "Test location map" and aria-describedby → the hint
  - no focus trap; arrow keys pan and +/- zoom when focused
  - the presets and fields stay a complete keyboard alternative
  - loading and failure are role=status text
- AC9 (tokens/layout):
  - only token classes; no raw palette and no `.leaflet-*` overrides in index.css
  - map h-48 / md:h-56, full width
  - at 360×640 no horizontal overflow with the panel open; at 1280×800 with the panel open the page still doesn't scroll
  - the map never paints over the sticky header
  - in dark mode tiles stay light and the frame uses tokens [manual visual]
- AC10 (fold-ins): A–D as specified, each a separate reviewable hunk with its test.
- AC11: typecheck, lint and test clean; the 696 existing tests pass (updated in place only where props/structure changed); counts reported.
- AC12 (docs): ADR-014 appended; ARCHITECTURE geo tree, README (VITE_MAP_TILE_URL + demo step) and .env.example updated; ROADMAP note updated (tick only after AC13); CLAUDE.md untouched.
- AC13 [manual, live, orchestrator]:
  - the map renders OSM tiles with the attribution visible
  - click a spot → that cell's room joined, the rectangle covers the cell, the "Test spot" badge shows
  - click the neighbouring cell → the room switches (exactly one unavailable + one join)
  - preset C → the map recentres on London
  - a second user (tab or raw-XMPP probe) in the same cell chats; bob clicks the neighbour → alice sees "bob left"
  - WS frames: no lat/lng/latitude/longitude/coord; any `-?\d{1,3}\.\d{4,}` match must be a timestamp fraction only
  - no "Map container is already initialized" under StrictMode; no page reload on first map open
  - the AC6 prod grep result; 360 px with the panel open
  - the pane flips visibility every ~6 s (lifecycle/liveness-probe noise)

## Risks / watch-outs
- **Tree-shaking is fragile:**
  - lazy() only behind the literal `import.meta.env.DEV ?` ternary (not `if (import.meta.env.DEV)` around a let, not hoisted into a helper)
  - the CSS import only in DevMap.tsx
  - never add `.leaflet-*` rules or arbitrary variants (`[&_.leaflet-control]`) anywhere: Tailwind scans all sources and those would ship
  - AC6 is the check; if something survives, fix the import structure, not the grep
- **Env inlining:** never pass the whole import.meta.env to parseConfig again.
- **Privacy:**
  - the click point exists only in the Leaflet event → onPick → override.set → Cell
  - no useState/useRef in DevMap; no map.locate; don't draw the device cell
  - tile requests reveal the viewed area + IP (dev only; restate in ADR-014)
  - mount on open means no tile requests until asked
- **OSM policy:** visible attribution; no `referrerPolicy:'no-referrer'`; no prefetch (default keepBuffer); no offline caching.
- **react-leaflet 4 + StrictMode/HMR:** MapContainer creates the map in a ref callback; verify there's no "already initialized" error live. Unmount on close cleans up.
- **Tailwind preflight vs Leaflet:** Leaflet 1.9 CSS resets max-width with !important, and unlayered CSS beats Tailwind v4 layered preflight. Still check visually for tile gaps.
- **`<details>` in jsdom:** set `.open` and dispatch `toggle` in tests.
- **Antimeridian:** a world-wrapped click lng must go through wrapLng, or cellFor rejects it silently.
- **Hippocratic license:** not OSI-approved; acceptable, stated in the ADR.
- **Layout:** the open panel plus a 14rem map squeezes the md+ chat card. Acceptable; don't make the panel a second scroll container.

## Out of scope
- A product map (RoomMap/Map page/heat view), neighbour cells, a crosshair or "Enter picks the centre", map.locate, marker icons.
- A configurable attribution, multiple providers, a tile proxy.
- Any change to xmpp/, state/useAreaRoom.ts, infra/, MongooseIM or CLAUDE.md.
- Other string moves into ui/text.ts beyond "You left the room".
- Hysteresis/auto-switching (Phase 4), geo_service (Phase 3).
- Any dependency beyond the five packages above.
