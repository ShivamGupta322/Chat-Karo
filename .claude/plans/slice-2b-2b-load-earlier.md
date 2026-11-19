# Plan: Phase 2 slice 2b-2b — "Load earlier messages"

Status: PLANNED by the supervisor on 2026-11-18. Builds on 2b-2a (HEAD 12eb368). The ADR is a new **ADR-012**.

## Goal
A joined user can page backwards through the room's last 24 h, 50 messages per click, using a "Load earlier messages" button at the
top of the message list. Older pages are inserted above what is shown, the scroll position doesn't jump, nothing is
duplicated, and the button goes away once the 24 h window (or the 500-item timeline cap) is reached. The ADR-011 anti-spoof, throttle and
one-query-per-room rules are unchanged.

## Context
- ADRs:
  - ADR-004: 24 h window.
  - ADR-008: transport seam, Strophe stays in the adapter.
  - ADR-009: text in `ui/text.ts`, tokens only, no jargon.
  - ADR-010: suspend/rejoin.
  - ADR-011: MAM semantics, the `insertAt` anchor, the ≥ 1100 ms global throttle, one query per room, anti-spoof, initialDone, manual retry.
- Touched:
  - `web/src/xmpp/{mam.ts,types.ts,client.ts}`
  - `web/src/state/room.ts`, `web/src/ui/text.ts`
  - `web/src/components/MessageList.tsx`, new `web/src/components/scrollAnchor.ts`
  - `web/src/pages/Chat.tsx`
  - tests, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`

## Decisions (go into ADR-012)
1. **Where earlier pages go: just above an anchor message, not always index 0.** An earlier page is inserted directly before the timeline
   message whose id is the query's `<before>` anchor (the client's `firstId`), or at index 0 if that message isn't present.
   - In the normal case this is index 0.
   - It also stays correct for Leave → Join of the same room: the store keeps the old timeline and appends the new initial page at the end,
     so gap messages fetched via "Load earlier" must land between the old session and the new initial page.
   - `insertAt` moves up by the inserted count whenever the insertion index ≤ `insertAt` (always true: the anchor is a history message below `insertAt`).
2. **firstId lifecycle (client, `TrackedRoom.firstId`).** firstId is the `<before>` cursor.
   - Set by an initial load **only while null**, to `fin.first ?? buffer[0]?.id ?? null`.
   - Replaced by each earlier page with that page's first id.
   - Set to `null` when an earlier page reports complete, or on `item-not-found`.
   - Survives suspend/rejoin (like `lastSeenId`). Never touched by gap pages or live messages.
   - Why "only while null": in the gap → `item-not-found` → initial fallback, the fallback page lands below the pre-drop messages. Moving firstId to it would
     insert older pages below the pre-drop messages, out of order.
3. **Earlier pages never change `lastSeenId`, `liveSinceHistory` or `initialDone`.** Today `client.ts:473-474` sets `lastSeenId` from any
   page's last item. For an earlier page that would make the next reconnect catch-up start from an old id. Limit it to initial/gap. Regression test.
4. **`item-not-found` on `<before>firstId</before>` means "nothing earlier", not a failure.** Set `firstId = null` and emit
   `history-loaded {earlier, messages: [], done: true, complete: true}`.
   - The anchor only disappears when purged or older than the window, and then nothing older is left in the window.
   - The same rule covers a long session whose oldest loaded message has aged past 24 h.
   - Other conditions (timeout, resource-constraint, service-unavailable, …) → `history-failed {earlier}`.
5. **When the window is complete:** `complete = fin.complete || buffer.length === 0 || nextFirst === null`, for earlier **and** initial pages.
   - For initial pages this is a small change: an empty initial page with `complete='false'` now reports `complete: true`.
   - This keeps `canLoadEarlier` consistent with `firstId !== null`.
6. **Retry: the button retries itself.**
   - Earlier failures do **not** set `history.failed` (that flag drives the "Couldn't load recent messages." banner and `retryHistory`, which stay
     for initial/gap only).
   - The store tracks `history.earlier: 'idle' | 'loading' | 'failed'` separately.
   - On failure the button reads "Try again", described by the error text; clicking it calls `loadEarlier` again with the same firstId.
   - Never an auto-retry.
7. **Cap rule (MAX_TIMELINE = 500).**
   - An earlier page is **never** trimmed from either end. It is inserted only up to the free space (`500 − timeline.length`), keeping the
     **newest** part of the page (next to the anchor, so the timeline stays contiguous); the older remainder is dropped.
   - When anything is dropped, or the length reaches 500, `canLoadEarlier` becomes false.
   - Reducer invariant: `canLoadEarlier ⇒ timeline.length < MAX_TIMELINE`. Once the timeline reaches 500 (from earlier pages, live front-trim or gap
     inserts), "Load earlier" is withdrawn for that room session. Live/gap front-trim behaviour is unchanged.
   - Exact boundary: length 499 + a 50-message page → 1 inserted (the newest of the page), and the button disappears.
8. **When the button shows:** only when `joined && canLoadEarlier && !history.loading && !history.failed`. The client rejects `loadEarlier` while
   an initial/gap query is queued or in flight (one per room), so hiding the button avoids clicks that do nothing. It also keeps "Try again" (recent) and the earlier
   button from ever showing together.
9. **Divider: unchanged.** Earlier messages are `isHistory: true` and inserted above, so the last history message and the divider after it stay put. Pin with a test.
10. **Layout and a11y: the button sits in the scroll container but outside `role="log"`.**
    - MessageList gets a scrolling wrapper `<div>`. Inside it: the earlier block (button + a `role="status"` line), then the
      `<ol role="log">`, which no longer scrolls itself.
    - Conventional "scroll up to find it" UX; label changes don't happen inside the polite live log; the log's children stay messages only.
11. **Scroll preservation: keep the old first row in place, not a scrollHeight delta.**
    - Strophe can deliver an earlier page and a live message in one task, and React batches them into one render, so a scrollHeight delta would also include the appended height.
    - Snapshot the first row's key and `offsetTop`. After a render where an earlier load just finished and the old first row is no longer first, add
      (new offsetTop − old offsetTop) to `scrollTop`.
    - This takes priority over stick-to-bottom only for that render. It also absorbs the earlier block's own height change (e.g. the button
      disappearing at complete).

## Steps
1. `web/src/xmpp/mam.ts`:
   - `MamQuery.page` becomes `{ before: true } | { before: string } | { after: string }`.
   - `buildMamQuery` writes `<before>{id}</before>` (escaped by `xmlEl`) for a string, and an empty `<before/>` for `true`.
   - Update the "2b-2b adds" comment. Nothing else changes.
2. `web/src/xmpp/types.ts`:
   - `HistoryDirection` gains `'earlier'` (doc comment updated).
   - Split `history-loaded` into two members (Interfaces) so the earlier one carries `anchorId`.
   - `XmppClient` gains `loadEarlier(roomJid)`.
3. `web/src/xmpp/client.ts`:
   - (a) `TrackedRoom` gains `firstId: string | null` (doc comment = decision 2), initialised to `null` in `joinRoom`.
   - (b) An internal cursor type: `schedulePage(room, cursor, page)` / `sendPage(room, cursor, page)` take it instead of `(direction, after)`.
     RSM mapping: initial → `{before: true}`, gap → `{after}`, earlier → `{before}`. The throttle code in `schedulePage` and the queued placeholder (`queryId: ''`) are unchanged.
   - (c) `startHistory` and the `item-not-found` gap fallback build the right cursors; their behaviour is unchanged.
   - (d) `loadEarlier(roomJid)`:
     - Return (no event) unless all hold: `state.status === 'connected'`, the room exists, `room.state === 'joined'`, `room.initialDone`,
       `room.firstId !== null`, `room.mam === null`, `room.mamTimer === null`.
     - Then emit `history-loading {earlier}` and `schedulePage(room, {direction:'earlier', before: room.firstId}, 1)`.
     - Do **not** reset `liveSinceHistory`.
   - (e) In `sendPage` `.then` (the existing stale guard first):
     - **earlier:**
       - `!res.ok && condition === 'item-not-found'` → `firstId = null`; emit loaded `{earlier, anchorId: cursor.before, messages: [], done: true, complete: true}`.
       - Other `!res.ok` → `failHistory(room, 'earlier', condition)`. Fin-less → `'bad-response'`.
       - Otherwise `nextFirst = fin.first ?? buffer[0]?.id ?? null`, `complete` per decision 5, `firstId = complete ? null : nextFirst`; emit
         loaded `{earlier, anchorId, messages, done: true, complete}`.
       - Return **before** the lastSeenId line.
     - **initial:** compute `nextFirst` the same way; `if (room.firstId === null) room.firstId = nextFirst`; emit `complete: fin.complete ||
       buffer.length === 0 || nextFirst === null`.
     - **gap:** unchanged.
     - Move the `lastSeenId` update (`:473-474`) so it runs only for initial/gap.
   - (f) `handleMessage`, `cancelHistory`, `suspendRooms`, `untrack`, `terminate`: no change. Confirm with tests that they also cancel earlier queries.
   - (g) No `console.*` in the new paths.
4. `web/src/state/room.ts`:
   - (a) `RoomHistory` gains `earlier: 'idle' | 'loading' | 'failed'`; `initialHistory.earlier = 'idle'`.
   - (b) Export the pure `mergeEarlier` (Interfaces).
   - (c) Internal `withEarlierCap(history, timeline)`: returns `history` (same ref) unless `canLoadEarlier && timeline.length >= MAX_TIMELINE`,
     then `canLoadEarlier: false`. Apply it on every path that changes the timeline: `append`, the initial/gap `history-loaded` branch, and the earlier branch.
   - (d) `history-loading`: `direction === 'earlier'` → `earlier: 'loading'` only (same ref if already loading); don't touch `loading`/`failed`. Other
     directions as today.
   - (e) `history-failed {earlier}` → `earlier: 'failed'` only.
   - (f) `history-loaded {earlier}` → `mergeEarlier(timeline, insertAt, anchorId, messages)`; `earlier: 'idle'`; `canLoadEarlier = !complete &&
     !truncated && newLength < MAX_TIMELINE`. Same ref when nothing changed.
   - (g) Initial done → `canLoadEarlier = !complete && timeline.length < MAX_TIMELINE`.
   - (h) Reset `earlier` to `'idle'` on `room-joining` (same room), `room-suspended` and `room-left`. Otherwise a cancelled query leaves the button stuck on "Loading…" after a rejoin.
5. `web/src/ui/text.ts`: `HISTORY_TEXT` gains:
   - `loadEarlier: 'Load earlier messages'`
   - `loadingEarlier: 'Loading earlier messages…'`
   - `earlierFailed: "Couldn't load earlier messages."`
   - The retry label reuses `HISTORY_TEXT.retry` ("Try again").
6. `web/src/components/scrollAnchor.ts` (new, pure): `nextScrollTop` (Interfaces). No DOM access.
7. `web/src/components/MessageList.tsx`:
   - (a) **Structure:**
     - An outer `<div ref={scrollRef}>` takes over the scrolling classes from the `<ol>`
       (`relative h-[55dvh] overflow-y-auto p-3 sm:p-4 md:h-[62dvh]`; `relative` makes it the rows' offsetParent).
     - Inside it, when the `earlier` prop is non-null, the earlier block `<div className="mb-2 flex flex-col items-center gap-1">` with:
       - a `<button type="button">`, labelled idle → `loadEarlier`, loading → `loadingEarlier`, failed → `retry`. While loading: `aria-disabled="true"` (**not** `disabled`,
         so focus isn't lost) and the click is ignored. When failed: `aria-describedby` points at the status line.
       - a `<p id={useId()} role="status" className="m-0 text-xs text-ink-muted">`, always present while the block is, containing `earlierFailed` only when failed.
     - Button classes: the HistoryStatus retry-button classes plus `aria-disabled:cursor-progress aria-disabled:text-ink-muted`. No opacity.
     - Then the `<ol role="log" aria-live="polite" aria-label="Messages" tabIndex={-1}>` with `className="m-0 grid list-none content-start gap-0.5 p-0"`.
     - `aria-busy` is true when `busy || earlier?.status === 'loading'`.
   - (b) Each row `<li>` (message, system, divider) gets `data-row-key={row.key}`.
   - (c) **Scroll:**
     - Keep the `onScroll` stick logic, now on `scrollRef`.
     - Refs: `snap: {firstKey, firstTop}` and `prevEarlierLoading: boolean`.
     - The layout effect runs on `[items, earlier?.status]`:
       - find the first row by walking `listRef.current.children` (no `querySelector`: keys may contain `|`, `@`, `/`), and find the element for the previous key the same way to read its `offsetTop`
       - call `nextScrollTop`, apply a non-null result, then refresh `snap` and `prevEarlierLoading`
     - Also refresh `snap` in the button's click handler, before calling `onLoad`.
   - (d) **Focus:** a ref records whether the button has focus (`onFocus`/`onBlur`). When the block goes from present to absent while that ref is true,
     call `listRef.current.focus({ preventScroll: true })` and reset the ref.
   - (e) Props per Interfaces. Callers that omit `earlier` behave exactly as today.
8. `web/src/pages/Chat.tsx`: pass `earlier={joined && h.canLoadEarlier && !h.loading && !h.failed ? { status: h.earlier, onLoad: () =>
   { if (room.roomJid !== null) client.loadEarlier(room.roomJid); } } : null}`, where `h = room.history`. Nothing else changes.
9. `web/src/components/timelineRows.ts`: no change (test only).
10. Docs:
    - `docs/ROADMAP.md`: 2b-2b done; tick the `xmpp/` module item (connect, reconnect, join/leave, send/receive and history are all done).
    - `docs/ARCHITECTURE.md`: add `scrollAnchor.ts` if the components are listed per file.

No new dependencies (Tailwind v4's `aria-disabled:` variant is built in).

## Interfaces
```ts
// xmpp/mam.ts
export interface MamQuery {
  roomJid: string; iqId: string; queryId: string; startIso: string; max: number;
  /** before: true = newest page; before: id = page ending just before id; after: id = page starting just after id */
  page: { before: true } | { before: string } | { after: string };
}
```
```ts
// xmpp/types.ts
/** initial: newest page after a first join; gap: catching up after a reconnect; earlier: "Load earlier messages". */
export type HistoryDirection = 'initial' | 'gap' | 'earlier';
// XmppEvent: replace the single history-loaded member with
  | { type: 'history-loaded'; roomJid: string; direction: 'initial' | 'gap';
      messages: ChatMessage[]; done: boolean; complete: boolean }
  | { type: 'history-loaded'; roomJid: string; direction: 'earlier';
      /** the <before> id this page ends at; the store inserts the page just above it */
      anchorId: string; messages: ChatMessage[]; done: true; complete: boolean }
