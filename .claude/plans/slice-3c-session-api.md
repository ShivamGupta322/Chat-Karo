# Plan: Phase 3c — POST /api/session (pseudonymous account, XMPP registration, JWT) and the Vite /api proxy

Status: APPROVED 2026-11-21 after review round 1 with live checks (HEAD 542cb9f). AC9 is run on localhost:5173 (Vite listens on ::1). ADR to append: **ADR-017**.
CLAUDE.md is user-owned: never edit it; list the proposed changes in the report.
Orchestrator note: the user's local `.env` `JWT_SECRET` already satisfies the new rules (32 chars, 14 distinct, not the placeholder; checked without printing it).

## Goal
`POST /api/session {"nickname":"Zed"}` does the following:
- validates the nickname
- reserves it in `profiles` (unique, case-insensitive)
- registers a random-localpart XMPP account with a random password through the MongooseIM admin GraphQL API
- returns the XMPP credentials once, plus a 1 h HS256 JWT for geo_service

The Vite dev server proxies `/api/` to geo_service, so the client calls it same-origin, as in production. The client itself is not switched over (that is 3e).

## Verified facts (the supervisor probed MongooseIM 6.2.1 live; throwaway users deleted)
- Mutation: `account { registerUser(domain: DomainName!, username: UserName, password: String!) : UserPayload {jid, message} }`. `username` is optional (the server generates one if it is omitted; we always pass ours).
- Responses:

  | Case | HTTP | Body |
  |---|---|---|
  | success | 200 | `{"data":{"account":{"registerUser":{"jid":"x@chaterl.localhost","message":"..."}}}}` |
  | duplicate | 200 | `errors[0].extensions.code = "exists"`, registerUser null |
  | unknown domain / empty password | 200 | code `"cannot_register"` |
  | invalid UserName (space, `@`, 1100 chars) | 400 | code `"input_coercion"` |
  | wrong basic auth | 401 | `"wrong_credentials"` |
  | no auth | 401 | `"no_permissions"` |

  Mixed-case usernames are lowercased.
- `removeUser(user: JID!)`: success, or 200 with code `"not_allowed"` if the user doesn't exist.
- `changeUserPassword` exists. Queries: checkPassword, checkPasswordHash, checkUser, countUsers, listUsers.
- **`checkPassword` echoes the plaintext password in its `message`. Never log admin response bodies.**
- `[auth.jwt]` exists in 6.2.1 but is rejected (see decision 2).
- `password.format = "scram"`: MongooseIM stores only SCRAM hashes, so the plaintext exists only in our single response.
- curl exists in the mongooseim image (`docker compose exec -T mongooseim bash -s`), useful for probes.

