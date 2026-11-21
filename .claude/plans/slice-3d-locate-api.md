# Plan: Phase 3d — POST /api/locate (JWT, strict validation, room upsert, crash-safe privacy)

Status: APPROVED 2026-11-21 after 3 review rounds with live checks (HEAD 23b5e0a). Rounds 2–3 fixed invalid-UTF-8 crashes in the auth parser, the content-type check and the redaction filter. ADR to append: **ADR-018**.
CLAUDE.md is user-owned: never edit it; list the proposed changes in the report.

## Goal
Authenticated clients send `POST /api/locate {lat, lng, range?, accuracy?}`. geo_service:
- validates the body
- turns it into a geohash cell and drops the coordinates
- bumps the `rooms` document in MongoDB
- returns `{cell, precision, range, room_jid}`

The coordinates must never reach any log, crash report, error tuple, reply or Mongo document, **even when the handler crashes after decoding**. A fault-injection CT test proves it.

## Context
- ADR-001 (range → 7/6/5), ADR-005 (server assigns rooms, coordinates discarded; this ships without rate limit/jump check, see Risks).
- ADR-013 (room id `g<precision>_<geohash>`; web MUC domain default `muc.<domain>`).
- ADR-015, ADR-016 (geo_store privacy contract: exactly six room keys; driver quirk 5: only cell data may reach geo_store).
- ADR-017 (JWT, geo_http_json, redaction, `{error, message}`, 503 + retry-after: 5).
- Touched:
  - `geo_service/src/{geo_http,geo_config,geo_log_redact}.erl`, `geo_service/rebar.config` (test profile only)
  - `test/{geo_config_tests,geo_log_redact_tests}.erl`
  - `.env.example`, README, ARCHITECTURE, ROADMAP, DECISIONS
- Reused as-is: geo_cell (from_point/3, room_id/1, room_jid/2), geo_store:touch_room/1, geo_auth:verify/3, geo_http_json:read_json_object/2, geo_http_reply, geo_fake_mim (log store + valid admin URL).
- **Facts checked in code (they drive the design):**
  - **Cowboy crash path:** cowboy_handler:execute/2 re-raises handler exceptions; cowboy_stream_h then logs "had its request process ~p exit with reason ~0p" with `{Reason, Stacktrace}`. The request process is proc_lib, so a crash report follows too. A `{badmatch, Map}` / `case_clause` reason, or a function_clause top frame with args, would print the decoded map or the raw floats.
  - **cow_http_hd:parse_authorization/1** crashes with function_clause on malformed input (the header value would end up in the stack args), so we parse the header ourselves.
  - **OTP json:decode/1 errors carry input bytes** (e.g. `{unexpected_sequence, <<"1.0e400">>}`). geo_http_json:decode/2 already catches error:_ and drops the reason; keep it so.
  - **Duplicate JSON keys** are first-wins (`{"a":1,"a":2}` → `#{a=>1}`): not a privacy issue; record it in the ADR.
  - **Encoder edges:** (90,180) → zzzzzzz; (−90,−180) → 0000000; lat 0, lng +180 → xbpbpbp, lng −180 → 8000000; −0.0 and 0 → s000000.
  - **MUC domain:** the MongooseIM template hard-codes `host = "muc.@HOST@"`; the web derives `muc.${domain}` when VITE_XMPP_MUC_DOMAIN is empty; `MUC_SUBDOMAIN` in .env.example is read by nothing.

## Dependencies
- **meck 1.2.0** (hex, Apache-2.0), **test profile only** (already in the local hex cache). It's needed for fault injection without production test hooks; it never ships.
  - Add it as `{profiles, [{test, [{deps, [{proper, "1.5.0"}, {meck, "1.2.0"}]}, ...]}]}`.
  - If it fails on OTP 28.4.2: STOP and report; don't swap in a DI hook.
- No runtime deps, no new OTP apps.