// history-loading / history-failed keep `direction: HistoryDirection` (now incl. 'earlier').
// XmppClient gains:
  /** Fetch the page before the oldest loaded history message (24 h window). No-op unless connected, joined,
   *  the initial load has completed, more history exists, and no history query is queued or in flight. */
  loadEarlier(roomJid: string): void;
```
```ts
// xmpp/client.ts (internal)
type Cursor =
  | { direction: 'initial' }
  | { direction: 'gap'; after: string }
  | { direction: 'earlier'; before: string };
function schedulePage(room: TrackedRoom, cursor: Cursor, page: number): void;
function sendPage(room: TrackedRoom, cursor: Cursor, page: number): void;
```
```ts
// state/room.ts
export interface RoomHistory {
  loading: boolean; failed: boolean; canLoadEarlier: boolean; insertAt: number;
  /** state of the "Load earlier messages" query; independent of loading/failed (recent history) */
  earlier: 'idle' | 'loading' | 'failed';
}
/** De-dupes against the timeline and within the batch. Inserts at most MAX_TIMELINE - timeline.length of the
 *  NEWEST fresh messages, in order, directly before the message with id === anchorId (index 0 if absent).
 *  Never trims. insertAt += inserted when the insertion index <= insertAt. truncated = some fresh were dropped.
 *  Same timeline reference (and insertAt) when nothing was inserted. */