## Design decisions (all go into ADR-017)
1. **Session model.**
   - POST takes only `{nickname}`. geo_service generates both the localpart and the password, and returns the password exactly once.
   - Returning users: the client keeps `{jid, xmpp_password}` as the long-lived device credential. The JWT lives 1 h. Renewal `POST /api/session/renew {jid, xmpp_password}` is designed now (admin `checkPassword`, never log the body) and built in 3e.
   - Lost device: a new identity. The old nickname stays reserved until the abandonment cleanup (Phase 4/5). Recovery is a v1 non-goal.
   - JWT:
     - header exactly `{"alg":"HS256","typ":"JWT"}`
     - claims exactly `iss="chaterl-geo"`, `aud="chaterl-api"`, `sub=<localpart>`, `iat`, `exp=iat+3600`, `jti` (128-bit random, base64url; reserved for revocation)
     - no nickname in the token
   - Verification:
     - HS256 only; reject `alg:none`, any other alg, any header key besides alg/typ, and non-canonical or padded base64url
     - compare the signature with `crypto:hash_equals/2` BEFORE parsing the payload
     - reject unknown or missing claims
     - skew 30 s: valid iff `Now < exp + 30` and `iat =< Now + 30`; also reject `exp - iat > 3600`; a token over 4096 bytes is invalid
   - JWT_SECRET rules:
     - 32..512 printable ASCII; no `"` or `\`; at least 10 distinct chars
     - reject anything starting with `change-me` (case-insensitive)
     - on failure the app doesn't start and logs only the key name
     - the HMAC key is the raw string bytes; generate with `openssl rand -hex 32`
2. **XMPP credentials: option (a).** geo_service registers a real rdbms user with a random password.
   - Why: no MongooseIM config change; SCRAM keeps working (dev alice/bob and the Phase 2 login untouched); the JWT secret stays in geo_service; real accounts enable 3f affiliations/bans/removeUser; reconnect (ADR-010) keeps a stable password.
   - Rejected `[auth.jwt]`: the XMPP password would become a 1 h bearer token (reconnect breaks after exp), the secret would be shared, it changes the auth chain, and jwt users aren't real accounts.
   - Rejected `mod_auth_token`: same complexity.
   - Localpart: `u` + 32 lowercase hex (`binary:encode_hex(crypto:strong_rand_bytes(16), lowercase)`); nodeprep-safe, and it passes the web ACCOUNT_LOCALPART regex.
   - Password: `xp1_` + base64url of 24 random bytes (32 chars). The prefix enables pattern redaction.
3. **Nicknames.**
   - ASCII `^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$` (2–20 chars), case preserved.
   - Uniqueness via the existing `nickname_unique_ci` index (en, strength 2): the insert is the claim.
   - Reserved names (case-insensitive, exact) → 409 `nickname_taken`, indistinguishable from a taken name: admin, administrator, mod, moderator, root, system, sysop, staff, support, help, official, nearby, chaterl, geo, geo_service, greeter, bot, server, mongooseim, xmpp, null, undefined, anonymous, everyone, here, me, you.
   - The nickname is never the localpart (it becomes the MUC nick in 3e).
4. **profiles.**
   - Pending: `{_id: <localpart>, nickname, state: "pending", createdAt, expiresAt: createdAt+600s}`.
   - Active: `$set state:"active"`, `$unset expiresAt` → `{_id, nickname, state:"active", createdAt}`.
   - No coordinates, IP or PII beyond the nickname.
   - New index `expiresAt_ttl` (`{expiresAt:1}`, `expireAfterSeconds: 0`), so orphaned pending reservations free their nickname within ~11 min. Active profiles have no TTL in 3c.
5. **Admin client.**
   - OTP httpc (`inets` in applications), default profile.
   - POST JSON with a precomputed `Authorization: Basic …`; options `{timeout,5000}`, `{connect_timeout,2000}`, `{autoredirect,false}`, `{body_format,binary}`.
   - Constant GraphQL documents; all values as variables.
   - MONGOOSEIM_ADMIN_URL must be `http://` (https rejected).
   - Never log request/response bodies.
   - Redaction secrets add the admin password, the base64 basic credential and the JWT secret, plus regex patterns for `xp1_…` passwords and JWT-shaped strings.
   - `/api/ready` does NOT depend on the admin API; a MongooseIM outage gives 503 on session requests only.
6. **Rate limiting deferred:**
   - per-IP needs a trusted-proxy XFF policy, and the stack is localhost-only until Phase 6
   - ROADMAP Phase 4 line: "geo_rate also limits POST /api/session per client IP (trusted-proxy XFF)"
   - ROADMAP Phase 6 line: "session rate limit + MongooseIM `auth.max_users_per_domain` backstop before going public"
7. **Vite proxy, no CORS.**
   - `server.proxy` and `preview.proxy` `'/api/'` → `http://127.0.0.1:<GEO_HTTP_PORT|8080>`, `changeOrigin:false`, `xfwd:false`. Use 127.0.0.1 (Node on Windows resolves localhost to ::1).
   - The port comes from `loadEnv(mode, '..', 'GEO_HTTP_PORT')` (exposes nothing to the client; envPrefix unchanged; `loadEnv(…,'')` stays banned). This is a narrow ADR-008 exception recorded in ADR-017.
   - `VITE_API_URL=/api` in .env.example (first read in 3e). No CORS headers anywhere.
