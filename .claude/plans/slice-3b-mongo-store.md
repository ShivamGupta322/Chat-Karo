# Plan: Phase 3b — Mongo pool, readiness, geo_cell, geo_store rooms upsert

Status: APPROVED 2026-11-21 after 2 review rounds with live Docker checks (HEAD bc9bb6d). Known issue: ADR-016 quirk 10, fix in slice 3b.1. ADR to append: **ADR-016**.
CLAUDE.md is user-owned: do NOT edit it; list the proposed changes in the report.

## Spike result (supervisor, verified on OTP 28.4.2 vs dev Mongo 7.0.48, OP_MSG)
Driver: comtihon/mongodb-erlang master @ `b17302e7f4f128cf2113a665a5d300b66829cd5d` (3.6.10, Apache-2.0).

Transitive deps, pinned via rebar.lock:
| Dep | Source | Licence | Note |
|---|---|---|---|
| bson v0.2.4 @ `f5a8c7030dd0107d2eed99059bc09c53ebe5e5dd` | — | Apache-2.0 | |
| poolboy 1.6.1 @ `6b5212c4cb20b85e57c9627bb0940c126f4e0766` | comtihon fork, branch | ISC | |
| pbkdf2 @ `5201a735639496fc595061160117e4ec155d73f5` | — | Apache-2.0 | dead code on OTP ≥ 24; 3 removed-crypto compile warnings are expected |

Worked:
- connect, ping/hello
- update with upsert (`upserted` key on insert, n=1 on update)
- find_one (`undefined` when missing), insert
- createIndexes (2dsphere + TTL), $near
- erlang:timestamp() dates (ms precision); GeoJSON [lng,lat] round trip
- 50 concurrent calls on pool 3
- Mongo down at start: connect returns {ok,Pid}, calls give {error,timeout} after serverSelectionTimeoutMS
- self-recovery after a late Mongo start; a killed topology cleans up its own processes and the name can be re-registered
- SCRAM with auth_source works for users with SHA-1 (SHA-256-only users FAIL)
- TLS verify_peer + cacertfile + the https hostname match fun works; unknown CA and a hostname mismatch are rejected; no explicit SNI needed (an IP literal fails the hostname check)
- dialyzer clean with plt_extra_apps [bson, poolboy] when ping goes via mongoc:transaction/4

Quirks to handle:
1. A failed write returns `{true, #{<<"writeErrors">> := [...]}}`. Always check writeErrors / writeConcernError.
2. The `mongo_api:command/3` spec is wrong (Dialyzer). Use `mongoc:transaction(Topo, fun(#{pool := W}) -> mc_worker_api:command(W, Cmd) end, #{}, T)`.
3. There is no call timeout by default. `mc_utils:get_timeout/0` reads `application:get_env(mc_worker_call_timeout)` in the CALLING process's app (default infinity). Set `{mc_worker_call_timeout, 5000}` in geo_service's app env.
4. The password leaks into poolboy/supervisor/mc_server crash reports, hence the logger redaction filter.
5. The driver logs via error_logger on failed calls, possibly including the command document, so only cell data may reach geo_store.
6. A missing topology raises `exit:{noproc,_}` in the caller, outside mongoc:transaction's try. geo_mongo catches `exit:_` and returns `{error, mongo_unavailable}`.
7. The mc_server processes aren't OTP-supervised but stop with the topology (verified); acceptable.
8. SRV only works for a single connection (random host, no TXT). For Atlas, use a host list + `{rs, SetName, Seeds}`. Replica-set mode is unverified.

## Atlas vs Docker (relayed to the user)
- Stay on Docker Mongo for dev and the Phase 6 VPS. Atlas becomes an env-only switch.
- If the user chooses Atlas:
  - the DB user needs SCRAM-SHA-1
  - resolve SRV/TXT manually into MONGO_HOSTS / MONGO_REPLICA_SET / MONGO_AUTH_SOURCE=admin / MONGO_TLS=true
  - add the VPS IP to the IP access list
  - run init-indexes.js once
  - use an alphanumeric password
  - check /api/ready = 200 and no password in the logs

