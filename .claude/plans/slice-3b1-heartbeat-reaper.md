# Plan: Phase 3b.1 — reap leaked Mongo heartbeat connections on a hung server

Status: APPROVED 2026-11-21 after 2 review rounds with live pause tests (HEAD 7dada48). The design comes from the supervisor's slice-3b round-2 review, which read the driver source; the orchestrator turned it into this plan.
ADR: extend **ADR-016** (quirk 10 becomes "fixed in 3b.1" + live evidence). No new ADR unless the design changes.
CLAUDE.md is user-owned: do NOT edit it.

## Problem (ADR-016 quirk 10)
In `_build/default/lib/mongodb/src/mongoc/mc_monitor.erl`, `check/2` does:
```erlang
{ok, Conn} = mc_worker_api:connect(ConnectArgs),
{true, IsMaster} = is_master_check(mc_utils:use_legacy_protocol(Conn), Conn),
Finish = os:timestamp(),
mc_worker_api:disconnect(Conn),
```
`disconnect` runs only on success. On a hung mongod, TCP still connects (the kernel completes the handshake) but `hello` times out after 5 s (mc_worker_call_timeout) and exits:
- `loop/1` / `maybe_recheck/6` swallow it with `catch _:_`
- the worker is start_link'ed to the monitor; the monitor traps exits, and its handle_info only reacts to the `server` pid
- so the worker hibernates with its socket open, and mongod never closes idle client connections

The leak rate is about one connection per 10–11 s of hang (5 s protocol detection in mc_worker:init, plus 5 s hello). Live: 5 → 6 → 8 → 10 connections over three 20 s `docker compose pause mongo` cycles. In the node: 1 mc_monitor, 1 poolboy, 10 mc_worker, of which 5 are hibernating and linked only to the mc_monitor.

## Goal
geo_service periodically stops heartbeat `mc_worker` processes that the driver's `mc_monitor` abandoned:
- without forking or patching the driver
- without ever killing a heartbeat check in progress
- proven by a CT case that blackholes Mongo traffic and by the orchestrator's live pause test

## Design
1. **New pure module `src/geo_mongo_reaper.erl`:**
   - `select(Candidates :: [pid()], Seen :: #{pid() => integer()}, NowMs :: integer(), MinAgeMs :: pos_integer()) -> {ToReap :: [pid()], NewSeen :: #{pid() => integer()}}`
   - a candidate first seen at least MinAgeMs ago (`NowMs - SeenAt >= MinAgeMs`) goes to ToReap and is removed from NewSeen
   - a new candidate is added to NewSeen with NowMs
   - pids no longer among the candidates are dropped from Seen
   - `candidates() -> [pid()]`:
     - scan `erlang:processes()` for processes whose initial call is `{mc_monitor, init, 1}`; use `proc_lib:translate_initial_call/1`, and check it works for these gen_server processes, otherwise read `'$initial_call'` from the process dictionary
     - take their `links` and keep pids whose initial call is `{mc_worker, init, 1}`
     - guard every `process_info` against `undefined` (dead process); never crash
   - `-spec` on every export. No logging in this module.
   - Performance: scanning all processes every 5 s is fine for this small node; add a comment saying so.
2. **`src/geo_mongo_probe.erl`:**
   - the state becomes a map holding the status and `seen => #{}`
   - on every probe tick, after the ping, call `select(candidates(), Seen, erlang:monotonic_time(millisecond), ?REAP_MIN_AGE_MS)` with `?REAP_MIN_AGE_MS = 30000`
   - stop each pid in ToReap with `mc_worker_api:disconnect/1`; wrap each in try/catch, because the process may already be gone
   - when N > 0, log `#{event => mongo_heartbeat_reaped, count => N}` at notice level, nothing else (no pids, no reasons)
   - Comment the safety argument: a live heartbeat worker lives at most 2 × connectTimeoutMS + 2 × call timeout ≈ 20 s (own connect + protocol-detection connect; detection recv + hello), so 30 s never kills a check in progress. "Monitor is idle" is NOT used as the test: it races with a new check, and killing that worker makes mc_server tear down the pool (update_unknown).
   - Check in the driver source that disconnecting such a worker doesn't make the monitor or mc_server react (the monitor ignores a normal EXIT from a non-server pid).
