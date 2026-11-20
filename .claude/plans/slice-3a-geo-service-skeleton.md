# Plan: Phase 3a — geo_service skeleton, health endpoint, geohash module

Status: APPROVED 2026-11-20 after 2 review rounds with live Docker checks (HEAD 5627de7). ADR to append: **ADR-015**.

**Orchestrator amendment:** CLAUDE.md is user-owned. The coder must NOT edit it, so step 19's CLAUDE.md edits and that part of AC14
are replaced by a "Proposed CLAUDE.md changes" section in the coder report (exact old → new lines), which the orchestrator hands to the user.
The OTP 27+ minimum is recorded in ADR-015.

## Phase 3 slice breakdown
| Slice | Content | Ends with (verifiable) |
|---|---|---|
| **3a** | rebar3 app, supervisor with an embedded Cowboy listener, env-driven `sys.config.src`/`vm.args.src` + validated config, `GET /api/health`, JSON 404/405, pure `geohash` (encode/bounds/centre/neighbours) with EUnit + PropEr cross-checked against the web vectors, erlfmt/dialyzer/eunit/ct, Dockerfile, compose service with healthcheck | `curl http://127.0.0.1:8080/api/health` → `{"status":"ok"}`; compose shows 4 healthy services |
| **3b** | Driver spike (comtihon/mongodb-erlang at a pinned SHA with OP_MSG, vs Mongo 7), `geo_mongo` pool, `geo_store` rooms upsert, pure `geo_cell`, health reports Mongo readiness, CT vs 127.0.0.1:27018. If neither fork works with Mongo 7, stop and escalate | `rebar3 ct` upserts/reads a `rooms` doc |
| **3c** | `geo_auth` (HS256 JWT with OTP crypto), `geo_xmpp_admin` via httpc to the MongooseIM admin GraphQL, `profiles` store, `POST /api/session`; Vite `/api` proxy (same-origin) | curl creates a user who can log in |
| **3d** | `POST /api/locate` (JWT, strict validation, body cap, upsert, `{cell, room_jid}`); coordinates never reach logs (crash-report-safe), with a test | curl with a JWT returns the room; no coordinates in logs |
| **3e** | Client: `web/src/api/geoService.ts`, session + locate, delete `roomJidForCell`, geo/ → api/ ESLint boundary; supersedes part of ADR-013 | Phase-2 demo with server-assigned rooms |
| **3f** | MUC lockdown (`default_room.public = false`, admin-only room creation, geo_service creates rooms), remove `xmpp/roomCreation.ts`, recheck MAM access; keep dev-seed lobby | **Phase 3 demo** |

Doc findings:
- The hex `mongodb_erlang` 3.4.0 has only the legacy opcodes, which Mongo 6+ removed, so it is unusable. Upstream comtihon master v3.6.10 (`b17302e7f4f1`, Apache-2.0) has OP_MSG, as a git dep; fallback is emqx/mongodb-erlang.
- `/api/locate` needs auth, so session comes before locate.
- `geo_rate` stays in Phase 4.

## Goal
Create the `geo_service` Erlang/OTP 28 rebar3 application:
- a supervised, embedded Cowboy listener serving `GET /api/health`
- config from the environment, checked at startup
- a pure, property-tested `geohash` module that matches `web/src/geo/geohash.ts`

It ships as a Docker image and a healthy compose service on `127.0.0.1:8080`.

## Context
- ADR-001 (precisions 7/6/5), ADR-005 (privacy), ADR-007 (secrets/ports), ADR-013 (client encoder; `g7_<geohash>` from 3b).
- CLAUDE.md Erlang/OTP rules; ARCHITECTURE geo_service tree.
- Touched: `docker-compose.yml`, `.gitattributes`, `.env.example` (comment only), `docs/ARCHITECTURE.md`, `README.md`, `docs/DECISIONS.md`.
- Read-only refs: `web/src/geo/geohash.ts`, `web/tests/geo/vectors.ts`, `web/tests/geo/geohash.test.ts`.

