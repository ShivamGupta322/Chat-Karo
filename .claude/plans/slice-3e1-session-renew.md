# Plan: Phase 3e-1 — POST /api/session/renew (+ ADR-019 with the client-switch design)

Status: APPROVED 2026-11-21 after review round 1 with live checks (HEAD d0cfe14). ADR to append: **ADR-019** "Session renewal and the client switch design".
CLAUDE.md is user-owned: never edit it.

## Slicing of 3e
| Slice | Content | Ends with |
|---|---|---|
| **3e-1** (this plan) | Server: POST /api/session/renew, geo_xmpp_admin:check_password/3, ADR-019 (the renew contract AND client decisions D1–D7) | curl: create, renew, the new token works on /api/locate |
| 3e-2 | Client identity: web/src/api/ (fetch wrapper, session/renew, token manager, device credential), Welcome page, auto sign-in on reload, sign-out / start over; DevLogin and LoginForm removed; rooms still via roomJidForCell for this slice | A browser creates a pseudonymous identity, chats, and keeps it across reloads |
| 3e-3 | Locate switch: geo/ calls /api/locate, the validated room_jid drives useAreaRoom, delete roomJidForCell, geo/→api/ ESLint boundary, error states, live privacy checks; partly supersedes ADR-013 | Phase 2 demo with server-assigned rooms |

## Verified live (MongooseIM 6.2.1; one throwaway user created and deleted; no credentials printed)
`query C($user: JID!, $password: String!) { account { checkPassword(user: $user, password: $password) { correct } } }`
- right password: 200 `{"data":{"account":{"checkPassword":{"correct":true}}}}`
- wrong / empty password: 200 `{"correct":false}`
- unknown user (any domain): 200 `{"errors":[{"extensions":{"code":"user_does_not_exist",...},"message":"Password <PLAINTEXT> for user ... does not exist"}],"data":{"account":{"checkPassword":null}}}`
- an unparsable JID: 400 `input_coercion`
- Selecting only `{ correct }` removes the echoed password from the success/wrong bodies; the `user_does_not_exist` error message STILL echoes it, so never log bodies.

## Design decisions for all of 3e (record in ADR-019; client parts land in 3e-2/3e-3)
- **D1 Device credential:**
  - localStorage key `nearby.identity.v1`, JSON `{"v":1,"jid","xmppPassword","nickname"}`, validated on read (malformed = absent)
  - IndexedDB has the same XSS exposure with more complexity; sessionStorage loses the identity on tab close; WebCrypto can't help (SASL needs the plaintext)
  - XSS accepted for a portfolio project (no third-party scripts, React escaping, no dangerouslySetInnerHTML, CSP in Phase 6)
  - the JWT is memory-only
  - if a write fails, keep it in memory + "This name won't be remembered on this device."
  - copy: "Nearby gives you a name on this device only. There's no email or password. If you clear this browser's data or switch devices, you'll start again with a new name."
  - never delete the credential without an explicit user action (auth-failed or a renew 401 → "Try again" / "Start over")
  - Sign out = XMPP disconnect + Welcome with "Continue as {nickname}" / "Start over with a new name"; Start over asks for confirmation ("Your current name can't be recovered.")
  - no server-side removeUser in 3e
- **D2 Token lifecycle** (web/src/api/, injected clock/timers/fetch):
  - expiresAt = now + expires_in*1000
  - proactive renew at 80% + a lazy check before a locate (renew if no token or < 60 s left)
  - single-flight renew
  - a locate 401 → one renew + one retry; a second 401 → error state
  - renew 401 invalid_credentials → identity-invalid (offer Start over, nothing wiped)
  - renew 503/timeout/network → keep XMPP, retry with max(retry-after, backoff 5 s → 30 s); none while offline, retry on `online`
  - fetch timeouts: /api/session 15 s, renew 15 s, locate 10 s
  - after onboarding the 201 token is used; on reload XMPP connect and renew start in parallel
- **D3 Locate flow — CONFIRMED by the user on 2026-11-21 (send the area centre).** Reasoning given to the user: Phase 4 hysteresis runs in the browser with the raw fix; the jump check works on cell centres; Phase 5 range prefixes still resolve; place matching can run client-side if needed; reversible (the server accepts any point).
  - send the CENTRE of the locally computed precision-7 cell (not the raw fix), omit accuracy; the server answer is identical; the raw fix never leaves the device; amends ADR-005 wording
  - fallback if rejected: keep the latest fix in a useRef and send it + accuracy
  - the local geohash stays (dev map, de-dup, snapping)
  - locate only on the ADR-013 §3 room-change triggers + a retry after an error; no range key
  - response: tolerate extra keys; require cell, precision ∈ {5,6,7}, range, room_jid matching `^g(5|6|7)_[0-9b-hjkmnp-z]{5,7}@<mucDomain>$`; precision = cell length = room prefix; for block, cell = the local cell; a mismatch → bad-response, no join
  - keep the previous room until the new assignment arrives; desired = null on location loss or a locate failure
  - MUC nick = the profile nickname
  - states: assigning, unavailable, offline, identity-invalid, bad-response