## Design decisions (all go into ADR-018)
1. **Auth.**
   - Header only: `cowboy_req:header(<<"authorization">>, Req)` parsed by our own total function, never cowlib.
   - Parsing:
     - no header / empty / any non-Bearer scheme → `missing`
     - the value equals `bearer` (any case), or starts with `bearer` + one space (scheme case-insensitive, RFC 7235) → a bearer credential was presented
     - the token must be 1..4096 bytes of `[A-Za-z0-9._-]`; an empty token, a second space, commas or other chars → `invalid`
     - duplicate Authorization headers arrive joined as "Bearer a, Bearer b" → the comma makes them `invalid`
   - Query-string tokens: NOT supported. No header + `?access_token=` → 401 missing. A valid header + any non-empty query string → 400 invalid_request.
   - 401 (RFC 6750):
     - body `{"error":"unauthorized","message":"A valid bearer token is required."}`
     - missing → `www-authenticate: Bearer realm="chaterl-api"`
     - invalid (malformed, bad sig, alg none, wrong secret, expired) → `www-authenticate: Bearer realm="chaterl-api", error="invalid_token"`
     - expired and invalid look the same externally
   - Order: 405 (method) → 401 → query-string 400 → 415/413/400 from the body. The body is never read for a 401.
   - The JWT alone is enough in 3d (no profile lookup: nothing is revocable yet; a token stays valid ≤1 h after its profile is deleted, accepted). Dev alice/bob have no token; CT mints tokens with geo_auth:issue/3.
2. **The request.**
   - Keys: `lat`, `lng` required; `range`, `accuracy` optional; any other key (incl. `Lat`, `latitude`) → 400 invalid_request.
   - Types: lat/lng/accuracy must be `is_number/1`; strings, true/false/null (atoms in OTP json), arrays and objects → invalid_request; `1e400` fails decoding → 400 invalid_json.
   - range: exactly "block" | "neighbourhood" | "area" via geo_cell:parse_range/1; default block; US "neighborhood" rejected (note it for 3e).
   - accuracy: accepted and validated (number, 0..1000000 m, else invalid_request), then ignored; never stored or logged.
   - Check order: key set + types, then range, then accuracy, then bounds. A body that is both malformed and out of range → invalid_request.
   - Bounds: lat [−90, 90], lng [−180, 180] inclusive (via geo_cell:from_point/3). Outside → 400 invalid_location (one code for both).
   - Antimeridian: lng 180 and −180 give different cells/rooms (accepted, documented).
   - Body cap 256 bytes; content-type rule from geo_http_json.
3. **Response.**
   - 200, ordered keys only: `{"cell":"u4pruyd","precision":7,"range":"block","room_jid":"g7_u4pruyd@muc.chaterl.localhost"}`. No separate room key. Later additive keys (places/neighbours) are possible, so the 3e parser tolerates extra keys.
   - The response is byte-identical for created vs updated (no activity oracle).
   - MUC domain: derived `<<"muc.", XmppDomain/binary>>` in geo_config:session/0, mirroring `muc.@HOST@`. No new env var.
     - session/0 fails `{bad_config, xmpp_domain}` if the derived domain would exceed 253 bytes (domain > 249).
     - Remove the unused MUC_SUBDOMAIN from .env.example.
     - The web VITE_XMPP_MUC_DOMAIN stays (3e validates room_jid against it).
