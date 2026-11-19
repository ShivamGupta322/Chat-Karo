# Plan: Phase 2 slice 2b-1 — Connection resilience (reconnect, keepalive, timeline clearing)

Status: PLANNED by the supervisor on 2026-11-17. Live probes run by the orchestrator the same day (results below).
2b-2 (MAM history) is outlined at the end and gets a full plan only after 2b-1 is approved.

The supervisor checked the MongooseIM 6.2.1 docs (configuration/listen, modules/mod_ping, modules/mod_mam,
modules/mod_stream_management) and the Strophe 3.1.1 source:
- Strophe has no XEP-0198 or XEP-0199 support.
- `send()` flushes immediately, so a timer-throttled hidden tab still answers pings; only a fully frozen tab can't.
- The WebSocket is created synchronously in `Connection.connect()` at `conn._proto.socket`, and `_onClose(e)` discards the CloseEvent.

## Live probe results (orchestrator, 2026-11-17, visible pane, MongooseIM 6.2.1)
**Probe A**
1. Live MUC message: `<message from='lobby@muc…/probe-b' type='groupchat'><body>probe-1</body><stanza-id by='lobby@muc.chaterl.localhost' id='1G1' xmlns='urn:xmpp:sid:0'/></message>`
2. The history copy on rejoin (maxstanzas=20) has the SAME `<stanza-id by=room id='1G1'>`, plus
   `<delay xmlns='urn:xmpp:delay' stamp='2026-11-17T17:25:33Z' from='lobby@muc…'/>`.
   → **Step 7c branch: KEEP `historyMaxStanzas` on rejoin.** The store already de-dupes by id.
3. Stale session: after `conn._proto.socket.close()` (no `</close>`), a new alice session joining as the same nick within
   5 s gets `<conflict/>` (409). After **99 s** bob had still NOT seen the old nick leave (no `mod_ping` yet). This confirms
   the `mod_ping` kill design.
4. MongooseIM log: nothing relevant to connections; see the MAM finding below.

**Probe B (for 2b-2)**
- Room disco features: `urn:xmpp:mam:1`, `urn:xmpp:mam:2`, `urn:xmpp:mam:2#extended`.
- A query with a `start` = now−24h form field returns `<fin complete="true"><count>0</count>` → **broken (see below)**.
- A query without a start filter (`<max>3</max><before/>`) works: `<fin><set><first index="4">181</first><last>1O1</last><count>7</count></set></fin>`.
  - The result is `<message from='lobby@muc…'><result queryid='…' xmlns='urn:xmpp:mam:2' id='1O1'><forwarded xmlns='urn:xmpp:forward:0'>`
    `<delay stamp='1970-01-01T00:00:00.000007Z' from='lobby@muc…/alice'/>`
    `<message from='lobby@muc…/alice' id='…' type='groupchat'><body>yupp</body><x xmlns='…muc#user'>…</x></message></forwarded></result></message>`
  - `result@id` uses the same base-32 format as the live stanza-id (e.g. '1G1' = 1537). The inner message has NO stanza-id of its own.
- Two back-to-back MAM queries: both OK (the shaper delays rather than errors, as observed).
- `<after>nope</after>` → `<error code='404' type='cancel'><item-not-found/></error>`. `<after>1G1</after>` → `complete="true"`.
- **SERVER BUG (blocks 2b-2):**
  - MUC archive ids are tiny and counter-like (257, 513, 769, … = microseconds 1, 2, 3 << 8), so `delay` stamps read 1970-01-01.
  - The MongooseIM log shows `level=error what=archive_muc_single_message_failed reason=duplicate_key …
    mod_mam_muc_rdbms_arch_async … message_id=1537`: new messages collide with existing ids after a restart and are
    silently DROPPED from the archive.
  - The container clock is correct.
  - 2b-2 must first find the root cause (MongooseIM 6.2.1 MUC MAM id/timestamp generation, async writer) and fix or
    work around it before any MAM UI work.

## Goal
The signed-in client survives network drops, background-tab socket kills and MongooseIM restarts:
- It reconnects automatically with jittered exponential backoff, and immediately when the browser comes back online or the tab becomes visible.
- It rejoins its room and keeps its timeline across the outage.
- A terminal sign-out, auth failure or session replacement clears the timeline and never reconnects.
- Unexpected socket closes are logged with code, reason and visibility, so the background-drop cause can be determined.