export function mergeEarlier(
  timeline: TimelineItem[], insertAt: number, anchorId: string, messages: readonly ChatMessage[],
): { timeline: TimelineItem[]; insertAt: number; truncated: boolean };
```
```ts
// components/scrollAnchor.ts
export interface ScrollSnapshot { firstKey: string | null; firstTop: number }
/** Returns the scrollTop to apply after a render, or null to leave it alone.
 *  1. earlierJustLoaded && prev.firstKey !== null && firstKeyNow !== prev.firstKey && prevKeyTopNow !== null
 *       → scrollTop + (prevKeyTopNow - prev.firstTop)        // keep the old first row in place
 *  2. else stick → scrollHeight                                // existing stick-to-bottom
 *  3. else null */
export function nextScrollTop(a: {
  prev: ScrollSnapshot; firstKeyNow: string | null; prevKeyTopNow: number | null;
  earlierJustLoaded: boolean; stick: boolean; scrollTop: number; scrollHeight: number;
}): number | null;
// earlierJustLoaded = prevEarlierLoading.current && earlier?.status !== 'loading'
```
```ts
// components/MessageList.tsx
export interface MessageListProps {
  items: TimelineItem[]; emptyText: string; busy?: boolean;
  /** null/undefined = "Load earlier" not offered */
  earlier?: { status: 'idle' | 'loading' | 'failed'; onLoad: () => void } | null;
}
```
Wire example: `<set xmlns='http://jabber.org/protocol/rsm'><max>50</max><before>CO4G5LO56CG1</before></set>`.

## Tests required
- All 380 existing tests stay green. List every assertion changed in place, with the reason. Expected:
  - fake `XmppClient`s (e.g. `tests/xmpp/pageHide.test.ts`) gain `loadEarlier: vi.fn()`
  - any `complete: false` assertion on an **empty** initial page (decision 5)
  - tests relying on the `<ol>` being the scroll element
- **`tests/xmpp/mam.test.ts`:**
  - `{before: 'CO4G5LO56CG1'}` → `<before>` text in the RSM namespace, no `<after>`
  - `<before>` escapes `<&'"` and round-trips
  - `{before: true}` still empty