8. **Request validation.**
   - POST only (405 + `allow: POST`).
   - content-type `application/json` (a charset param, if any, must be utf-8), else 415.
   - Body cap 1024 bytes: content-length > cap → 413 before reading; read_body `more` or > cap → 413.
   - Invalid JSON or not an object → 400 `invalid_json`. Anything but exactly key `nickname` with a string value → 400 `invalid_request`.
   - Rule violation → 400 `invalid_nickname`; taken/reserved → 409; Mongo/XMPP unavailable → 503 + `retry-after: 5`; else 500 `internal_error`.
   - Shape `{error, message}` via geo_http_reply; `cache-control: no-store` on all session responses.

## Dependencies
None new. Add `inets` (OTP) to applications. Forbidden: jose, jwerl, hackney, gun, any CORS lib, any new npm package.

## Steps
1. **geo_config: `session/0`.**
   - Reads jwt_secret, xmpp_domain, mim_admin_url, mim_admin_user, mim_admin_password, validated in that order; errors name the key only; parsers exported.
   - Rules:
     - xmpp_domain: host chars 1..253
     - mim_admin_url: `uri_string:parse`, scheme http, non-empty host, no userinfo/query/fragment, non-empty path; stored as a string for httpc
     - mim_admin_user: user_char 1..128
     - mim_admin_password: password_char, non-empty
     - jwt_secret: as decision 1
   - Build `authorization => <<"Basic ", B64/binary>>` and keep `basic_b64` for redaction.
2. **sys.config.src:** add `{jwt_secret,"${JWT_SECRET}"}`, `{xmpp_domain,"${XMPP_DOMAIN}"}`, `{mim_admin_url,"${MONGOOSEIM_ADMIN_URL}"}`, `{mim_admin_user,"${MONGOOSEIM_ADMIN_USER}"}`, `{mim_admin_password,"${MONGOOSEIM_ADMIN_PASSWORD}"}`.
   shell.config:
   - a clearly labelled dev-only secret literal (≥32 chars, e.g. `"dev-shell-only-not-a-real-secret-0123456789"`)
   - xmpp_domain "chaterl.localhost"
   - mim_admin_url "http://127.0.0.1:5551/api/graphql", commented: "not published to the host: session returns 503 in rebar3 shell"
   - admin "admin" / "shell-only"
3. **geo_log_redact:**
   - filter args become `#{secrets := [binary()], patterns := [re:mp()]}`
   - `install(Secrets)` compiles the built-in patterns and installs even if Secrets is empty: `xp1_[A-Za-z0-9_-]{32}` and `eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}`
   - apply the secrets, then `re:replace(..., global, binary)`, to every binary and byte char list (same walk)
   - adapt the existing tests (behaviour unchanged)