## Context
- Roadmap phase 2: the 2b carry-forward items 1 and 2.
- ADRs:
  - ADR-004 (applies in 2b-2).
  - ADR-008 connection semantics: `connection-lost` is the hook for reconnect. Its bullet "password … deliberately not kept" is superseded by ADR-010.
  - ADR-009: text in `ui/text.ts`, tokens only.
- Also: ROADMAP "Learned in Phase 1" (stale nick `<conflict/>`) and the CLAUDE.md frontend rules.
- Touched:
  - `web/src/xmpp/{client.ts,types.ts,stanzas.ts,pageHide.ts,XmppProvider.tsx,index.ts}`, `web/src/xmpp/strophe/stropheTransport.ts`
  - `web/src/state/{room.ts,session.ts,bindXmpp.ts}`, `web/src/ui/text.ts`
  - `web/src/components/{ConnectionStatus.tsx,AppHeader.tsx}`, `web/src/pages/Chat.tsx`, `web/src/App.tsx`
  - `infra/mongooseim/mongooseim.toml.tmpl`, tests, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` (module list ~line 150)

## Keepalive decision (goes into ADR-010)
- **No XEP-0198 resumption in 2b.**
  - Strophe 3.1.1 has no SM support; the only plugin is a separate, stale package (a new dependency).
  - SM is opt-in per stream (the client sends `<enable/>`), and our client never enables it, so the server's `mod_stream_management` has no effect.
  - For groupchat, rejoin plus the 2b-2 MAM gap fill gives the same experience.
- **No `mod_websockets` `ping_rate` yet.** It's verified ("positive integer … time (in milliseconds) between pings sent by
  server") but only matters behind an idle-timeout proxy; deferred to Phase 6 (Caddy).
- **Yes: server-side XEP-0199 via `mod_ping` with `timeout_action = "kill"`.**
  - It reaps dead or frozen sessions within about 92 s, which frees the nick (no `<conflict/>` / `alice-2`) and removes ghost occupants.
  - A throttled background tab still answers. Only a truly frozen tab is killed, and it reconnects as soon as it's visible again.
- **Yes: a client liveness probe.** On `online` or `visibilitychange → visible` while connected, send one XEP-0199 ping to the server domain with a 5 s timeout.
  - A timeout counts as a lost connection.
  - Any reply, even an error, means the link is alive.
- **Keep server-assigned resources.** Rejected alternative: a fixed per-tab resource would replace the stale session, but the old session's MUC `unavailable` would then be routed to the NEW session (same full JID) and break the rejoin.

## Steps
1. `infra/mongooseim/mongooseim.toml.tmpl`: add after `[modules.mod_presence]` (all options verified on the 6.2.1 mod_ping page):
   ```toml
   # XEP-0199: answer client pings and reap dead/frozen sessions (frees MUC nicks). ADR-010.
   [modules.mod_ping]
     send_pings = true
     ping_interval = 60        # seconds of client inactivity before the server pings
     timeout_action = "kill"
     ping_req_timeout = 32     # seconds to wait for the pong
   ```
   Touch nothing else. The orchestrator then runs `docker compose up -d --force-recreate mongooseim` and checks it is healthy.
2. `web/src/xmpp/reconnect.ts` (new, pure, no DOM): backoff maths plus a retry scheduler with injected timers. Exponent
   overflow is safe because `Math.min` with Infinity gives the cap; no loop.
3. `web/src/xmpp/socketClose.ts` (new, pure): `describeSocketClose(...)` returns the log record, with exactly the Interfaces fields and the reason truncated to 123 chars.
4. `web/src/xmpp/strophe/stropheTransport.ts`:
   - (a) Right after `c.connect(...)` returns, read `(c as unknown as { _proto?: { socket?: unknown } })._proto?.socket`.
     Comment it as a Strophe 3.1.1 private field, tied to the pin (ADR-008). If it's `instanceof WebSocket`, call
     `addEventListener('close', …, { once: true })` (not `onclose`, which Strophe owns). Otherwise call
     `console.warn('xmpp: socket close logging unavailable')` once per page.
   - (b) Keep a `WeakSet` of connections we closed ourselves (`disconnect()` and replacement). A close on one of these is expected and isn't logged.
   - (c) Track `hiddenSince` with one `document` `visibilitychange` listener per transport.
   - (d) On an unexpected close: `console.warn('xmpp socket closed', describeSocketClose({...}))`. Never log stanzas, bodies or JIDs.
5. `web/src/xmpp/stanzas.ts`, all built with `xmlEl`:
   - `NS_PING = 'urn:xmpp:ping'`
   - `buildPing(to, id)` → `<iq type='get' to id><ping xmlns='urn:xmpp:ping'/></iq>`
   - `isPingRequest(el)` → true for an iq with type `get` and a `ping` child in `NS_PING`
   - `buildIqResult(iq)` → `<iq type='result' id to=from/>`
6. `web/src/xmpp/types.ts`: extend `ConnectionState`, add the `room-suspended` event, `wake()` and the new options (see Interfaces).
7. `web/src/xmpp/client.ts`, the reconnect state machine (rules below):
   - (a) `let creds: {jid; password} | null`: set in `connect()`, nulled in every terminal path. Comment: in memory only, never persisted or emitted.
   - (b) `hadSession` becomes true on the first `connected` after a user `connect()`. Only then are drops retried; initial sign-in failures stay terminal (today's behaviour).
   - (c) `TrackedRoom.state` gains `'suspended'`.
     - On a retryable drop, every tracked room (joined, joining or configuring) has its timer cleared, becomes `suspended`, and `room-suspended` is emitted.
     - On reconnect `connected`: send initial presence. Then for each suspended room, in insertion order: set `nick = baseNick`, `attempt = 0`,
       `configuring = false`, `occupants = new Set()`, set state to `'joining'`, and call `sendJoin`.
     - **Probe A result: keep `historyMaxStanzas` on rejoin** (the history copies carry the same stanza-id by=room as live; the store de-dupes by id).
   - (d) Instant-room race: in `handleJoiningPresence` capture `const gen = generation`. Ignore the `acceptInstantRoom` result
     unless `generation === gen && room.state === 'joining' && room.configuring`.
   - (e) In `onStanza`, answer an `isPingRequest` iq with `buildIqResult`. Other get/set keep `service-unavailable`.
   - (f) `leaveRoom` on a suspended room: untrack it and emit `room-left self` WITHOUT sending presence. Send presence only while `connected`.
   - (g) `disconnect()` also works while `reconnecting`: `userInitiated=true`, `generation++`, cancel timers,
     `transport.disconnect('user')`, then go terminal immediately with no error.
   - (h) `terminate(error?)`:
     - cancel the retry and stable timers
     - emit `room-left 'disconnected'` for every tracked room, including suspended ones
     - clear `rooms` and `creds`, set `hadSession = false`
     - set state `disconnected` (with the error if any)
8. `web/src/xmpp/lifecycle.ts` (new): `installLifecycleTriggers(client, win, doc)`.
   - `online` on `win` calls `client.wake()`.
   - `visibilitychange` on `doc` calls `wake()` only when `doc.visibilityState === 'visible'`.
   - Returns a cleanup function.
9. `web/src/xmpp/pageHide.ts`: also disconnect when the status is `'reconnecting'`.
10. `web/src/xmpp/XmppProvider.tsx`: install the lifecycle triggers next to pageHide in the same effect and clean both up. Still
    no `disconnect()` in cleanup (StrictMode). Export `installLifecycleTriggers` from `xmpp/index.ts`.
11. `web/src/state/room.ts` (regression test FIRST):
    - `case 'connection'`: when `event.state.status === 'disconnected'`, return `{ ...initialRoomState }`, or `state` itself if it's already initial. Other statuses return `state`. Nick-conflict retries still keep the timeline (same-room `room-joining` is untouched).
    - `RoomState.status` gains `'reconnecting'`. `room-suspended` for the current room sets `status: 'reconnecting'` and `occupants: []`, and keeps the timeline.
12. `web/src/state/bindXmpp.ts`: route `connection` events to BOTH stores: the session store first, then `useRoomStore.getState().apply(event)`.
13. `web/src/state/session.ts`: export `selectSessionJid(c)`, which returns the jid for `connected`/`reconnecting`, else null.
14. `web/src/App.tsx`: render `Chat` when the status is `connected` OR `reconnecting` (otherwise every drop would bounce the user to login).
15. `web/src/ui/text.ts`: add `CONNECTION_TEXT` (exact strings below), with no jargon.
16. `ConnectionStatus.tsx`: `reconnecting: { text: CONNECTION_TEXT.statusReconnecting, dot: 'bg-warning' }`.
17. `AppHeader.tsx`: show the name when `selectSessionJid` is non-null.
18. `components/ConnectionBanner.tsx` (new), rendered by `Chat.tsx` between `AppHeader` and `<main>` only while reconnecting:
    - Layout:
      - a `role="status"` region holding the static `bannerLost` and `bannerAutoRetry` text
      - the visible countdown in an `aria-hidden="true"` span
      - a `<button type="button">` labelled `retryNow`, outside the status region, calling `onRetryNow`
    - Countdown: a 1 s `setInterval`, running only while `nextAttemptAt !== null` and cleared on unmount or change. Seconds = `Math.max(0, Math.ceil((nextAttemptAt - now()) / 1000))`.
    - Tokens only: `bg-surface-sunken text-ink border-b border-line`, a `bg-warning` dot, the button styled like Sign out. Mobile-first, wraps.
19. `pages/Chat.tsx`:
    - render the banner, with `onRetryNow = client.wake()`
    - use `selectSessionJid` for the default nick
    - when `room.status === 'reconnecting'`, the status line shows `CONNECTION_TEXT.roomReconnecting`
    - the Composer stays disabled
20. Docs:
    - `docs/ROADMAP.md`: mark the 2b-1 parts done and the background-drop and timeline carry-forwards resolved, with a one-line Probe A note.
    - `docs/ARCHITECTURE.md` (~line 150): add `reconnect.ts`, `lifecycle.ts` and `socketClose.ts`.
    - No new CLAUDE.md commands.

No new dependencies.

## Interfaces
```ts
// xmpp/types.ts
export type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected'; jid: string }
  /** attempt: 1-based number of the next/in-flight retry. nextAttemptAt: epoch ms, null while an attempt is in flight. jid: last bound full JID. */
  | { status: 'reconnecting'; jid: string; attempt: number; nextAttemptAt: number | null }
  | { status: 'disconnecting' }
  | { status: 'disconnected'; error?: ConnectionError };