- **`tests/xmpp/client.test.ts` `describe('history: load earlier')`** (same `setupH`/`advance`/`finish` helpers; the fin helper gains `first`):
  - Happy path:
    - initial with 2 results and fin `complete=false first=F1` → `history-loaded {initial, complete:false}`
    - `loadEarlier(ROOM)` → `history-loading {earlier}`; one IQ with `<before>F1</before>`, start = now−24h, max 50, no `<after>`
    - results + fin `complete=false first=F2` → `history-loaded {earlier, anchorId:'F1', messages in server order, isHistory, done:true, complete:false}`
    - the next `loadEarlier` → `<before>F2</before>`
  - The final page `complete=true` → `complete:true`; a later `loadEarlier` → no IQ, no event.
  - An empty page with `complete=false` → `complete:true`.
  - fin without `<first>` but with results → the next cursor is `buffer[0].id`.
  - Guards (no IQ, no event):
    - before the initial load is done; while initial or gap is in flight or queued; while an earlier page is in flight
    - a double call → exactly one IQ
    - unknown room, suspended room, while reconnecting
    - after an initial page that was complete
  - Throttle:
    - initial sent at T0 and finished, `loadEarlier` at T0+500 → advance(599): no 2nd IQ; +1: sent
    - two rooms back to back → the second waits ≥ 1100 ms
  - Errors:
    - timeout / resource-constraint / service-unavailable → `history-failed {earlier, condition}`; fin-less → `'bad-response'`
    - no auto-retry (60 s: no IQ)
    - a second `loadEarlier` after a failure → a new IQ with the **same** `<before>F1</before>`
    - `item-not-found` → `history-loaded {earlier, messages:[], complete:true}`, then `loadEarlier` is a no-op
    - nothing throws
  - lastSeenId regression:
    - live `S1`, then an earlier page whose last id is `E50` → drop → reconnect → the gap IQ has `<after>S1</after>`, not E50
    - same without a live message → the gap uses the initial page's last id, not the earlier page's
  - firstId lifecycle:
    - survives a drop: earlier F2 loaded → drop → rejoin → gap done → `loadEarlier` uses `<before>F2</before>`
    - gap `item-not-found` → fallback initial → firstId unchanged (still F2)
    - leave + join again → a new TrackedRoom → firstId comes from the new initial page
  - Stale results:
    - earlier page in flight → drop → reconnect → the old IQ resolves → ignored
    - `leaveRoom` with an earlier page in flight or queued → no later IQ or events
    - `terminate` → timer count back to baseline
  - Anti-spoof (earlier query): wrong queryid / resourceful outer `from` / another room's `from` → excluded, no `message` event.
  - Privacy: the `console.*` spy covers the earlier tests; no call contains a body or room JID.
