# Plan: Slice 2a+ — Branding & UI polish ("Nearby")

Status: PLANNED by supervisor on 2026-11-17, approved user decisions (name Nearby, clean & calm look, brand + polish
scope). Next step: hand this plan verbatim to the `coder` agent (round 1), then browser-verify, then supervisor review.

## Goal
Rebrand the web client's user-facing surface as **Nearby**, with a calm, token-based visual design (one accent colour,
soft cards, automatic dark mode). Replace XMPP jargon with plain language. Rebuild the message timeline as proper chat
bubbles: own messages on the right, an "Earlier messages" divider, and grouping of consecutive messages. Features and
`xmpp/` logic do not change. Everything must pass WCAG AA in light and dark mode.

## Context
- Roadmap phase 2. An extra slice between 2a (committed `b2bd67f feat(web): scaffold client…`) and 2b. It doesn't
  depend on anything unbuilt.
- Docs: CLAUDE.md Frontend rules, ADR-003, ADR-008. Includes the 2a round-2 review suggestions 1 and 3 (steps 3–4).
- Touched:
  - `web/index.html`, `web/package.json` (description only), `web/src/index.css`, `main.tsx`, `App.tsx`
  - `components/*` (`describe.ts` moves)
  - `pages/{DevLogin,Chat}.tsx`
  - `state/room.ts` (import path only), `state/bindXmpp.ts`
  - `xmpp/XmppProvider.tsx` (removes the store-binding import only)
  - tests
  - `README.md`, `docs/PROJECT.md`, `CLAUDE.md` (one line)

## Decisions made in this plan
1. `web/package.json` `"name"` stays `chaterl-web`. It's a private npm id that users never see, and renaming churns the
   lockfile. Add `"description": "Nearby — web client (chatErl codebase)"`.
2. No font dependency: use a system font stack. Google Fonts would send visitor IPs to a third party, which is the wrong
   message for a privacy-led product.
3. No new runtime or dev dependencies. The logo and icons are inline SVG.
4. Dev sign-in takes a **username**: `alice` → `alice@${xmppDomain}`. A full JID is also accepted if it's on the configured
   domain; anything else is rejected inline. Input is lowercased.
5. The room field takes a **room name**: `lobby` → `lobby@${mucDomain}`, or a full address on the MUC domain. The UI shows only the
   localpart, never the full JID. The field is dev-only and goes away in 2c.
6. Earlier-messages divider: a single row placed directly after the **last** history message, with text "Earlier messages ↑"
   (the arrow is aria-hidden), `role="separator"` and `aria-label="Earlier messages above"`. It appears only if history exists.
   Remove the per-message "(earlier)" marker and the history `opacity-70`.
7. Composer: an sr-only label "Message" plus a visible placeholder "Message the room…" (≥4.5:1). AC11 is amended for this
   one input only.
8. Header account area: the account name plus a "Sign out" button. No dropdown menu.

## Steps
1. `web/public/favicon.svg` (new) is the logo with literal colours `#0f766e` / `#ffffff`. `web/index.html` gets:
   - `<title>Nearby</title>`
   - meta description: "Chat with people around you. Others see only your area, never your exact location."
   - `<meta name="color-scheme" content="light dark">`
   - theme-color `#f8fafc` for light and `#0f172a` for dark (two media-scoped metas)
   - `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`
2. `web/src/index.css` holds the tokens (below), in Tailwind v4 `@theme` (NOT `@theme inline`).
   - `@media (prefers-color-scheme: dark) { :root { … } }` overrides the variables.
   - `:root { color-scheme: light dark; }`
   - `@layer base`:
     - html, body get `bg-canvas text-ink font-sans antialiased`
     - `:focus-visible { outline: 2px solid var(--color-accent-ink); outline-offset: 2px; }`
     - `::placeholder { color: var(--color-ink-muted); opacity: 1; }`
     - reduced-motion disables transitions
   - No raw palette classes may remain in `web/src`.
3. Move `components/describe.ts` → **`web/src/ui/text.ts`**, with the strings below. `state/room.ts` and the components
   import from `../ui/text`. Delete `components/describe.ts`. Rule: `ui/` imports only from `xmpp/`.