- **D4 Boundaries:**
  - src/api/ is a leaf
  - the locate value is importable only from src/geo/**, src/main.tsx, tests (`**/api/locate`)
  - `no-restricted-globals` fetch/XMLHttpRequest/navigator.sendBeacon everywhere except src/api/**
  - localStorage/sessionStorage only in src/api/deviceCredential.ts
  - xmpp/ also gets `**/api`
  - guards proven by lint fixture tests
- **D5 Dev login:**
  - remove pages/DevLogin.tsx, components/LoginForm.tsx and ui/addresses.ts toRoomJid/roomLabel in 3e-2 (alice/bob stay for tools/xmpp-smoke and the lobby)
  - the two-window demo via a DEV-only `?identity=<[a-z0-9]{1,16}>` storage slot (literal import.meta.env.DEV) or a private window
- **D6 Onboarding:**
  - pages/Welcome.tsx: a labelled nickname input mirroring `^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$`; aria-invalid + aria-describedby; role=alert for submit errors
  - 400 → the rule; 409 "That name is taken. Try another."; 503/timeout/network "Nearby can't create names right now. Try again in a few seconds."; 500 generic
  - busy "Creating…"; store the credential before XMPP connect; tokens and ui/text.ts only
- **D7:** VITE_API_URL optional, default /api; a same-origin path only (one leading /, no //, query, hash, whitespace); read in config.ts and passed explicitly in main.tsx.

## Goal (3e-1)
A returning device swaps `{jid, xmpp_password}` for a fresh 1 h JWT. geo_service checks:
- the account has an ACTIVE profile (before MongooseIM)
- the password, via admin checkPassword

It returns `{nickname, token, token_type, expires_in}`. The password and token are never logged; a crash can't put them in a crash report.

## Steps
1. **geo_xmpp_admin.erl:** add check_password/3, check_password_request/3, parse_check_password/2.
   - The constant document selects ONLY `correct`; variables `user` and `password`.
   - Reuse send/1, status_error/1, error_code/1, log_failure/2 (status only). Update the module comment.
2. **geo_session.erl:**
   - `parse_credentials/3` (pure, total)
   - `renew/3`: parse_credentials → geo_store:get_profile/1 (BEFORE MongooseIM) → geo_xmpp_admin:check_password/3 → geo_auth:issue/3
   - the nickname comes from the profile; nothing logged on success; calls fully qualified (meckable)
3. **New geo_http_session_renew.erl:**
   - 405 (allow: POST) first; `geo_http_json:read_json_object(Req, 1024)`
   - the body must be exactly keys jid and xmpp_password, both binaries, else 400 invalid_request
   - everything after decoding in ONE `try ... catch Class:Reason:Stack` like geo_http_locate:guarded/3; a crash → 500 internal_error + a single `logger:error(#{event => renew_crashed, class, reason, where})` from geo_crash:summary/3
   - the read phase outside the try; no terminate/3; the reply is the last expression in the try
   - module comment: the body holds a live credential (ADR-018 §4b reasoning; the xp1_ pattern is only the backstop)
   - don't pattern-match the password in a function head outside the try; keep parse_credentials total
4. **geo_http.erl:** route `{"/api/session/renew", geo_http_session_renew, SessionCfg}` before the catch-all.
5. **test/geo_fake_mim.erl:** teach it checkPassword.
   - operation/1 → `check` when the query contains checkPassword
   - in modes ok/exists a successful register stores `{{pw, Jid}, Password}` in ETS (keeper-owned)
   - check: equal → `{"correct":true}`; different → `{"correct":false}`; no entry → 200 user_does_not_exist (the verified shape, with a message echoing the password)
   - unauthorized/http503/garbage apply to check; new mode `slow_check` (7 s); export `forget_user/1`; update the header comment
6. **ARCHITECTURE:** login step 1 (renewal built in 3e-1); the HTTP API row for /api/session/renew; module table (geo_xmpp_admin checkPassword; geo_session renew; new geo_http_session_renew); a "Status (Phase 3e-1)" paragraph.
7. **DECISIONS:** append ADR-019:
   - the renew contract, the verified facts, D1–D7 (client parts marked "land in 3e-2/3e-3"; D3 marked "pending user confirmation; if confirmed amends ADR-005 wording")
   - the known follow-up: retrofitting the guarded try/catch into geo_http_session (it holds a generated password)
   - a "Live evidence" heading for the orchestrator
8. **ROADMAP:** under Phase 3 add "Slice 3e-1: POST /api/session/renew" (unticked; the orchestrator ticks after live checks) and note the 3e-2/3e-3 split under "Client switches…"; add renew to the Phase 4 geo_rate line.

## Interfaces
```erlang
%% geo_xmpp_admin
-define(CHECK_QUERY, <<"query CheckPassword($user: JID!, $password: String!) "
    "{ account { checkPassword(user: $user, password: $password) { correct } } }">>).
-type check_error() :: invalid | unavailable | unauthorized | bad_response.
-spec check_password(admin(), Jid :: binary(), Password :: binary()) -> ok | {error, check_error()}.
-spec check_password_request(admin(), binary(), binary()) -> request().
%% 200 correct =:= true -> ok; 200 correct =:= false -> {error, invalid};
%% 200 errors[0].extensions.code "user_does_not_exist" -> {error, invalid};
%% 200 anything else (other code, non-boolean correct, not JSON) -> {error, bad_response};
%% 401 -> unauthorized; 5xx -> unavailable; transport failure/timeout -> unavailable; other -> bad_response
-spec parse_check_password(Status :: non_neg_integer(), Body :: binary()) -> ok | {error, check_error()}.

%% geo_session
%% Jid exactly <<"u", 32 x [0-9a-f], "@", XmppDomain/binary>> (no uppercase hex, no resource, no other domain);
%% Password exactly <<"xp1_", 32 x [A-Za-z0-9_-]>>.
-spec parse_credentials(term(), term(), XmppDomain :: binary()) -> {ok, Localpart :: binary()} | error.
-type renew_result() :: #{nickname := binary(), token := binary(), expires_in := pos_integer()}.
-spec renew(Jid :: term(), Password :: term(), geo_config:session_cfg()) ->
    {ok, renew_result()} | {error, invalid_credentials | unavailable | internal}.
%% parse error -> invalid_credentials (no Mongo, no MongooseIM call)
%% get_profile not_found | pending -> invalid_credentials (no MongooseIM call)
%% get_profile {error, mongo_unavailable} -> unavailable; {error, bad_document} -> internal
%% check_password {error, invalid} -> invalid_credentials; {error, unavailable} -> unavailable;
%% {error, unauthorized | bad_response} -> internal; ok -> geo_auth:issue(Localpart, Secret, erlang:system_time(second))
```
HTTP:
```
POST /api/session/renew   content-type: application/json   body <= 1024 bytes
{"jid":"u<32 hex>@chaterl.localhost","xmpp_password":"xp1_<32>"}
200 {"nickname":"Zed","token":"<jwt>","token_type":"Bearer","expires_in":3600}   (ordered, json_ordered)
400 invalid_json | invalid_request ("Send exactly {\"jid\": string, \"xmpp_password\": string}.")
401 {"error":"invalid_credentials","message":"These credentials are not valid."}
    one constant body for malformed shape, unknown/pending/deleted profile, wrong password, unknown XMPP user;
    no www-authenticate (credentials are in the body, not an HTTP auth scheme; documented in ADR-019)
405 + allow: POST; 413; 415
503 service_unavailable + retry-after: 5 (Mongo or MongooseIM unavailable/timeout)
500 internal_error (admin 401 / bad response, bad profile document, crash)
cache-control: no-store everywhere
```
Logging: nothing per request on success or 4xx. Only the existing xmpp_admin_unauthorized / xmpp_admin_bad_response (status only) and renew_crashed. No logger call receives the body, jid, password, token or an admin body.

## Tests required
- **geo_xmpp_admin_tests:**
  - the request carries the constant query; it contains `{ correct }` and NOT `message`; variables exactly user/password; the Basic header
  - parse_check_password:
    - 200 true → ok; 200 false → invalid; 200 user_does_not_exist (echoing message) → invalid
    - 200 other code / `correct: "true"` / null / non-JSON → bad_response; 400 input_coercion → bad_response
    - 401 → unauthorized; 500/503 → unavailable; 302 → bad_response
- **geo_session_tests:**
  - parse_credentials accepts the valid shape; rejects uppercase hex, 31/33 hex, a missing `u`, `alice@chaterl.localhost`, the right localpart with another domain, different domain case, a trailing `/res`, non-binary jid/password, a password without xp1_, 31/33-char passwords, `+`/`=`, a trailing newline
  - renew/3 with meck (geo_store / geo_xmpp_admin / geo_auth as needed):
    - not_found and pending → invalid_credentials AND check_password not called
    - mongo down → unavailable, no admin call
    - each check_password result mapped
    - success → the token verifies (geo_auth:verify/3), sub = localpart, nickname from the profile
- **geo_session_SUITE** (real Mongo chaterl_ct + fake MIM), new cases:
  - renew_200: create then renew → 200, exactly the four keys in order, no-store; the token verifies with the CT secret, sub = localpart, nickname matches; **the renewed token is accepted by POST /api/locate** (200)
  - renew_wrong_password_401: exactly one check call recorded
  - renew_unknown_localpart_401: zero admin calls
  - renew_malformed_401: alice's jid, a foreign domain, a password without xp1_; zero admin calls
  - renew_deleted_profile_401: create, delete the profile doc → 401; zero admin calls
  - renew_account_missing_401: create, forget_user in the fake → 401 (user_does_not_exist path)
  - renew_validation: GET → 405 + allow; text/plain → 415; 1025 bytes → 413; `nope` → 400 invalid_json; missing/extra key, number values → 400 invalid_request; /api/session/renew/x → 404
  - renew_xmpp_unavailable_503 (http503) with retry-after: 5; renew_xmpp_slow_503 (slow_check) answered in < 7 s
  - renew_xmpp_unauthorized_500; renew_garbage_500
  - renew_mongo_unavailable_503 in the mongo_down group; zero admin calls
  - renew_crash_is_sanitised: meck geo_session:renew/3 to `error({badmatch, Password})` → 500; the captured logs contain one renew_crashed and NO occurrence of the password, and no cowboy_stream_h/proc_lib crash report
  - extend logs_contain_no_secrets: all renew passwords (right and wrong), renewed tokens and the fake's echoed message text never appear
- Existing suites green; dialyzer and fmt clean.

## Acceptance criteria ([LIVE] = orchestrator)
- AC1: eunit, ct (Mongo up), dialyzer 0, fmt pass; the new tests fail if the profile-before-MongooseIM order, the `{ correct }`-only selection or the try/catch is removed.
- AC2: valid credentials → 200, exactly nickname, token, token_type, expires_in in order; the token verifies, sub = localpart, exp−iat = 3600, accepted by /api/locate.
- AC3: every credential failure → the same 401 body; malformed/unknown/deleted → zero admin calls.
- AC4: validation statuses as specified; no-store everywhere.
- AC5: MongooseIM unavailable/slow or Mongo unavailable → 503 + retry-after: 5 within ~6 s; admin 401/garbage → 500.
- AC6: a crash after decoding → 500 + only renew_crashed; no password in any log.
- AC7: ARCHITECTURE, ROADMAP, ADR-019 as in Steps 6–8.
- AC8 [LIVE]: rebuild, 4 healthy; session → renew → 200; the new token gives /api/locate 200; both direct (127.0.0.1:8080) and via Vite (http://localhost:5173/api/session/renew), no access-control-*; bodies from files; secrets never printed.
- AC9 [LIVE]: wrong xp1_ → 401; alice's jid → 401; stop mongooseim → 503 + retry-after (ready stays 200, RestartCount 0), start → 200; stop mongo → 503.
- AC10 [LIVE]: the log scan (script, values never printed): 0 × test passwords (right and wrong), issued/renewed tokens, `is correct`, `is incorrect`; 0 renew_crashed.
- AC11 [LIVE]: cleanup; listUsers = alice, bob.

## Risks
- **Credential in crash output:** the try/catch is the guarantee; never log Body; no password matching in function heads outside the try; parse_credentials total.
- **Admin bodies echo passwords:** select only `correct`; never log a body, even at debug level.
- **No rate limit:** renew is a password oracle and costs a SCRAM check per call; brute force is infeasible (192-bit); shape + profile-first keep junk away; Phase 4/6; accepted while localhost-only.
- **Timing oracle** (unknown localpart is faster): accepted (128-bit random localparts).
- **No revocation:** the old token stays valid until exp (ADR-017).
- The handler blocks the request process ≤5 s: fine.
- Cowboy exact-segment routing: add the 404 check for /api/session/renew/x.
- **Windows:** CT Mongo 127.0.0.1:27018; exec -T; bodies from files; keep LF for the new .erl.

## Out of scope
- any web/ change (3e-2/3e-3); CLAUDE.md
- account deletion, abandonment cleanup, revocation/jti denylist
- rate limiting, MongooseIM config changes, MUC lockdown (3f)
- retrofitting the try/catch into geo_http_session (note in ADR-019 as a known follow-up)

Suggested commit: `feat(geo): POST /api/session/renew for returning devices (Phase 3e-1)`.
