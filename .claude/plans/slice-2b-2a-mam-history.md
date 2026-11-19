# Plan: Phase 2 slice 2b-2a — Room history from MAM (initial load, reconnect catch-up, server archive fix)

Status: PLANNED by the supervisor on 2026-11-18. 2b-2 is split: **2b-2a** (this plan) and **2b-2b** "Load earlier
messages" (outline at the end).

## Goal
When you join a room, Nearby loads up to the last 50 messages from the past 24 h out of the durable MAM archive, so history
survives a MongooseIM restart. After a reconnect it fetches exactly what was missed during the outage, with no duplicates.
MUC join `<history/>` is no longer used.

## Context
- Roadmap phase 2, item "2b-2: MAM history". Resolves the "2b-2 BLOCKER" and stanza-id de-dupe carry-forwards.
- ADRs:
  - ADR-004: 24 h only.
  - ADR-008: transport seam; the MUC echo is the source of truth.
  - ADR-009: strings in `ui/text.ts`, tokens only.
  - ADR-010: rooms suspended/rejoined. **This slice supersedes ADR-010's "`historyMaxStanzas` (20) is kept on rejoin" bullet.**
- Root cause (found by the orchestrator, upstream MongooseIM 6.2.1):
  - `src/muc/mod_muc_room.erl` `broadcast_room_packet` passes `timestamp => Activity#activity.message_time` to the MAM hook.
  - `store_user_activity` does not store the activity when min_message_interval and min_presence_interval are 0 and both user shapers are `none` (our default config).
  - So `message_time = 0`, and `mod_mam_utils:generate_message_id(0)` → `mongoose_mam_id:next_unique(0)` (a NIF returning max(candidate, last+1)).
  - Result: counter-like ids that restart after each restart, 1970 stamps, empty `start` filters, and `duplicate_key` collisions that silently drop messages.
  - **Workaround (uncommitted, already in the template):** `user_message_shaper = "muc_user_msg"` in `[modules.mod_muc]` plus `[shaper.muc_user_msg] max_rate = 100_000`.
  - Verified live: new id `CO4EUIA5RT81`, a 24 h start query → `count 1` with `delay stamp='2026-11-18T15:49:25.250549Z'`, no duplicate_key.
