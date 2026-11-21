## Plan: Slice 3e-2 (APPROVED 2026-11-21 after 2 review rounds with live checks), client identity (Welcome, device credential, token manager, auto sign-in)

The orchestrator should save this plan as `C:\Users\DELL\Desktop\chatErl\.claude\plans\slice-3e2-client-identity.md`. I made no edits.

### Baseline (measured at 4d90200, clean tree)
- **Tests:** `npx vitest run` gives 33 files and 788 tests. In two runs, 3 and 8 tests failed, all on the 5 s default timeout under load. The second run's failures were `LoginForm > submits the expanded…`, `LoginForm > submits a full address…` and `AppHeader > shows the account name…`. These are existing flakes, not regressions.
- **Typecheck and lint:** `npm run typecheck` and `npm run lint` are both clean.
- **Things that drive the design:**
  - `Chat.tsx` builds the MUC nick from `localpartOf(jid)`. With server-made accounts that would be `u<32 hex>`, which is 33 characters. That is longer than `MAX_NICK_LENGTH` (32), so every join would fail with `invalid-nick`. **So the MUC nick must become the profile nickname in 3e-2.** D3 says this already, but the work can't wait for 3e-3.
  - `client.connect()` does nothing unless the state is `idle` or `disconnected`. So a fast "Start over → new name" or "Sign out → Continue" while the old session is still `disconnecting` would silently not connect. Fixed below with `connectWhenIdle`.
  - The XMPP password already lives only in the client's closure for reconnect (ADR-010). The session Zustand store never holds it. Both stay that way.

### Goal
A first-time visitor picks a nickname. The client creates a pseudonymous identity (`POST /api/session`), stores the device credential, connects to XMPP with it and chats in the area room (rooms still come from `roomJidForCell`). Reloading signs back in automatically. Sign out and Start over work with confirmation. A memory-only API token is kept valid by a token manager that 3e-3 will use for `/api/locate`. The dev login is removed.

### Context
- **Roadmap phase:** 3, slice 3e-2. It depends only on 3c and 3e-1, both live. Nothing is out of order.
- **ADRs:**
  - ADR-019 D1, D2, D4 (the fetch, storage and xmpp parts), D5, D6, D7. D3 only for "MUC nick = profile nickname" and the token seam.
  - ADR-008: explicit env keys in `main.tsx`; `envPrefix` and `loadEnv` rules.
  - ADR-009: tokens; all text in `ui/text.ts`; no jargon.
  - ADR-010: reconnect; password in a closure; what counts as terminal.
  - ADR-011 and ADR-012: unchanged. `isOwn` is nick-based, which works better with unique nicknames.
  - ADR-013: geo boundary, ESLint pattern, dev picker.
  - ADR-014: literal `import.meta.env.DEV` tree-shaking and the prod dist grep.
  - ADR-017: the session contract.
- **Existing code touched:**
  - `web/src/main.tsx`, `App.tsx`, `config.ts`
  - `pages/Chat.tsx`
  - `components/AppHeader.tsx`
  - `ui/text.ts`
  - `eslint.config.js`, `vite.config.ts` (test block only)
  - Deleted: `pages/DevLogin.tsx`, `components/LoginForm.tsx`, `ui/addresses.ts`
  - Tests: `tests/integration/chatFlow.test.tsx`, `tests/components/{components,round2,brand}.test.tsx`, `tests/ui/text.test.ts`, `tests/config.test.ts`; deleted: `tests/ui/addresses.test.ts`
  - Docs: `docs/ARCHITECTURE.md`, `README.md`, `docs/DECISIONS.md`, `docs/ROADMAP.md`

### Dependencies
None new. The lint fixture test uses the `ESLint` class from the existing `eslint` devDependency and `tseslint.configs.disableTypeChecked` from the existing `typescript-eslint`.

### Steps
0. **Baseline build first, before touching anything.** At 4d90200 run `cd web && npm run build`. Record the byte size of each file in `web/dist/assets/` (expect exactly 1 `.js` and 1 `.css`) and the vite gzip figures. Run the grep terms from AC22 on this baseline build and record the counts. The DevLogin terms must hit here, which proves the grep works.
1. `web/src/api/http.ts` (new): the only fetch caller. `createHttp({ baseUrl, fetch?, timers? })` → `Http`.
   - **Request options:** `method: 'POST'`, headers `content-type: application/json` and `accept: application/json`, optional `authorization: Bearer <token>`, `credentials: 'omit'`, `cache: 'no-store'`, `redirect: 'error'`.
   - **Timeout:** one `AbortController` per request.
     - A timer aborts it, and the result is `{kind:'timeout'}`.
     - If an external `signal` aborts it, the result is `{kind:'aborted'}`. If the signal is already aborted, return that without calling fetch.
     - The listener and the timer are always cleaned up in `finally`.
   - **Response body:** read with `text()` inside the abortable section. Over 65 536 characters → `bad-response`. Empty → `body: null`. Unparsable JSON on a 2xx → `bad-response`; on a non-2xx → `body: null`.
   - **`retry-after`:** only `^\d{1,4}$` seconds count; convert to ms and cap at 300 000, otherwise null.
   - **Failures:** a rejected fetch → `{kind:'network'}`. It never throws and never logs.
   - **Default fetch:** `(...a) => globalThis.fetch(...a)`, resolved at call time so test fakes apply.
2. `web/src/api/nickname.ts` (new): `NICKNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/` and `validateNickname(raw)`. It trims the input; empty → `'empty'`; failing the regex → `'invalid'`.
3. `web/src/api/session.ts` (new): `createSessionApi(http, { xmppDomain })`.
   - **Constants:** `SESSION_TIMEOUT_MS = 15_000`, `RENEW_TIMEOUT_MS = 15_000`, plus `LOCATE_TIMEOUT_MS = 10_000` exported for 3e-3.
   - **Success status:** create is 201 only; renew is 200 only. Any other 2xx → `bad-response`.
   - **Non-2xx:** → `{kind:'http', status, code, retryAfterMs}`. `code` = `body.error` if it is a string matching `^[a-z_]{1,64}$`, else null.
   - **Validating the 201:**
     - `jid` matches `^u[0-9a-f]{32}@<escaped xmppDomain>$`
     - `xmpp_password` matches `^xp1_[A-Za-z0-9_-]{32}$`
     - `nickname` passes `NICKNAME_RE`
     - `token` is 1..4096 characters of `[A-Za-z0-9._-]`
     - `token_type === 'Bearer'`
     - `expires_in` is an integer in 60..86400
     - Extra keys are tolerated. Anything else → `bad-response`.
   - **Validating the 200 from renew:** the same token, `token_type`, `expires_in` and nickname checks.