3. **Optional (decide and justify in the report):** `{use_legacy_protocol, false}` in WorkerOpts. That removes the extra protocol-detection socket per worker and the fallback to legacy when a worker starts during a stall. Only adopt it if mc_worker / mc_worker_pid_info clearly support it at the pinned SHA and the CT suite stays green; the reaper is still required either way.
4. **Docs:**
   - ADR-016 quirk 10: change "KNOWN ISSUE, fix in slice 3b.1" to "fixed in slice 3b.1" and describe the reaper (min age 30 s, scan on the 5 s probe tick, disconnect via the public API, the notice event)
   - update the Consequences sentence
   - leave a "**3b.1 live evidence:**" placeholder line at the end of ADR-016's evidence for the orchestrator
   - ARCHITECTURE: the geo_mongo_probe description gains "reaps abandoned heartbeat connections"; add geo_mongo_reaper to the module table
   - ROADMAP: do NOT tick (the orchestrator ticks after live verification)

## Tests required
- **`test/geo_mongo_reaper_tests.erl` (eunit), for select/4:**
  - a new pid is not reaped and is recorded
  - a pid seen MinAge − 1 ms ago is not reaped; exactly MinAge is reaped; one seen MinAge + 1 ago is reaped and removed from Seen
  - a pid that disappeared from the candidates is dropped from Seen
  - multiple pids with mixed ages
  - Use `list_to_pid` or spawned dummy pids.
- **`test/geo_mongo_reaper_tests.erl`, for candidates/0:**
  - spawn a fake process registered with a `'$initial_call'` of `{mc_monitor, init, 1}` (via proc_lib), linked to a fake `{mc_worker, init, 1}` process and to an unrelated process
  - candidates() returns only the fake worker
  - clean up the fakes
  - If faking initial calls via proc_lib is awkward, use `proc_lib:spawn_link` with an MFA whose module/function match; explain the approach in the test.
- **`test/geo_mongo_SUITE.erl`, new case `proxy_blackhole_no_heartbeat_leak`:**
  - Extend the existing gen_tcp proxy helper with a **blackhole** mode: it keeps accepting new connections and keeps both sockets of every relay open, but stops forwarding in both directions (buffer or drop).
  - Restart the app pointed at the proxy; wait for ready.
  - Blackhole for 35 s (more than 3 hung checks); restore forwarding; wait for ready.
  - Sleep 40 s (more than one reap window); then assert:
    - `length(geo_mongo_reaper:candidates()) =< 1`
    - live upstream sockets in the proxy `=< PoolSize + 1`
    - exactly 1 child under mc_pool_sup
  - Restore the normal app config in an `after` block.
  - **Write this test first and confirm it FAILS without the reaper** (e.g. run it with the reaper call commented out, or before adding it) and report the failing numbers. Then make it pass.
- The existing suites stay green (eunit 348+, ct 18+ → 19+).

## Acceptance criteria ([LIVE] = orchestrator)
- AC1: rebar3 compile clean (warnings_as_errors, warn_missing_spec); every new export has a -spec.
- AC2: rebar3 eunit passes twice in a row (report the totals).
- AC3: rebar3 ct passes with Mongo up; geo_mongo_SUITE is not skipped; proxy_blackhole_no_heartbeat_leak passes; its pre-fix failure is reported.
- AC4: rebar3 dialyzer exit 0; AC5: rebar3 fmt --check clean; no CRLF in changed files.
- AC6: no new deps; the driver is untouched (no _checkouts, no module overrides).
- AC7: the only new log event is `mongo_heartbeat_reaped` with count only; no pids, reasons, hosts or secrets.
- AC8 [LIVE]: rebuild; three 20 s `docker compose pause mongo` cycles, each followed by unpause and a 60 s wait → connections from the geo_service IP back to exactly 5 (allow ≤ 6 while a reap window is pending, but 5 by the end); `mongo_heartbeat_reaped` appears in the logs; RestartCount 0; ready 200 after each.
- AC9 [LIVE]: two stop/start outages still give 5 connections and a bounded log (no regression of quirk 9).
- AC10: docs updated as described; CLAUDE.md untouched.

## Risks
- **Killing a live check:** a heartbeat worker during a real check is linked to the monitor too. The 30 s min age is the guard; never lower it below ~2× the worst-case check duration.
- **Identification by initial call** depends on driver internals at the pinned SHA. The candidates/0 test plus the live check catch drift; comment that a driver upgrade must re-verify it.
- **The proxy blackhole on Windows:** ensure sockets really stay open, the listener keeps accepting, and nothing is forwarded; report if it's flaky after a genuine attempt.
- **The monitor may open a new heartbeat connection right as we reap:** this is harmless, since only workers ≥30 s old are touched.

## Out of scope
- forking or patching the driver; changing heartbeat frequencies
- any change to the pool supervision from 3b
- 3c work; web/ and MongooseIM changes; ROADMAP ticks; CLAUDE.md edits

Suggested commit: `fix(geo): reap Mongo heartbeat connections leaked on a hung server (Phase 3b.1)`