- Touched:
  - `infra/mongooseim/mongooseim.toml.tmpl`
  - `web/src/xmpp/{client.ts,types.ts,index.ts}`, new `web/src/xmpp/mam.ts`
  - `web/src/state/room.ts`, `web/src/ui/text.ts`
  - `web/src/components/MessageList.tsx`, new `web/src/components/HistoryStatus.tsx`
  - `web/src/pages/Chat.tsx`
  - tests, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`

## Decisions (they go into ADR-011)
1. **Joins always use `maxstanzas="0"`, including rejoins.** The `historyMaxStanzas` option is removed. MAM is the only history source:
   mod_muc's in-memory history is lost on restart and would race with MAM.
2. **Synchronous MUC archive writes (`async_writer.enabled = false`).** The room process is serial, and a sync write archives each message
   before broadcasting it, so a message is either already in MAM when our join is processed or delivered live afterwards. With the async
   writer (2000 ms flush) a message sent just before a (re)join could be in neither.
3. **Timeline order is by position, not a global `sentAt` sort.**
   - Live messages get `sentAt = client now()`; MAM messages get server `<delay>`. Sorting across clocks misorders on skewed phones.
   - History batches are inserted at an anchor index (`history.insertAt`): the timeline length at the latest `room-joined`, advanced per insert.
   - Everything received live after the join stays after the history; pages arrive in server order.
4. **Catch-up pages forward, capped at 5 pages × 50.** If the cap is reached before `complete`, keep what was fetched and add the notice "Some messages from
   while you were away couldn't be loaded." No backward re-query.
5. **Errors:** `history-failed`, no auto-retry. The user retries via `retryHistory(roomJid)`.

## Steps
1. `infra/mongooseim/mongooseim.toml.tmpl`: keep the orchestrator's `user_message_shaper` + `[shaper.muc_user_msg]` change as-is. Add,
   **inside the existing `[modules.mod_mam.muc]` table, after `host`**:
   ```toml
     [modules.mod_mam.muc]
       host = "muc.@HOST@"
       # Archive room messages synchronously, before the room broadcasts them, so a message is either in MAM
       # or delivered live after a (re)join — never in neither (the async writer flushes every 2 s). ADR-011.
       async_writer.enabled = false
   ```
   This is verified against the 6.2.1 mod_mam docs (boolean, default true; the docs example shows `muc.async_writer.enabled = false`). Touch nothing else.
   (The orchestrator commits the server change separately.)
2. `web/src/xmpp/mam.ts` (new, pure, built only with `xmlEl`, no Strophe): `buildMamQuery`, `isMamResultMessage`, `parseMamResult`,
   `parseMamFin` (see Interfaces).
   - `parseMamResult` reuses `parseGroupchat` from `stanzas.ts` on the inner `<message>`.
   - `sentAt` comes from the `<forwarded>` `<delay>` only.
3. `web/src/xmpp/types.ts`: remove `historyMaxStanzas`; add the MAM options, `HistoryDirection`, the 3 history events and `retryHistory`.
4. `web/src/xmpp/client.ts`:
   - (a) Remove `historyMaxStanzas`; `sendJoin` → `buildJoinPresence(room.roomJid, room.nick, 0)`.
   - (b) `TrackedRoom` gains:
     - `lastSeenId: string | null` (survives suspend/rejoin)
     - `liveSinceHistory: boolean`
     - `mam: { queryId; direction; page; buffer: MamItem[]; startMs } | null`
     - `mamTimer: ReturnType<typeof setTimeout> | null`
   - (c) `cancelHistory(room)`: clear `mamTimer` and set `mam = null`. Call it from `suspendRooms`, `untrack` and `terminate` (every room). NOT from `clearTimer`/`markJoined`.
   - (d) `markJoined`: after emitting `room-joined`, call `startHistory(room)`.
   - (e) `startHistory(room)`:
     - return if `state.status !== 'connected' || room.state !== 'joined' || room.mam || room.mamTimer`
     - set `room.liveSinceHistory = false`
     - `direction = room.lastSeenId !== null ? 'gap' : 'initial'`
     - emit `history-loading`, then `schedulePage(room, direction, room.lastSeenId, 1)`
   - (f) `schedulePage(room, direction, after, page)`, a GLOBAL throttle (the MAM shaper is per user):
     - `const wait = Math.max(0, nextMamAt - now()); nextMamAt = now() + wait + mamMinIntervalMs;`
     - if `wait === 0`, call `sendPage` synchronously; otherwise `room.mamTimer = setTimeout(…, wait)`
   - (g) `sendPage(room, direction, after, page)`:
     - Capture `g = generation`; `queryId = newId()`; `startMs = now() - historyWindowMs`; `room.mam = {queryId, direction, page, buffer: [], startMs}`.
     - `transport.sendIQ(buildMamQuery({ roomJid, iqId: newId(), queryId, startIso: new Date(startMs).toISOString(), max: mamPageSize,
       page: after === null ? { before: true } : { after } }), mamTimeoutMs)`.
     - In `.then`: ignore unless `generation === g && rooms.get(jid) === room && room.state === 'joined' && room.mam?.queryId === queryId`. Then take the buffer and set `room.mam = null`.
     - `!res.ok`:
       - `direction === 'gap' && page === 1 && condition === 'item-not-found'` → `room.lastSeenId = null`, emit `history-loading {initial}`, `schedulePage(room, 'initial', null, 1)` (once; an initial run never falls back)
       - otherwise emit `history-failed {roomJid, direction, condition}`
     - `fin = parseMamFin(res.stanza)`; null → `history-failed {condition: 'bad-response'}`.
     - Convert the buffer to `ChatMessage` (`isHistory: true`, `isOwn: nick !== null && nick === room.nick`, `roomJid`).
     - If `!room.liveSinceHistory` and the buffer is non-empty, set `room.lastSeenId = last item id`.
     - Initial: emit `history-loaded {initial, messages, done: true, complete: fin.complete}`.
     - Gap:
       - `done = fin.complete || buffer.length === 0 || fin.last === null || page >= mamMaxGapPages`
       - emit `history-loaded {gap, messages, done, complete}`
       - if `!done`, `schedulePage(room, 'gap', fin.last, page + 1)`
     - The promise must never throw.
   - (h) `handleMessage`:
     - Once the room is resolved and BEFORE error/groupchat handling: if `isMamResultMessage(el)` → if `room.mam` exists, `parseMamResult(el, { roomJid, queryId: room.mam.queryId, notBefore: room.mam.startMs })`, push a non-null item if `buffer.length < mamPageSize`, and return. A result message never reaches `parseGroupchat`.
     - For a live groupchat with `m.stanzaId !== null`: `room.lastSeenId = m.stanzaId; room.liveSinceHistory = true`.
   - (i) `retryHistory(roomJid)`: look up the room → `startHistory` (all guards apply).
   - (j) Never `console.*` stanzas, bodies or JIDs in history paths.
5. `web/src/xmpp/index.ts`: `HistoryDirection` comes through `export * from './types'`. Do NOT export `mam.ts`.
6. `web/src/state/room.ts`:
   - Add `history: RoomHistory` (initial `{ loading: false, failed: false, canLoadEarlier: false, insertAt: 0 }`).
   - Export a pure `mergeHistory`.
   - Replace `cap()` with an anchor-aware cap: trimming `k` items from the front gives `insertAt = max(0, insertAt - k)`. Every append path (live message, notices, message-error) uses it.
   - Events:
     - `room-joining` for a new room → initial (resets history); for the same room → keep history, `loading: false`
     - `room-joined` → `history: {...history, insertAt: timeline.length, failed: false}`
     - `room-suspended` → `loading: false`
     - `history-loading` (same room) → `loading: true, failed: false`
     - `history-loaded`:
       - `mergeHistory` at `insertAt`
       - `done` → `loading: false`
       - `initial && done` → `canLoadEarlier: !complete`
       - `gap && done && !complete` → insert the notice `HISTORY_TEXT.gapTruncated` at `insertAt` and advance it
     - `history-failed` → `loading: false, failed: true`
     - any history event for another room → same reference
     - `history-loaded` with zero new messages and no flag change → same reference
   - Live `message` stays an append (with de-dupe).
7. `web/src/ui/text.ts`: add `HISTORY_TEXT` (below).
8. `web/src/components/HistoryStatus.tsx` (new):
   - null unless `loading` or `failed`
   - loading: `<p role="status">` with `HISTORY_TEXT.loading`
   - failed: `<div role="status">` with `HISTORY_TEXT.failed` and a `<button type="button">` with `HISTORY_TEXT.retry` calling `onRetry`
   - tokens only: `text-ink-muted`, `border-b border-line`, `px-3 py-2 text-sm`; button classes copied from the ConnectionBanner "Try now"
9. `web/src/components/MessageList.tsx`: optional prop `busy?: boolean` → `aria-busy={busy ? 'true' : undefined}` on the `<ol role="log">`. No other change.
10. `web/src/pages/Chat.tsx`:
    - inside `<section aria-label="Chat">`, above MessageList: `<HistoryStatus history={room.history} onRetry={() => { if (room.roomJid !== null) client.retryHistory(room.roomJid); }} />`
    - pass `busy={room.history.loading}`
    - when joined, the timeline is empty and history is loading: `emptyText = HISTORY_TEXT.emptyLoading`
11. `web/src/components/timelineRows.ts`: **no change**. The divider stays after the last history message, so after a catch-up it moves below the
    caught-up block (intended; pin it with a test).
12. Docs:
    - `docs/ROADMAP.md`: mark the 2b-2 BLOCKER resolved (root cause + workaround, one line each, pointing at ADR-011), 2b-2a done, 2b-2b next.
    - `docs/ARCHITECTURE.md`: add `mam.ts` to the web `xmpp/` module list.

No new dependencies.

## Interfaces
```ts
// xmpp/mam.ts
export const NS_MAM = 'urn:xmpp:mam:2';
export const NS_RSM = 'http://jabber.org/protocol/rsm';
export const NS_FORWARD = 'urn:xmpp:forward:0';
export interface MamQuery {
  roomJid: string; iqId: string; queryId: string; startIso: string; max: number;
  page: { before: true } | { after: string };   // 2b-2b adds { before: string }
}
/** <iq type='set' to=roomJid id=iqId><query xmlns=NS_MAM queryid=queryId>
 *    <x xmlns='jabber:x:data' type='submit'><field var='FORM_TYPE' type='hidden'><value>urn:xmpp:mam:2</value></field>
 *      <field var='start'><value>{startIso}</value></field></x>
 *    <set xmlns=NS_RSM><max>{max}</max><before/> | <after>{id}</after></set></query></iq> */