4. **geo_service_app:** after `mongo()`, `{ok, Session} ?= geo_config:session()`. `install(secrets(Mongo, Session))` with the mongo password if any, admin password, basic b64, jwt secret. Pass `#{listen, mongo, session}` to the sup.
5. **geo_service_sup / geo_http:** `geo_http:child_spec(Listen, SessionCfg)`, `dispatch(SessionCfg)`, route `{"/api/session", geo_http_session, SessionCfg}` before the catch-all. Update callers, including the tests.
6. **app.src:** add `inets`.
7. **New `src/geo_auth.erl`** (pure): issue/3, verify/3, verify_hs256/2; `?TTL`, `?SKEW`, `?MAX_TOKEN` (4096). No logging.
8. **New `src/geo_nickname.erl`** (pure): validate/1 + the reserved list.
9. **geo_mongo:** `insert_one/2`, `delete_one/2` via mongoc:transaction/4 with mc_worker_api:insert/3 and delete_one/3, `?CALL_TIMEOUT`, and the guarded wrapper. insert returns `{{Bool, Map}, Doc}`: classify the first element. CT must confirm the real reply shapes vs Mongo 7, including 11000 on the nickname index.
10. **geo_store:** create_pending_profile/3, activate_profile/1, delete_profile/1, get_profile/1. 11000 → nickname_taken (comment: an `_id` collision ~2^-128). Module doc: "rooms and profiles; never coordinates".
11. **New `src/geo_xmpp_admin.erl`:** register_user/4, remove_user/3 + pure register_request/4, remove_request/3, parse_register/3, parse_remove/3. httpc:request/4 with the options above. Logs: `xmpp_admin_unauthorized` (error); `xmpp_admin_bad_response` with status only (warning). Never bodies.
12. **New `src/geo_session.erl`:** create/2, new_localpart/0, new_password/0. Flow:
    1. validate (reserved → nickname_taken)
    2. generate the localpart and password
    3. create_pending_profile
    4. register_user:
       - on exists → delete the profile, return internal (NEVER remove that account)
       - on unavailable/unauthorized/rejected/bad_response → best-effort remove_user (ignore the result; a timeout may have registered), delete the profile, return unavailable (only for unavailable) or internal
    5. activate_profile; on error → best-effort remove_user + delete_profile, return unavailable, log `session_rollback` with the localpart + step (no secrets)
    6. `geo_auth:issue(Localpart, Secret, erlang:system_time(second))`
    7. log `session_created` with the localpart only (info)

    It runs in the Cowboy request process (no gen_server), so blocking ≤ ~5 s is OK.
13. **New `src/geo_http_json.erl`:** `read_json_object(Req, MaxBytes)` does the content-type/cap/decode checks (reused by 3d).
14. **New `src/geo_http_session.erl`:** the handler; maps the method and results to statuses; 201 with the body in Interfaces; never logs the body or the result.
15. **infra/mongo/init-indexes.js:** `d.profiles.createIndex({ expiresAt: 1 }, { name: "expiresAt_ttl", expireAfterSeconds: 0 })` with a comment; update the `_id` comment to "random XMPP localpart u<32 hex>".
16. **docker-compose.yml** geo_service env: `JWT_SECRET: ${JWT_SECRET}`, `XMPP_DOMAIN: ${XMPP_DOMAIN}`, `MONGOOSEIM_ADMIN_URL: ${MONGOOSEIM_ADMIN_URL:-http://mongooseim:5551/api/graphql}`, `MONGOOSEIM_ADMIN_USER: ${MONGOOSEIM_ADMIN_USER}`, `MONGOOSEIM_ADMIN_PASSWORD: ${MONGOOSEIM_ADMIN_PASSWORD}`. No depends_on mongooseim (comment why).
17. **.env.example** (comments on their OWN lines, never after an empty value):
    - JWT_SECRET rules + `openssl rand -hex 32` + "geo_service refuses to start with this placeholder. Never logged."
    - MONGOOSEIM_ADMIN_URL "http only (Docker network)"
    - `VITE_API_URL=/api` with "same-origin path; in dev Vite proxies /api/ to geo_service on 127.0.0.1:GEO_HTTP_PORT, in production the reverse proxy does; used by the client from 3e"
    - GEO_HTTP_PORT "the Vite /api proxy reads it too"
18. **Web:**
    - new `web/vite.apiProxy.ts` exporting `apiProxyTarget(port: string | undefined): string`: undefined/'' → `http://127.0.0.1:8080`; digits 1..65535 → `http://127.0.0.1:<n>`; else throw `Error('GEO_HTTP_PORT must be a port number (1-65535)')`
    - vite.config.ts: function form `defineConfig(({ mode }) => …)`, `target = apiProxyTarget(loadEnv(mode, '..', 'GEO_HTTP_PORT').GEO_HTTP_PORT)`, `server.proxy` and `preview.proxy` = `{ '/api/': { target, changeOrigin: false, xfwd: false } }`; keep and extend the ADR-008 comment
    - tsconfig include + ESLint as needed