## Goal
Connect geo_service to MongoDB through a supervised comtihon/mongodb-erlang topology, configured entirely from env:
- Docker is the default.
- It is Atlas-ready: seed list, replica set, auth, TLS.

Also add:
- a pure `geo_cell`
- a `geo_store` that upserts `rooms` documents keyed by cell (cell centre only)
- a readiness probe with `GET /api/ready`
- a log filter that redacts the Mongo password

Proven by `rebar3 ct` upserting and reading a rooms doc in the dev Mongo.

## Context
- Roadmap Phase 3 "MongoDB pool + geo_store; init-indexes.js".
- ADR-001 (7/6/5), ADR-004 (TTL), ADR-005 (no coordinates stored), ADR-007, ADR-013 (`g7_<geohash>`), ADR-015.
- init-indexes.js: NO change. 3b uses only `_id`, `center_2dsphere` and `lastActiveAt_ttl`, which already exist and are present in the dev volume.
- Touched:
  - geo_service/{rebar.config, rebar.lock, src/geo_service.app.src, src/geo_config.erl, src/geo_service_app.erl, src/geo_service_sup.erl, src/geo_http.erl, config/sys.config.src, config/shell.config, Dockerfile, test/geo_http_SUITE.erl, test/geo_config_tests.erl}
  - docker-compose.yml, .env.example, docs/{ARCHITECTURE.md, DECISIONS.md}, README.md

## Dependencies
- Add exactly `{mongodb, {git, "https://github.com/comtihon/mongodb-erlang.git", {ref, "b17302e7f4f128cf2113a665a5d300b66829cd5d"}}}`. Transitive deps are locked, not listed. Commit rebar.lock.
- Forbidden: hex mongodb_erlang, the emqx fork, JSON libs, jose, hackney, gun, an own OP_MSG client.
- The Docker build stage needs git (the erlang:28.4.2 full image has it; confirm).

## Steps
1. **rebar.config:** add the dep; `plt_extra_apps, [cowlib, bson, poolboy]` (more only if Dialyzer reports unknowns; say so).
2. **app.src:**
   - applications `[kernel, stdlib, crypto, public_key, ssl, ranch, cowboy, mongodb]`
   - `{env, [{mc_worker_call_timeout, 5000}]}`, commented: "Read by the mongodb driver via application:get_env/1 in the CALLING process's application; default is infinity (a hung Mongo would block callers forever). Not host/port/secret."