export function buildMamQuery(q: MamQuery): Element;
export interface MamItem { id: string; nick: string | null; body: string; sentAt: number }
/** true iff el is <message> with a <result xmlns=NS_MAM> child. */
export function isMamResultMessage(el: Element): boolean;
/** null unless ALL hold: outer <message> @from === expect.roomJid exactly (bare) [anti-spoof]; <result xmlns=NS_MAM>
 *  @queryid === expect.queryId and non-empty @id [anti-spoof]; <forwarded xmlns=NS_FORWARD> has <delay xmlns='urn:xmpp:delay'>
 *  with a parseable stamp >= expect.notBefore; its <message> parses via parseGroupchat and its bare from === expect.roomJid.
 *  id = result@id; nick = inner resource (null = room itself). */
export function parseMamResult(el: Element, expect: { roomJid: string; queryId: string; notBefore: number }): MamItem | null;
/** <fin xmlns=NS_MAM complete='true'|'1'?><set xmlns=NS_RSM><first index=…>…</first><last>…</last></set></fin>.
 *  null if no fin; first/last null when absent or empty. */
export function parseMamFin(iq: Element): { complete: boolean; first: string | null; last: string | null } | null;
```
```ts
// xmpp/types.ts
export type HistoryDirection = 'initial' | 'gap';
// XmppEvent gains:
  | { type: 'history-loading'; roomJid: string; direction: HistoryDirection }
  | { type: 'history-loaded'; roomJid: string; direction: HistoryDirection;
      messages: ChatMessage[]; done: boolean; complete: boolean }
  | { type: 'history-failed'; roomJid: string; direction: HistoryDirection; condition: string }