19. **Docs:**
    - ARCHITECTURE:
      - login flow with option (a) and renewal marked 3e
      - module table (geo_auth, geo_nickname, geo_session, geo_xmpp_admin, geo_http_json, geo_http_session; geo_store covers profiles)
      - HTTP row; profiles model + indexes
      - status (inets/httpc, env keys, redaction patterns); security (JWT, no CORS)
    - ROADMAP: tick the admin-API item; the Cowboy line → "3c done: /api/session"; add the Phase 4 and Phase 6 lines (decision 6)
    - README: `openssl rand -hex 32` → JWT_SECRET; a session curl example; dev /api via http://localhost:5173/api/…
    - DECISIONS: ADR-017 (decisions 1–8, the verified facts, the rollback order and the accepted orphan case, checkPassword echoes passwords, renewal designed for 3e, a "Live evidence" heading)

## Interfaces
```erlang
%% geo_config
-type session_key() :: jwt_secret | xmpp_domain | mim_admin_url | mim_admin_user | mim_admin_password.
-type session_cfg() :: #{jwt_secret := binary(), xmpp_domain := binary(), admin := geo_xmpp_admin:admin()}.
-spec session() -> {ok, session_cfg()} | {error, {bad_config, session_key()}}.
%% geo_auth
-type claims() :: #{sub := binary(), iat := integer(), exp := integer(), jti := binary()}.
-spec issue(Sub :: binary(), Key :: binary(), Now :: integer()) -> {Token :: binary(), ExpiresIn :: 3600}.
-spec verify(Token :: binary(), Key :: binary(), Now :: integer()) -> {ok, claims()} | {error, invalid_token | expired}.
-spec verify_hs256(Token :: binary(), Key :: binary()) -> {ok, Header :: map(), Payload :: map()} | {error, invalid_token}.
%% geo_nickname
-spec validate(term()) -> {ok, binary()} | {error, invalid | reserved}.
%% geo_xmpp_admin
-type admin() :: #{url := string(), authorization := binary(), basic_b64 := binary(), password := binary()}.
-type reg_error() :: exists | unavailable | unauthorized | rejected | bad_response.
-spec register_user(admin(), Domain :: binary(), Localpart :: binary(), Password :: binary()) -> ok | {error, reg_error()}.
-spec remove_user(admin(), Domain :: binary(), Localpart :: binary()) -> ok | {error, not_found | unavailable | unauthorized | bad_response}.
-spec register_request(admin(), binary(), binary(), binary()) -> {string(), [{string(), string()}], string(), binary()}.
-spec parse_register(Status :: non_neg_integer(), Body :: binary(), ExpectedJid :: binary()) -> ok | {error, reg_error()}.
%% 200 + data.account.registerUser.jid =:= ExpectedJid -> ok; 200 + errors[0].extensions.code "exists" -> exists,
%% "cannot_register" -> rejected; 401 -> unauthorized; 5xx -> unavailable; httpc {error,_} -> unavailable;
%% anything else (incl. 400, jid mismatch, bad JSON) -> bad_response. remove: ok -> ok; "not_allowed" -> not_found.
%% geo_session
-type result() :: #{nickname := binary(), jid := binary(), xmpp_password := binary(), token := binary(), expires_in := pos_integer()}.
-spec create(Nickname :: term(), geo_config:session_cfg()) -> {ok, result()} | {error, invalid_nickname | nickname_taken | unavailable | internal}.
-spec new_localpart() -> binary().
-spec new_password() -> binary().
%% geo_store
-spec create_pending_profile(binary(), binary(), erlang:timestamp()) -> ok | {error, nickname_taken | mongo_unavailable | write_failed}.
-spec activate_profile(binary()) -> ok | {error, not_found | mongo_unavailable | write_failed}.
-spec delete_profile(binary()) -> ok | {error, mongo_unavailable | write_failed}.
-spec get_profile(binary()) -> {ok, #{id := binary(), nickname := binary(), state := pending | active, created_at := erlang:timestamp()}} | not_found | {error, mongo_unavailable | bad_document}.
%% geo_mongo
-spec insert_one(binary(), map()) -> {ok, write_result()} | {error, write_error()}.
-spec delete_one(binary(), map()) -> {ok, write_result()} | {error, write_error()}.
%% geo_http_json
-spec read_json_object(cowboy_req:req(), pos_integer()) -> {ok, map(), cowboy_req:req()} | {error, 400 | 413 | 415, Code :: binary(), Message :: binary(), cowboy_req:req()}.
```
GraphQL constants (values only in `variables`):
```
mutation RegisterUser($domain: DomainName!, $username: UserName, $password: String!) { account { registerUser(domain: $domain, username: $username, password: $password) { jid } } }
mutation RemoveUser($user: JID!) { account { removeUser(user: $user) { jid } } }
```
HTTP:
```
POST /api/session   content-type: application/json   {"nickname":"Zed"}
201 {"nickname":"Zed","jid":"u<32hex>@chaterl.localhost","xmpp_password":"xp1_<32>","token":"<jwt>","token_type":"Bearer","expires_in":3600}
400 invalid_json | invalid_request | invalid_nickname   409 nickname_taken   405 (allow: POST)
413 payload_too_large   415 unsupported_media_type   503 service_unavailable (retry-after: 5)   500 internal_error
```
Web: `export function apiProxyTarget(port: string | undefined): string`.