// XmppEvent gains:  | { type: 'room-suspended'; roomJid: string }
export interface XmppClient { /* existing */
  /** online / tab visible / "Try now": retry now if reconnecting, liveness-probe if connected, else no-op. */
  wake(): void;
}
export interface XmppClientOptions { /* existing */
  backoff?: Partial<BackoffPolicy>;   // defaults DEFAULT_BACKOFF
  stableAfterMs?: number;             // default 60_000
  probeTimeoutMs?: number;            // default 5_000
  random?: () => number;              // default Math.random, [0,1)
}
```
`sameState` must compare `jid`, `attempt` and `nextAttemptAt` for `reconnecting`.

```ts
// xmpp/reconnect.ts
export interface BackoffPolicy { baseDelayMs: number; maxDelayMs: number; jitter: number }
export const DEFAULT_BACKOFF: BackoffPolicy = { baseDelayMs: 1_000, maxDelayMs: 30_000, jitter: 0.2 };
/** failures = 0 for the first retry. base = min(maxDelayMs, baseDelayMs * 2 ** failures);
 *  returns Math.round(base * (1 - jitter + 2 * jitter * random())). Cap applies before jitter (24–36 s at cap). */
export function backoffDelay(failures: number, policy: BackoffPolicy, random: () => number): number;
export interface RetryScheduler {
  /** Schedules onFire after backoffDelay(failures); increments failures; returns { attempt: failures, at } (1-based). Cancels any pending timer. */
  schedule(onFire: () => void): { attempt: number; at: number };
  /** If a timer is pending: cancel it, invoke onFire synchronously, return true. Else false. Does NOT reset failures. */
  fireNow(): boolean;
  cancel(): void;               // pending timer only
  reset(): void;                // failures = 0 (stable timer and terminate)
  readonly pending: boolean;
}
export function createRetryScheduler(deps: { policy: BackoffPolicy; random: () => number; now: () => number }): RetryScheduler; // global setTimeout/clearTimeout (vi fake timers)