4. `web/src/api/deviceCredential.ts` (new): **the only file that touches browser storage.**
   - **Factory:** `createCredentialStore({ xmppDomain, slot, storage? })`.
   - **Key:** `nearby.identity.v1`, or `nearby.identity.v1.<slot>` when there is a slot.
   - **Default storage getter:** `() => { try { return window.localStorage } catch { return null } }`. Safari and disabled storage throw on access.
   - **`load()`:** JSON.parse inside try. The value must have exactly the keys `v, jid, xmppPassword, nickname`, with `v === 1` and the same jid, password and nickname rules as step 3. Anything else → `null` (treated as absent). The malformed entry is **left in place**, because nothing is deleted without a user action. The next onboarding save overwrites it.
   - **`save(c)`:** writes exactly `{"v":1,"jid","xmppPassword","nickname"}` and returns `{ok:true}` or `{ok:false}`. A setItem exception or no storage → `{ok:false}`.
   - **`clear()`:** returns a boolean.
   - The type has no token field, so a token cannot be persisted.
5. `web/src/api/tokenManager.ts` (new): implements D2. Interface below.
   - **Status:** in a closure, generation-guarded. The token never appears in the status, events or errors.
   - **Defaults:** `now = () => Date.now()`. Timers call `globalThis.setTimeout` / `globalThis.clearTimeout` at call time (so vitest fake timers apply). `online` = `navigator.onLine` plus the window `online` event.
   - **`start(cred, initial?)`:** calls `stop()` first, then either adopts `initial` (after onboarding) or renews at once (reload, Continue, Try again).
   - **Adopting a token:** `expiresAt = now + expiresIn*1000`. A single timer fires at `now + 0.8*expiresIn*1000` for the proactive renew. The backoff attempt counter resets.
   - **Single-flight:** a renew in flight is shared. `getToken()` while waiting on backoff cancels the backoff timer and renews now (user-driven, rare). The background loop alone obeys the backoff.
   - **Result mapping:**

     | Renew result | Effect |
     |---|---|
     | 200 | Adopt the token, status `valid`. |
     | http 401 | Status `identity-invalid` (terminal): clear the token, cancel timers, stop retrying. |
     | http 400 / 404 / 405 / 413 / 415 | Status `failed` (terminal, no retry). A still-unexpired token is kept until it expires. 404 is what a stale geo_service image returns. |
     | Anything else (5xx, 429, `network`, `timeout`, `bad-response`) | Schedule a retry. |

   - **Retry scheduling:** if `!isOnline()`, status `offline` and no timer. Otherwise `delay = max(retryAfterMs ?? 0, min(5000 * 2^attempt, 30000))` (5, 10, 20, 30, 30… s), status `retrying {nextAttemptAt}`.
   - **Offline:** the proactive timer and background retries never fetch while offline. An `online` event renews at once if the status is `offline` or `retrying`.
   - **`stop()`:** bumps the generation, aborts the in-flight renew, clears timers, the token and the cred, unsubscribes `online`, sets status `idle`. Late results are ignored.
6. `web/src/api/devIdentitySlot.ts` (new, pure, DEV-only use):
   - `readDevIdentitySlot(search)` → `{ slot: string | null; invalid: boolean }`, using `new URLSearchParams(search).get('identity')`.
   - Absent → `{slot:null, invalid:false}`. It must match `^[a-z0-9]{1,16}$`, otherwise (empty included) `{slot:null, invalid:true}`.
   - `DEV_SLOT_WARNING = 'Nearby (dev): ignoring an invalid dev identity slot; use ?identity= with 1-16 of a-z 0-9.'`
7. `web/src/api/index.ts` (new): the public entry. Re-exports the factories and types from steps 1–5 plus `validateNickname` / `NICKNAME_RE`. `devIdentitySlot` is imported directly by `main.tsx` only.
8. `web/src/config.ts`: add `apiUrl: string` and read `VITE_API_URL` (D7).
   - Unset or blank → `/api`.
   - Otherwise it must match `^/(?:[A-Za-z0-9._~-]+/)*[A-Za-z0-9._~-]+$` and have no `.` or `..` segment. This rules out `//`, a trailing `/`, `?`, `#`, whitespace, a scheme and a bare `/`.
   - Error `'VITE_API_URL must be a same-origin path such as /api'`, never echoing the value.
   - Error order becomes ws, domain, muc, api, tiles.
9. `web/src/main.tsx`:
   - Pass `VITE_API_URL: import.meta.env.VITE_API_URL` explicitly.
   - Build the services outside React:
     ```ts
     const devSlot = import.meta.env.DEV ? readDevIdentitySlot(window.location.search) : { slot: null, invalid: false };
     if (import.meta.env.DEV && devSlot.invalid) console.warn(DEV_SLOT_WARNING);
     ```
     Then `createHttp` → `createSessionApi` → `createCredentialStore({ xmppDomain, slot: devSlot.slot })` → `createTokenManager({ renew: sessionApi.renew })` → `createIdentityController({...})`, then `identity.start()` **before** `root.render`, so there is no flash of the Welcome page.
   - Render `<XmppProvider><IdentityProvider controller={identity}><App mucDomain mapTileUrl/></IdentityProvider></XmppProvider>`. `xmppDomain` is no longer an App prop.
10. `web/src/state/identity.ts` (new): the Zustand `useIdentityStore` (shape below, no password and no token) and the pure `selectAppView(identity, connection)`.
11. `web/src/state/identityController.ts` (new): `createIdentityController(deps)`, outside React like the XMPP client. It subscribes to `client` for connection state and to `tokens` for the token status kind.
    - The credential is held in a closure (it is also in localStorage anyway). The password passes only to `client.connect(jid, password)`, where ADR-010's closure keeps it for reconnect. It is never put in Zustand.
    - **`start()`:** `credentials.load()`. If there is a credential: set the nickname, `intent:'active'`, `tokens.start(cred)` (renew) and `connectWhenIdle(cred)`, so connect and renew run in parallel (D2). If not: `intent:'none'`.
    - **`onboard(raw)`:**
      - Ignore the call if `creating` is set or a nickname is present.
      - Run `validateNickname`. On failure set `onboardError` and stop.
      - Set `creating:true`, then `await session.create`.
      - On error, map it as in the table below and set `creating:false`.

        | Create result | `onboardError` |
        |---|---|
        | http 400 | `invalid` |
        | 409 | `taken` |
        | 502 / 503 / 504, `timeout`, `network` | `unavailable` |
        | Anything else (500, 413, 415, 404, `bad-response`) | `failed` |

      - On success: `credentials.save` **before** connecting (D6), then set `{nickname, intent:'active', remembered: saved.ok, creating:false}`, `tokens.start(cred, {token, expiresIn})` and `connectWhenIdle(cred)`.
    - **`continueSession()`:** used for both "Continue as X" and "Try again". Sets `intent:'active'`, then `tokens.start(cred)` and `connectWhenIdle(cred)`.
    - **`signOut()`:** cancels a pending connect, `tokens.stop()`, `intent:'signed-out'`, `client.disconnect()`. The credential stays.
    - **`startOver()`** (called only after the user confirms):
      1. Cancel a pending connect and `tokens.stop()`.
      2. `client.disconnect()` if connecting, connected or reconnecting.
      3. `credentials.clear()`, drop the in-memory credential.
      4. Reset the store to onboarding.
    - **`connectWhenIdle(cred)`:** if the client is `idle` or `disconnected`, connect now. Otherwise subscribe and connect on the first `idle`/`disconnected` state. Only one pending connect at a time; it is cancelled by signOut and startOver.
    - **Terminal disconnect:** a transition to `disconnected` while `intent==='active'` (auth-failed, connection-failed, conflict, pagehide) → `tokens.stop()`. A renew failure never touches XMPP.
    - **`dispose()`:** for tests and HMR. Unsubscribes and stops the tokens.
    - **Seam for 3e-3:** `tokens: TokenAccess`.
    - No console calls (lint-enforced).