3. **geo_config:** `mongo/0` + pure parsers; still the only app-env reader.
   - Validation order: hosts, replica_set, db, user, password, auth_source, tls, tls_ca_file, pool_size.
   - MONGO_HOSTS: comma-separated `host[:port]`, 1..16 entries; host `[A-Za-z0-9.-]` 1..253; port 1..65535 (default 27017); no whitespace, no IPv6.
   - MONGO_REPLICA_SET: "" or `[A-Za-z0-9_.-]{1,64}`; "" with more than one host → bad_config mongo_replica_set.
   - MONGO_DB: `[A-Za-z0-9_-]{1,63}`.
   - MONGO_USER / MONGO_PASSWORD:
     - both "" → no auth; exactly one "" → bad_config naming the EMPTY key
     - password: no control characters, `"` or `\`
     - user: `[A-Za-z0-9._@-]{1,128}`
   - MONGO_AUTH_SOURCE: "" → <<"admin">>, else the db regex.
   - MONGO_TLS: "true" | "false" | "" ("" → false); anything else → bad_config.
   - MONGO_TLS_CA_FILE (checked only when TLS is true): "" → OS store (`public_key:cacerts_load()` must be ok, else bad_config mongo_tls_ca_file); otherwise `filelib:is_regular/1`.
   - MONGO_POOL_SIZE: "" → 5, else 1..50.
4. **src/geo_log_redact.erl:** logger primary filter `filter(LogEvent, Secrets)`.
   - It walks `msg` (report maps/lists, `{Format, Args}`, `{string, S}`) through tuples, lists (improper too), maps and binaries.
   - A binary equal to or containing a secret has the secret replaced by `[REDACTED]`; a char list equal to a secret becomes `"[REDACTED]"`.
   - `install([binary()]) -> ok`: remove any existing `geo_redact`, add it if the list is non-empty. `uninstall() -> ok`.
   - No logging inside.
5. **src/geo_cell.erl** (pure; see Interfaces).
6. **src/geo_mongo.erl:**
   - `child_spec/1` = `#{id => geo_mongo, start => {mongoc, connect, [Seed, TOpts, WOpts]}, restart => permanent, shutdown => 5000, type => worker, modules => [mc_topology]}`.
   - Seed: `{single, "h:p"}` | `{rs, RsBin, ["h:p", ...]}`.
   - TOpts: `[{register, geo_mongo_topology}, {pool_size, N}, {max_overflow, 0}, {serverSelectionTimeoutMS, 2000}, {connectTimeoutMS, 5000}]`.
   - WOpts: `[{database, Db}]` + `{login, U}, {password, P}, {auth_source, Src}` with auth + `{ssl, true}, {ssl_opts, Tls}` with TLS.
   - Tls: `[{verify, verify_peer}, {cacerts, public_key:cacerts_get()} | {cacertfile, Path}, {versions, ['tlsv1.3','tlsv1.2']}, {customize_hostname_check, [{match_fun, public_key:pkix_verify_hostname_match_fun(https)}]}]`. NO server_name_indication.
   - Wrappers `ping/0` (mongoc:transaction/4 + mc_worker_api:command/2), `update_one/4` (mongo_api:update/5), `find_one/3` (mongo_api:find_one/4):
     - each wrapped in `try ... catch exit:_ -> {error, mongo_unavailable} end` (commented)
     - a driver `{error, _}` → `{error, mongo_unavailable}`
     - pure `classify_write/1`
   - Never log driver reasons or documents.
7. **src/geo_mongo_probe.erl** (gen_server, registered):
   - init: named ETS `geo_mongo_status` (set, protected, read_concurrency), insert `{mongo, down}`, then `{ok, S, {continue, probe}}`.
   - The probe pings and writes up/down. On a TRANSITION only, log `#{event => mongo_ready}` (info) or `#{event => mongo_unavailable}` (warning), with no reason. Reschedule with `erlang:send_after(5000, self(), probe)`.
   - Blocking in handle_info is OK (no I/O handle_call); comment this.
   - `geo_mongo:ready/0` reads ETS directly.
8. **src/geo_store.erl:** `touch_room/1,2`, `get_room/1`.
   - Upsert filter `#{<<"_id">> => RoomId}`.
   - Update `#{<<"$set">> => #{<<"lastActiveAt">> => Now}, <<"$setOnInsert">> => #{<<"precision">>, <<"geohash">>, <<"center">> => geo_cell:centre_geojson(Cell), <<"createdAt">> => Now}}`.
   - On write error 11000, retry once.
   - No function accepts lat/lng.
9. **geo_service_app:**
   - validate http_listen() then mongo(); on error log `#{event => bad_config, key => K}`
   - then `geo_log_redact:install(Secrets)` (`[Password]` with auth, else `[]`) BEFORE starting the sup
   - start the sup with `#{listen => L, mongo => M}`; `stop/1` → `geo_log_redact:uninstall()`
10. **geo_service_sup:** `start_link(#{listen, mongo})`; children in order geo_mongo, geo_mongo_probe, geo_http; one_for_one 5/10.
11. **geo_http + src/geo_http_ready.erl:** route `/api/ready`, GET/HEAD only (405 with allow otherwise); reads `geo_mongo:ready()`; never reads the body. `/api/health` unchanged (liveness).
12. **config/sys.config.src:** add `{mongo_hosts, "${MONGO_HOSTS}"}, {mongo_db, "${MONGO_DB}"}, {mongo_replica_set, "${MONGO_REPLICA_SET}"}, {mongo_user, "${MONGO_USER}"}, {mongo_password, "${MONGO_PASSWORD}"}, {mongo_auth_source, "${MONGO_AUTH_SOURCE}"}, {mongo_tls, "${MONGO_TLS}"}, {mongo_tls_ca_file, "${MONGO_TLS_CA_FILE}"}, {mongo_pool_size, "${MONGO_POOL_SIZE}"}`.
    config/shell.config: hosts "127.0.0.1:27018", db "chaterl", the rest "".