## Dependencies (exact pins; the supervisor verified them on hex.pm and compiled them on local OTP 28.4.2)
| Package | Version | License | Scope | Why |
|---|---|---|---|---|
| cowboy | 2.21.0 | ISC | runtime | HTTP server; needs cowlib >= 2.22.0, ranch >= 1.8.0 |
| cowlib | 2.22.0 | ISC | transitive | pinned via rebar.lock |
| ranch | 2.4.0 | ISC | transitive | `ranch:child_spec/5` for the embedded listener |
| proper | 1.5.0 | GPL-3.0 | **test profile only** | property tests; GPL is OK because it is never in the release |
| erlfmt | 1.9.0 | Apache-2.0 | project_plugins | `rebar3 fmt`; fall back to 1.8.0 only if it misbehaves |

Forbidden in 3a: jsx/thoas/jiffy (use OTP `json`), rebar3_proper, poolboy, any Mongo driver, jose, hackney, gun.

## Steps
1. **`geo_service/rebar.config`:**
   - `{minimum_otp_vsn, "27"}`
   - `{erl_opts, [debug_info, warnings_as_errors, warn_missing_spec]}`
   - `{deps, [{cowboy, "2.21.0"}]}`
   - `{project_plugins, [{erlfmt, "1.9.0"}]}`
   - `{erlfmt, [write, {files, ["src/*.erl","src/*.app.src","test/*.erl","test/*.hrl","rebar.config"]}]}`
   - `{dialyzer, [{warnings, [unknown, unmatched_returns, error_handling]}]}`
   - test profile: `{deps,[{proper,"1.5.0"}]}`, `{erl_opts,[nowarn_missing_spec]}`
   - prod profile: `{relx, [{mode, prod}, {include_erts, false}, {include_src, false}]}`
   - top-level `{relx, [{release, {geo_service, "0.1.0"}, [geo_service]}, {sys_config_src, "config/sys.config.src"}, {vm_args_src, "config/vm.args.src"}, {extended_start_script, true}]}`
   - `{shell, [{config, "config/shell.config"}, {apps, [geo_service]}]}`
   - Commit `rebar.lock`.
2. **`src/geo_service.app.src`:** vsn "0.1.0", `{applications,[kernel,stdlib,cowboy]}`, `{mod,{geo_service_app,[]}}`, `{env,[]}` (no default host/port).
3. **`src/geo_config.erl`:** pure parsing plus the single reader over `application:get_env/2`. It is the only module that reads app env.
4. **`src/geo_service_app.erl`:** `start/2` calls `geo_config:http_listen()`.
   - On `{error,{bad_config,Key}}`: `logger:error(#{event=>bad_config,key=>Key})` (the key name only, NEVER the value), then return `{error,{bad_config,Key}}`.
   - Otherwise `geo_service_sup:start_link(Listen)`.