12. `web/src/state/IdentityProvider.tsx` (new): a context with `useIdentityController()`, which throws outside the provider like `useXmppClient`.
13. `web/src/components/ConfirmDialog.tsx` (new): custom. jsdom does not implement `HTMLDialogElement.showModal`.
    - `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby` the title, `aria-describedby` the body.
    - Fixed overlay `fixed inset-0 z-20` with backdrop `bg-ink/40` (a token with opacity, no raw palette).
    - Initial focus on **Cancel** (the safe default for a destructive action). Tab and Shift+Tab cycle between the two buttons.
    - Escape → `onCancel`. A backdrop click → `onCancel`.
    - On unmount, focus goes back to the element that was focused when it opened, if it is still connected.
    - The destructive button is an outline: `border border-danger text-danger bg-surface`. Contrast is already documented for both modes, so no new token.
14. `web/src/components/IdentityNotice.tsx` (new). Props: `{ remembered: boolean; identityInvalid: boolean; onStartOver(): void }`.
    - Renders nothing when both are fine.
    - Not remembered → `role="status"` with `notRemembered`.
    - Identity invalid → `role="alert"` with `identityInvalid` plus a "Start over" button that opens the ConfirmDialog.
15. `web/src/pages/Welcome.tsx` (new). One page with a `view` prop union (Interfaces).
    - **`new` view:**
      - `<main>` with the h1 Wordmark, the tagline, h2 `heading` and the device note (the exact D1 copy).
      - A form with a labelled input (`id="nickname"`, `maxLength={20}`, `autoComplete="nickname"`, `autoCapitalize="none"`, `spellCheck={false}`), `aria-describedby` = hint id (+ error id when an error is shown) and `aria-invalid` when there is a field error.
      - Validation runs on submit with `validateNickname`. A local error, or a server `invalid`/`taken`, shows in `<p id="nickname-error">` and focuses the input.
      - `unavailable`/`failed` show in a `role="alert"` paragraph.
      - A server error is shown only while the input still equals the submitted value, so editing hides it.
      - The submit button uses `aria-disabled` plus a guard while busy, not `disabled`, so focus is not lost (ADR-012 pattern). Its label switches to "Creating…".
    - **`returning` view:**
      - Heading `returningHeading` and the nickname.
      - If `error` is set, a `role="alert"` with `describeConnectionError(error)`.
      - Primary button: `continueAs(nickname)` with no error, `tryAgain` with an error.
      - Secondary button `startOver`, which opens the ConfirmDialog. Confirming calls `onStartOver`.
      - Both buttons are `aria-disabled` while `busy`.
    - **`connecting` view:** `role="status"` with `connecting(nickname)` and a "Cancel" button → `onCancel` (signOut). A hung WebSocket must not trap the user.
    - Mobile-first: `mx-auto grid min-h-dvh max-w-md content-center p-4`, the same card styles as the old LoginForm.
16. `web/src/App.tsx`: `useXmppStoreBinding(client)`, read `useIdentityStore` and the session connection, then `switch (selectAppView(...))` → Welcome (new / returning / connecting) or Chat.
    - Chat gets `nickname`, `onSignOut={identity.signOut}` and `banner={<IdentityNotice … onStartOver={identity.startOver}/>}`.
    - `identityInvalid = token === 'identity-invalid'`.
17. `web/src/pages/Chat.tsx`:
    - New props `nickname: string`, `onSignOut(): void`, `banner?: ReactNode`.
    - `useAreaRoom(client, desiredRoomJid, nickname)` replaces `localpartOf(jid)`. Drop the `localpartOf` and `selectSessionJid` use that only existed for the nick.
    - Render `banner` under the ConnectionBanner.
    - `AppHeader` gets `name={nickname}` and `onSignOut={onSignOut}`.
18. `web/src/components/AppHeader.tsx`: props `{ connection, name, onSignOut }`. Shows `name`, never a jid. The "Sign out" label comes from `IDENTITY_TEXT.signOut`.
19. `web/src/ui/text.ts`:
    - Add `IDENTITY_TEXT` (exact strings below).
    - Rewrite the `describeConnectionError` copy.
    - Delete `describeAddressError`, `AddressKind` and `AddressError`.
    - Keep `INVALID_ROOM` (`JOIN_FAILURES['invalid-room']` uses it).
20. Delete `web/src/pages/DevLogin.tsx`, `web/src/components/LoginForm.tsx` and `web/src/ui/addresses.ts` (the whole file: `toAccountJid` is dead once LoginForm goes). `isValidRoomJid` stays in `xmpp/`.
21. `web/eslint.config.js` (D4, the parts that apply now):
    - **Constants:**
      - `NET_GLOBALS` = `fetch`, `XMLHttpRequest`
      - `STORAGE_GLOBALS` = `localStorage`, `sessionStorage`, `indexedDB`
      - matching `no-restricted-properties` entries for objects `window`, `globalThis`, `self` × `fetch`, `XMLHttpRequest`, `localStorage`, `sessionStorage`, `indexedDB`
      - `{object:'navigator', property:'sendBeacon'}`
    - **Base `**/*.{ts,tsx}` block:** `no-restricted-globals` = NET + STORAGE; `no-restricted-properties` = all of the above.
    - **`src/api/**`:**
      - globals and properties for STORAGE only (fetch allowed)
      - `no-restricted-imports: restrict(STROPHE, LEAFLET, API_LEAF)` with `API_LEAF = { group: ['../*', '../**'], message: 'src/api/ is a leaf: it imports nothing from the rest of the app.' }`
      - `no-console: ['error', {}]`
    - **`src/api/deviceCredential.ts`:** globals NET + `sessionStorage` + `indexedDB`; properties without the `localStorage` entries.
    - **`src/state/identity*.{ts,tsx}` and `src/pages/Welcome.tsx`:** `no-console: ['error', {}]`.
    - **`src/xmpp/**` and `src/xmpp/strophe/**`:** add `API_ANY = { group: ['**/api', '**/api/*'], message: 'src/xmpp/ must not depend on api/.' }` to their existing restrict lists.
    - **`tests/**`:** `no-restricted-globals` and `no-restricted-properties` off (fakes need fetch and storage).
    - Messages: "Only src/api/ may make network requests." / "Only src/api/deviceCredential.ts may use browser storage."
    - Keep the comment that flat config replaces a rule wholesale per block.