13. **Dockerfile** runtime stage: apt install `curl ca-certificates`.
14. **docker-compose.yml** geo_service:
    - env `MONGO_HOSTS: ${MONGO_HOSTS:-mongo:27017}`, `MONGO_DB: ${MONGO_DB:-chaterl}`, the others `${VAR:-}` (`MONGO_TLS: ${MONGO_TLS:-false}`)
    - `depends_on: {mongo: {condition: service_healthy}}` (dev ordering only; the code still starts degraded)
    - healthcheck URL → `/api/ready`
15. **.env.example:** replace `MONGO_URL` (unused by any code) with the new variables plus one-line comments, and a commented "Atlas example" block (no real values) pointing to ADR-016.
16. **Docs:**
    - ARCHITECTURE: supervision status; module table (+geo_mongo, geo_mongo_probe, geo_log_redact, geo_cell, geo_store, geo_http_ready); HTTP table (+/api/ready); rooms model (3b writes `_id, precision, geohash, center, createdAt, lastActiveAt`; placeId/slowModeSec arrive in Phase 5; readers treat missing as null/0).
    - README: ready curl; `rebar3 ct` needs Mongo on 127.0.0.1:27018; the init-index re-run command.
    - ADR-016.
    - Do NOT edit CLAUDE.md.