// XmppClient gains:
  /** Re-run history for a joined room after history-failed. No-op if not connected/joined or a query is queued/in flight. */
  retryHistory(roomJid: string): void;
// XmppClientOptions: REMOVE historyMaxStanzas; ADD
  mamPageSize?: number;        // default 50 (= server max_result_limit)
  mamMaxGapPages?: number;     // default 5
  mamMinIntervalMs?: number;   // default 1_100 (server mam_shaper is 1/s per user)
  mamTimeoutMs?: number;       // default 15_000
  historyWindowMs?: number;    // default 86_400_000 (ADR-004)
```
```ts
// state/room.ts
export interface RoomHistory { loading: boolean; failed: boolean; canLoadEarlier: boolean; insertAt: number }
// RoomState gains: history: RoomHistory
/** De-dupes against existing message ids AND within the batch; inserts the rest, in order, at insertAt (clamped to
 *  [0, timeline.length]); applies MAX_TIMELINE by trimming the front and shifting insertAt down by the trimmed count.
 *  Returns the same timeline reference (and insertAt) when nothing new was inserted. */
export function mergeHistory(timeline: TimelineItem[], insertAt: number, messages: readonly ChatMessage[]):
  { timeline: TimelineItem[]; insertAt: number };
```
```ts
// ui/text.ts
export const HISTORY_TEXT = {
  loading: 'Loading recent messages…',
  emptyLoading: 'Loading recent messages…',
  failed: "Couldn't load recent messages.",
  retry: 'Try again',
  gapTruncated: "Some messages from while you were away couldn't be loaded.",
} as const;
// components/HistoryStatus.tsx
export interface HistoryStatusProps { history: RoomHistory; onRetry: () => void }
```

## Tests required
All 293 existing tests stay green. Changed in place (not deleted):
- `tests/xmpp/client.test.ts:239`: `maxstanzas` "20" → "0" (rename the test).
- Any fake `XmppClient` in component/integration tests gains `retryHistory`.
- `tests/xmpp/stanzas.test.ts:34` stays.

New:
- **`tests/fixtures/stanzas.ts`:** captured-shape fixtures:
  - a result message with `queryid`, id `CO4EUIA5RT81`, `<delay stamp='2026-11-18T15:49:25.250549Z'>` and an inner `muc#user` `<x>`
  - a fin IQ with `complete='true'`, `<first index='0'>`, `<last>`, `<count>`
  - an `item-not-found` error IQ