## Tests required
- **test/geo_auth_tests.erl:**
  - Round trip: sub back, `exp - iat = 3600`; the header decodes to exactly `{"alg":"HS256","typ":"JWT"}`; two issues → different jti.
  - The RFC 7515 A.1 vector via verify_hs256/2: key = base64url-decoded JWK `k`, token `eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`. Re-check against the RFC text.
  - Rejections (invalid_token):
    - a one-char flip in payload/signature; the wrong key
    - `alg:none` (empty sig and copied valid sig); HS512, RS256, lowercase hs256
    - a header with kid/crit/jku; typ "JWS"
    - 2/4 segments or an empty segment; `=` padding, `+` or `/`; a non-canonical last char
    - > 4096 bytes
    - a non-JSON header or a JSON array; a payload with a missing or extra claim
    - exp float/string; wrong iss/aud; a sub not `u<32hex>`; `exp - iat = 3601`
  - Time: `Now = exp+29` ok, `exp+30` → expired; `iat = Now+30` ok, `Now+31` → invalid_token.
- **test/geo_nickname_tests.erl:**
  - valid: Al, zed_99, A-b, 20 chars
  - invalid: `<<>>`, a, 21 chars, leading `_`/`-`, a space, ü, an emoji, `<script>`, a@b, a/b, a non-binary
  - reserved: ADMIN, Nearby, geo_service
- **test/geo_session_tests.erl:** 1000 × new_localpart matches `^u[0-9a-f]{32}$`, all unique; same for new_password with `^xp1_[A-Za-z0-9_-]{32}$`.
- **test/geo_xmpp_admin_tests.erl:**
  - register_request: url, auth header, content type; `query` equals the constant (no localpart/password in it); `variables` carries them
  - parse_register against every captured response (success, exists, cannot_register, input_coercion 400, 401 wrong_credentials, 401 no_permissions, 503, garbage, a jid mismatch)
  - parse_remove: ok and not_allowed
  - Construct realistic bodies from the shapes in "Verified facts"; you may re-probe MongooseIM via `docker compose exec -T mongooseim` ONLY IF the orchestrator allows; here it does NOT, so build them from the facts above.
- **test/geo_config_tests.erl:**
  - jwt_secret: '', 31 chars, 32×'a' (few distinct), the exact .env.example placeholder, `CHANGE-ME…` 64 chars, containing `"`, containing `\r`, 513 chars all fail; 64 hex chars ok
  - mim_admin_url: https, ftp, `http://u:p@h/x`, `http:///x`, `http://h` (no path), `http://h/x?q=1` fail; `http://mongooseim:5551/api/graphql` ok
  - bad domain/user/password charsets fail
  - every error is exactly `{error,{bad_config,Key}}` and never contains the value