22. `web/vite.config.ts`: in the `test` block add `testTimeout: 20_000`, with a comment. Reason: the baseline shows 3–8 `userEvent` tests timing out at the 5 s default on this machine; heavy tests already pass 20 s by hand.
23. Docs:
    - **`docs/ARCHITECTURE.md`:**
      - Frontend tree: `api/` lists `http.ts`, `session.ts`, `tokenManager.ts`, `deviceCredential.ts` (the only storage user), `nickname.ts`, `devIdentitySlot.ts` (dev), `index.ts`, replacing `geoService.ts`.
      - `state/` adds `identity.ts`, `identityController.ts`, `IdentityProvider.tsx`.
      - `pages/` becomes `Welcome, Chat`.
      - Login flow gets client steps 3–6: store the credential before connecting; JWT in memory only; on reload auto-connect plus renew in parallel; proactive renew at 80%; a renew failure never disconnects XMPP; MUC nick = the profile nickname.
    - **`README.md`:**
      - Rewrite "Web client (dev)": open http://localhost:5173 and pick a name. The name is stored on this device only. alice and bob remain only for the smoke page.
      - Rewrite "Phase 2 demo" steps 2–4: no dev-seed needed for the web app; open a second window with `http://localhost:5173/?identity=b` (dev only, a separate stored name) or a private window and pick another name.
      - Add a short "Removing test names" snippet (the cleanup commands from AC "cleanup").
    - **`docs/ROADMAP.md`:** under Phase 3, add "Slice 3e-2: client identity (Welcome, device credential, token manager)", unticked. The orchestrator ticks it after the live checks.
    - **`docs/DECISIONS.md`:** update ADR-019 (see the ADR section).

### Interfaces
```ts
// api/http.ts
export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
export interface Timers { set(fn: () => void, ms: number): TimerHandle; clear(h: TimerHandle): void }
export interface HttpResponseLike { status: number; headers: { get(name: string): string | null }; text(): Promise<string> }
export type FetchLike = (url: string, init: RequestInit) => Promise<HttpResponseLike>;
export type ApiError =
  | { kind: 'network' } | { kind: 'timeout' } | { kind: 'aborted' } | { kind: 'bad-response' }
  | { kind: 'http'; status: number; code: string | null; retryAfterMs: number | null };
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };
export interface HttpResponse { status: number; body: unknown; retryAfterMs: number | null }
export interface PostOptions { timeoutMs: number; signal?: AbortSignal; token?: string }
export interface Http { postJson(path: `/${string}`, body: unknown, opts: PostOptions): Promise<ApiResult<HttpResponse>> }
export function createHttp(o: { baseUrl: string; fetch?: FetchLike; timers?: Timers }): Http;

// api/deviceCredential.ts
export interface DeviceCredential { jid: string; xmppPassword: string; nickname: string }
export const CREDENTIAL_KEY = 'nearby.identity.v1';
export interface CredentialStore { load(): DeviceCredential | null; save(c: DeviceCredential): { ok: boolean }; clear(): boolean }
export function createCredentialStore(o: { xmppDomain: string; slot: string | null; storage?: () => Storage | null }): CredentialStore;

// api/session.ts
export interface CreatedSession { credential: DeviceCredential; token: string; expiresIn: number }
export interface RenewedSession { nickname: string; token: string; expiresIn: number }
export interface SessionApi {
  create(nickname: string): Promise<ApiResult<CreatedSession>>;          // POST {apiUrl}/session {"nickname"}
  renew(c: DeviceCredential, signal?: AbortSignal): Promise<ApiResult<RenewedSession>>; // POST {apiUrl}/session/renew {"jid","xmpp_password"}
}
export function createSessionApi(http: Http, o: { xmppDomain: string }): SessionApi;

// api/tokenManager.ts
export type TokenStatus =
  | { kind: 'idle' } | { kind: 'renewing' } | { kind: 'valid'; expiresAt: number }
  | { kind: 'retrying'; nextAttemptAt: number } | { kind: 'offline' }
  | { kind: 'identity-invalid' } | { kind: 'failed' };
export type TokenResult = { ok: true; token: string } | { ok: false; error: 'stopped' | 'offline' | 'identity-invalid' | 'unavailable' };
export type WithTokenResult<T> = ApiResult<T> | { ok: false; error: { kind: 'token'; reason: Exclude<TokenResult, {ok:true}>['error'] } | { kind: 'unauthorized' } };
export interface TokenAccess {
  getToken(): Promise<TokenResult>;  // token with >= 60 s left, else single-flight renew
  /** 3e-3 seam: call(token); on http 401 drop that token, renew once, retry once; second 401 -> {kind:'unauthorized'} */
  withToken<T>(call: (token: string) => Promise<ApiResult<T>>): Promise<WithTokenResult<T>>;
  getStatus(): TokenStatus;
  subscribe(l: (s: TokenStatus) => void): () => void;
}
export interface TokenManager extends TokenAccess {
  start(c: DeviceCredential, initial?: { token: string; expiresIn: number }): void;
  stop(): void;
}
export function createTokenManager(o: {
  renew: SessionApi['renew']; now?: () => number; timers?: Timers;
  online?: { isOnline(): boolean; subscribe(cb: () => void): () => void };
  renewAtFraction?: number /*0.8*/; minValidityMs?: number /*60_000*/; backoffBaseMs?: number /*5_000*/; backoffMaxMs?: number /*30_000*/;
}): TokenManager;

// state/identity.ts
export type OnboardError = 'empty' | 'invalid' | 'taken' | 'unavailable' | 'failed';
export interface IdentityState {
  nickname: string | null;                 // null = no credential
  intent: 'none' | 'active' | 'signed-out';
  creating: boolean;
  onboardError: OnboardError | null;
  remembered: boolean;                     // false after a failed storage write
  token: TokenStatus['kind'];
}
export type AppView =
  | { kind: 'onboarding'; busy: boolean; error: OnboardError | null }
  | { kind: 'connecting'; nickname: string }
  | { kind: 'chat'; nickname: string }
  | { kind: 'returning'; nickname: string; error: ConnectionError | null; busy: boolean };
export function selectAppView(id: IdentityState, c: ConnectionState): AppView;
```

`selectAppView` rules, in order:
1. `nickname === null` → `onboarding`.
2. `intent === 'signed-out'` → `returning{error:null, busy: c.status === 'disconnecting'}`.
3. Otherwise, by connection status:
   - `connected` | `reconnecting` → `chat`
   - `idle` | `connecting` → `connecting`
   - `disconnecting` → `returning{busy:true, error:null}`
   - `disconnected` → `returning{error: c.error ?? null, busy:false}`