- **`tests/xmpp/mam.test.ts`:**
  - `buildMamQuery`:
    - iq type/to/id; query namespace and queryid
    - submit form with hidden FORM_TYPE `urn:xmpp:mam:2` and `start`
    - RSM `<max>50</max>` plus empty `<before/>` or `<after>ID</after>`, correct namespaces
    - escaping of `<&'"` round-trips
  - `parseMamResult`, happy path (fixture) → `{id:'CO4EUIA5RT81', nick, body, sentAt: Date.parse(stamp)}`.
  - `parseMamResult` returns null for each of:
    - outer `from` with a resource / another room / missing
    - wrong queryid; missing or empty `result@id`
    - no forwarded; no delay or an unparseable stamp; stamp < `notBefore` (a 1970 legacy row)
    - inner `chat` type; inner `from` from another room
    - empty or whitespace body; subject-only
    - wrong namespace `urn:xmpp:mam:1`
  - An inner message from the room bare JID → `nick: null`.
  - `isMamResultMessage` true and false.
  - `parseMamFin`: complete `'true'`/`'1'` → true, absent → false; first/last read; a missing `<set>` → nulls; no fin → null.
- **`tests/xmpp/client.test.ts`, `describe('history (MAM)')`** (fake transport and timers, controllable `now`, deterministic `newId`):
  - First join → after the 110 presence:
    - `room-joined`, then `history-loading {initial}`
    - exactly one sendIQ with `<before/>`, max 50, start = now−24h ISO, to = room
    - two results, then fin complete → ONE `history-loaded {initial, 2 messages in order, isHistory, done, complete}`
  - `isOwn` for the room's own nick.
  - Anti-spoof: wrong queryid, a resourceful outer `from` or another room's `from` → not included and no `message` event.
  - A result with no query in flight → ignored.
  - More results than `mamPageSize` → capped.
  - Gap after reconnect:
    - live message `S1` → drop → reconnect → rejoin with `maxstanzas='0'`
    - `history-loading {gap}` + an IQ with `<after>S1</after>` and no `<before/>`
  - Gap paging:
    - fin incomplete with `last=L1` → `done:false`
    - the next IQ is not sent before 1100 ms (advance 1099: 1 IQ; +1: 2 IQs, `<after>L1</after>`)
    - page 2 complete → done
  - Gap cap: 5 incomplete pages → exactly 5 IQs, the last event `done:true, complete:false`, no 6th IQ after 10 s.
  - Fallback: a gap `item-not-found` → `history-loading {initial}` → an IQ with `<before/>` after the throttle. A second `item-not-found` → `history-failed {initial}`, no more IQs.
  - Errors:
    - timeout / resource-constraint / service-unavailable → `history-failed` with that condition
    - fin-less → `'bad-response'`
    - no auto-retry (60 s: no IQ); nothing throws
  - `retryHistory`:
    - after a failure → a new query
    - in flight or queued → no-op
    - unknown or suspended room → no-op
  - Stale results:
    - drop in flight → reconnect → the old IQ resolves → ignored, and the old buffer isn't reused
    - `leaveRoom` while in flight or with a queued timer → no later IQ, no events
    - `terminate` clears timers (`vi.getTimerCount()` back to baseline)
  - `lastSeenId`:
    - a live message during the initial query is not overwritten by the page's last id; the next gap uses the live id
    - no live message → the gap uses the page's last id
    - a live message without a stanza-id doesn't change it
  - Throttle across rooms: two rooms back to back → the second IQ only after ≥ 1100 ms.
  - Privacy: spy on `console.*` across the history tests; no call contains a body or the room JID.
