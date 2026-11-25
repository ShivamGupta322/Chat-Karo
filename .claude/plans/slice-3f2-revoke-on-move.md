# Plan: Slice 3f-2 — revoke the old room's membership on move

Status: PLANNED by supervisor 2026-11-24 (HEAD 08fc3a4). New **ADR-021**; ADR-020 status/residual line → "see ADR-021". CLAUDE.md user-owned (proposals at the end).

**User decisions (2026-11-24):** U1-A (ETS now; slice 3f-3 startup reconciliation right after), U2-A (keep the last membership until the next move; Phase 4 expiry), U3-A (older tab shows "removed" + "Join again", no automatic re-locate).

## Goal
After a successful `POST /api/locate` into room R the caller is `member` of R and of no other `g7_` room. The old membership is set to NONE after the new grant and before the 200, best effort (a failed revoke never fails the locate; it is retried on the user's next locate). Same-user locates are serialized by a per-user lock in a supervised ETS owner. The web client treats the MUC 321 removal as part of moving, never as a failure, and never loops.

## Context
- Phase 3, slice 3f-2; depends on 3f-1 (ADR-020). ADRs 016 (supervision), 017 (admin client: constant documents, bodies never logged), 018 (guarded handler; reply is the try's last expression), 019 (keep-room window; `failed.room` null; bundle), 020 (grant, deadline, failure mapping, D3-A).
- Touched: `geo_service/src/{geo_xmpp_admin,geo_room_access,geo_http_locate,geo_service_sup}.erl`, `geo_service.app.src`, new `src/geo_membership.erl`; tests `geo_fake_mim.erl`, `geo_locate_SUITE.erl`, `geo_room_access_tests.erl`, `geo_xmpp_admin_tests.erl`, new `geo_membership_tests.erl`; web `src/xmpp/{client.ts,types.ts}`, `src/pages/Chat.tsx`, `src/ui/text.ts` + tests; docs.
- No new dependencies. Bundle baseline 274 536 B → ceiling **278 536 B**.

## Verified facts (MongooseIM 6.2.1; release source in the container, read-only psql)
1. No per-user room-affiliation query: `priv/graphql/schemas/admin/muc.gql` queries are listRooms, getRoomConfig, listRoomUsers, listRoomAffiliations(room, affiliation), getRoomMessages. `listUserRooms` only in `admin/muc_light.gql` (unused module). `listRoomAffiliations` loaded rooms only (`mod_muc_api.erl:305-314` → `room_users_aff/1` :555).
2. `NONE` exists (`global/muc.gql` MUCAffiliation). `setUserAffiliation` → `mod_muc_api:set_affiliation/3` (:316-338), acts as first owner; loaded rooms only (`mod_muc:room_jid_to_pid/1`, `mod_muc.erl:920-929`, no restore) → `room_not_found` when unloaded.
3. member → none in a members-only room (`mod_muc_room.erl:2832-2841`): `safe_send_kickban_presence(JID, Reason, <<"321">>, none, SD)`, affiliation removed, role none. none → none is a no-op ok (`can_change_aff/3` :3033).
4. Kick presence (:3114-3170): from `room/<nick>`, `type="unavailable"`, `<x xmlns=muc#user><item affiliation="none" role="none"/><status code="321"/></x>`, **no status 110**; sent to every occupant incl. the removed one; a bare JID matches all that user's sessions (`foreach_matched_user/3` :2181-2196) → SM ghosts removed too.
5. `set_affiliation(_, none, _)` removes the entry (:1406-1414); `save_persistent_room_state/1` (:966) → `mod_muc_rdbms:store_room/4` (:126-135) rewrites room + all affiliations in one transaction → NONE deletes the `muc_room_aff` row.
6. A membership in an unloaded room is inert but persisted: MAM `can_access_room` → `{error, not_found}` → false; joins hit the restart trap (`not-allowed`); it revives when geo_service loads the room.
7. `removeUser` keeps MUC affiliations (mod_muc hooks have `remove_domain`, no `remove_user`; `mod_muc_rdbms` deletes per domain only).
8. `process_admin_items_set/4` logs `muc_admin_query` at **info** with from_jid + target JID; our `loglevel = "warning"` suppresses it — never lower it.
9. `deleteRoom` runs `forget_room` → deletes the room's MAM (`mod_mam_muc.erl:242-248`); `createInstantRoom` on a missing room creates it (Phase 4 relevance).
10. Data now: `muc_rooms` 1 row (lobby); `muc_room_aff` 3 rows (alice member, bob member, nearby-rooms owner). No `g7_` memberships to migrate.
11. Mongo: only *pending* profiles TTL out (`expiresAt`); active profiles never expire. `rooms` docs TTL 7 days after `lastActiveAt`; MUC rooms persist.

## Decisions (supervisor)
1. **user → room in ETS** in a new supervised `geo_membership` gen_server: `protected, named_table, set, read_concurrency`, rows `{UserJid, Current, Pending}`; it also holds the per-user lock state (waiters are `From` tags). Rejected: MongooseIM (no per-user query), Postgres direct (new dep + internal creds/schema coupling), Mongo profile field (U1-C). Restart: table empty → at most one stale membership per user who moves after a restart (closed by 3f-3 reconciliation if U1-A).
2. **Ordering under the existing 8 s deadline**: acquire lock (waiting counts against the deadline; no lock → `{error, unavailable}` → 503 + retry-after 5) → grant (unchanged) → settle (old current + pending, minus R) → revoke each → requeue failures → release → reply.
   - Revoke before the reply ("200 ⇒ old membership revoked or queued"); the 321 can arrive in the keep-room window (client step 10).
   - Revoke failure/timeout never changes the response; requeued, cap 16 pending per user, oldest dropped with one `membership_pending_dropped` warning.
   - Same-room locate: no revoke of R; pending retried.
   - Grant failure: no settle, no revoke.
   - Unloaded old room: `set_none` → `room_not_found` → load it (create, configure, exit, as the grant slow path) then `set_none`; second `room_not_found` → failed; short deadline (`MIN_CALL_MS` 250) → back to pending.
   - Lock held across grant+settle+revoke (prevents A→B→A kicking the user from the current room). FIFO per user, max 4 waiters (beyond → `{error, busy}` at once), monitor the holder (crash releases), `cancel` cast when a waiter's call times out. Different users never block each other.
   - `handle_call` does only map/ETS work; all I/O in the request process.
   - Owner calls wrapped: `acquire` exit/noproc/timeout → `{error, busy}`; `settle`/`requeue` failure → "tracking lost": still 200, revokes skipped, one `membership_tracking_failed` warning (atoms only). Never log the exit reason (it embeds JID + room).
   - Owner implements `format_status/1`: counts only.
3. **One membership per account** is correct (identity = device credential; tabs share a location). Only "same identity, two tabs, different dev-picker cells" conflicts (U3).
4. **Lobby never touched**: tracker records only `/api/locate` rooms; `revoke/3` refuses any room whose localpart fails `geo_cell:parse_room_id/1` or whose domain ≠ MUC domain (no admin call, one `room_revoke_failed step=guard reason=not_a_cell_room`); non-`u`+32hex users excluded at the handler.
5. **Existing memberships**: none in dev → no migration. ADR-021 documents the manual procedure: stop mongooseim; `DELETE FROM muc_room_aff WHERE aff = 2 AND room_id IN (SELECT id FROM muc_rooms WHERE muc_host = 'muc.<domain>' AND room_name LIKE 'g7\_%')`; start mongooseim.
6. **Long-term cleanup is Phase 4**: membership expiry (N h after last locate, supervised worker), idle room deletion (also purges MAM), account deletion must revoke before `removeUser`.

## Decisions for the user (recommended first)
- **U1 Restart residual** — A: ETS now + slice 3f-3 "membership reconciliation on start" right after (Mongo `rooms` × `listRoomAffiliations` → pending revokes, loaded rooms only). B: fold reconciliation into 3f-2 (~+40%). C: store current room on the Mongo profile (durable user↔cell link in app DB). D: read Postgres directly.
- **U2 Last membership after sign-out / location off / Start over** — A: keep until next move; Phase 4 expiry + idle deletion. B: `POST /api/leave` now.
- **U3 Same identity, two tabs, different cells (dev)** — A: last locate wins; other tab shows "removed" + "Join again", no automatic re-locate. (B auto re-locate rejected: ping-pong.)

## Steps
1. **`geo_xmpp_admin.erl`**: constant `SET_NONE_QUERY`, `set_none/4`, `set_none_request/3`, `parse_set_none/2` (same rules as `parse_set_member/2`; delegating is fine); `log_failure/2` covers `set_none` (status only); header comment.
2. **`geo_membership.erl`** (new): gen_server, ETS owner, per-user lock manager (Interfaces). Export pure `settle_entry/2`, `requeue_entry/3`. `format_status/1`. Public functions wrap `gen_server:call/3` in `try … catch exit:_`.
3. **`geo_service_sup.erl`**: child between `geo_mongo_sup` and `geo_http`: `#{id => geo_membership, start => {geo_membership, start_link, []}, restart => permanent, shutdown => 5000, type => worker}`; comment; add `geo_membership` to `registered` in `geo_service.app.src`.
4. **`geo_room_access.erl`**: extract `load_room/2` (create with lazy owner register, configure, exit) from `slow_path/3` — grant behaviour/call sequence byte-identical. Add `revoke/3` and `assign/3` (Decision 2); `release` in an `after` inside `assign/3`. `ctx()` gains `muc_domain`. `geo_xmpp_admin`, `geo_membership`, `geo_session` calls fully qualified. Revoke failures (not `unavailable`) → `logger:warning(#{event => room_revoke_failed, step => Step, reason => Reason})` atoms only; `unavailable` requeued silently.
5. **`geo_http_locate.erl`**: call `geo_room_access:assign/3` instead of `grant/3`; `access_ctx/1` adds `muc_domain`; mapping unchanged; module comment.
6. **`geo_fake_mim.erl`**: `setUserAffiliation` with `affiliation: NONE` → op `set_none` (loaded: delete `{aff, Room, User}`, answer string; unloaded: `room_not_found`). `reset/0` unloads rooms but **keeps affiliations** (simulates a MongooseIM restart). `affs/1` (User → sorted rooms). Modes `none_503`, `slow_member` (set_member after 1 s), `{slow_for, UserJid}` (every MUC op for that user after 7 s). Header.
7. **`web/src/xmpp/types.ts`**: `LeaveReason` gains `'removed'`.
8. **`web/src/xmpp/client.ts`**: `handleJoinedPresence` self unavailable: 307 → `kicked`, 301 → `banned`, **321 → `removed`**, else `other`. `handleJoiningPresence` self unavailable with 321 → `untrack` + `room-left` reason `removed` (not `failJoin('other','unavailable')`). Self detection stays `110 || nick === room.nick` (kick has no 110). Comment: 321 comes from geo_service revoking on move (ADR-021).
9. **`web/src/ui/text.ts`**: `AREA_TEXT.moving = "Moving you to your new area's chat…"`; `AREA_TEXT.removed = "You're no longer in this area's chat. Nearby may be open in another tab."`.
10. **`web/src/pages/Chat.tsx`**: `removed = current && room.status === 'left' && room.leftReason === 'removed'`. `removed && assignment.status === 'assigning'` → `AREA_TEXT.moving`, **no button**. Else `removed` → `AREA_TEXT.removed` + existing "Join again" (`retry`); its refused join goes through the existing single `useAccessRecovery` refresh+join. Nothing else triggers a locate. Keep focus handling and `role=status`.
11. **Docs**: ADR-021 (context, decisions 1–6, U1–U3 as decided, verified facts + sources, residuals, manual SQL, empty `### Live evidence (3f-2)` for the orchestrator); ADR-020 status/residual line; ARCHITECTURE (supervision tree, module table, "Locate & join" step 3, "Status (Phase 3f-2)"). ROADMAP left to the orchestrator.

## Interfaces
```
mutation SetNone($room: BareJID!, $user: JID!) { muc { setUserAffiliation(room: $room, user: $user, affiliation: NONE) } }
```
Variables exactly `{"room": RoomJid, "user": UserJid}`.
```erlang
%% geo_xmpp_admin
-spec set_none(admin(), RoomJid :: binary(), UserJid :: binary(), Timeout :: pos_integer()) -> ok | {error, room_error()}.
-spec set_none_request(admin(), binary(), binary()) -> request().
-spec parse_set_none(non_neg_integer(), binary()) -> ok | {error, room_error()}.
%% geo_membership
-type entry() :: #{current := binary(), pending := [binary()]}.   %% pending: no dups, never current, length =< 16
-spec start_link() -> gen_server:start_ret().
-spec acquire(UserJid :: binary(), Deadline :: integer()) -> ok | {error, busy}.
%%   call timeout = Deadline - now - 250; =< 0 -> {error, busy} without a call; on timeout sends cancel.
-spec release(UserJid :: binary()) -> ok.                 %% cast {release, User, self()}; ignored unless self() holds it
-spec settle(UserJid :: binary(), Room :: binary()) -> {ok, Revoke :: [binary()]} | {error, unavailable}.
-spec requeue(UserJid :: binary(), Rooms :: [binary()]) -> ok | {error, unavailable}.
-spec current(UserJid :: binary()) -> {ok, binary()} | none.   %% ets:lookup in the caller (protected table)
-spec settle_entry(entry() | none, Room :: binary()) -> {entry(), Revoke :: [binary()]}.
%%   none -> {#{current => Room, pending => []}, []}
%%   #{current := Room, pending := P} -> {#{current => Room, pending => []}, P}
%%   #{current := Old, pending := P} -> {#{current => Room, pending => []}, dedupe([Old | P]) -- [Room]}
-spec requeue_entry(entry(), [binary()], Cap :: pos_integer()) -> {entry(), Dropped :: non_neg_integer()}.
%%   adds rooms =/= current, not already pending; keeps the newest Cap.
%% Lock state: #{locks := #{User => {Pid, MRef, queue:queue({From, Pid})}}, monitors := #{MRef => User}}; max 4 waiters/user.
%% geo_room_access
-type ctx() :: #{admin := geo_xmpp_admin:admin(), xmpp_domain := binary(), muc_domain := binary(),
                 room_owner := binary(), deadline := integer()}.
-spec assign(ctx(), RoomJid :: binary(), UserJid :: binary()) -> ok | {error, unavailable | failed}.
-spec grant(ctx(), binary(), binary()) -> ok | {error, unavailable | failed}.     %% unchanged
-spec revoke(ctx(), RoomJid :: binary(), UserJid :: binary()) -> ok | {error, unavailable | failed}.
```
```ts
export type LeaveReason = 'self' | 'kicked' | 'banned' | 'removed' | 'disconnected' | 'other';
```
`/api/locate` HTTP contract unchanged (same 200 bytes, same 401/400/500/503).

## Tests required
- `geo_xmpp_admin_tests.erl`: `set_none_request` exact constant document + exactly two variables; `parse_set_none` 200 string → ok, `room_not_found`, other code → `bad_response`, non-JSON, 401, 503, 400.
- `geo_membership_tests.erl`: pure — none → no revoke; same room → pending returned, current kept; move → `[Old | Pending]` minus R, deduped; pending containing R → R not returned; requeue skips current + dups; cap keeps newest 16 and reports dropped. Process — different users independent; same user FIFO; holder `exit(kill)` → waiter gets ok; waiter past deadline → `{error, busy}`, its cancel removes it, next waiter still gets the lock; 5th waiter → busy at once; release from non-holder ignored; settle/requeue/current round trip; owner not running → acquire busy, settle `{error, unavailable}`, no crash; `format_status` contains no user/room binary.
- `geo_room_access_tests.erl` (meck `geo_xmpp_admin`, `geo_membership`): fast move exactly acquire, set_member(R), settle, set_none(Old), release; same room → no set_none; set_none `room_not_found` → create, configure, exit, set_none (owner `nearby-rooms@d/geo_service`, nick `Nearby`); set_none `unavailable` → requeue([Old]), ok, no log; `bad_response` → requeued, ok, exactly one atom-only `room_revoke_failed`; deadline exhausted after grant → 0 set_none, all requeued, ok; grant failed/unavailable → no settle/revoke, passed through; acquire busy → `{error, unavailable}`, 0 admin calls; settle `{error, unavailable}` → ok + one `membership_tracking_failed`, 0 set_none; release on every path incl. set_member raising (exception propagates); non-cell/foreign-domain room in revoke → 0 admin calls + guard log; existing grant tests green.
- `geo_locate_SUITE.erl`: `move_revokes_old` (A then B → `affs == [B]`, last call set_none on A with room = A's JID, user = sub@domain; 200 bytes = 3f-1 shape); `same_cell_no_revoke`; `back_and_forth` (A, B, A → `[A]`); `revoke_failure_still_200` (`none_503` on move to B → 200, `[A, B]`; then normal + move to C → set_none A and B, `[C]`); `revoke_unloaded_room` (A, `reset()`, B → A loaded via create/configure/exit then set_none; `[B]`); `concurrent_same_user` (`slow_member`, A and B 50 ms apart → both 200 within 4 s; exactly one membership = last-finished request); `lock_timeout_503` (`{slow_for, U}`: second locate for U → 503 + retry-after 5 within 9 s, 0 set_member with the second room; another user V → 200 < 2 s); `owner_restart_forgets` (A, kill geo_membership, wait re-registered, B → 200, 0 set_none, `[A, B]`; sup child restart count 1). Log scan over all new cases: no room JID, sub, coordinate, admin body; no `room_revoke_failed`/`membership_*` except where asserted.
- Web `tests/xmpp/client.test.ts`: joined + self unavailable 321 without 110 → `room-left` `removed`, untracked, no leave stanza; another occupant's 321 → `occupant-left` only; 307 → kicked, 301 → banned; 321 while joining → `room-left` `removed`, no `room-join-failed`.
- `tests/state/useAccessRecovery.test.tsx`: `room-left` `removed` on desired room → 0 refresh, idle.
- `tests/integration/chatFlow.test.tsx`: joined A; move (assigning, A kept); 321 for A → `moving`, no "Join again", no join/leave stanza for A; locate resolves B → exactly one join of B → joined; total locates 1. Joined A settled; 321 → `removed` text + labelled keyboard-reachable "Join again"; +60 s → 0 locates/joins; click → join A → `registration-required` → exactly 1 refresh → join → joined; focus moves to status line when the button disappears.
- `tests/ui/text.test.ts`: new strings.

## Acceptance criteria ([LIVE] = orchestrator, rebuilt geo_service image)
- AC1 eunit, ct, dialyzer (0), fmt --check, typecheck, lint, test; JS ≤ 278 536 B (+ gzip).
- AC2 `-spec` on new exports; `geo_membership` supervised with `format_status/1`; no gen_server exit reason, admin body, JID, room or coordinate logged (CT scan).
- AC3 200 only after the grant; on a move the old room NONE before the reply or requeued; revoke failure never changes status; bytes unchanged.
- AC4 concurrent and back-and-forth end with exactly one membership; lock timeout → 503; other users unaffected.
- AC5 lobby: no admin call for a non-cell room (unit); [LIVE] `listRoomAffiliations lobby` unchanged after all tests.
- AC6 [LIVE] new identity at A then B: A → owner only; B → owner + user MEMBER; psql count of that user's `muc_room_aff` rows = 1 (count only); B → A → B → still 1.
- AC7 [LIVE] scratchpad Node script, fresh identity: locate A, join, send; locate B → receive the 321 unavailable for its A nick (record shape, JIDs masked); MAM to A → error (record), 0 messages; join A → `registration-required`.
- AC8 [LIVE] two tabs at A; tab 1 moves to B: no "You left the room"/"Join again" at any sampled frame, joined B, exactly 1 locate, 0 join stanzas to A after the 321; tab 2 sees tab 1 leave; no new locates over 2 min.
- AC9 [LIVE] same identity, two tabs, different cells: older tab shows `removed` + "Join again"; 0 automatic locates over 2 min; click → joined, the other tab then shows `removed`.
- AC10 [LIVE] `docker compose restart geo_service` with a user at A, then move to B → 200; A still lists the user (U1 residual, record); move to C → B revoked, A still listed (until 3f-3); 0 `locate_crashed`.
- AC11 [LIVE] MongooseIM restart with a user at A; after the client's single recovery re-locate, stop that tab; restart MongooseIM again (A unloaded); locate B via script with the same token → 200, A loaded and revoked (owner only), `listRoomUsers A` → `[]`.
- AC12 [LIVE] geo_service logs 0 hits for cell-centre digits, `g7_`, `eyJ`, `xp1_`, test localparts, `room_revoke_failed`, `membership_`; MongooseIM counts of `muc_admin_query` (0) and `muc_send_kickban_presence_failed` (0), lines not printed.
- AC13 [LIVE] cleanup: test identities removed (removeUser + profiles), test rooms loaded + deleted, Mongo room docs deleted; `muc_room_aff` = 3 lobby rows; `listUsers` = alice, bob, nearby-rooms + the owner's two accounts; browser storage cleared.

## Risks / watch-outs
- U1 residual: don't claim "one membership per user" unconditionally until 3f-3.
- Phase 4 caveats (ROADMAP): idle `deleteRoom` must drop the room from every tracker entry (else load-to-revoke recreates it); account deletion must revoke before `removeUser`; membership expiry needs tracker timestamps; `geo_rate` should align with this table.
- MongooseIM `loglevel` must stay ≥ warning; the owner's crash reports are the main new leak vector (`format_status/1`); `gen_server:call` exit reasons embed the request.
- Each revoke rewrites the room row + affiliations (changes `muc_rooms.id`; MAM keys by JID).
- Slow-path revoke adds up to 4 calls (only after a MongooseIM restart), within 8 s; lock waits give 503 not hangs.
- ETS grows one row per user since start (~200 B); bounded by Phase 4 expiry.
- "Join again" after `removed` may flash "You can't open this room." (known carry-forward).
- Concurrency test: assert "exactly one membership = last-finished request", not a specific room.

## Out of scope
Startup reconciliation (3f-3), `POST /api/leave` (unless U2-B), membership expiry / idle deletion / MAM purge (Phase 4), opaque names (3g), account deletion, `useAccessRecovery` semantics, XEP-0198 ghosts, MongooseIM config changes.

## Proposed CLAUDE.md changes (user-owned; list only)
- Privacy: "A user is a member of at most one cell room. Every path that grants MUC membership goes through `geo_room_access:assign/3` (grant + revoke of the previous room under the per-user lock)."
- Privacy: "MongooseIM `loglevel` must stay `warning` or stricter: at info it logs user JID + room on affiliation changes."
- MongooseIM: "`removeUser` does not remove MUC affiliations in 6.2.1. Revoke memberships before deleting an account."
- Erlang: "Processes whose state or messages hold user↔room or user↔cell data implement `format_status/1`."