```ts
// state/identityController.ts
export interface IdentityController {
  start(): void; onboard(nickname: string): Promise<void> /* never rejects */;
  continueSession(): void; signOut(): void; startOver(): void; dispose(): void;
  readonly tokens: TokenAccess;
}
export function createIdentityController(d: { client: XmppClient; credentials: CredentialStore; session: SessionApi; tokens: TokenManager; store?: typeof useIdentityStore }): IdentityController;

// pages/Welcome.tsx
export type WelcomeProps =
  | { view: 'new'; busy: boolean; error: OnboardError | null; onCreate(nickname: string): void }
  | { view: 'returning'; nickname: string; busy: boolean; error: ConnectionError | null; onContinue(): void; onStartOver(): void }
  | { view: 'connecting'; nickname: string; onCancel(): void };
// components/ConfirmDialog.tsx
export interface ConfirmDialogProps { title: string; body: string; confirmLabel: string; cancelLabel: string; onConfirm(): void; onCancel(): void }
```

**Stored value (exact):** `localStorage["nearby.identity.v1"]` (or `"nearby.identity.v1.<slot>"`) = `{"v":1,"jid":"u<32hex>@chaterl.localhost","xmppPassword":"xp1_<32>","nickname":"<nick>"}`.

**`ui/text.ts` strings (exact):**
```ts
export const IDENTITY_TEXT = {
  tagline: 'Chat with people around you',
  heading: 'Pick a name',
  nicknameLabel: 'Your name',
  nicknameHint: '2–20 characters: letters, numbers, - or _. Start with a letter or number.',
  deviceNote: "Nearby gives you a name on this device only. There's no email or password. If you clear this browser's data or switch devices, you'll start again with a new name.",
  submit: 'Start chatting',
  creating: 'Creating…',
  errorEmpty: 'Enter a name.',
  errorInvalid: 'Names are 2–20 characters: letters, numbers, - or _, starting with a letter or number.',
  errorTaken: 'That name is taken. Try another.',
  errorUnavailable: "Nearby can't create names right now. Try again in a few seconds.",
  errorFailed: 'Something went wrong. Try again.',
  returningHeading: 'Welcome back',
  continueAs: (name: string): string => `Continue as ${name}`,
  tryAgain: 'Try again',
  startOver: 'Start over with a new name',
  connecting: (name: string): string => `Signing you in as ${name}…`,
  cancel: 'Cancel',
  signOut: 'Sign out',
  notRemembered: "This name won't be remembered on this device.",
  identityInvalid: "Nearby can't confirm your name anymore. You can keep chatting for now, or start over with a new name.",
  identityInvalidAction: 'Start over',
  confirmTitle: 'Start over with a new name?',
  confirmBody: "Your current name can't be recovered.",
  confirmAction: 'Start over',
} as const;
export function describeOnboardError(e: OnboardError): string; // empty→errorEmpty, invalid→errorInvalid, taken→errorTaken, unavailable→errorUnavailable, failed→errorFailed
// describeConnectionError (rewritten):
// auth-failed:       "Nearby couldn't sign you in with this name."
// connection-failed: "Can't reach the chat server right now. Try again in a moment."
// connection-lost:   'Connection lost. Try again.'
// error:             'Something went wrong. Try again.'
```

### Tests required
Every new component or integration test uses `userEvent.setup({ delay: null })`. `testTimeout` is 20 s globally.

- **`tests/api/http.test.ts`** (fake fetch returning `HttpResponseLike`; vitest fake timers):
  - URL is `baseUrl + path`; method, headers, `credentials:'omit'`, `cache:'no-store'`, `redirect:'error'`; Bearer header only when `token` is given
  - body is JSON
  - 2xx JSON parsed; empty body → null; bad JSON on 2xx → `bad-response`, on 4xx → `body:null`; over 64 KiB → `bad-response`
  - `retry-after` "5" → 5000; "abc", "-1", "99999", missing → null; "301" → 300000
  - rejected fetch → `network`
  - timeout at exactly `timeoutMs` → `timeout` and the fetch signal is aborted
  - external abort → `aborted`; an already-aborted signal → no fetch call
  - timer and listener cleared after success (no pending timers)
  - never throws, even if the fetch fake throws synchronously
- **`tests/api/session.test.ts`:**
  - create: 201 happy path maps to `{credential, token, expiresIn}`
  - create: 200 → `bad-response`
  - create: each 201 field violated in turn → `bad-response`: jid of another domain, uppercase hex, a resource; password 31 characters; missing token; `token_type` "bearer"; `expires_in` 0 or 3600.5
  - create: extra keys tolerated
  - create: 409 `{error:'nickname_taken'}` → http 409 code `nickname_taken`; 503 + `retry-after` → `retryAfterMs`
  - renew: 200 happy path
  - renew: 401 code `invalid_credentials`
  - renew: request body is exactly `{"jid","xmpp_password"}` (no nickname)
  - renew: timeouts passed are 15 000
- **`tests/api/deviceCredential.test.ts`** (in-memory `Storage` fake; a throwing fake; `storage: () => null`):
  - save → exact JSON string and key
  - slot `b` → key `nearby.identity.v1.b`; slots are isolated
  - load round-trip
  - load returns null for: missing, non-JSON, an array, `v:2`, an extra key, a missing key, a wrong domain, a bad password, a bad nickname. In every case the entry is **still present** afterwards.
  - setItem throws → `{ok:false}`
  - no storage → load null, save `{ok:false}`
  - clear removes only its own key
- **`tests/api/tokenManager.test.ts`** (vitest `useFakeTimers()`, `now: () => Date.now()`, a deferred `renew` fake, a fake `online` object; `await vi.advanceTimersByTimeAsync`):
  - `start(cred, initial)` → `valid`, no renew; renew fires at exactly 80% (2880 s for 3600), not at 2879.999 s
  - `start(cred)` renews immediately
  - single-flight: 3 concurrent `getToken()` calls → 1 renew
  - `getToken` with ≥ 60 s left returns without a renew; with 59 s left it renews
  - 401 → `identity-invalid`, no further renews after 10 min, `getToken` → `identity-invalid`
  - 400 and 404 → `failed`, no retry
  - 503 with `retry-after` 20 s → next at 20 s (max wins); without it the backoff runs 5, 10, 20, 30, 30 s, then resets after a success
  - timeout and network errors are retried the same way
  - offline: a failure while offline → `offline` with no timer; the `online` event → renew at once; the proactive timer while offline → no fetch
  - `stop()` during an in-flight renew → its signal is aborted, a late resolve is ignored (status stays `idle`, no token)
  - `stop()` then `start()` → an old-generation result ignored
  - `stop()` removes the online listener and clears timers (`vi.getTimerCount() === 0`)
  - `withToken`: 200 passes through; a 401 then renew then 200 → exactly 2 calls, the second with the new token; 401, 401 → `unauthorized` after exactly one renew; token failure → `{kind:'token'}` with no call
  - privacy: status objects and subscriber payloads never contain the token string (JSON.stringify check)
  - `getToken` during backoff renews at once
- **`tests/api/nickname.test.ts`:**
  - valid: `ab`, `A1`, `a_b-c`, 20 characters, padded `"  Alice "` → `Alice`
  - invalid: empty or whitespace → `empty`; `a`, 21 characters, `_ab`, `-ab`, `a b`, `ä1`, `a.b` → `invalid`