## Interfaces
```erlang
%% geo_config
-type mongo_seed() :: {single, string()} | {rs, binary(), [string(), ...]}.      % "host:port"
-type mongo() :: #{seed := mongo_seed(), database := binary(),
                   auth := none | #{user := binary(), password := binary(), source := binary()},
                   tls := false | #{ca := os | file:filename_all()}, pool_size := 1..50}.
-type mongo_key() :: mongo_hosts | mongo_replica_set | mongo_db | mongo_user | mongo_password | mongo_auth_source
                   | mongo_tls | mongo_tls_ca_file | mongo_pool_size.
-spec mongo() -> {ok, mongo()} | {error, {bad_config, mongo_key()}}.
-spec parse_hosts(term()) -> {ok, [{string(), inet:port_number()}, ...]} | error.
%% (plus parse_* helpers per key, all `-> {ok, V} | error`, all exported for EUnit)

%% geo_cell (pure, ADR-001)
-type range() :: block | neighbourhood | area.
-type precision() :: 5 | 6 | 7.
-type cell() :: #{precision := precision(), geohash := geohash:geohash()}.
-type geojson_point() :: #{binary() => binary() | [float()]}.   % #{<<"type">> => <<"Point">>, <<"coordinates">> => [Lng, Lat]}
-spec precision(range()) -> precision().                       % block 7, neighbourhood 6, area 5
-spec parse_range(term()) -> {ok, range()} | {error, invalid_range}.   % <<"block">> | <<"neighbourhood">> | <<"area">>
-spec from_point(Lat :: term(), Lng :: term(), range()) ->
    {ok, cell()} | {error, lat_out_of_range | lng_out_of_range}.  % errors are atoms only; never echo inputs
-spec parse_cell(term(), term()) -> {ok, cell()} | {error, invalid_cell}.  % precision 5..7, byte_size == precision, valid base32
-spec room_id(cell()) -> binary().                              % <<"g7_u4pruyd">> (matches web roomJidForCell)
-spec parse_room_id(term()) -> {ok, cell()} | {error, invalid_room_id}.
-spec room_jid(cell(), MucDomain :: binary()) -> binary().      % <<"g7_u4pruyd@muc.chaterl.localhost">>
-spec centre_geojson(cell()) -> geojson_point().                % from geohash:centre/1, order [Lng, Lat]

%% geo_mongo
-spec child_spec(geo_config:mongo()) -> supervisor:child_spec().
-spec ready() -> boolean().     % ETS read; false if the table is absent (try/catch error:badarg, commented)
-spec ping() -> ok | {error, mongo_unavailable}.
-spec update_one(binary(), map(), map(), #{upsert => boolean()}) ->
    {ok, #{matched := non_neg_integer(), upserted := boolean()}} | {error, mongo_unavailable | {write_failed, integer() | unknown}}.
-spec find_one(binary(), map(), map()) -> {ok, map()} | not_found | {error, mongo_unavailable}.
-spec classify_write(term()) -> {ok, #{matched := non_neg_integer(), upserted := boolean()}}
                               | {error, mongo_unavailable | {write_failed, integer() | unknown}}.
   % {true,#{writeErrors:=[#{code:=C}|_]}} → {write_failed,C}; writeConcernError → {write_failed,C};
   % {true,#{n:=N}=R} → ok, upserted = is_key(upserted); {false,_} → {write_failed,unknown}; {error,_} → mongo_unavailable

%% geo_store (rooms only)
-type room() :: #{id := binary(), precision := geo_cell:precision(), geohash := binary(),
                  center := geo_cell:geojson_point(), created_at := erlang:timestamp(), last_active_at := erlang:timestamp()}.
-spec touch_room(geo_cell:cell()) -> {ok, created | updated} | {error, mongo_unavailable | write_failed}.
-spec touch_room(geo_cell:cell(), Now :: erlang:timestamp()) -> {ok, created | updated} | {error, mongo_unavailable | write_failed}.
-spec get_room(geo_cell:cell()) -> {ok, room()} | not_found | {error, mongo_unavailable | bad_document}.

%% geo_log_redact
-spec filter(logger:log_event(), [binary()]) -> logger:filter_return().
-spec install([binary()]) -> ok.
-spec uninstall() -> ok.
```
Mongo rooms document (exactly these keys):
`{ _id: "g7_u4pruyd", precision: 7, geohash: "u4pruyd", center: { type: "Point", coordinates: [<cell-centre lng>, <cell-centre lat>] }, createdAt: Date, lastActiveAt: Date }`

HTTP:
- GET /api/ready → 200 `{"status":"ready","mongo":"up"}` | 503 `{"status":"unavailable","mongo":"down"}`; HEAD gives the same status with no body; other methods → 405 + `allow: GET, HEAD`; security headers via geo_http_reply.
- GET /api/health unchanged: 200 `{"status":"ok"}` whatever Mongo's state.

## Tests required
- **test/geo_cell_tests.erl:**
  - precision/1 table
  - parse_range accepts the three binaries; rejects `"block"` (list), `<<"Block">>`, `<<>>`, atoms
  - from_point (57.64911, 10.40744) → u4pruyd / u4pruy / u4pru
  - room_id / parse_room_id round trip
  - parse_room_id rejects `g8_x`, `g7_u4pruy`, `g7_u4pruya`, `G7_…`, `g7u4pruyd`, `<<>>`, list input
  - room_jid exact
  - centre_geojson is [Lng, Lat] (geohash:centre swapped)
  - two points in the same cell give an identical centre_geojson that differs from both points
  - `zzzzzzz` / `0000000` / `xbpbpbp` / `8000000` are within range
  - errors are exact atoms (no input values)
- **test/geo_config_tests.erl** (extend):
  - hosts accepts `"mongo:27017"`, `"mongo"` (→27017), `"a.example.net:27017,b.example.net:27017"`, `<<"127.0.0.1:27018">>`
  - hosts rejects `""`, `" mongo"`, `"mongo:"`, `"mongo:0"`, `"mongo:70000"`, `"[::1]:27017"`, `"a,,b"`, `"mongodb://x"`, 17 hosts, `undefined`
  - the replica-set rule; the db regex
  - user/password pairing names the empty key; a password with `"` → bad_config mongo_password
  - auth_source default admin; tls strictness (`"TRUE"` and `"1"` rejected)
  - the CA file must exist when tls=true and is ignored when false
  - pool_size bounds; validation order
  - no returned term contains the password sentinel