4. **Privacy: both (b) and (a); (b) is the guarantee.**
   - **(b) Guarded handler:**
     - Everything after body decoding (geo_locate:cell_for/1, geo_store:touch_room/1, building the reply) runs inside ONE `try ... catch Class:Reason:Stack`.
     - A crash replies 500 internal_error and logs exactly one `#{event => locate_crashed, class, reason, where}` built by the pure `geo_crash:summary/3`:
       - reason = the atom itself, or the leading atom of a tagged tuple, else `term`
       - where = the top 5 frames as `{M, F, Arity, Line | undefined}`, with argument lists turned into arities and error_info dropped
     - So no cowboy_stream_h error or proc_lib crash report is produced for this path. This is a deliberate narrow exception to let-it-crash: a short-lived request process with nothing to restart, whose reason and stack are exactly what can carry the user's position.
     - The read and auth phases stay OUTSIDE the try (Cowboy's `{request_error, …}` exits must propagate so Cowboy answers 400/408/413; those carry no body).
     - geo_cell:from_point/3 and geohash:encode/3 are already total; a PropEr property proves cell_for/1 total.
     - Every call into geo_locate and geo_store must be fully qualified (meck relies on it).
     - The reply must be the LAST expression in the try.
   - **(a) Logger backstop in geo_log_redact:**
     - Map rule: any map key (binary any case, or atom) in lat, lng, lon, latitude, longitude, accuracy → the value replaced by `[REDACTED]`.
     - Two key-preserving text patterns over binaries and char lists:
       - `(?i)("(?:lat|lng|lon|latitude|longitude|accuracy)"\s*:\s*)("[^"]*"|[^,}\]\s]*)` → `\1[REDACTED]` (raw body bytes)
       - `(?i)(<<"(?:lat|lng|lon|latitude|longitude|accuracy)">>\s*=>\s*)([^,}\s]*)` → `\1[REDACTED]` (pre-formatted ~p)
     - Patterns become `{MP, Replacement}`; the existing ones keep `[REDACTED]` as the whole replacement.
     - The ADR must say plainly what this does NOT cover: bare floats in stack args (`[57.6, 10.4, block]`), and a body split across TCP packets. Hence (b) is the guarantee.
   - Constant error messages, never echoing values or key names. No logger call receives the body, Req, cfg, Lat or Lng.
   - Abuse: rate limit + impossible-jump stay in Phase 4 (geo_rate). Any valid token can locate any cell repeatedly. Accepted while localhost-bound. The response is deterministic from the input.
5. **The Mongo write.**
   - geo_store:touch_room(Cell) on every successful locate.
   - `{error, mongo_unavailable}` → 503 service_unavailable + retry-after: 5. "Return the room anyway" is rejected: from 3f geo_service owns room creation.
   - `{error, write_failed}` → 500 + one `#{event => locate_store_failed}` at warning (no cell, no sub).
   - No MongooseIM room creation (3f). TTL: rooms expire 7 days after lastActiveAt.
6. **Status codes:**

   | Status | Code |
   |---|---|
   | 200 | success |
   | 400 | invalid_json, invalid_request (shape/types/range/accuracy/unknown keys/query string), invalid_location |
   | 401 | unauthorized + www-authenticate |
   | 405 | method_not_allowed + allow: POST (before auth) |
   | 413 | payload_too_large |
   | 415 | unsupported_media_type |
   | 503 | service_unavailable + retry-after: 5 |
   | 500 | internal_error |

   All with cache-control: no-store.
7. **Logging:** none per request on success, at any level. Auth failures and 4xx aren't logged. Only locate_crashed (error) and locate_store_failed (warning), neither with a cell or sub.
8. **`/api/session/renew` stays in 3e.**

## Steps
1. **rebar.config:** add `{meck, "1.2.0"}` to the test-profile deps (check that rebar.lock is unaffected; test deps aren't locked at top level).
2. **geo_config:** `session_cfg()` gains `muc_domain := binary()`; session/0 derives it (bad_config xmpp_domain if > 253); export a pure `-spec muc_domain(binary()) -> binary()`; fix literal session_cfg maps in tests.
3. **New geo_http_auth.erl** (pure, no logging, no Req): bearer/1, check/3 (with geo_auth:verify/3; expired → invalid), www_authenticate/1.
4. **New geo_locate.erl** (pure, no logging, no processes): cell_for/1 (key set, types, range, accuracy, then geo_cell:from_point/3 → `{ok, Cell, Range}`, never the inputs); response/3 (the ordered key/value list). Module comment: inputs are raw coordinates; errors are bare atoms.
5. **New geo_crash.erl** (pure): summary/3 per decision 4; never argument values, non-atom reasons or error_info.
6. **New geo_http_locate.erl** (cowboy_handler):
   - method → auth (check/3 with erlang:system_time(second)) → query string → geo_http_json:read_json_object(Req, 256) → guarded/3 = try/catch around cell_for → touch_room → geo_http_reply:json_ordered(200, …)
   - the catch replies 500 and logs locate_crashed with geo_crash:summary/3
   - no terminate/3; module comment explains the catch (ADR-018)
7. **geo_http:** route `{"/api/locate", geo_http_locate, #{jwt_secret => …, muc_domain => …}}`, built from the session cfg (least privilege: no admin creds in its opts).
8. **geo_log_redact:** the coordinate-key map rule + two key-preserving patterns; update args() and the comment; existing behaviour unchanged.
9. **Tests** (below).
10. **.env.example:** delete MUC_SUBDOMAIN; next to XMPP_DOMAIN add a comment (own line): "the MUC domain is muc.<XMPP_DOMAIN>, as in mongooseim.toml.tmpl; geo_service and the web derive it".
11. **README:** after the session example, a locate example (curl.exe style, `<token>` placeholder, `--data-binary @body.json`), the exact 200 shape, and "coordinates are turned into a cell and discarded, never logged or stored".
12. **ARCHITECTURE:**
    - /api/locate HTTP row (request, response, errors, 256-byte cap, Bearer)
    - "Status (Phase 3d)" paragraph (JWT only, no rate limit, no geo_room, accuracy ignored, MUC domain derived, guarded handler, redaction backstop)
    - module table (geo_locate, geo_http_auth, geo_crash, geo_http_locate; extend geo_log_redact)
    - "Locate & join": rate limit, geo_room and places are not yet built
13. **ROADMAP:** do NOT tick (the orchestrator ticks after live checks); you may update the note text.
14. **DECISIONS:** ADR-018 "POST /api/locate: auth, validation and crash-safe coordinate handling" covering:
    - decisions 1–8, the meck test dep, the filter's known gaps, first-wins duplicate keys, the Phase 4 deferrals
    - a "Live evidence" heading for the orchestrator

## Interfaces
```erlang
%% geo_config
-type session_cfg() :: #{jwt_secret := binary(), xmpp_domain := binary(), muc_domain := binary(), admin := geo_xmpp_admin:admin()}.
-spec muc_domain(XmppDomain :: binary()) -> binary().          % <<"muc.", D/binary>>
%% geo_http_auth (pure)
-spec bearer(binary() | undefined) -> {ok, Token :: binary()} | missing | invalid.
-spec check(binary() | undefined, Key :: binary(), Now :: integer()) -> {ok, Sub :: binary()} | {error, missing | invalid}.
-spec www_authenticate(missing | invalid) -> binary().
%% missing -> <<"Bearer realm=\"chaterl-api\"">>
%% invalid -> <<"Bearer realm=\"chaterl-api\", error=\"invalid_token\"">>
%% geo_locate (pure)
-spec cell_for(map()) -> {ok, geo_cell:cell(), geo_cell:range()} | {error, invalid_request | invalid_location}.
-spec response(geo_cell:cell(), geo_cell:range(), MucDomain :: binary()) -> [{binary(), binary() | integer()}].
%% [{<<"cell">>,Hash},{<<"precision">>,P},{<<"range">>,<<"block">>|...},{<<"room_jid">>,Jid}]
%% geo_crash (pure)
-spec summary(error | exit | throw, term(), list()) ->
    #{class := error | exit | throw, reason := atom(), where := [{module(), atom(), arity(), pos_integer() | undefined}]}.
%% geo_http_locate
-type cfg() :: #{jwt_secret := binary(), muc_domain := binary()}.
-export_type([cfg/0]).
-spec init(cowboy_req:req(), cfg()) -> {ok, cowboy_req:req(), cfg()}.
```
HTTP:
```
POST /api/locate
authorization: Bearer <jwt>         (scheme case-insensitive; header only; no query string)
content-type: application/json      (optional charset=utf-8)
{"lat": number, "lng": number, "range"?: "block"|"neighbourhood"|"area", "accuracy"?: number 0..1000000}   (<= 256 bytes)
200 {"cell":"u4pruyd","precision":7,"range":"block","room_jid":"g7_u4pruyd@muc.chaterl.localhost"}
```
Error messages (constants):
- invalid_request: "Send {\"lat\": number, \"lng\": number} with optional \"range\" (block, neighbourhood, area) and \"accuracy\" (metres)."
- invalid_request (query string): "Query parameters are not accepted."
- invalid_location: "lat must be within -90..90 and lng within -180..180."
- 503/500: same texts as geo_http_session.

The rooms doc is unchanged: exactly `_id, precision, geohash, center (cell centre [lng, lat]), createdAt, lastActiveAt`. No index changes.

## Tests required
- **test/geo_http_auth_tests.erl:**
  - bearer/1:
    - undefined, `<<>>` → missing; `Basic abc`, `Digest x`, `Bear abc`, `Bearerx abc` → missing
    - `Bearer abc`, `bearer abc`, `BeArEr abc` → `{ok, <<"abc">>}`
    - `Bearer`, `Bearer  abc` (two spaces), `Bearer abc def`, `Bearer a, Bearer b`, a token containing `"`, `,`, a tab or `+`, a 4097-byte token → invalid
  - check/3 with a real geo_auth:issue/3 token: valid → `{ok, Sub}`; expired (issued Now−3700) → `{error, invalid}`; tampered payload, alg none (hand-built, empty signature), a different secret → `{error, invalid}`; undefined → `{error, missing}`
  - www_authenticate/1: both exact strings
- **test/geo_locate_tests.erl:**
  - Valid:
    - (57.64911, 10.40744) → g7 u4pruyd
    - every `?VECTORS` entry (include geohash_vectors.hrl) → `{ok, #{precision=>7, geohash=>H}, block}`
    - lng 180 → xbpbpbp, −180 → 8000000 (asserted different)
    - integers 0/0 and −0.0/−0.0 → s000000
  - Range: absent → block; block/neighbourhood/area → 7/6/5 (u4pruyd / u4pruy / u4pru); `"Block"`, `"neighborhood"`, `""`, 7, null, true, `[]` → invalid_request
  - Type matrix for lat and lng each: `<<"57.6">>`, true, false, null, `[]`, `#{}`, missing → invalid_request
  - Keys: extra foo, `Lat`, `latitude`, an empty map → invalid_request
  - accuracy: absent, 0, 25, 25.5, 1000000 ok; −1, 1000000.5, `<<"25">>`, null, true → invalid_request
  - Bounds: 90.0000001, −90.0000001, 180.0000001, −180.0000001, 1.0e308, 10^30 → invalid_location
  - Order: `{lat 91, lng 0, range "x"}` → invalid_request
  - Results never contain inputs: the Cell map has exactly precision and geohash; `~p` of every result contains no input number
  - PropEr totality (1000 cases): random maps ≤6 entries (known keys + random binaries; values: integers incl. huge, floats, binaries, booleans, null, lists, maps) → cell_for/1 never raises and returns one of the three shapes
  - response/3 exact, and `iolist_to_binary(json:encode_key_value_list(...))` equals the exact 200 body (also g6, g5)
  - **Drift guard** (pattern from geohash_tests; must RUN locally):
    - resolve `../../web/src/xmpp/jid.ts` from ?FILE, extract the `ROOM_LOCALPART = /…/` source, compile it with re, assert geo_cell:room_id/1 of every vector at precisions 5/6/7 matches
    - assert `../../web/src/config.ts` contains the literal `` `muc.${domain}` ``
    - if `web/src/geo/cell.ts` still defines roomJidForCell, assert its template is `` `g${String(cell.precision)}_${cell.geohash}@${mucDomain}` `` (skip this sub-check after 3e deletes it)
    - `?debugMsg` "skipped" when the files are absent
    - Read the actual web sources first and adapt the extraction to what is really there; report what you matched.
- **test/geo_crash_tests.erl:**
  - Stack `[{geo_cell, from_point, [57.6491137, 10.4074419, block], [{file,"x"},{line,3}]}, {m, f, 2, [{error_info, #{cause => 57.6491137}}]}]` with reason `{badmatch, #{<<"lat">> => 57.6491137}}` → reason badmatch, where `[{geo_cell, from_point, 3, 3}, {m, f, 2, undefined}]`; `~p` of the summary contains neither "57.649" nor "10.407"
  - A bare float reason → term; function_clause → function_clause; throw/exit classes preserved
  - A malformed stack entry → `{unknown, unknown, 0, undefined}` (no crash)
- **test/geo_log_redact_tests.erl** (additions; existing unchanged):
  - `#{<<"lat">> => 57.6491137, <<"lng">> => 10.4074419, <<"range">> => <<"block">>}` nested in a report → lat/lng masked, range kept
  - `<<"LAT">>` and `latitude` keys masked
  - the raw body binary `<<"{\"lat\":57.6491137, \"lng\" : -10.4074419,\"accuracy\":25}">>` and the same as a char list → all three values masked, keys kept
  - the pre-formatted `"#{<<\"lat\">> => 57.6491137}"` masked; a string `"lat": "57.6"` masked
  - unrelated `"latency": 57` untouched; xp1_ and JWT patterns still work
- **test/geo_config_tests.erl:** session/0 gives muc_domain `<<"muc.chaterl.localhost">>`; a 249-byte domain ok; 250 → `{error,{bad_config,xmpp_domain}}` (the value never appears).
- **New test/geo_locate_SUITE.erl** (CT; real Mongo, chaterl_ct; skip loudly if unreachable; reuse geo_fake_mim for the admin URL + log store; a capturing logger; primary level debug for the whole suite):
  - Setup:
    - create the rooms indexes as in init-indexes.js
    - mint tokens with geo_auth:issue(`<<"u", 32 hex>>`, ?JWT_SECRET, Now)
    - delete rooms per testcase
    - you may add test/geo_ct_http.erl (a raw-socket client: method, path, header list allowing duplicates, body, chunked); do not refactor geo_session_SUITE
  - Sentinels: A = (57.6491137, 10.4074419), B = (57.6485531, 10.4070917), both in u4pruyd; out of range 90.0000173 and −180.0000419; string "57.6491999".
  - Cases:
    1. locate_200_block:
       - raw body bytes exactly the 200 string; headers content-type, cache-control no-store, x-content-type-options
       - the rooms doc has exactly six keys, precision 7, geohash u4pruyd
       - center.coordinates == [CLng, CLat] from geohash:centre, ≠ [10.4074419, 57.6491137], containing neither sentinel
       - createdAt == lastActiveAt
    2. same_cell_updates: A, sleep 20 ms, B → identical bodies; one doc; createdAt unchanged; lastActiveAt strictly greater.
    3. ranges: neighbourhood → g6_u4pruy, area → g5_u4pru (docs precision 6 and 5); explicit block = default; with accuracy 25 → same body.
    4. edges: (90,180) → zzzzzzz; (−90,−180) → 0000000; (0,180) and (0,−180) → xbpbpbp and 8000000 (two docs); (0,0) integers → s000000; all accepted by the 2dsphere index.
    5. auth_401_matrix (each 401 with the exact www-authenticate + exact body; rooms count unchanged):
       - none → realm only; Basic → realm only; `?access_token=<valid>` without a header → realm only
       - expired, tampered, alg none, other secret, `Bearer` alone, two spaces, two Authorization headers each valid → invalid_token
       - no auth + text/plain → 401 (not 415); no auth + a 10 KB body → 401
       - the body never contains the token
       - positive controls: `bearer <valid>` and `BEARER <valid>` → 200
    6. method_405: GET, PUT, HEAD, OPTIONS without auth → 405 + allow: POST.
    7. validation:
       - valid auth + `?x=1` → 400 invalid_request; text/plain → 415
       - 257 bytes via content-length and via chunked → 413; exactly 256 bytes (whitespace-padded) → 200
       - `{bad`, `[]`, `{"lat":1e400,"lng":0}` → invalid_json
       - extra key, string lat, missing lng, "Block", accuracy −1 → invalid_request
       - 90.0000173 and −180.0000419 → invalid_location
       - no rooms write in any of these; no error body contains any sent number
    8. group mongo_down (restart the app with 127.0.0.1:1): valid token → 503 service_unavailable + retry-after: 5; invalid token → 401; restore and wait ready in end_per_group.
    9. group crash_injection (meck; end_per_testcase ALWAYS runs meck:unload()):
       - Variants:
         - (a) `meck:new(geo_locate, [passthrough])`, cell_for raising `meck:exception(error, {injected, Body})`; control: the injected term formatted with ~0p DOES contain "57.6491137" (not vacuous)
         - (b) cell_for raising `erlang:error(function_clause, [Lat, Lng])`
         - (c) `meck:new(geo_store, [passthrough])`, touch_room returning `{ok, bogus}` → case_clause
       - Each variant asserts:
         - 500 internal_error
         - exactly one captured locate_crashed event with the expected class/reason (injected / function_clause / case_clause)
         - zero proc_lib crash reports and zero events whose formatted text contains "had its request process"
         - the case's captured events contain no sentinel in any representation
         - `meck:num_calls/3` = 1
    10. logs_contain_no_coordinates (last):
        - control: `logger:error(#{body => #{<<"lat">> => 57.6491137}})` and `logger:error("~s", ["{\"lat\":57.6491137}"])` come out with [REDACTED] and without the sentinel
        - then for every captured event (formatted ~0p AND via logger_formatter:format/2), none of these appear for any sentinel F: the literal JSON text, `float_to_list(F,[short])`, `io_lib:format("~p",[F])`, `io_lib:format("~w",[F])`, nor any raw request body sent in the suite
        - assert locate_crashed is present; assert no `event =>` from our locate code other than locate_crashed/locate_store_failed
- **Regression:** geo_session_SUITE, geo_http_SUITE, geo_mongo_SUITE and all EUnit suites pass; web checks unchanged (no web edits).

## Acceptance criteria ([LIVE] = orchestrator)
- AC1: fmt, eunit (the drift guard RUNS; the property runs 1000), ct (geo_locate_SUITE not skipped; crash_injection runs), dialyzer 0 warnings; web checks clean.
- AC2 (review):
  - geo_locate, geo_http_auth and geo_crash have no logger calls
  - geo_http_locate logs only locate_crashed (summary) and locate_store_failed, with no cell/sub/Req/body/cfg/Lat/Lng
  - every step after decoding is inside the try; error messages are constants
  - meck is test-profile only
- AC3: the 200 body is byte-identical for created/updated; the rooms doc has exactly six keys; centre = the cell centre.
- AC4 [LIVE]: rebuild → 4 healthy, /api/ready 200.
- AC5 [LIVE]: session → token (in a variable, never printed); locate (57.6491137, 10.4074419) → 200 exact u4pruyd body; "range":"area" → g5_u4pru.
- AC6 [LIVE]: the g7_u4pruyd doc has exactly six keys; centre = the cell centre; a second locate bumps only lastActiveAt; rooms indexes unchanged.
- AC7 [LIVE]: no header → 401 realm only; tampered and alg-none → 401 invalid_token; GET → 405; lat 90.0000173 → 400 invalid_location; text/plain with auth → 415; token in the query string → 401.
- AC8 [LIVE]: via the Vite proxy `http://localhost:5173/api/locate` → the same 200; no access-control-* headers.
- AC9 [LIVE]: geo_service logs (script, values never printed): 0 × 57.6491137, 10.4074419, 90.0000173, the token; no locate_* lines after the successful and 4xx requests.
- AC10 [LIVE]: stop mongo → 503 + retry-after: 5 within ~8 s, RestartCount 0; start → 200 again once ready.
- AC11: README, ARCHITECTURE, ROADMAP note, ADR-018; MUC_SUBDOMAIN removed; CLAUDE.md proposals in the report.

## Risks
- **Privacy is the review gate:**
  - any `{ok, X} = …` or `#{<<"lat">> := L} = Body` match outside the try, or a logger call receiving Body/Req/coordinates, is BLOCKING
  - no terminate/3 (Cowboy passes it `{crash, Class, Reason}`)
  - nothing logged in the catch beyond geo_crash:summary/3
  - the backstop doesn't cover bare floats in stack args; only the try does
- **Reply last in the try** (no double reply).
- **read_json_object outside the try** (don't turn 408/413 into 500).
- **meck:** node-global; always unload; use passthrough; calls must be remote; don't assert meck:validate after erlang:error in an expect.
- **Debug logger level in CT** makes the driver chatty; filter assertions by our event names.
- **Replying 401 without reading the body:** the raw client uses `connection: close`.
- **Abuse/spoofing:** unlimited locates until Phase 4; accepted while localhost-bound.
- **3e:** accept extra keys; British "neighbourhood"; validate room_jid against VITE_XMPP_MUC_DOMAIN.
- **Windows:** JSON bodies via files + `curl.exe --data-binary @file`; Vite at localhost:5173 (::1), geo_service at 127.0.0.1:8080; MSYS_NO_PATHCONV=1 + exec -T; LF .erl files; the log grep in a script.

## Out of scope
- /api/session/renew and any client change (3e)
- MUC lockdown / MongooseIM room creation (3f)
- geo_rate, impossible jump, geo_room (Phase 4)
- places/neighbours; a profile lookup or revocation; CORS
- init-indexes.js changes; a MUC_DOMAIN env var
- refactoring geo_session_SUITE; runtime deps

## Proposed CLAUDE.md changes (for the user)
- Commands: `curl.exe -X POST http://127.0.0.1:8080/api/locate -H "authorization: Bearer <token>" -H "content-type: application/json" --data-binary @body.json   # locate (dev; token from /api/session)`
- Erlang/OTP: "HTTP handlers that receive coordinates run everything after body decoding inside one try/catch that replies 500 and logs only geo_crash:summary/3 (no reason values, no stack args). This is the one sanctioned exception to let-it-crash (ADR-018)."
- Privacy: "Never log a geohash cell together with a user id; no per-request location logs."

Suggested commit: `feat(geo): POST /api/locate with JWT auth and crash-safe coordinate handling (Phase 3d)`.