- **`tests/api/devIdentitySlot.test.ts`:**
  - `''` and `?x=1` → null, not invalid
  - `?identity=b`, `?identity=abc123` → slot
  - `?identity=`, `?identity=B`, 17 characters, `?identity=a-b`, `?identity=%20` → invalid
  - first value wins for a repeated param
- **`tests/state/identity.test.ts`:** a `selectAppView` table covering every intent × connection status. Includes disconnected with auth-failed / connection-failed / no error, and signed-out while disconnecting → busy.
- **`tests/state/identityController.test.ts`** (real client on `createFakeTransport`; fake `SessionApi`; real credential store on an in-memory Storage; fake TokenManager spy, plus one case with the real one):
  - `start()` with no credential → onboarding, no connect
  - `start()` with a credential → `connectCalls[0]` = stored jid and password, and `tokens.start(cred)` with no initial token, in the same tick
  - `onboard` happy path: save happens **before** `transport.connect` (call order recorded); `tokens.start` gets the initial token; store has `remembered:true`
  - save failure → still connects, `remembered:false`
  - onboard error mapping: 400, 409, 503, 502, `timeout`, `network`, 500, 413, `bad-response`; no save and no connect on any of them
  - double `onboard` while creating → one `create` call
  - invalid local nickname → no `create` call
  - `signOut` → `disconnectCalls ['user']`, `tokens.stop`, intent signed-out, storage unchanged
  - `continueSession` while the client is still `disconnecting` → no connect until `disconnected` is pushed, then exactly one
  - `startOver` while connected → disconnect, `tokens.stop`, storage key removed, store reset
  - `startOver` cancels a pending `connectWhenIdle` (no connect after the disconnect completes)
  - auth-failed after start → `tokens.stop`, storage intact
  - token `identity-invalid` → store `token` updates, no disconnect
  - privacy: `JSON.stringify(useIdentityStore.getState())` contains neither the password nor the token
  - `dispose` unsubscribes
- **`tests/pages/Welcome.test.tsx`:**
  - new: labelled input, hint linked by `aria-describedby`, device note shown, h1 and h2
  - empty submit → `errorEmpty`, `aria-invalid="true"`, error id in `aria-describedby`, focus on the input, `onCreate` not called
  - `a` → `errorInvalid`
  - a valid name trimmed → `onCreate('Alice')`
  - busy → label "Creating…", `aria-disabled`, Enter does not call `onCreate`
  - error `taken` → field error, focused; editing hides it
  - `unavailable` → `role=alert` with the exact copy
  - returning: "Continue as Alice" calls `onContinue`
  - returning with an auth-failed error → alert copy plus "Try again"
  - "Start over with a new name" → dialog; Cancel → no `onStartOver`, focus back on the trigger; confirm → `onStartOver` once
  - connecting: status text plus Cancel
  - keyboard-only path: Tab to the input, type, Enter
- **`tests/components/ConfirmDialog.test.tsx`:**
  - `role=alertdialog`, `aria-modal`, labelled and described
  - initial focus on Cancel
  - Tab from the last button wraps to the first; Shift+Tab wraps back
  - Escape → `onCancel`; backdrop click → `onCancel`
  - focus returns to the opener on unmount
- **`tests/components/IdentityNotice.test.tsx`:**
  - nothing rendered when both are fine
  - `notRemembered` as `role=status`
  - identity invalid as `role=alert`, plus Start over through the confirm dialog
- **`tests/lint/boundaries.test.ts`** (`// @vitest-environment node`):
  - Setup: `new ESLint({ cwd: webRoot, overrideConfig: tseslint.configs.disableTypeChecked })`, with `webRoot` from `fileURLToPath(new URL('../..', import.meta.url))`. `lintText(code, { filePath: path.join(webRoot, rel) })`. Assert on `ruleId` only. 60 s timeout on the describe.
  - **Errors:**
    - `fetch('/x')` in `src/components/F.tsx` → no-restricted-globals
    - `window.fetch`, `globalThis.fetch`, `self.fetch` in `src/state/f.ts` → no-restricted-properties
    - `new XMLHttpRequest()` in `src/pages/F.tsx`
    - `navigator.sendBeacon('/x')` in `src/geo/f.ts`
    - `localStorage.getItem('k')` in `src/components/F.tsx` and in `src/api/http.ts`
    - `window.localStorage` in `src/App.tsx`
    - `sessionStorage` and `indexedDB` in `src/api/deviceCredential.ts`
    - `import { createHttp } from '../api'` in `src/xmpp/client.ts` and in `src/xmpp/strophe/s.ts` → no-restricted-imports
    - `import x from '../state/session'` and `'../xmpp'` in `src/api/session.ts` → no-restricted-imports
    - `console.warn('x')` in `src/api/http.ts` and `src/state/identityController.ts` → no-console
  - **No error for those rules:**
    - `fetch` in `src/api/http.ts`
    - `localStorage` in `src/api/deviceCredential.ts`
    - `import { createHttp } from './http'` in `src/api/index.ts`
    - `fetch` and `localStorage` in `tests/x.test.ts`
- **`tests/config.test.ts`** (extend):
  - unset or blank → `/api`
  - accepted: `/api`, `/v1/api`, `/a.b_c~d-e`
  - rejected: `api`, `//evil`, `/api/`, `/`, `/api?x`, `/api#x`, `/a b`, `/../x`, `/./x`, `http://x/api`, `/api\n`
  - the value is never echoed
  - error order is ws, domain, muc, api, tiles
- **`tests/ui/text.test.ts`:**
  - `describeConnectionError` table gets the new copy
  - remove the address cases
  - add `IDENTITY_TEXT` and `describeOnboardError` to the jargon checks, using `/\b(JID|XMPP|MUC|occupant|token|credential|localpart)\b/i`. "password" is allowed: the device note says "no email or password".
  - exact-copy assertions for D1 / D6 / confirm
- **`tests/components/round2.test.tsx`:**
  - AppHeader renders `name="Alice_1"`, has no jid text, and Sign out calls back
  - `describeConnectionError('connection-lost')` → the new copy