- **test/geo_log_redact_tests.erl:**
  - nested map/tuple/list/binary-substring/improper-list redaction
  - `{Format, Args}` and `{string, S}`
  - non-matching events unchanged (`=:=`); an empty list is a no-op
  - install twice leaves one filter
- **test/geo_mongo_tests.erl:** classify_write fixtures (all branches).
- **test/geo_http_SUITE.erl** (no Mongo needed):
  - set mongo_hosts "127.0.0.1:1", db "geo_ct", the rest ""
  - add `ready_unavailable_without_mongo` (503 exact body; HEAD 503; POST 405)
  - the supervision test asserts geo_mongo + geo_mongo_probe are children
  - the bad-config test adds `mongo_hosts = ""` → `{bad_config, mongo_hosts}`
- **test/geo_mongo_SUITE.erl** (Mongo at `os:getenv("GEO_CT_MONGO_HOSTS", "127.0.0.1:27018")`, db `chaterl_ct`):
  - init_per_suite: a raw gen_tcp probe → skip if unreachable; start the app with http_port "0"; wait ≤10 s for ready; drop chaterl_ct; create the rooms indexes the same as init-indexes.js (commented). end_per_suite drops chaterl_ct.
  - init_indexes_drift_guard: `../../infra/mongo/init-indexes.js` declares center_2dsphere and lastActiveAt_ttl with `7 * 24 * 3600`.
  - ready_200
  - touch_room_create_then_update: created, then (+2 s) updated; createdAt unchanged; lastActiveAt advanced (ms); center == centre_geojson; exactly six keys; `_id` = room_id; also precision 5 and 6 cells, `zzzzzzz` and `xbpbpbp`.
  - same_cell_two_points_one_doc
  - get_room_missing → not_found
  - concurrent_touch_same_new_cell: 20 parallel → exactly 1 created, 19 updated, 1 document, no errors
  - topology_restart: kill `whereis(geo_mongo_topology)` → re-registered, ready true within 15 s
  - degraded_group: restart with mongo_hosts "127.0.0.1:1" → starts; touch_room → `{error, mongo_unavailable}` within 4 s; ready false
  - password_never_logged:
    - restart with the real hosts, user `ct_ghost`, password `"ct-sentinel-7q7q"`, and a capturing logger handler
    - wait 8 s (ready stays false); kill the topology once; wait 3 s
    - no captured event (`io_lib:format("~p", [E])`) contains the sentinel, and at least one captured event came from the driver

## Acceptance criteria ([LIVE] = orchestrator)
- AC1: compile is clean (our apps); every new export has a -spec.
- AC2: eunit passes.
- AC3: ct passes both suites with Mongo up, and geo_mongo_SUITE is NOT skipped (show the summary); geo_http_SUITE passes with Mongo stopped.
- AC4: dialyzer has zero warnings.
- AC5: fmt --check is clean.
- AC6: rebar.lock pins mongodb b17302e7…, bson f5a8c703…, poolboy 6b5212c4…, pbkdf2 5201a735…; no other new deps.
- AC7: no coordinates in logs or the DB:
  - geo_store has no lat/lng params
  - the doc has exactly six keys
  - `logger:` calls carry only event/key metadata
  - the redaction tests pass