4. Add `web/src/state/useXmppStoreBinding.ts`, which runs `useEffect(() => bindXmppToStores(client), [client])`.
   Remove the binding from `xmpp/XmppProvider.tsx`, which keeps only the context and `installPageHideClose`. `App.tsx` calls
   `useXmppStoreBinding(useXmppClient())`. No other `xmpp/` change.
5. `web/src/ui/addresses.ts` (new): `toAccountJid`, `toRoomJid`, `roomLabel` (see Interfaces).
6. `components/Logo.tsx` (new):
   - `LogoMark({className?, title?})` is aria-hidden unless it has a title, in which case it gets `role="img"` + `<title>`.
   - `Wordmark()` renders LogoMark + "Nearby".
7. `components/ConfigError.tsx` (new), moved out of `main.tsx`, uses the same card shell as sign-in: Wordmark, `<h1>` "Nearby
   can't start", "Fix these settings in the repo-root .env and restart the dev server:", and the list of variable names.
8. `components/AppHeader.tsx` (new): sticky, with a bottom border.
   - Left: Wordmark, with "Nearby" as the page `<h1>`.
   - Right: the ConnectionStatus pill, the account name (`localpartOf(jid)`) and a "Sign out" button that calls `client.disconnect()`.
   - Wraps at 360 px (flex-wrap, min-w-0, truncated name).
9. `ConnectionStatus.tsx` becomes a pill with a dot (aria-hidden) and a text label, `role="status"`:
   - idle / disconnected → "Offline" (ink-muted dot)
   - connecting → "Connecting…" (warning dot)
   - connected → "Online" (success dot)
   - disconnecting → "Signing out…" (warning dot)

   The text always states the state; colour is never the only signal.
10. `LoginForm.tsx` + `pages/DevLogin.tsx`: a centred card containing:
    - Wordmark and the tagline "Chat with people around you"
    - `<h2>` "Sign in" with a "Dev" badge
    - helper text "Development sign-in. Use an account from the dev seed (e.g. alice)."
    - "Username" (default `alice`, autocomplete="username", autocapitalize="none", spellcheck=false) with the hint "on
      {xmppDomain}" linked by aria-describedby
    - "Password"
    - a button reading "Sign in", or "Signing in…" while busy

    Validation goes through `toAccountJid`, with errors in `role="alert"` and no submit. Props become
    `{domain, defaultUsername, busy, error, onSubmit(jid,password)}`. The password stays in local state and is cleared on submit.