- **`tests/state/room.test.ts`:**
  - `mergeHistory`:
    - inserts at `insertAt` and advances it
    - de-dupes against existing ids and within the batch
    - same reference when nothing is new
    - clamps `insertAt`
    - cap: 495 items + 10 → 500, front trimmed, `insertAt` shifted by 5 and never negative
  - Reducer:
    - `room-joined` sets `insertAt = timeline.length`
    - **position over clock:** a live message after the join with `sentAt` EARLIER than the history stamps still renders after the history
    - gap history lands after the pre-outage messages and before post-rejoin live messages
    - a live message whose id already came via history is ignored
    - live appends trimmed by the cap shift `insertAt`
    - loading/failed flags; `room-suspended` clears `loading`
    - initial done → `canLoadEarlier = !complete`
    - gap done incomplete → the notice is inserted exactly once at `insertAt`
    - other-room events → same reference
    - a terminal disconnect resets history
- **`tests/components/timelineRows.test.ts`:** after a catch-up block (old live, then gap history) there is exactly one divider, after the gap block.
- **`tests/components/historyStatus.test.tsx`:**
  - nothing when idle
  - loading text in `role="status"`
  - failed text + "Try again" calls `onRetry` and is keyboard-reachable (Tab + Enter)
  - no raw palette classes
- **`tests/components/components.test.tsx`:** MessageList `aria-busy="true"` when `busy`, and absent otherwise.
- **`tests/integration/chatFlow.test.tsx`:**
  - log in → join → the MAM IQ is answered with 2 results → both bubbles show, with the divider
  - a later live message de-dupes against a history id
  - failure → "Couldn't load recent messages." → "Try again" sends a new IQ
  - reconnect + gap IQ `<after>` → one new bubble, no duplicates

## Acceptance criteria
- AC1: join presences (first join and rejoin) carry `<history maxstanzas='0'/>`; `historyMaxStanzas` is gone.
- AC2: after `room-joined`, one MAM v2 query (start now−24 h, max 50, `<before/>`); the newest ≤ 50 messages appear in order, marked as history, with the divider.
- AC3: after a reconnect, `<after>lastSeenId</after>` paging forward:
  - throttled to ≥ 1100 ms between sends, stopping after 5 pages
  - the truncated notice once if the cap is hit while incomplete
  - `item-not-found` → initial exactly once
- AC4: no duplicates. De-dupe by id (live stanza-id = MAM result@id) and within batches. Order by position, so clock skew can't move live messages above history.
- AC5: results accepted only when the outer `from` is exactly the room bare JID and the queryid matches; stamps older than the 24 h start are dropped; results never produce `message` events.
- AC6: at most one MAM query queued or in flight per room; stale results after a drop, leave or terminate are ignored and timers cleared.
- AC7: MAM failures → `history-failed` + "Couldn't load recent messages." + a working "Try again". Never an auto-retry, never a throw.
- AC8: the log has `aria-busy` while loading; strings in `ui/text.ts` with no jargon (no "MAM", "archive", "stanza"); tokens only; palette grep empty.
- AC9: typecheck, lint, test and build clean; Strophe only in the adapter; no new deps; no body/JID/coordinate logging in history paths.
- AC10: the template has `async_writer.enabled = false` in `[modules.mod_mam.muc]` and the commented shaper workaround; ADR-011 appended.
- AC11 (MANUAL): `docker compose up -d --force-recreate mongooseim` → healthy; no `archive_muc_single_message_failed`/`duplicate_key` while two users chat.
- AC12 (MANUAL): alice and bob chat → `docker compose restart mongooseim` → both reconnect. alice signs out and back in, joins → the pre-restart messages appear once with today's times (not 1970).
- AC13 (MANUAL): alice goes offline; bob sends 3; alice comes back online → after the rejoin the 3 appear exactly once, in order, above later messages. WS frames show `<after>` and no `<before/>`.
- AC14 (MANUAL): consecutive MAM IQs are ≥ 1.1 s apart; no `resource-constraint`.
- AC15 (MANUAL): with the legacy 1970 rows present, no 1970-stamped message ever renders.
- Note: the browser pane flips visibility about every 6 s, which triggers the throttled liveness probe (one per 30 s). Ignore those pings when reading frames.