- **test/geo_log_redact_tests.erl** (adapted + new):
  - the admin password, basic b64 and JWT secret are redacted, including inside the `"Basic …"` header string
  - an xp1_ password is redacted in a binary, a char list, a nested map, a sentence, and the args of a `{Format, Args}` message
  - a real geo_auth:issue token is redacted
  - `xp1_short` and `eyJ` alone are untouched
  - patterns apply with an empty secrets list
- **test/geo_session_SUITE.erl** (CT):
  - Setup:
    - real Mongo at GEO_CT_MONGO_HOSTS (skip loudly if unreachable, like geo_mongo_SUITE)
    - a FAKE MongooseIM admin `test/geo_fake_mim.erl` (Cowboy handler on port 0) with per-case modes: ok, exists, unauthorized, http503, slow 7 s, garbage, closed port; it records method, auth header and decoded variables
    - the app with the admin URL pointing at the fake; a capturing logger
    - per-run random nickname prefix; clean up the tracked profiles
  - Cases:
    1. create_201:
       - exactly 6 keys; jid = sub@domain; the token verifies with sub = localpart
       - the password equals what the fake received; the fake saw the exact Basic header
       - the Mongo profile has exactly `_id`, nickname, state="active", createdAt (no expiresAt); `cache-control: no-store`
    2. duplicate_case_insensitive_409: Zed… then zed… → 201 then 409; one fake call, one profile
    3. reserved_409: no fake call, no Mongo write
    4. concurrent_same_nickname: 10 parallel → exactly one 201 and nine 409s; one profile; one register call
    5. validation:
       - GET/PUT → 405 + allow POST; missing content type or text/plain → 415
       - 1025-byte body → 413, with content-length AND chunked
       - empty / `{bad` / `[]` → 400 invalid_json; an extra key or numeric nickname → 400 invalid_request; `a b` → 400 invalid_nickname
       - no fake call or Mongo write in any of these
    6. xmpp_unavailable_rolls_back: http503 and the closed port → 503 + retry-after; no profile left; the same nickname gets 201 after the fake is back to ok; the closed-port case triggers a best-effort remove request
    7. xmpp_slow_times_out: 503 within 6.5 s; no profile left
    8. xmpp_unauthorized_500: 500 internal_error; no profile; exactly one `xmpp_admin_unauthorized` event
    9. xmpp_exists_500_no_remove: 500; the fake got NO remove request
    10. mongo_unavailable_503 (own group, mongo_hosts 127.0.0.1:1): 503; the fake not called
    11. logs_contain_no_secrets (end of suite): no captured event (via logger_formatter) contains any returned password/token, the admin password, the basic b64 or the JWT secret
- **geo_mongo_SUITE:**
  - extend the init-indexes drift guard to profiles (nickname_unique_ci en/2, expiresAt_ttl expireAfterSeconds 0)
  - insert_one/delete_one cases (insert, a duplicate nickname → `{error,{write_failed,11000}}`, delete matched 1, again 0)
  - The CT creates the profiles indexes on chaterl_ct the same as init-indexes.js.
- **geo_http_SUITE:** set the new env keys (admin URL `http://127.0.0.1:1/api/graphql`); a bad_config case with jwt_secret = a 20-char sentinel → `{bad_config,jwt_secret}`, the sentinel 0 times in the logs.
- **web/tests/viteApiProxy.test.ts:** undefined, '', '8090', 'abc', '0', '70000', ' 8080'.