- **`tests/state/room.test.ts`:**
  - `mergeEarlier`:
    - inserts before the anchor; index 0 when the anchor is absent
    - Leave/rejoin-style timeline (old session, notices, new initial page with anchor X) → the page lands right before X
    - `insertAt` shifts by the inserted count
    - de-dupes against the timeline and within the batch; same ref when nothing is fresh
    - cap: 480 + 50 → 20 inserted (the last 20 of the batch, in order), `truncated: true`, length 500
    - 499 + 50 → 1 inserted; 500 + any → nothing inserted, same ref, `truncated: true`
    - never trims existing items
  - Reducer:
    - `history-loading {earlier}` sets only `earlier:'loading'` (`loading`/`failed` untouched, no banner)
    - `history-failed {earlier}` sets only `earlier:'failed'`; `history.failed` stays false
    - `history-loaded {earlier}` → `earlier:'idle'`, `canLoadEarlier = !complete`
    - truncated → false; reaching 500 exactly → false; initial done with the timeline at 500 → false
    - a live append that trims at the cap → false and `insertAt` shifted; a gap insert reaching the cap → false
    - `earlier` resets to idle on `room-suspended`, `room-joining` (same room) and `room-left`
    - other-room earlier events → same ref
    - a later live message whose id came via an earlier page is ignored