- AC8 [LIVE]: build ok; `/etc/ssl/certs/ca-certificates.crt` exists; 4 healthy; /api/ready 200 exact; /api/health 200.
- AC9 [LIVE]: `docker compose stop mongo` → within 20 s ready 503 and health 200; no geo_service restart; `mongo_unavailable` logged once. `start mongo` → ready 200 within 40 s, no restart.
- AC10 [LIVE]: boot with Mongo down (`stop mongo && up -d --no-deps --force-recreate geo_service`) → running, health 200, ready 503; start mongo → ready 200 with no restart.
- AC11 [LIVE]: `docker compose pause mongo` → ready 503 within 20 s, health < 1 s throughout; unpause → wait for healthy → ready 200.
- AC12 [LIVE]: `run --rm -e MONGO_HOSTS=` → exit ≠ 0, log names mongo_hosts; `-e MONGO_USER=x` → mongo_password.
- AC13 [LIVE]: `run -d --name gs_redact -e MONGO_USER=ghost -e MONGO_PASSWORD=live-sentinel-9z9z`, wait 20 s; the sentinel count in `docker logs` is 0; ready 503 inside; remove the container.
- AC14 [LIVE]: indexes `_id_, center_2dsphere, lastActiveAt_ttl`; re-running init-indexes.js exits 0 (idempotent).
- AC15: docs updated (ARCHITECTURE, README, .env.example with MONGO_URL gone, ADR-016); proposed CLAUDE.md changes listed; CLAUDE.md untouched.

## ADR-016 — MongoDB driver, readiness and Atlas-ready config
Cover:
- the driver + pins + licences; the spike evidence; the quirks and how each is handled
- the topology as a child of geo_service_sup, registered as geo_mongo_topology
- liveness (/api/health) vs readiness (/api/ready); the compose healthcheck on readiness (Docker doesn't restart unhealthy containers, so no crash loop); degraded boot with reconnect; config errors fail fast
- the env-only Atlas switch + its limits (SCRAM-SHA-1 only, no mongodb+srv, host list + replica set, rs mode unverified) + the user checklist
- the redaction filter; the password charset rule (no `"`, `\`, `$`)
- no code-created indexes (init-indexes.js is the source; Atlas needs a one-time manual run)
- a "Live evidence" heading for the orchestrator

## Risks / watch-outs
- **Privacy:** driver logs may include command docs, so geo_store sees only cells. from_point errors are atoms; 3d must not log inputs.
- **Secrets:**
  - the rendered sys.config holds MONGO_PASSWORD (crash dumps are already off)
  - never log the mongo() map
  - install the filter BEFORE the sup
- **Supervision:** a topology crash loop would stop the app (5/10). The spike saw no crash on down / wrong pw / kill.
- **Timeouts:** apply only to geo_service-app processes; CT processes have none (OK); poolboy checkout waits ≤5 s.
- **Log noise:** while Mongo is down the driver logs ~1 line per probe; accepted.
- **Windows:**
  - use MSYS_NO_PATHCONV=1; use 127.0.0.1 not localhost
  - git must be on PATH; autocrlf on dep sources is harmless
  - the first PLT run is slow
  - docker pause leaves Mongo unhealthy ~30 s after unpause
- **Lock:** poolboy is a fork branch; no `rebar3 upgrade` without review.
- **Compose:** depends_on is dev-only; an Atlas prod compose drops the mongo service.

## Out of scope
- endpoints that write rooms (/api/locate is 3d)
- profiles/places/reports, geo_auth, geo_xmpp_admin, MUC_SUBDOMAIN wiring
- an Atlas account/test; driver patches for SCRAM-SHA-256/SRV; the emqx fork
- init-indexes.js changes; web/ and MongooseIM changes
- ROADMAP ticks; CLAUDE.md edits; placeId/slowModeSec

## Proposed CLAUDE.md changes (for the user)
- Commands:
  - add `curl http://127.0.0.1:8080/api/ready`
  - `rebar3 ct` comment → "integration tests (needs mongo up on 127.0.0.1:27018)"
  - add `MSYS_NO_PATHCONV=1 docker compose exec mongo mongosh chaterl /docker-entrypoint-initdb.d/init-indexes.js`
- Stack: "mongodb-erlang driver" → "comtihon/mongodb-erlang (git, pinned SHA; see ADR-016)"

Suggested commit: `feat(geo): Mongo topology, readiness probe, geo_cell and rooms upsert (Phase 3b)`