5. **`src/geo_service_sup.erl`:** one_for_one, intensity 5, period 10. Only child: `geo_http:child_spec(Listen)`. Comment that the ARCHITECTURE children arrive later.
6. **`src/geo_http.erl`:** `ranch:child_spec(geo_http, ranch_tcp, TransOpts, cowboy_clear, ProtoOpts)`, so the listener lives under OUR supervisor.
   - `TransOpts = #{socket_opts=>[{ip,Ip},{port,Port}], connection_type=>supervisor}`
   - `ProtoOpts = #{env=>#{dispatch=>dispatch()}, connection_type=>supervisor}` (as cowboy's `ensure_connection_type/1` does). Check the Cowboy 2.21 docs (e.g. dynamic_buffer).
   - Routes `[{'_', [{"/api/health", geo_http_health, []}, {'_', geo_http_not_found, []}]}]`.
7. **`src/geo_http_reply.erl`:** sets content-type application/json, cache-control no-store, x-content-type-options nosniff; encodes with `json:encode/1`.
8. **`src/geo_http_health.erl`:**
   - GET/HEAD → 200 `{"status":"ok"}`
   - other methods → 405 with `allow: GET, HEAD` and `{"error":"method_not_allowed","message":"..."}`
   - never reads the body
9. **`src/geo_http_not_found.erl`:** 404 `{"error":"not_found","message":"..."}`.
10. **`src/geohash.erl`:** pure; no logging, no processes. Same algorithm as the TS: longitude bit first, `>=` midpoint goes to the upper half, start from floats -90.0/90.0/-180.0/180.0.
    - Neighbours are computed geometrically: centre ± (height|width); longitude wraps ±360 past ±180; directions beyond ±90 are omitted; re-encode at the same precision.
    - NO border/neighbour lookup tables.
11. **`config/sys.config.src`:**
    ```erlang
    [{geo_service, [{http_ip, "${GEO_HTTP_IP}"}, {http_port, "${GEO_HTTP_PORT}"}]},
     {kernel, [{logger_level, info},
               {logger, [{handler, default, logger_std_h,
                          #{formatter => {logger_formatter, #{single_line => true}}}}]}]}].
    ```
    The values are quoted strings on purpose: an unset variable becomes "", which geo_config rejects with the key name.
12. **`config/vm.args.src`:** `-sname geo_service` only. No `-setcookie` (relx uses the runtime user's `~/.erlang.cookie`); CLUSTER_COOKIE comes in Phase 6.
13. **`config/shell.config`:** `{http_ip,"127.0.0.1"}, {http_port,"8081"}`, for local `rebar3 shell` (8081 avoids the container's 8080; comment that).
14. **`geo_service/Dockerfile`**, multi-stage:
    - Build stage `FROM erlang:28.4.2 AS build`:
      - `COPY rebar.config rebar.lock ./`, then `RUN rebar3 as prod compile --deps_only`
      - `COPY config ./config`, `COPY src ./src`, then `RUN rebar3 as prod release`
    - Runtime stage `FROM erlang:28.4.2-slim`:
      - install curl (no recommends; remove the apt lists)
      - `useradd --create-home --shell /usr/sbin/nologin geo`
      - `COPY --from=build --chown=geo:geo /src/_build/prod/rel/geo_service /opt/geo_service`
      - `USER geo`, `EXPOSE 8080`, `CMD ["/opt/geo_service/bin/geo_service","foreground"]`
    - Don't bake in GEO_HTTP_PORT.
15. **`geo_service/.dockerignore`:** `_build/`, `*.plt`, `rebar3.crashdump`, `erl_crash.dump`, `test/`, `log/`.
16. **`docker-compose.yml`** service (no depends_on, no secrets):
    ```yaml
      geo_service:
        build:
          context: ./geo_service
        image: chaterl/geo_service:dev
        environment:
          GEO_HTTP_IP: "0.0.0.0"          # inside the container; the host side is 127.0.0.1 below
          GEO_HTTP_PORT: ${GEO_HTTP_PORT:-8080}
        ports:
          # localhost only, like the other services (VITE_API_URL points here)
          - "127.0.0.1:${GEO_HTTP_PORT:-8080}:${GEO_HTTP_PORT:-8080}"
        healthcheck:
          test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:$${GEO_HTTP_PORT}/api/health > /dev/null || exit 1"]
          interval: 10s
          timeout: 3s
          retries: 10
          start_period: 10s
        restart: unless-stopped
    ```
    Host port 8080 on 127.0.0.1 only; GEO_HTTP_PORT is both the container and the host port.
17. **`.gitattributes`:** `*.erl *.hrl *.src *.config rebar.config rebar.lock Dockerfile .dockerignore` → `text eol=lf`. Add this BEFORE creating the files, and write the files with LF.
18. **`.env.example`:** comment-only change on GEO_HTTP_PORT: "port geo_service listens on, published on 127.0.0.1 only; must match VITE_API_URL (change both if 8080 is taken)".
19. **Docs:**
    - ARCHITECTURE: 3a has only geo_http under the supervisor; the listener is embedded via ranch:child_spec; OTP json; the geohash API.
    - README "Running locally": geo_service starts with compose; 4 healthy services; the health curl.
    - **Do NOT edit CLAUDE.md.** In the report, give the exact proposed changes:
      - Stack: "Erlang/OTP 27+ (pinned 28.4.2)"
      - Commands: `docker compose up -d --build geo_service`, `curl http://127.0.0.1:8080/api/health`, `cd geo_service && rebar3 fmt`
      - "all three should be healthy" → four
20. **`docs/DECISIONS.md`: ADR-015 "geo_service foundation":**
    - OTP 27+ (pinned 28.4.2) for stdlib json, superseding CLAUDE.md's "26+" (pending the user's CLAUDE.md edit)
    - pins and licences, PropEr GPL test-only
    - the embedded listener under geo_service_sup
    - sys.config.src quoted env strings + geo_config validation that logs key names only
    - port 8080 on 127.0.0.1
    - the image layout (slim, non-root, no cookie until Phase 6)
    - geometric neighbours
    - the 3b driver finding
    - leave a "Live evidence" heading for the orchestrator

## Interfaces
```erlang
%% geohash
-type geohash() :: binary().                       % lowercase base32 "0123456789bcdefghjkmnpqrstuvwxyz", 1..12 chars
-type precision() :: 1..12.
-type direction() :: n | ne | e | se | s | sw | w | nw.
-type bounds() :: #{south := float(), west := float(), north := float(), east := float()}.
-type encode_error() :: invalid_precision | lat_out_of_range | lng_out_of_range.
-export_type([geohash/0, precision/0, direction/0, bounds/0]).
-spec encode(Lat :: term(), Lng :: term(), Precision :: term()) -> {ok, geohash()} | {error, encode_error()}.
%% check order as in TS: precision (integer 1..12), then lat (number in [-90,90]), then lng (number in [-180,180]);
%% non-numbers count as out of range; integers and floats accepted; never raises
-spec bounds(term()) -> {ok, bounds()} | {error, invalid_geohash}.
-spec centre(term()) -> {ok, {Lat :: float(), Lng :: float()}} | {error, invalid_geohash}.
-spec neighbour(term(), direction()) -> {ok, geohash()} | {error, invalid_geohash | beyond_pole}.
-spec neighbours(term()) -> {ok, #{direction() => geohash()}} | {error, invalid_geohash}.

%% geo_config
-type listen() :: #{ip := inet:ip4_address(), port := inet:port_number()}.
-spec http_listen() -> {ok, listen()} | {error, {bad_config, http_ip | http_port}}.
-spec parse_port(term()) -> {ok, inet:port_number()} | error.   % integer or ASCII-digit string/binary, 0..65535
-spec parse_ip(term()) -> {ok, inet:ip4_address()} | error.      % IPv4 via inet:parse_ipv4strict_address/1

-spec start_link(geo_config:listen()) -> supervisor:startlink_ret().
-spec child_spec(geo_config:listen()) -> supervisor:child_spec().   % ranch ref is the atom geo_http
-spec dispatch() -> cowboy_router:dispatch_rules().
-spec json(cowboy:http_status(), map(), cowboy_req:req()) -> cowboy_req:req().
-spec error_reply(cowboy:http_status(), Code :: binary(), Message :: binary(), cowboy_req:req()) -> cowboy_req:req().
```
HTTP:
- GET /api/health → 200 application/json, body exactly `{"status":"ok"}`
- HEAD → 200, no body
- other methods → 405 + `allow: GET, HEAD` + `{"error":"method_not_allowed","message":...}`
- any other path → 404 `{"error":"not_found","message":...}`

## Tests required
- **`test/geohash_vectors.hrl`:** the 17 VECTORS copied exactly from web/tests/geo/vectors.ts, the 7 BOUNDS rows from web/tests/geo/geohash.test.ts, and the precision-12 value `u4pruydqqvj8` for (57.64911, 10.40744). Header comment: "must match the web vectors".
- **`test/geohash_tests.erl` (EUnit):**
  - Vectors: each encodes to its cell at precision 7, and precision 12 starts with it.
  - Drift guard: resolve `../../web/tests/geo/vectors.ts` from `filename:dirname(?FILE)`; if it exists, regex ``\[(-?[0-9.]+), (-?[0-9.]+), '([0-9a-z]+)'\]`` must equal the .hrl list; otherwise print "skipped" with `?debugMsg`.
  - The four corners (±90, ±180) encode ok.
  - Bounds table compared with `==` (not `=:=` or patterns; on OTP 27+ `0.0 =:= -0.0` is false).
  - Containment plus centre re-encoding for each vector.
  - Errors:
    - lat ±90.0001 → lat_out_of_range; lng ±180.0001 → lng_out_of_range
    - non-numbers (`undefined`, `<<"1">>`, `"1"`) → the matching `*_out_of_range`
    - precision `0`, `13`, `7.5`, `-1`, `seven` → invalid_precision
    - bad precision is reported before bad coordinates
  - `bounds/1` rejects `<<>>`, `<<"U4PRUYD">>`, `<<"u4pruya">>`, `<<"u4prui">>`, `<<"u4pruydqqvj8x">>` and the list `"u4pruyd"`.
  - Neighbour vectors:
    - `u4pruyd` → n u4pruyf, ne u4pruyg, e u4pruye, se u4pruy7, s u4pruy6, sw u4pruy3, w u4pruy9, nw u4pruyc
    - `ezs42` → n ezs48, ne ezs49, e ezs43, se ezs41, s ezs40, sw ezefp, w ezefr, nw ezefx
    - antimeridian: `xbpbpbp` → e 8000000, ne 8000002, se 2pbpbpb; `8000000` → w xbpbpbp, nw xbpbpbr, sw rzzzzzz
    - equator/prime meridian: `s000000` → s kpbpbpb, w ebpbpbp, sw 7zzzzzz
    - north pole: `zzzzzzz` → exactly `#{e=>bpbpbpb, se=>bpbpbp8, s=>zzzzzzx, sw=>zzzzzzw, w=>zzzzzzy}`; `neighbour(zzzzzzz, n)` → `{error, beyond_pole}`
    - south pole: `0000000` → exactly `#{n=>0000002, ne=>0000003, e=>0000001, w=>pbpbpbp, nw=>pbpbpbr}`
    - precision 1: `u` → exactly `#{e=>v, se=>t, s=>s, sw=>e, w=>g}`
- **PropEr** (EUnit wrappers like `{timeout, 60, ?_assert(proper:quickcheck(prop_x(), [{numtests,1000},{to_file,user}]))}`):
  - Generators: lat `oneof([float(-90.0,90.0), integer(-90,90)])`, same for lng; geohashes from `vector(1..12, base32 char)`.
  - Properties:
    1. the bounds of encode contain the point
    2. encode(P) is a prefix of encode(12)
    3. centre round trip
    4. n/s/e/w opposite returns G
    5. shared edges, including e/w across ±180
    6. diagonals compose (ne == e of n, etc.)
    7. neighbours have the same length, differ from G and are distinct
    8. a neighbour is missing only when the cell touches ±90 on that side
  - Naming pitfall: `prop_test/0` clashes with EUnit's `*_test` export; name wrappers e.g. `roundtrip_property_test_/0`.
- **`test/geo_config_tests.erl`:**
  - parse_port accepts `8080`, `"8080"`, `<<"8080">>`, `0`, `65535`; rejects `""`, `" 8080"`, `"8080x"`, `"-1"`, `65536`, `"65536"`, `8080.0`, `undefined`
  - parse_ip accepts `"0.0.0.0"`, `"127.0.0.1"`; rejects `""`, `"::"`, `"localhost"`, `"256.0.0.1"`, `undefined`
  - http_listen returns the right `{bad_config, Key}`, with http_ip reported before http_port
- **`test/geo_http_SUITE.erl` (CT, no external services):**
  - Setup: set_env http_ip "127.0.0.1", http_port "0"; ensure_all_started; port via `ranch:get_port(geo_http)`; httpc.
  - HTTP:
    - GET → 200 with exact body + content-type
    - HEAD → 200 with an empty body
    - POST/DELETE → 405 with allow + code
    - `/nope` and `/api/health/x` → 404
  - Supervision: `{ranch_embedded_sup, geo_http}` is in `which_children(geo_service_sup)`; after `exit(Pid, kill)` it restarts and health answers again.
  - Bad config:
    - Stop the app, set http_port to `"secret-sentinel-8o8o"`; `application:start` → `{error, _}` containing `{bad_config, http_port}`.
    - A test logger handler sees the bad_config event, and no captured event contains the sentinel.

## Acceptance criteria ([LIVE] = orchestrator, against Docker)
- AC1: `rebar3 compile` passes with warnings_as_errors + warn_missing_spec; every export in src has a -spec.
- AC2: `rebar3 eunit` passes; the drift guard actually RUNS locally (not skipped); each property runs 1000 cases.
- AC3: `rebar3 ct` passes geo_http_SUITE, including the restart and bad-config/no-sentinel cases.
- AC4: `rebar3 dialyzer` reports zero warnings.
- AC5: `rebar3 fmt --check` passes; rebar.lock pins cowboy 2.21.0 / cowlib 2.22.0 / ranch 2.4.0; proper is test-profile only; erlfmt is in project_plugins only.
- AC6: `git ls-files --eol` shows lf for the geo_service text files (after `git add --renormalize .` or a check of the working-tree eol, `i/` after staging); the working-tree files are LF.
- AC7 [LIVE]: docker compose build passes; `id -u` is not 0; no host `_build` or `test/` in the image.
- AC8 [LIVE]: all 4 services healthy.
- AC9 [LIVE]: curl health 200 JSON exact; POST → 405 with allow; /nope → 404 JSON.
- AC10 [LIVE]: published on 127.0.0.1:8080 only.
- AC11 [LIVE]: `docker compose run --rm -e GEO_HTTP_PORT=abc geo_service` exits non-zero within ~10 s; the log names http_port, not `abc`; same when unset.
- AC12 [LIVE]: `docker compose stop geo_service` finishes within 10 s with exit code 0.
- AC13 [LIVE]: `MSYS_NO_PATHCONV=1 docker compose exec geo_service /opt/geo_service/bin/geo_service ping` → pong.
- AC14: ARCHITECTURE, README, the .env.example comment and ADR-015 updated; proposed CLAUDE.md changes listed in the report (CLAUDE.md untouched).
- AC15: no coordinates or config values logged; `logger:` calls in src carry only key/event metadata; geohash.erl has no logging.

## Risks / watch-outs
- **Windows line endings:** autocrlf=true. A CRLF vm.args.src gives `geo_service\r`. Add .gitattributes first, write LF, and check with `file`/`od`.
- **Git Bash:**
  - use `MSYS_NO_PATHCONV=1` for container paths
  - rebar3 is at ~/.local/bin; the Erlang path has a space
  - don't run `rebar3 release`/`shell` as ACs on Windows
- The first dialyzer run builds the PLT (~1 min).
- **PropEr:** watch the prop_*_test export clash.
- **Embedded Cowboy:**
  - set connection_type in both maps
  - the restart CT case is the regression guard
  - don't fall back to cowboy:start_clear
- **relx sys.config.src:** rendered at start into a writable release dir (hence --chown); unset variables become "".
- **No cookie:** needs a writable $HOME.
- **Floats:** compare with `==` in tests.
- **Port 8080 taken:** change GEO_HTTP_PORT and VITE_API_URL together.
- **Privacy:** geohash never logs or raises with coordinates; errors are atoms only.
- **Health is liveness only:** no fake db field.

## Out of scope
- Mongo, geo_cell, geo_auth, geo_xmpp_admin, /api/session, /api/locate, CORS/proxy, geo_rate, geo_room*, a JSON log formatter.
- Any web/ change.
- No depends_on, no secrets.
- No MongooseIM changes.
- No ROADMAP ticks (the orchestrator ticks after live verification).
- No deps beyond the table.
- **No CLAUDE.md edits.**

Suggested commit: `feat(geo): geo_service skeleton, /api/health and geohash module (Phase 3a)`.