- **`tests/components/brand.test.tsx`:** the Chat test passes `nickname="alice"` and `onSignOut`. The status line assertion is unchanged.
- **`tests/components/components.test.tsx`:** delete the `LoginForm` describe (6 tests) and its imports.
- **`tests/ui/addresses.test.ts`:** delete (17 tests).
- **`tests/integration/chatFlow.test.tsx`** (rewrite):
  - **Setup:** `mountApp({ stored?: DeviceCredential, fetchRoutes })` builds the fake transport and client, an in-memory Storage, `createHttp` with a routing fake fetch (it records requests), a real session API, a real token manager and a real controller. It calls `start()`, renders `XmppProvider > IdentityProvider > App`, and calls `dispose()` in `afterEach`.
  - **Helper:** `signInReturning()` seeds the storage so the app auto-connects. It replaces the old password typing in every existing area-room and history test, which stay otherwise unchanged.
  - **New and rewritten cases:**
    - (a) **Onboarding happy path.** The Welcome form appears. Type `Alice_1` and submit. The POST `/api/session` body is `{"nickname":"Alice_1"}`. Storage holds the exact 4-key JSON, with no token string anywhere. `connectCalls[0]` uses the response jid and password. Push `connected`; the header shows `Alice_1`. Locate; the join presence goes to `${CELL_ROOM}/Alice_1` (**not** the localpart). Send a message; the echo shows.
    - (b) **Returning.** No form. Connect and renew are called before any user action; the renew body is `{"jid","xmpp_password"}`.
    - (c) **Sign out → "Continue as Alice_1" → continue.** `connectCalls` is 2 with the same credentials, and the chat is back.
    - (d) **Start over.** Escape cancels (storage unchanged, focus back on the trigger). Confirming removes the key and shows the new-name form.
    - (e) **409.** Taken copy, `aria-invalid`, no storage write, no connect.
    - (f) **503, a rejected fetch, and a 15 s timeout (fake timers).** Each shows the unavailable alert.
    - (g) **Auth-failed for a stored credential.** Alert copy, "Try again" and "Start over". Try again → a second connect; storage untouched.
    - (h) **Renew 401 while connected.** Chat stays; `role=alert` notice with Start over; `disconnectCalls` empty; storage untouched.
    - (i) **Renew 503 while connected.** No notice and no disconnect; after advancing 5 s a second renew request goes out.
    - (j) **`setItem` throws during onboarding.** Connects anyway and shows the not-remembered notice.
    - (k) **Dropped connection.** The existing test, adapted; the token manager is not stopped by `reconnecting`.
    - (l) **Signing out while reconnecting.** Returning card; continue; the next session starts clean (adapted from the existing test).
    - (m) **Privacy across (a), (b) and (h).** Spy on `console.log/info/warn/error/debug`: no call argument contains the password or either token. Storage never contains a token.
  - The existing "privacy: no coordinate…" test stays.
- **Expected counts:** baseline 788 tests. Removed: 6 (LoginForm) + 17 (addresses) + 6 (address jargon cases) = 29, so 759 before additions. Report the exact before/after totals per file. No untouched file may lose tests.

### Acceptance criteria
- [ ] AC1. `web/src/api/` exists with the modules and interfaces above. It imports nothing from the rest of `src/` (lint-enforced) and contains no `console` call.
- [ ] AC2. Network access (`fetch`, `XMLHttpRequest`, `navigator.sendBeacon`, including the `window.`/`globalThis.`/`self.` forms) happens only in `src/api/**`. Browser storage happens only in `src/api/deviceCredential.ts`. `src/xmpp/**` cannot import `api`. All three are proven by `tests/lint/boundaries.test.ts`.
- [ ] AC3. With no stored credential the Welcome form is shown. A valid name triggers `POST {apiUrl}/session`, stores `{"v":1,jid,xmppPassword,nickname}` **before** `client.connect`, connects with those credentials, and joins the area room with the **nickname** as MUC nick. The header shows the nickname, never a jid or localpart.
- [ ] AC4. With a stored valid credential, start-up shows no form: XMPP connect and renew start in parallel, before render.
- [ ] AC5. Onboarding errors show the exact copy:
  - local or 400 → the rule
  - 409 → "That name is taken. Try another."
  - 502/503/504, timeout (15 s) or network → "Nearby can't create names right now. Try again in a few seconds."
  - else → "Something went wrong. Try again."
  
  Field errors set `aria-invalid` and focus the input. Others use `role=alert`. The busy label is "Creating…".
- [ ] AC6. Sign out disconnects XMPP, stops the token manager, keeps the credential, and shows "Continue as {nickname}" and "Start over with a new name". Continue reconnects with the same credential.
- [ ] AC7. Start over always goes through an accessible `role=alertdialog` (labelled, described, focus starts on Cancel, Tab trapped, Escape cancels, focus returns to the opener). Only confirming clears the stored credential.
- [ ] AC8. An XMPP auth failure (or any terminal failure) with a stored credential shows the error, "Try again" and "Start over", and wipes nothing.
- [ ] AC9. Renew 401 shows the identity-invalid notice with Start over, keeps XMPP connected, and wipes nothing. Renew 503, timeout or network errors keep XMPP connected and retry after max(retry-after, 5→10→20→30 s), never while offline, and at once on `online`.
- [ ] AC10. The token is memory-only: never in storage, Zustand state, status objects or console output. The token manager renews at 80% of `expires_in`, single-flights renews, and exposes `getToken` / `withToken` for 3e-3.
- [ ] AC11. A failed storage write still connects and shows "This name won't be remembered on this device."
- [ ] AC12. A fast Continue or Start over while the old session is still disconnecting connects exactly once, after the disconnect completes.
- [ ] AC13. `VITE_API_URL` is optional (default `/api`), validated per D7, never echoed, and passed explicitly in `main.tsx`.
- [ ] AC14. DEV-only `?identity=<[a-z0-9]{1,16}>` selects storage key `nearby.identity.v1.<slot>`. An invalid value is ignored with one console warning in dev.
- [ ] AC15. `DevLogin.tsx`, `LoginForm.tsx`, `ui/addresses.ts` and `describeAddressError` are gone, with no remaining references. alice and bob still work on the smoke page.
- [ ] AC16. All new strings are in `ui/text.ts`, have no jargon, and use only the existing colour tokens.
- [ ] AC17. `npm run test` passes (report the totals before and after per file, and the removed tests by name). `npm run typecheck` and `npm run lint` are clean. `npm run build` succeeds.
- [ ] AC18. Docs are updated (ARCHITECTURE tree and login flow, README dev and demo sections, ROADMAP line, ADR-019 client section). CLAUDE.md is untouched.
- [ ] AC19 [LIVE]. Onboarding as a new name connects and chats in the area room (Test spot A gives `g7_u4pruyd`). The join presence is to `g7_u4pruyd@muc.chaterl.localhost/<Nickname>`.
- [ ] AC20 [LIVE]. Reload: no form, auto-connects, same nickname. The Network tab shows one `/api/session/renew` with 200.
- [ ] AC21 [LIVE]. A second window `http://localhost:5173/?identity=b` with another name: both are in the same area chat, see each other in "People here · 2", and messages go both ways. A private window also works.
- [ ] AC22 [LIVE / prod dist].
  - **Build:** `cd web && npm run build`, then still exactly one `.js` and one `.css` in `dist/assets`. Report the byte deltas against the step-0 baseline; JS growth must be at most +8 000 B raw.
  - **Must be 0** in `dist`, by `grep -rEc` (Git Bash):
    - `Development sign-in|dev seed|login-username|current-password|Usernames use letters|Enter a room name|Use an account on`
    - `alice` (case-sensitive)
    - `dev identity slot|Test spot A|Test locations|leaflet|openstreetmap`
  - **Must be ≥ 1** (proves the build is the new one): `nearby.identity.v1` and `That name is taken. Try another.`