- **`tests/components/timelineRows.test.ts`:** earlier history prepended above `[history…, live…]` → exactly one divider, still directly after the
  same last history message.
- **`tests/components/scrollAnchor.test.ts` (new):**
  - prepend after an earlier load → `scrollTop + delta` (including a negative delta when the block shrank)
  - prepend after an earlier load while `stick` is true → still anchored (not bottom)
  - an append-only render while stuck → `scrollHeight`; not stuck and no earlier load → null
  - a prepend without `earlierJustLoaded` → stick or null
  - the previous key is gone → stick/null; `prev.firstKey` null → stick/null
- **`tests/components/messageList.earlier.test.tsx` (new):**
  - no prop → no button
  - idle → "Load earlier messages" button **not** inside `role="log"`; click and Tab+Enter each call `onLoad` once
  - loading → label "Loading earlier messages…", `aria-disabled="true"` not `disabled`; a click doesn't call `onLoad`; focus stays; the log has
    `aria-busy="true"`
  - failed → `role="status"` contains "Couldn't load earlier messages."; the button reads "Try again" with `aria-describedby`; a click calls `onLoad`
  - focus: focus the button, rerender with `earlier={null}` → `document.activeElement` is the log
  - rows carry `data-row-key`
  - jsdom scroll preservation:
    - stub `offsetTop` on `HTMLElement.prototype` (sibling index × 40 + 48 when the earlier block is present)
    - writable `scrollTop`/`scrollHeight` on the scroll div
    - loading → rerender with 3 prepended items and status idle → `scrollTop` grew by 120
  - no raw palette classes
- **`tests/components/components.test.tsx`:** the existing aria-busy tests still pass against the `<ol>`.
- **`tests/integration/chatFlow.test.tsx`** (real client + fake transport, `mamPageSize: 2`):
  - join → initial 2 results, fin `complete=false first=F1` → button shown
  - click → advance the throttle → IQ `<before>F1</before>` → 2 results, fin `complete=true` → 4 bubbles in order, the new ones above; button gone;
    one divider after the last history bubble
  - a later live message with one of those ids → no duplicate
  - an error IQ → "Couldn't load earlier messages." + "Try again" → a new IQ with the same `<before>`; the recent-history banner never appears

## Acceptance criteria
- AC1: when the initial page is incomplete, "Load earlier messages" shows at the top of the scrollable message area, outside `role="log"`. Hidden while joining, reconnecting,
  loading recent history, or after recent history failed.
- AC2: each click sends exactly one MAM v2 query, `<before>firstId</before>` with start = now−24 h and max 50, where firstId is the previous page's fin `<first>`.
  The page is inserted above the anchor, in order, marked as history.
- AC3: the button disappears on complete / an empty page / `item-not-found` / the timeline reaching 500. It never reappears for that room session unless a new initial load (after Leave/Join)
  is incomplete. An earlier page never trims existing messages; at the cap only the newest part that fits is inserted.
- AC4: no duplicates (de-dupe by id against the timeline and within the batch).
- AC5: the global ≥ 1100 ms throttle and the one-query-per-room guard apply. `loadEarlier` does nothing while any history query for the room is queued or in flight.
- AC6: earlier pages never change `lastSeenId`/`initialDone`; the next catch-up after a drop still starts from the newest seen id.
- AC7: stale earlier results after a drop/leave/terminate are ignored; timers cleared; the button is never stuck on "Loading…" after a rejoin.
- AC8: failures show "Couldn't load earlier messages." + "Try again", retrying the same page. The recent banner is not shown. Never an auto-retry or a throw.
- AC9: scroll position is preserved on prepend, even if a live message arrives in the same render. Stick-to-bottom still works for live messages and initial/gap loads.
- AC10: keyboard/screen reader:
  - Tab reaches the button; Enter/Space work
  - `aria-disabled` while loading, so focus stays
  - the log has `aria-busy` while loading
  - when the button disappears while focused, focus moves to the log without scrolling