11. `RoomForm.tsx` becomes a compact card titled "Room (dev)".
    - Fields: "Room" (default `lobby`, hint "Room name, e.g. lobby") and "Your name" (default = account name, hint "Shown
      to others in the room").
    - Buttons Join/Leave, keeping the key + preventDefault fix.
    - Validation via `toRoomJid`/`normalizeNick`. Props: `defaultRoom` (a name) replaces `defaultRoomJid`. `onJoin` still
      gets the full room JID.
12. `components/timelineRows.ts` (new): `toTimelineRows` (see Interfaces).
13. `MessageList.tsx` renders the rows. Keep `<ol role="log" aria-live="polite" aria-label="Messages">`, the
    stick-to-bottom behaviour and the cleanup.
    - Message row `<li data-kind="message" data-own data-continuation>`:
      - own messages right, others left
      - bubble `max-w-[85%] sm:max-w-[75%] rounded-2xl px-3 py-2`
      - own `bg-accent text-on-accent`, others `bg-surface-sunken text-ink`
      - body `<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">`
      - meta line (shown only when not a continuation): nick, or "You", plus `<time dateTime>HH:MM</time>`, `text-xs`
      - continuation rows keep an sr-only "`{nick|You}`, `{time}`: " prefix
      - `title` = full local time
    - System row (`data-kind="system"`): centred, `text-xs text-ink-muted`, no bubble. Covers notices and nick-null messages.
    - Divider row as in decision 6.
    - Empty states: "Join a room to start chatting." / "No messages yet. Say hello!" via a new `emptyText` prop
      chosen by Chat.
14. `Composer.tsx`: a rounded input bar.
    - sr-only label "Message", placeholder "Message the room…".
    - Accent Send button with a paper-plane SVG (aria-hidden) and the text "Send", visible from `sm:` and sr-only below, so the
      accessible name is always "Send".
    - Error strings come from `describeSendError`; the behaviour is unchanged.
15. `OccupantList.tsx`:
    - `<h2>People here <span aria-hidden="true">·</span> {n}</h2>`
    - initial avatars (`bg-surface-sunken text-ink`, first grapheme uppercased, aria-hidden) and " (you)" in ink-muted
    - empty state "No one here yet"
    - a sidebar card at md and up; below md it sits under the chat card with wrapping chips. One rendered instance only.
16. `pages/Chat.tsx`:
    - Page: `min-h-dvh flex flex-col` with AppHeader on top.
    - Main area: `mx-auto w-full max-w-5xl p-3 sm:p-4 gap-3 grid md:grid-cols-[1fr_16rem]`; every child `min-w-0`.
    - Room card above the chat card. Status line (`role="status"`): "Joining **lobby**…" / "You're in **lobby** as alice" /
      "You left the room" / the failure text. Uses `roomLabel` only.
    - Chat card: `bg-surface rounded-2xl border border-line shadow-sm`, list `h-[55dvh] md:h-[62dvh]`, composer pinned underneath.
17. Docs:
    - README headline `# Nearby` with the subtitle "Location-based chat (codebase: chatErl)", and Sign in/Username wording in the web section.
    - `docs/PROJECT.md` gets a "Naming" line under Concept.
    - The CLAUDE.md one-liner becomes "**chatErl** (product name: **Nearby**) — …".
    - Do NOT write ADR-009.
18. Tests as below.

## Interfaces

### Design tokens (`web/src/index.css`)
```css
@import "tailwindcss";

@theme {
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
    Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji";

  --color-canvas: #f8fafc;          /* page background */
  --color-surface: #ffffff;         /* cards, inputs */
  --color-surface-sunken: #f1f5f9;  /* others' bubbles, avatars, chips */
  --color-line: #e2e8f0;            /* decorative borders/dividers only */
  --color-field: #64748b;           /* input borders (non-text 3:1) */
  --color-ink: #0f172a;             /* body text */
  --color-ink-muted: #475569;       /* secondary text, meta, placeholders */
  --color-bubble-meta: #475569;     /* meta text on surface-sunken */
  --color-accent: #0f766e;          /* the ONE accent: own bubbles, primary buttons */
  --color-accent-strong: #115e59;   /* hover/active on accent */
  --color-on-accent: #ffffff;       /* text on accent */
  --color-on-accent-muted: #ccfbf1; /* time/meta inside own bubble */
  --color-accent-ink: #0f766e;      /* accent-coloured text, links, focus ring */
  --color-danger: #b91c1c;
  --color-success: #15803d;
  --color-warning: #b45309;
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-canvas: #0f172a;
    --color-surface: #1e293b;
    --color-surface-sunken: #334155;
    --color-line: #334155;
    --color-field: #64748b;
    --color-ink: #f1f5f9;
    --color-ink-muted: #94a3b8;
    --color-bubble-meta: #cbd5e1;
    --color-accent: #0f766e;
    --color-accent-strong: #115e59;
    --color-on-accent: #ffffff;
    --color-on-accent-muted: #ccfbf1;
    --color-accent-ink: #5eead4;
    --color-danger: #fca5a5;
    --color-success: #86efac;
    --color-warning: #fcd34d;
  }
}
```
Rules:
- body text uses `ink`
- meta text uses `ink-muted` on canvas/surface, but **`bubble-meta` on surface-sunken** (dark ink-muted on sunken is 4.04:1 and fails AA)
- no `opacity-*` on text
- `line` is never used for text or input borders

### Contrast ratios (WCAG 2.x; script: scratchpad contrast.mjs)
| Pair | Light | Ratio | Dark | Ratio |
|---|---|---|---|---|
| ink / canvas | #0f172a / #f8fafc | 17.06 | #f1f5f9 / #0f172a | 16.30 |
| ink / surface | #0f172a / #ffffff | 17.85 | #f1f5f9 / #1e293b | 13.35 |
| ink / surface-sunken | #0f172a / #f1f5f9 | 16.30 | #f1f5f9 / #334155 | 9.45 |
| ink-muted / canvas | #475569 / #f8fafc | 7.24 | #94a3b8 / #0f172a | 6.96 |
| ink-muted / surface (incl. placeholder) | #475569 / #ffffff | 7.58 | #94a3b8 / #1e293b | 5.71 |
| bubble-meta / surface-sunken | #475569 / #f1f5f9 | 6.92 | #cbd5e1 / #334155 | 6.97 |
| on-accent / accent | #ffffff / #0f766e | 5.47 | same | 5.47 |
| on-accent / accent-strong | #ffffff / #115e59 | 7.58 | same | 7.58 |
| on-accent-muted / accent | #ccfbf1 / #0f766e | 4.86 | same | 4.86 |
| accent-ink / surface | #0f766e / #ffffff | 5.47 | #5eead4 / #1e293b | 9.89 |
| accent-ink / canvas | #0f766e / #f8fafc | 5.23 | #5eead4 / #0f172a | 12.07 |
| danger / surface | #b91c1c / #ffffff | 6.47 | #fca5a5 / #1e293b | 7.71 |
| danger / canvas | #b91c1c / #f8fafc | 6.18 | #fca5a5 / #0f172a | 9.41 |
| success / surface | #15803d / #ffffff | 5.02 | #86efac / #1e293b | 10.42 |
| warning / surface | #b45309 / #ffffff | 5.02 | #fcd34d / #1e293b | 10.15 |
| non-text: field border / surface | #64748b / #ffffff | 4.76 | #64748b / #1e293b | 3.07 |
| non-text: focus ring / canvas | #0f766e / #f8fafc | 5.23 | #5eead4 / #0f172a | 12.07 |
| non-text: accent button / canvas | #0f766e / #f8fafc | 5.23 | #0f766e / #0f172a | 3.26 |

Any pair not in this table needs its ratio in the coder's report, or it is a blocking finding.

### Logo mark (exact markup)
```tsx
<svg viewBox="0 0 32 32" className={className} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
  {title && <title>{title}</title>}
  <path fill="var(--color-accent)" d="M16 2C9.4 2 4 7 4 13.2c0 4.3 2.6 8 6.4 9.9L16 30l5.6-6.9c3.8-1.9 6.4-5.6 6.4-9.9C28 7 22.6 2 16 2z"/>
  <circle cx="11" cy="13" r="1.9" fill="var(--color-on-accent)"/>
  <circle cx="16" cy="13" r="1.9" fill="var(--color-on-accent)"/>
  <circle cx="21" cy="13" r="1.9" fill="var(--color-on-accent)"/>
</svg>
```
`favicon.svg` uses the same paths with literal `#0f766e` / `#ffffff` and `xmlns`.

### Address helpers (`web/src/ui/addresses.ts`)
```ts
export type AccountJidResult = { ok: true; jid: string } | { ok: false; error: 'empty' | 'invalid' | 'wrong-domain' };
export function toAccountJid(input: string, domain: string): AccountJidResult;
// trim + toLowerCase; '' → empty; contains '/' → invalid; 'name' → name@domain; 'name@domain' → as-is;
// 'name@other' → wrong-domain; localpart must match /^[a-z0-9][a-z0-9._-]{0,63}$/ else invalid
export type RoomJidResult = { ok: true; jid: string } | { ok: false; error: 'empty' | 'invalid' | 'wrong-domain' };
export function toRoomJid(input: string, mucDomain: string): RoomJidResult;
// trim (NO lowercasing); 'name' → name@mucDomain; full JID only on mucDomain; must pass isValidRoomJid
export function roomLabel(roomJid: string): string; // localpart; whole string if no '@'
```

### Timeline rows (`web/src/components/timelineRows.ts`)
```ts
import type { TimelineItem } from '../state/room';
import type { ChatMessage } from '../xmpp';
export const GROUP_WINDOW_MS = 5 * 60_000;
export type TimelineRow =
  | { kind: 'message'; key: string; message: ChatMessage; continuation: boolean }
  | { kind: 'system'; key: string; text: string; at: number }   // notices + room messages (nick === null)
  | { kind: 'divider'; key: 'earlier-divider' };
export function toTimelineRows(items: readonly TimelineItem[]): TimelineRow[];
// continuation iff previous ROW is a message row with same nick and same isOwn and |Δt| <= GROUP_WINDOW_MS;
// system/divider rows break groups. Divider: once, directly after the LAST isHistory message (if any).
// keys: message → `m-${id}`, system → notice id or `m-${id}`.
```
Remove MessageList's `selfNick` prop (alignment uses `message.isOwn`).

### User-facing text (`web/src/ui/text.ts`), with no "JID", "XMPP", "MUC" or "occupant"

describeConnectionError:
| Reason | Text |
|---|---|
| auth-failed | "Wrong username or password." |
| connection-failed | "Can't reach the chat server. Check that it's running and try again." |
| connection-lost | "Connection lost. Please sign in again." |
| error | "Something went wrong. Please sign in again." |

describeJoinFailure (`satisfies Record<JoinFailure,string>`):
| Failure | Text |
|---|---|
| conflict | "That name is already taken in this room." |
| not-authorized | "This room needs a password." |
| forbidden | "You're not allowed to join this room." |
| registration-required | "This room is invite-only." |
| service-unavailable | "This room is full or unavailable." |
| not-acceptable | "This room doesn't accept that name." |
| item-not-found | "That room doesn't exist." |
| timeout | "The room didn't respond. Try again." |
| room-config-failed | "The room couldn't be set up. Try again." |
| not-connected | "You're offline." |
| invalid-room | "Room names use lowercase letters, numbers, dots, dashes or underscores." |
| invalid-nick | "Names must be 1–32 characters." |
| other | "Couldn't join the room." |

describeMessageError: unchanged from 2a round 2.

describeSendError (`satisfies Record<SendError,string>`; `SendError = Extract<SendResult,{ok:false}>['error']`):
| Error | Text |
|---|---|
| empty | "Type a message first." |
| too-long | "That message is too long (max 2000 characters)." |
| not-connected | "You're offline." |
| not-joined | "Join a room first." |

describeAddressError(kind, error, domain):
| Kind / error | Text |
|---|---|
| account / empty | "Enter your username." |
| account / invalid | "Usernames use letters, numbers, dots, dashes or underscores." |
| account / wrong-domain | "Use an account on {domain}." |
| room / empty | "Enter a room name." |
| room / invalid | same as invalid-room above |
| room / wrong-domain | "That room isn't on this server." |

### Component props (changed)
```ts
LoginForm({ domain: string; defaultUsername: string; busy: boolean; error: string | null; onSubmit(jid: string, password: string): void })
RoomForm({ defaultRoom: string; defaultNick: string; mucDomain: string; status: RoomState['status']; onJoin(roomJid: string, nick: string): void; onLeave(): void })
MessageList({ items: TimelineItem[]; emptyText: string })
OccupantList({ occupants: string[]; selfNick: string | null })   // unchanged
AppHeader({ connection: ConnectionState; onSignOut(): void })
ConfigError({ errors: string[] })
LogoMark({ className?: string; title?: string }); Wordmark({ className?: string })
```

## Tests required
Keep the intent of existing tests. Update expected text and queries (prefer getByRole/getByLabelText), and replace class-name
assertions with behaviour or `data-kind` checks. No test may be deleted without a replacement. The report lists every changed test (old → new).

- `tests/ui/addresses.test.ts` (new):
  - `toAccountJid`:
    - 'alice' → alice@chaterl.localhost
    - '  Alice ' → lowercased
    - a full matching JID is accepted
    - 'alice@evil.example' → wrong-domain
    - '' → empty
    - 'al ice', 'alice/res', '-alice' → invalid
    - 65 characters → invalid
  - `toRoomJid`:
    - 'lobby' → lobby@muc.chaterl.localhost
    - a full JID on the MUC domain is accepted
    - another domain → wrong-domain
    - 'Lobby' → invalid
    - '' → empty
  - `roomLabel`: 'g7_gcpvj0e@muc.x' → 'g7_gcpvj0e'.
- `tests/ui/text.test.ts`: the describe tests moved here and updated. Every JoinFailure and SendError maps to a non-empty string. No string
  matches `/\b(JID|XMPP|MUC|occupant)/i` (iterate over every exported map/function with every known input).
- `tests/components/timelineRows.test.ts` (new):
  - 3 bob messages within 5 min → [false, true, true]
  - a 6-min gap breaks the group
  - a different nick breaks it
  - own after other breaks it
  - a notice between two bob messages breaks it
  - exactly one divider, right after the last history message
  - no divider without history
  - divider at the end when everything is history
  - nick null → system row
- `tests/components/components.test.tsx` (updated):
  - LoginForm:
    - labels 'Username'/'Password'
    - '  alice  ' submits alice@chaterl.localhost
    - a full JID on the domain submits unchanged
    - a wrong domain shows an alert and doesn't submit
    - the password is cleared after submit
    - busy → the "Signing in…" button is disabled
    - the error prop renders in role=alert
  - Composer:
    - textbox name 'Message' with placeholder "Message the room…"
    - button name 'Send'
    - existing behaviour kept
  - MessageList:
    - shows the emptyText prop
    - own vs other via data-own
    - data-kind="system" for nick null and for notices
    - with history + live → separator named 'Earlier messages above' and no "(earlier)" text
    - no history → no separator
    - a continuation shows the visible nick once but keeps the sr-only attribution
    - `<script>` text renders literally
    - the meta line shows "You" for own messages
  - OccupantList:
    - heading /People here.*2/
    - " (you)" for self
    - "No one here yet" when empty
    - the heading textContent isn't uppercase
- `tests/components/round2.test.tsx` (updated):
  - ConnectionStatus: connected → "Online", with no domain or resource.
  - AppHeader: shows "alice" (not the full JID); "Sign out" calls onSignOut.
  - RoomForm:
    - the Leave regression tests stay (label "Room")
    - 'test2' + Join → onJoin('test2@muc.chaterl.localhost', nick)
    - an invalid room shows an alert and doesn't call onJoin
  - The connection-lost text uses the new string.
- `tests/components/brand.test.tsx` (new):
  - LogoMark is aria-hidden without a title, and role=img with a name when it has one.
  - ConfigError shows the heading and every error item.
  - The Chat page room status reads "You're in lobby as alice" and never contains "@muc".
- `tests/integration/chatFlow.test.tsx` (updated):
  - Sign in via Username + Password + "Sign in"; `connectCalls[0].jid` is alice@chaterl.localhost.
  - The default room "lobby" → join presence to lobby@muc.chaterl.localhost/alice.
  - The rest is unchanged. Keep `{delay:null}` and the 20 s timeout.
- `tests/xmpp/*` and `tests/state/*`: only import paths change (ui/text). The message-error strings stay the same.

## Acceptance criteria
- AC1: typecheck, lint (0 warnings), test and build all pass. Every behaviour covered by the 138 tests from 2a is still covered. The report lists the changed tests and the new total.
- AC2: no new deps. dependencies and devDependencies are byte-identical apart from the added "description". name is still chaterl-web.
- AC3: `git diff b2bd67f -- web/src/xmpp` shows only the store-binding removal in XmppProvider.tsx.
- AC4: `grep -rnE "\b(slate|gray|zinc|neutral|stone|blue|sky|indigo|teal|emerald|green|red|amber|yellow)-[0-9]{2,3}\b" web/src`
  finds nothing, and no text uses `opacity-` (disabled buttons are allowed).
- AC5: `grep -rniE "\bJID\b|XMPP|\bMUC\b|occupant" web/src/components web/src/pages web/src/ui --include=*.tsx` finds no
  user-visible strings. Identifiers and comments are OK; the reviewer checks by hand.
- AC6 (manual): the tab shows the Nearby favicon and the title "Nearby". Sign-in shows the logo, "Nearby", the tagline, "Sign in" with the Dev badge, and
  Username/Password.
- AC7 (manual): light and dark screenshots of sign-in and chat show:
  - a calm neutral background with one accent colour
  - own messages right in accent bubbles, others left in sunken bubbles
  - system notices centred and muted
  - grouping
  - the "Earlier messages ↑" divider, with no "(earlier)" markers
- AC8: the header shows the logo + "Nearby", the status pill, "alice" and "Sign out", with no domain or resource. The room status reads "You're in lobby as alice".
- AC9: the people card heading reads "People here · N" in sentence case, with "(you)" on self and "No one here yet" when empty.
- AC10: contrast matches the table in both modes. Spot-check the own-bubble text, dark meta in others' bubbles, the placeholder and an error alert.
- AC11 (amended):
  - Keyboard: the Tab order is logical, and the focus ring is visible in both modes.
  - Labels: every input has a programmatic label, and all except the composer also have a visible label.
  - At 360×740 in both modes, scrollWidth === clientWidth on sign-in and chat, including after a 300-char message with no spaces.
- AC12: ConfigError: with a bad `VITE_XMPP_WS_URL` passed through the shell (NOT by editing .env), the styled "Nearby can't start" card lists the variable name.
- AC13: README headline, PROJECT.md naming and the CLAUDE.md one-liner are updated. The repo, package and domain names are unchanged.
- AC14: all 2a behaviour still works live:
  - sign in with `alice` (username only)
  - join lobby
  - chat with bob
  - Leave only leaves
  - a wrong password shows "Wrong username or password."
  - stopping MongooseIM shows "Connection lost. Please sign in again."

## Risks / watch-outs
- Tailwind v4: put the tokens in `@theme`, not `@theme inline`, so the dark `:root` overrides win. Don't use `dark:` for colours.
- jsdom has no CSS, so contrast, alignment and dark mode are manual checks. Keep the visual logic testable via `data-own`/`data-kind`/`data-continuation` and the separator role.
- Grouping must not drop authorship for screen readers (keep the sr-only prefix). Add no extra live regions; the divider must not cause an announcement storm.
- Lowercase usernames only. Never the password, and never room names (uppercase is invalid there).
- Set `::placeholder` explicitly with opacity 1.
- `dvh` units: no fallbacks needed.
- Privacy is unchanged: no analytics, web fonts or third-party requests. The meta-description claim must stay true.
- Layering:
  - `xmpp/` imports nothing from `state/`, `ui/`, `components/` or `pages/`.
  - `ui/` imports only from `xmpp/`.
  - `state/` may import from `ui/` and `xmpp/`.
- Windows: no POSIX-only npm scripts.

## Out of scope
- Feature changes: reconnect, MAM, location, map, range slider, avatar uploads or colour hashing.
- A manual theme toggle, a PWA manifest, extra icons, i18n.
- Web fonts, icon libraries, UI kits, animation libraries.
- Renaming the repo, the package name, Erlang apps, the XMPP domain or env vars.
- Further `xmpp/` changes, or changes to the store shapes.
- Writing ADR-009 or ticking ROADMAP items (the orchestrator does that).

## ADR-009 (orchestrator writes it after approval)
**ADR-009 — Product name "Nearby" and UI design tokens.**
- Context: the UI needed a user-facing identity; the 2a screens used XMPP jargon and default browser styling.
- Decision:
  - **Nearby** in every user-facing surface; **chatErl** stays the codebase name (repo, package name, Erlang apps, XMPP domain, env vars).
  - "Clean & calm" look: one teal accent `#0f766e`, slate neutrals, automatic dark mode via `prefers-color-scheme`.
  - Colours only as semantic Tailwind v4 `@theme` tokens in `web/src/index.css`, with raw palette classes banned. Every
    pair is documented at ≥4.5:1 (text) / ≥3:1 (UI) in both modes.
  - System font stack (no web fonts, for privacy); inline SVG for the logo and icons.
  - User-facing text lives in `web/src/ui/text.ts` with no protocol jargon.
- Consequences:
  - A new colour means a new token plus a contrast check.
  - The codename/product-name mismatch is deliberate and documented.
  - There is no manual dark-mode override yet.