- [ ] AC23 [LIVE]. Sign out → "Continue as X" → continue works, same nickname, back in the room.
- [ ] AC24 [LIVE]. Start over → dialog (Escape cancels first) → confirm → new-name form → a new name works. The old key is overwritten or removed.
- [ ] AC25 [LIVE]. The taken name from AC19, typed in another case in window b → "That name is taken. Try another."
- [ ] AC26 [LIVE]. `docker compose stop mongooseim`, then onboard a new name in a fresh slot (`?identity=c`) → the 503 copy within about 10 s. Then `start mongooseim`.
- [ ] AC27 [LIVE]. `docker compose stop mongo`, then reload a signed-in window. XMPP connects and chat works. The renew calls return 503 and retry with growing gaps (about 5, 10, 20 s, Network tab). No notice; XMPP never drops. After `start mongo` the next renew returns 200.
- [ ] AC28 [LIVE]. `Object.keys(localStorage)` contains only `nearby.identity.v1` and `nearby.identity.v1.<slot>` keys. sessionStorage is empty.
- [ ] AC29 [LIVE]. The JWT (copied from the renew response in the Network tab, compared inside the page, never printed) does not appear in any localStorage value.
- [ ] AC30 [LIVE]. The console shows no password or token across onboarding, reload, sign-out and continue. Search the console for `xp1_` and `eyJ`: 0 hits.
- [ ] AC31 [LIVE]. At 360×640, Welcome (new, returning, connecting), the dialog and Chat with the notice have no horizontal overflow (`scrollWidth === 360`).
- [ ] AC32 [LIVE]. Keyboard only: Tab to the name field, type, Enter → chat. Sign out → Tab to "Start over…" → Enter → focus is on Cancel → Escape → focus back on the trigger.
- [ ] AC33 [LIVE cleanup]. For each test nickname:
  - Find the localpart: `MSYS_NO_PATHCONV=1 docker compose exec -T mongo mongosh --quiet chaterl --eval 'db.profiles.find({nickname:{$in:[...]}},{_id:1}).toArray()'`
  - Remove the account: `MSYS_NO_PATHCONV=1 docker compose exec mongooseim mongooseimctl account removeUser --user <localpart>@chaterl.localhost`
  - Delete the profile: `db.profiles.deleteMany({_id:{$in:[...]}})`
  
  Afterwards `listUsers` shows only alice and bob.

### Risks / watch-outs
- **Privacy and secrets:**
  - The password is now in localStorage (D1, accepted XSS exposure). Never add `dangerouslySetInnerHTML` or third-party scripts.
  - The device credential sits in a closure in the controller and in the XMPP client. It must never go into Zustand (devtools), errors, console or URLs.
  - The `?identity` slot carries no secret.
- **Two tabs, same identity:** two sessions with the same jid and server-assigned resources (ADR-010). Both join with the same nick, and one becomes `Name-2` through the existing conflict retry. Accepted; note it in ADR-019.
- **Sign out vs pagehide:** `pagehide` disconnects without an error. A bfcache restore shows "Continue as X". That is intended.
- **Orphans:** a 201 that fails client validation leaves an orphan identity, consistent with ADR-017's accepted orphan case.
- **`clear()` failing on Start over:** the next reload would bring back the old identity. Edge case; accepted and documented.
- **Timer limits:** a background-tab throttle or sleep can fire the 80% timer late. The lazy `getToken` check covers it. `setTimeout` for 2880 s is well under the 2^31 ms limit.
- **Literal DEV guard:** keep the `import.meta.env.DEV ? … : …` ternary literal in `main.tsx` (ADR-014). An indirect boolean keeps `devIdentitySlot` in the bundle. AC22 catches it.
- **ESLint:**
  - Flat config replaces a rule wholesale per block. Every block that sets `no-restricted-imports`, `-globals` or `-properties` must re-list everything it still needs.
  - The lint test overrides type-aware parsing (virtual files are not in the TS project). It asserts guard rules only.
- **Windows:**
  - Build lint fixture paths with `path.join` from a `fileURLToPath` root, and pass `cwd: webRoot` so `src/api/**` globs match.
  - Vite listens on `localhost` (::1). Hand-written curl must use `localhost:5173`, not 127.0.0.1.
  - Use `MSYS_NO_PATHCONV=1` and `exec -T` for the docker commands.
  - Run test, typecheck, lint and build one after another, never in parallel. The full suite takes about 4 minutes here.
- **Test flakiness:** `userEvent` component tests can time out at 5 s on this machine. Step 22 adds `testTimeout: 20_000`. Don't "fix" a timeout by weakening assertions.
- **Stale geo_service image:** a renew 404 means the image wasn't rebuilt (seen in 3e-1). It maps to `failed`. Check `docker compose build geo_service` before the live checks.

### Out of scope
- `/api/locate` calls, removing `roomJidForCell`, the `**/api/locate` import guard, locate error states (all 3e-3).
- Server-side `removeUser` or profile deletion on Start over (D1: none in 3e).
- MUC lock-down, rate limits, CSP.
- Any geo_service, MongooseIM or Mongo change.
- A visible dev-slot badge.
- Native `<dialog>`.
- New dependencies.
- Editing CLAUDE.md.

### ADR
**Update ADR-019; no ADR-020 is needed.** Every choice above implements D1/D2/D4–D7 or follows from them.
- **Status line:** "Accepted. Server part 3e-1. Client identity 3e-2: D1, D2 (token manager; first use in 3e-3), D4 (network, storage and xmpp guards; the locate guard comes in 3e-3), D5, D6, D7. D3 confirmed 2026-11-21, lands in 3e-2/3e-3."
- **New section "Client implementation (3e-2)",** covering:
  - MUC nick = profile nickname from 3e-2, because the `u<32hex>` localpart is 33 characters and over `MAX_NICK_LENGTH`
  - the token manager stops on sign-out, Start over and terminal XMPP disconnects; `reconnecting` is not terminal
  - `getToken` bypasses the backoff
  - renew 400/404/405/413/415 → `failed` (terminal)
  - the returning view unifies sign-out, auth-failed and connection-failed
  - `connectWhenIdle`
  - the `describeConnectionError` copy rewrite
  - a custom `alertdialog` (jsdom has no `showModal`)
  - malformed or foreign-domain stored entries are ignored, not deleted
  - the `VITE_API_URL` regex
  - the two-tab `Name-2` behaviour
  - `testTimeout` 20 s
  - live evidence after the run
- **Status-line notes on older ADRs:** add "Amended by ADR-019 (3e-2): the dev username login and `ui/addresses.ts` are removed" to ADR-009. Add "addresses cleanup done in 3e-2" to ADR-013's consequences.

### Proposed CLAUDE.md changes (user-owned; for the user to apply)
- Commands:
  - `bash infra/mongooseim/dev-seed.sh  # create alice/bob test users + lobby room (smoke page only; the web app makes its own names)`
  - add `http://localhost:5173/?identity=b  # dev only: a second stored identity for two-window testing`
- Frontend rules: add "Network calls (fetch/XHR/sendBeacon) only in `web/src/api/`. Browser storage only in `web/src/api/deviceCredential.ts`. The API token is memory-only (ESLint-enforced)."
- Still pending from ADR-015: "Erlang/OTP 26+" → "27+".