## Risks / watch-outs
- **The workaround depends on the shaper.** It must stay generous (100 000 B/s). Removing it brings back 1970 ids and dropped messages.
  - Re-check `mod_muc_room:store_user_activity`/`broadcast_room_packet` on any MongooseIM upgrade, and track an upstream issue.
  - Side effect: per-room activity records for each active user (bounded by occupants).
- **Sync archive writes:** each room message waits for a PostgreSQL insert. Fine at our scale; revisit only if room latency shows up.
- **Ordering:** Strophe delivers result `<message>`s before the IQ result resolves. Don't buffer stanzas in the adapter.
- **Phase 3:** with `default_room.public = false`, the mod_mam_muc access rules for non-public rooms must still let occupants query. Add this to the Phase 3 checklist.
- **The mam_shaper delayed rather than rejected** in Probe B. The client throttle is still required, and `resource-constraint` → `history-failed`.
- **History `isOwn` is nick-based:** a user rejoining as `alice-2` sees older `alice` messages as not-own. Acceptable; record it in the ADR.
- **No crash paths:** `.then` re-checks the generation, room identity, joined state and queryId, and never throws.
- **Privacy:** never log bodies, JIDs or stanzas from MAM paths.

## Out of scope
- Load earlier, `<before>firstId</before>`, scroll preservation and the cap rule when adding older messages (2b-2b).
- Purging archive rows older than 24 h (Phase 4) and "messages disappear after 24 h" UI.
- Deleting the legacy 1970 rows (needs the user's OK).
- XEP-0198, MAM preferences, search, MUC Light, geo_service, the 2c layout.
- Divider semantics changes; moving the existing inline strings in Chat.tsx.

## Orchestrator steps (not for the coder)
1. Commit the server change on its own before the web change: `fix(infra): work around MongooseIM 6.2.1 MUC archive timestamp bug; sync MUC archive writes` (only when the user asks to commit).
2. AC11–AC15 and the re-check after `async_writer.enabled = false` are pending until Docker Desktop is healthy.
3. **Legacy rows: needs the user's explicit OK.** Optionally delete the ~10 MUC archive rows with 1970 stamps. SELECT and count first (e.g. `id < (1::bigint << 40)`) and confirm the count before any DELETE. The code doesn't depend on it.
4. After approval, append **ADR-011 "Room history via MAM"** covering:
   - the root cause
   - the workaround and its risk
   - the sync writer
   - history semantics: `maxstanzas=0` on every join, superseding ADR-010's historyMaxStanzas bullet; initial 24 h / newest 50; catch-up `<after>` forward with the 5×50 cap and notice; `item-not-found` → initial once; the ≥ 1100 ms throttle; anti-spoof; de-dupe by stanza-id = result@id; order by position and why; manual retry only; nick-based isOwn; the 24 h bound; the legacy rows decision
   Optionally add "Amended by ADR-011" under ADR-010's status line.

## Outline: 2b-2b Load earlier messages (full plan after 2b-2a approval)
- `HistoryDirection` gains `'earlier'`, `MamQuery.page` gains `{ before: string }`, and `TrackedRoom` gains `firstId` (from the initial fin `first`, updated per earlier page).
- `client.loadEarlier(roomJid)`: `<before>firstId</before>` within the 24 h start; same throttle and one-in-flight guard; errors → `history-failed {earlier}`.
- Store:
  - earlier pages are inserted at index 0, and `insertAt` shifts up by the inserted count
  - `canLoadEarlier = !complete`
  - when adding older messages, the cap must not evict them: stop offering "Load earlier" at `MAX_TIMELINE` instead of trimming the newest
- UI: a "Load earlier messages" button at the top of the log, scroll position preserved (`scrollHeight` delta in a layout effect), a retry hint, strings in `text.ts`.
- ACs: the button disappears at the 24 h boundary or `complete`; no jump in scroll position; throttle respected.