// xmpp/socketClose.ts
export interface SocketCloseInput { code: number; reason: string; wasClean: boolean; visibility: DocumentVisibilityState; hiddenForMs: number | null }
export interface SocketCloseLog { code: number; reason: string; wasClean: boolean; hidden: boolean; hiddenForMs: number | null }
export function describeSocketClose(i: SocketCloseInput): SocketCloseLog; // reason sliced to 123 chars; no other fields

// xmpp/lifecycle.ts
export function installLifecycleTriggers(
  client: Pick<XmppClient, 'wake'>,
  win: EventTarget = window,
  doc: EventTarget & { readonly visibilityState: DocumentVisibilityState } = document,
): () => void;

// components/ConnectionBanner.tsx
export interface ConnectionBannerProps {
  state: Extract<ConnectionState, { status: 'reconnecting' }>;
  onRetryNow: () => void;
  now?: () => number; // default Date.now (tests)
}

// ui/text.ts
export const CONNECTION_TEXT = {
  statusReconnecting: 'Reconnecting…',
  bannerLost: 'Connection lost.',
  bannerAutoRetry: "We'll reconnect automatically.",
  bannerRetryIn: (seconds: number): string => `Reconnecting in ${seconds}s…`,
  bannerRetrying: 'Reconnecting…',
  retryNow: 'Try now',
  roomReconnecting: 'Reconnecting to the room…',
} as const;
```

### Client transition rules
`gen` is the generation captured at `transport.connect`. Callbacks from older generations are ignored, as today.

| Current state / trigger | Action |
|---|---|
| idle/disconnected + `connect(jid,pw)` | store `creds`, `userInitiated=false`, `hadSession=false`, scheduler.reset(), state `connecting`, `transport.connect` |
| transport `connecting` while `reconnecting` | no state change (stay `reconnecting`, `nextAttemptAt: null`) |
| transport `connected` | cancel retry; state `connected`; send `<presence/>`; `hadSession=true`; start stable timer (`stableAfterMs` → `scheduler.reset()`); rejoin suspended rooms |
| transport `failed` `auth-failed` | `terminate(error)` |
| transport `failed` with `condition === 'conflict'` (stream conflict = session replaced) | `terminate({ reason: 'connection-lost', condition: 'conflict' })` |
| transport `failed` other, `hadSession && !userInitiated` | `scheduleRetry()` |
| transport `failed` other, otherwise | `terminate(error)` (initial-login behaviour) |
| transport `disconnected`, `userInitiated` | `terminate()` |
| transport `disconnected` while `connected`/`disconnecting`, `hadSession` | `scheduleRetry()` |
| transport `disconnected` while `reconnecting` and `!scheduler.pending` | `scheduleRetry()` |
| transport `disconnected` while `reconnecting` and `scheduler.pending` | ignore |
| `wake()` while `reconnecting` | `scheduler.fireNow()` (no-op if an attempt is already in flight) |
| `wake()` while `connected`, no probe in flight | `transport.sendIQ(buildPing(domainOf(jid), newId()), probeTimeoutMs)`. If the result is `{ok:false, condition:'timeout'}` and generation + `connected` are unchanged: `generation++`, `transport.disconnect('stale')`, `scheduleRetry()`. Any other result means alive. |
| `wake()` otherwise | no-op |
| `disconnect()` while `connected`/`connecting` | as today (the transport drives it to `terminate()`) |
| `disconnect()` while `reconnecting` | `userInitiated=true`, `generation++`, `transport.disconnect('user')`, `terminate()` |

`scheduleRetry()`:
1. Suspend rooms (idempotent) and clear the stable timer.
2. `const {attempt, at} = scheduler.schedule(attemptNow)`.
3. State `reconnecting {jid: lastJid, attempt, nextAttemptAt: at}`.

`attemptNow()`:
1. If `!creds`, return.
2. `const g = ++generation`.
3. State `reconnecting {…, nextAttemptAt: null}`.
4. `transport.connect(creds.jid, creds.password, s => onTransportStatus(s, g))`.

## Tests required
All existing tests (224) stay green. Tests whose behaviour changes on purpose are updated in place, not deleted:
- `client.test.ts` "an unexpected transport disconnect reports connection-lost"
- "a transport-initiated disconnecting then disconnected is still a loss"
- "a transport drop leaves every room and ends disconnected with the error"

These now assert `reconnecting` plus `room-suspended`. Add a new test for the remaining terminal `connection-lost` (stream `conflict`).

- **`tests/state/room.test.ts`** (FIRST, the regression tests for carry-forward item 2):
  - A timeline with a "bob joined" notice → `connection` disconnected → equals `initialRoomState`. Then same-room `room-joining` → timeline empty. Must fail on `cd32b4c`.
  - A nick-conflict retry (same-room `room-joining`, `alice-2`) keeps the timeline.
  - `connection` reconnecting/connected returns the same reference.
  - `room-suspended` keeps the timeline, clears occupants and sets status `reconnecting`; for another room it returns the same reference.
  - suspended → `room-joining` → occupant-joined ×2 (no notices) → `room-joined`: the timeline is unchanged except for messages.
- **`tests/state/bindXmpp.test.ts`** (new): `connection` disconnected resets the room store and updates the session store.
- **`tests/xmpp/reconnect.test.ts`** (new, fake timers):
  - `backoffDelay` with random 0.5 → 1000, 2000, 4000, 8000, 16000, 30000, 30000 for failures 0–6.
  - random 0 → 800; random 0.999999 → about 1200 at failures 0. At the cap: 24000 and about 36000.
  - failures 1000 → finite and ≤ 36000.
  - Scheduler:
    - successive `schedule` calls give attempts 1, 2, 3 and `at = now + delay`
    - fires only after the delay (advance delay−1: not fired; +1: fired)
    - `fireNow` fires synchronously, clears the pending timer and doesn't reset failures; with nothing pending it returns false
    - `reset` makes the next delay 1 s; `cancel` stops the callback
- **`tests/xmpp/client.test.ts`**, new `describe('reconnect')` (random 0.5, controllable `now`):
  - A drop after a session → `reconnecting {attempt:1, nextAttemptAt: now+1000}` and `room-suspended` for every room, with no `room-left`. After 1000 ms, exactly one new `transport.connect` with the same jid and password.
  - The failure schedule 2000, 4000, 8000 … 30000. A trailing `disconnected` after `failed` is ignored (only one timer).
  - Reset: stay connected 59 s then drop → the delay continues; stay 60 s then drop → 1000.
  - Rejoin:
    - after `connected`, initial presence first, then a join to `room/baseNick` (even if the previous nick was `alice-2`)
    - `room-joining`, then `room-joined` after the 110 presence
    - two suspended rooms rejoin in order
  - auth-failed during a retry → terminal `disconnected {auth-failed}` and `room-left disconnected`. `wake()` plus advancing timers → no connect.
  - No reconnect after a stream `conflict`.
  - Sign-out:
    - `disconnect()` with a timer pending → `disconnected` with no error, and no connect after advancing 60 s
    - `disconnect()` with an attempt in flight → a late `connected` from the old generation is ignored
  - pagehide while reconnecting → no reconnect (real `installPageHideClose` with an EventTarget).
  - An initial sign-in `connection-failed` is not retried.
  - `wake()` while reconnecting attempts immediately; a second `wake()` during the in-flight attempt is a no-op; failures are not reset.
  - `wake()` while connected sends ONE ping `to='chaterl.localhost'` (`urn:xmpp:ping`), with no second ping while one is in flight.
    - a timeout → `transport.disconnect('stale')`, `reconnecting`, rooms suspended
    - `service-unavailable` or a result → still connected
    - a timeout arriving after a state change → ignored
  - An incoming server ping `<iq type='get' id='p1' from='chaterl.localhost'><ping xmlns='urn:xmpp:ping'/></iq>` → reply `type='result' id='p1' to='chaterl.localhost'`. Other gets still get `service-unavailable`.
  - Instant-room race: a drop during `configuring` with the IQ resolving later → no `room-joined` or `room-join-failed` for the stale attempt.
  - `leaveRoom` while suspended → `room-left self`, nothing sent, no rejoin after reconnect.
  - Credentials:
    - the password never appears in any state or event, including reconnecting states
    - `localStorage.setItem` and `sessionStorage.setItem` are never called (spied)
    - after `terminate`, `wake()` causes no `transport.connect`
- **`tests/xmpp/lifecycle.test.ts`** (new): `online` calls wake; `visibilitychange` calls wake for `'visible'` but not `'hidden'`; nothing is called after cleanup.
- **`tests/xmpp/pageHide.test.ts`**: `reconnecting` also disconnects.
- **`tests/xmpp/socketClose.test.ts`** (new): the record has exactly the keys `code, reason, wasClean, hidden, hiddenForMs`; `hidden` is true only for `'hidden'`; a 500-char reason is cut to 123.
- **`tests/xmpp/stanzas.test.ts`**: `buildPing` shape and namespace; `isPingRequest` true and false (wrong namespace, `type='result'`); `buildIqResult` copies the id and sets `to` from `from`.
- **`tests/components/connectionBanner.test.tsx`** (new, fake timers):
  - shows "Reconnecting in 3s…", then "2s…" after 1 s
  - shows "Reconnecting…" when `nextAttemptAt` is null
  - "Try now" calls `onRetryNow` and is keyboard-reachable
  - the `role="status"` region holds the static text but not the countdown
  - the interval is cleared on unmount (`vi.getTimerCount()` is 0)
- **`tests/integration/chatFlow.test.tsx`**:
  - log in → join → transport `disconnected`:
    - Chat stays mounted and the banner is visible
    - the header pill reads "Reconnecting…" and the Composer is disabled
    - advance 1 s, push `connected` and the 110 presence → the banner is gone, the Composer is enabled and the old message is still there
  - Second case: Sign out while reconnecting → the login form shows. Sign in and join again → the message list is empty (the stale-notice regression, end to end).

## Acceptance criteria
- AC1: backoff is 1, 2, 4, 8, 16, 30, 30 … s ±20% and resets after 60 s connected (fake-timer tests).
- AC2: an unexpected drop after a successful sign-in never shows the login form. The client shows the banner, retries automatically, rejoins every room with the base nick, and keeps the timeline.
- AC3: no reconnect after an auth failure, a stream conflict, a user sign-out (including during a pending or in-flight retry) or pagehide. Credentials are dropped in every terminal path and never persisted (unit tests).
- AC4: `online`, tab-visible and "Try now" each trigger an immediate attempt while reconnecting. While connected, they run a 5 s liveness ping, and a timeout leads to reconnect.
- AC5: the client answers server XEP-0199 pings with `type='result'`.
- AC6: the timeline is cleared on a terminal disconnect and kept across nick-conflict retries and reconnects. A regression test was written first and fails on `cd32b4c`.
- AC7: unexpected WS closes log `console.warn('xmpp socket closed', {code, reason, wasClean, hidden, hiddenForMs})` from `web/src/xmpp/` only, with no stanzas, bodies, JIDs or coordinates. Expected closes are not logged.
- AC8: new text lives in `ui/text.ts` with no jargon, and only tokens are used (the palette grep is empty). The banner is keyboard-usable, and its live region does not announce every second.
- AC9: typecheck, lint, test and build are clean. Strophe is imported only in the adapter. No new dependencies.
- AC10 (MANUAL, visible window): `docker compose stop mongooseim` → "Connection lost. Reconnecting in Ns…" with N growing. `docker compose start mongooseim` → the client reconnects within one backoff step of the server becoming healthy (or immediately via "Try now"), rejoins lobby, the occupants refill, the Composer is enabled and earlier timeline lines remain.
- AC11 (MANUAL): DevTools Network "Offline" for 10 s → banner; back "Online" → an immediate attempt (a new stream within about 1 s).
- AC12 (MANUAL): Sign out while the banner is showing → login form, with no further WS connections. Sign in and join lobby → no stale "bob joined".
- AC13 (MANUAL): after `mod_ping`, MongooseIM is healthy. An idle visible tab shows server `<ping/>` about every 60 s with our `result` replies, and stays connected for more than 3 minutes.
- AC14 (MANUAL, diagnostic): background the tab for more than 10 minutes (or until a drop). On return:
  - the console shows the close record with `hidden: true` and `hiddenForMs`
  - the client reconnects immediately on visible
  - the record goes into the ADR

## Risks / watch-outs
- **Privacy:** no coordinates, bodies or JIDs in the logs or the probe. The WS close reason is server text, truncated. Credentials stay in a closure only (Strophe's `Connection` already holds `pass`).
- **Strophe private `_proto.socket`:** guard with `instanceof WebSocket` and warn once if it's missing. Never throw from the adapter (Strophe removes handlers that throw).
- **Stale nick on rejoin:** if the old session is still alive, the rejoin gets `<conflict/>` and becomes `alice-2`. That's acceptable; `mod_ping` bounds it to about 92 s.
- **Transient auth failure during a full-stack restart:** terminal, so the user signs in again. Document this in the ADR.
- **Unexpected self-unavailable during rejoin:** must fail or leave cleanly, as today. No auto-retry loops.
- **Effect hygiene:**
  - the lifecycle and pageHide listeners are removed in cleanup
  - the banner interval is cleared
  - the stable, retry and probe timers are cleared in `terminate`
- **Generation discipline:** every async continuation re-checks the generation and state before acting.
- **Rooms map:** suspended rooms stay in `rooms`, so `joinRoom` on the same JID while reconnecting returns `not-connected` (the state check comes first) and doesn't create a duplicate.
- **Verification:** live checks need a VISIBLE browser window.

## Out of scope
- Anything MAM-related, `<history/>` changes, "Load earlier messages" and history events (2b-2).
- XEP-0198 client support, `mod_websockets` `ping_rate`/`timeout`, a fixed per-tab resource.
- The 2c "chat card fills height" change.
- Moving existing inline strings in `Chat.tsx`/`ConnectionStatus.tsx` into `text.ts` (only new strings go there).
- bfcache `pageshow` restore, offline-specific wording, a reconnect give-up limit.

## Outline: 2b-2 History from MAM (full plan after 2b-1 approval)
- **FIRST: fix the server archive bug from Probe B.** Room archive ids and timestamps are near zero (1970 stamps),
  `start` filters return nothing, and `duplicate_key` errors silently drop messages. Find the root cause in MongooseIM 6.2.1 MUC MAM before building UI.
- **Server:** in `[modules.mod_mam.muc]`, `async_writer.enabled = false` (verified in the 6.2.1 docs). The async writer flushes
  every 2000 ms, so a message sent just before a (re)join would be in neither the live stream nor MAM. `max_result_limit` defaults to 50.
- **`xmpp/mam.ts`** (pure), using `urn:xmpp:mam:2` (confirmed by disco):
  - `buildMamQuery({roomJid, queryId, id, startIso, max, before?, after?})`
  - `parseMamResult(el, roomJid, queryId) → ChatMessage | null`:
    - the outer `from` must be the room bare JID (anti-spoof)
    - the id is `result@id`, which matches the live stanza-id format (confirmed)
    - `sentAt` comes from the forwarded `<delay>`, the nick from the inner `from` resource
    - subjects and empty bodies are dropped
  - `parseMamFin(iq) → {complete, first, last}`
- **`client.ts`:**
  - Joins use `maxstanzas="0"` (remove `historyMaxStanzas`).
  - After `room-joined`: an initial query (start = now−24h, max 50, `<before/>`), or a gap query `<after>lastSeenStanzaId</after>` paging forward (cap 5 pages).
  - If the after-id is rejected (`item-not-found`, confirmed), fall back to the initial query.
  - `loadEarlier(roomJid)` uses `<before>firstId</before>` within 24 h.
  - One query in flight per room, plus a client throttle of ≥1100 ms between MAM sends.
  - `resource-constraint`/`policy-violation`/timeout → `history-failed`. Never throw, no automatic retries.
- **Events:** `history-loading`/`history-loaded`/`history-failed { roomJid, direction: 'initial'|'earlier'|'gap', … }`.
- **Store:** merge by id; keep messages in `sentAt` order; `history: { loading, canLoadEarlier, failed }`; prepends must not evict the loaded page; re-check the divider logic.
- **UI:** a "Load earlier messages" button, scroll position preserved, a retry hint, strings in `text.ts`.
- **ADR-011** "Room history via MAM" after approval.

## ADRs for the orchestrator
- After 2b-1: **ADR-010 "Web client resilience: reconnect and keepalive"**. Cover:
  - the backoff policy and reset
  - in-memory credentials (supersedes ADR-008's "password not kept")
  - `connection-lost` → `reconnecting`, terminal only for stream conflict
  - no XEP-0198, and why
  - `mod_ping` kill and the 92 s reap window
  - the liveness probe on visible/online
  - server-assigned resources kept, and why
  - the `ping_rate` deferral to Phase 6
  - the timeline cleared only on terminal disconnect
  - the AC14 close-code finding
- After 2b-2: **ADR-011 "Room history via MAM"**.