## Acceptance criteria ([LIVE] = orchestrator)
- AC1: fmt/eunit/ct/dialyzer clean (geo_session_SUITE not skipped); npm typecheck/lint/test clean.
- AC2: no coordinates anywhere; the profile holds only `_id`, nickname, state, createdAt (+ expiresAt while pending); the JWT payload holds only iss, aud, sub, iat, exp, jti.
- AC3: geo_auth is HS256-only, hash_equals before the payload parse, all vectors pass.
- AC4 [LIVE]: rebuild → 4 healthy, /api/ready 200 (the local JWT_SECRET already qualifies).
- AC5 [LIVE]: curl POST /api/session → 201, 6 keys, jid `u[0-9a-f]{32}@chaterl.localhost`, expires_in 3600, a JWT with only the 6 claims and `exp - iat = 3600`.
- AC6 [LIVE]: the returned credentials log in to XMPP (the dev login form: localpart + xmpp_password); alice still logs in.
- AC7 [LIVE]: the profile is visible with exactly the four fields; profiles indexes `_id_`, nickname_unique_ci, expiresAt_ttl after re-running init-indexes (`exec -T`).
- AC8 [LIVE]: LIVE3C → 409; admin → 409; "a" → 400; text/plain → 415.
- AC9 [LIVE]: the Vite proxy: `http://127.0.0.1:5173/api/health` → 200, and POST session via 5173 works; no CORS headers.
- AC10 [LIVE]: `stop mongooseim` → 503 + retry-after within 8 s, no profile left, ready stays 200, RestartCount 0; start → the same nickname gets 201.
- AC11 [LIVE]: geo_service logs contain 0 returned passwords/tokens, JWT_SECRET and the admin password; session_created shows localparts only.
- AC12 [LIVE]: `run --rm -e JWT_SECRET=short` → exit 1, `{bad_config,jwt_secret}`, `short` absent; same for the placeholder.
- AC13 [LIVE]: remove the live test users via the admin API and delete their profiles; listUsers shows only alice and bob.
- AC14: docs + ADR-017; CLAUDE.md proposals in the report only.

## Risks
- **Secrets in crash reports:** httpc/handler reports can carry the body or auth header. The static secrets include the basic b64; the patterns cover xp1_ and JWTs; crash dumps are off. No logger call gets a body, result, Req or session cfg.
- **checkPassword echoes the password** (3e): parse only `correct`, never log.
- **Windows:** use 127.0.0.1 not localhost for the proxy; CRLF in .env puts `\r` in values; curl.exe in PowerShell; MSYS_NO_PATHCONV=1; exec -T; keep new .erl files LF.
- **Assert the mc_worker_api:insert reply shapes** against Mongo 7 in CT before relying on them; Erlang timestamps → BSON Date (TTL needs a Date).
- **Rollback after a timeout:** the best-effort remove is mandatory; orphans are possible if MongooseIM is fully down (accepted); never remove on exists.
- **Concurrency:** the unique index is the only arbiter; no find-then-insert; the 409 path must not call MongooseIM.
- **The httpc default profile** is node-wide: per-request options only, never httpc:set_options.
- **Abuse:** unlimited sign-ups until Phase 4; acceptable only while localhost-bound; documented with ROADMAP blockers.
- **Dev alice/bob** have no profile/JWT; 3d CT mints tokens with geo_auth:issue/3.
- **The loadEnv exception** must stay exactly 'GEO_HTTP_PORT'.

## Out of scope
- the renewal endpoint; client use of /api/session (3e)
- JWT on other routes and /api/locate (3d)
- rate limiting
- any MongooseIM config change; the MUC lockdown (3f)
- abandonment/reconciliation, nickname change, Unicode nicknames, status/blocked
- a $jsonSchema validator; CORS; refresh tokens/revocation; readiness depending on MongooseIM
- new deps

## Proposed CLAUDE.md changes (for the user)
- Commands:
  - `curl.exe -X POST http://127.0.0.1:8080/api/session -H "content-type: application/json" -d "{\"nickname\":\"Zed\"}"   # create a pseudonymous session (dev)`
  - `openssl rand -hex 32   # value for JWT_SECRET (geo_service refuses the placeholder)`
- Frontend rules: "The client calls geo_service same-origin at `/api` (Vite dev proxy → 127.0.0.1:GEO_HTTP_PORT; reverse proxy in production). No CORS."
- General: "The XMPP password and JWT are secrets: never log request/response bodies of `/api/session` or the MongooseIM admin API."

Suggested commit: `feat(geo): POST /api/session with XMPP provisioning and JWT (Phase 3c)`.