- AC11: anti-spoof unchanged.
- AC12: strings in `ui/text.ts` with no jargon (no "MAM", "archive", "stanza", "page"); tokens only; the palette grep is empty.
- AC13: typecheck, lint, test and build clean; Strophe only in the adapter; no new deps; no body/JID/coordinate logging.
- AC14 (MANUAL, ≥ 120 seeded messages):
  - 3 clicks' worth of pages; each `<before>` = the previous fin `<first>`
  - consecutive MAM IQs ≥ 1.1 s apart
  - the final fin is `complete='true'` (record `first index`)
  - every seeded message renders once, in order; the button disappears after the last page
- AC15 (MANUAL): no scroll jump. The topmost message `<li>` keeps its `getBoundingClientRect().top` within ±2 px across a page load (plus screenshots). Repeat
  with bob sending a message during the load.
- AC16 (MANUAL): keyboard. Tab to the button + Enter; focus stays during loading; after the final page `document.activeElement` is the log; a rapid double-click → one IQ.
- AC17 (MANUAL): go offline during an earlier load → the button hides while reconnecting → after the rejoin the gap query runs, then the button returns; the next click continues from the same
  `<before>` with no duplicates.
- AC18 (MANUAL, probe): `<before>bogus</before>` and `<before>` + an id older than the start → record the result (expected: item-not-found or an empty complete
  set). Both end up as "nothing earlier" in the client.

## Manual verification guide (orchestrator)
- Seed with a scratchpad raw-XMPP Node script as **bob** (password from `.env`, never printed): join lobby with `maxstanzas='0'`, send 120
  groupchats `seed 001`…`seed 120` ~30 ms apart, then confirm with a MAM `<before/>` max 50 query that `<count>` ≥ 127. Run the AC18 probes from the script too.
- Then, in a visible pane as alice:
  - join lobby, scroll to the top, capture the WS frames for each IQ/fin, click 3 times
  - after each click capture `<before>` vs the previous `<first>`, the IQ timestamps, fin `complete`/`first index`, the bubble count, the top-row rect top
    before/after, and divider count = 1
  - DOM check: each `seed NNN` appears once, in ascending order
- Noise: the pane flips visibility about every 6 s, which triggers the liveness ping (at most once per 30 s). Ignore `urn:xmpp:ping` IQs.
- The seeded rows stay in the lobby's 24 h window (harmless; expire with the Phase 4 purge). Ask the user before deleting any archive rows.

## Risks / watch-outs
- **lastSeenId corruption:** the `client.ts:473-474` update must not run for earlier pages.
- **The reducer branches on direction:** otherwise an earlier load would show the "Loading recent messages…" banner and its retry.
- **MongooseIM `complete` for backward paging:** rely on `complete`, plus the empty-page and missing-first fallbacks. Record in AC14 whether the final page has
  `first index='0'`.
- **Screen readers:** prepends are additions to a polite live region and may be read once `aria-busy` clears (same as the 2b-2a initial load).
  Accepted; no aria-live toggling hacks.
- **Focus after a non-final load** stays on the button, which scroll preservation moves above the viewport. Deliberate; note it in the ADR.
- **Row regrouping:** the old first row can become a continuation and shift a few px. Acceptable.
- **A stale snapshot after a resize** is covered by the click-time snapshot. No ResizeObserver.
- **MessageList restructure:** keep `role`/`aria-*` on the `<ol>`; never put the button or status inside the `<ol>`.
- **The ADR-011 ordering edge** (initial failed, then a drop) still holds; earlier pages don't make it worse.
- **Privacy:** never log bodies, JIDs or stanzas.

## Out of scope
- Auto-load on scroll-to-top, a "start of last 24 h" marker, jump-to-latest, unread counts.
- A configurable page size; raising or virtualising the 500 cap.
- Hiding messages older than 24 h in the UI / the archive purge (Phase 4); deleting the legacy 1970 rows (needs the user's OK).
- Divider semantics; initial/gap changes beyond decision 5; HistoryStatus banner changes.
- A seeding tool in the repo; geo_service; the 2c layout.

## ADR
New **ADR-012 "Load earlier messages"**, plus "Extended by ADR-012" on ADR-011's status line. Cover decisions 1–11 and the AC14–AC18 live evidence.
