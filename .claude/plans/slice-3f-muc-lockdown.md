# Plan: Slice 3f-1 — MUC lockdown (server-created, members-only, unlisted rooms)

Status: PLANNED by supervisor 2026-11-23 (HEAD e2b7c36). New **ADR-020**; amend status notes of ADR-008 (instant-room creation removed), ADR-011 (MAM access in members-only rooms), ADR-013 ("anyone can join any g7 room" + disco leak resolved, residuals listed). CLAUDE.md is user-owned — never edit; proposals at the end.

**User decisions (2026-11-23):** D1-A members-only; D3-A revoke-on-move in slice 3f-2 right after; D4-A keep `g7_` names, opaque names in slice 3g before Phase 3 closes; D5-A delete the 10 existing rooms + affiliations (approved, run by the orchestrator as step 0). D2-A (persistent) and D6-A (accept MongooseIM warnings in dev, `loglevel = "error"` in Phase 6) taken as recommended.

## Goal
Only geo_service creates MUC rooms; every `g7_*` room is members-only, hidden from disco, with hardened occupant options. `POST /api/locate` ensures the cell's room exists, is loaded, and has the caller as `member` before answering 200 — you can only join the room of the cell you located into. The web client stops creating rooms; on an access-refused join (e.g. after a MongooseIM restart) it re-locates once and rejoins, then shows a clear state with a manual retry — never a loop.

## Context
- Roadmap Phase 3 last item. Depends on 3c, 3d, 3e-3.
- ADRs: 005, 007, 008, 010, 011 (shaper workaround + sync MUC archive stay untouched), 013, 017 (admin client: constant documents, variables only, bodies never logged), 018 (guarded locate handler), 019 (bundle baseline 273 163 B → ceiling **277 163 B**).
- Touched: `infra/mongooseim/{mongooseim.toml.tmpl,entrypoint.sh,dev-seed.sh}`, `docker-compose.yml`, `.env.example`; `geo_service/src/{geo_xmpp_admin,geo_http_locate,geo_http,geo_config}.erl`, `config/sys.config.src`, new `src/geo_room_access.erl`; tests `geo_fake_mim.erl`, `geo_xmpp_admin_tests.erl`, `geo_locate_SUITE.erl`, `geo_config_tests.erl`, new `geo_room_access_tests.erl`; web `src/xmpp/{client.ts,types.ts,stanzas.ts}` (delete `roomCreation.ts`), `src/geo/{roomAssigner.ts,RoomAssignment.tsx,index.ts}`, new `src/state/useAccessRecovery.ts`, `src/pages/Chat.tsx`, `src/ui/text.ts` + tests; docs ADR-020, ARCHITECTURE, README.
- No new dependencies (meck already test-only).

## Verified facts (MongooseIM 6.2.1)
Sources: release source in the running container (`/usr/lib/mongooseim/lib/mongooseim-6.2.1/{src,include,priv}`), docs https://esl.github.io/MongooseDocs/6.2.1/modules/mod_muc/, read-only live checks.

- **Config keys** (`mod_muc.erl` `config_spec/0`, `default_room_config_spec/0`): `access_create` exists (default `all`); `default_room.{public, public_list, persistent, members_only, anonymous, allow_private_messages, allow_query_users, allow_change_subj, allow_user_invites, maygetmemberlist, max_users, title, description}` exist. Defaults (`include/mod_muc_room.hrl`): public true, public_list true, persistent false, members_only false, anonymous true, allow_private_messages true, allow_query_users true, allow_change_subj true, allow_user_invites false, maygetmemberlist `[]`, max_users 200.
- ACL syntax `[acl] name = [{user = "x"}]`, `match` defaults to `current_domain` (`mongoose_config_spec.erl` `acl_item/0`); a rule with no matching clause denies (`acl.erl`).
- `load_permanent_rooms_at_startup` is **ignored** in 6.2.1 (source logs "deprecated. The option is ignored."). `hibernated_room_check_interval`/`hibernated_room_timeout` default `infinity` → loaded rooms stay loaded until restart.
- **Restart trap** (`mod_muc.erl` `route_to_room` → `get_registered_room_or_route_error_from_presence`): a join presence to an unloaded room checks `access_create` **before** restoring from DB → denied users get `<not-allowed/>` and MongooseIM logs `check_user_can_create_room_failed` at warning with `from_jid` + `room_id`. After any restart, members cannot rejoin until something allowed loads the room. IQs restore without that check. Live: after restart `getRoomConfig lobby` → `room_not_found`, `listRooms` → `count: 10, rooms: []`.
- **Service disco#items** (`iq_disco_items/4`, `room_to_item/4`): loaded rooms hidden unless `public` or asker is occupant/admin; **persistent unloaded rooms are listed to everyone by name** (no check) → residual leak after restart (D4).
- **Room disco** (`mod_muc_room.erl`): `disco#info` answered to anyone, incl. `muc#roominfo_occupants` and the title (falls back to room name). Room `disco#items` forbidden to non-occupants only when `public_list = false`.
- **Members-only**: non-member join → `<registration-required/>`. MAM (`can_read_conference/2`): members-only rooms → only owner/admin/member read; open rooms → **anyone not outcast reads the archive without joining**. Setting the same affiliation again is a no-op ok.
- **Admin GraphQL** (`priv/graphql/schemas/admin/muc.gql`, `global/muc.gql`; resolver `mongoose_graphql_muc_admin_mutation.erl`; `extensions.code` = reason atom):
  - `createInstantRoom(room: BareJID!, owner: JID!, nick: ResourceName!): MUCRoomDesc` — join presence **from the owner** (`access_create` checked against the owner), unlock IQ, sync `can_access_room`. Restores a DB room with stored options/affiliations; if loaded, owner just joins. Errors `user_not_found`, `room_not_found` (e.g. owner denied), `internal` ("Room is locked").
  - `setUserAffiliation(room, user: JID!, affiliation: MUCAffiliation!): String` — acts as the room's first owner (badmatch if no owner); loaded rooms only (`room_not_found` otherwise); also `not_allowed`, `cannot_modify`.
  - `changeRoomConfiguration(room, config: MUCRoomConfigInput!): MUCRoomConfig` — loaded only; omitted fields keep value.
  - `exitRoom(room, user: FullJID!, nick)` — fire-and-forget unavailable presence. `deleteRoom` loaded only. `getRoomConfig`, `listRoomAffiliations` read-only.
- **Owner ghost**: `createInstantRoom` makes the owner an occupant without a session; the subject groupchat bounces `service-unavailable` → room expels it. For temporary rooms `exitRoom` destroys the room (why D2-B is fragile).
- **Existing data** (read-only psql): `muc_rooms` 10 rows (lobby, test1, test3, 7 `g7_*`), all stored `"public":true,"members_only":false` — stored options override `default_room`. `muc_room_aff` 10 owner rows (creators, incl. one pseudonymous `u…`) = persisted user↔cell history.

## Decisions (supervisor)
- **Room creator**: dedicated account `XMPP_ROOM_OWNER` (default `nearby-rooms`) is the only `access_create` allow. geo_service creates/restores rooms via `createInstantRoom` with owner full JID `<owner>@<domain>/geo_service`, nick `Nearby`. Localpart ≤ 32 chars, can't collide with `u`+32hex. Registered lazily on first `user_not_found`, password from `geo_session:new_password/0`, discarded, never logged.
- **Latency**: fast path 1 call (`setUserAffiliation`); slow path (unloaded room) create → configure → exit → set (4 calls, +2 once to register the owner). Hard deadline 8 s (client timeout 10 s). 200 body unchanged.
- **Failure mapping**: MongooseIM unreachable / 5xx / deadline → 503 `service_unavailable` + `retry-after: 5`; admin 401, unexpected answer, uncreatable room → 500 `internal_error` + one `room_access_failed` warning (atoms only). Order: Mongo `touch_room` first (Mongo down → 503, no admin call), then access, then reply.
- **Config enforced on load**: every slow path applies the constant `changeRoomConfiguration`.
- **Hardening**: `public_list=false`, `allow_query_users=false`, `allow_private_messages=false`, `allow_change_subj=false`, `allow_user_invites=false` (explicit), `maygetmemberlist=[]` (explicit), `anonymous=true` (explicit). `max_users` 200; `title`/`description` empty — never put a place or cell there.
- **Lobby + alice/bob kept**: `dev-seed.sh` creates `lobby` via the owner account, applies the config, makes alice/bob members. Re-run after a MongooseIM restart (documented). `tools/xmpp-smoke` unchanged (201 branch now dead, out of scope).
- **Client recovery**: join failure `registration-required` or `not-allowed` for the assigned room → re-locate once (`refresh`) and rejoin; a second access failure before a successful join → "Nearby couldn't let you into this area's chat." + "Try again". No loop.

## Decisions for the user (recommended first)
- **D1 Join control** — A: members-only, `member` granted per successful locate. B: open but unlisted (anyone can join any cell and read its 24 h MAM without joining; names guessable).
- **D2 Persistence** — A: persistent rooms (as today). B: temporary rooms (needs probe + re-plan; revisit with Phase 4).
- **D3 Membership cleanup** — A: none in 3f-1; slice 3f-2 right after adds revoke-on-move (supervised ETS owner of user → last room; set old room NONE after new grant). B: fold into 3f-1. C: Phase 4 idle deletion only.
- **D4 Room names** — A: keep `g7_<geohash>` now; slice 3g "opaque room names" (HMAC-derived) before Phase 3 closes. B: deterministic forever. C: opaque names in 3f. Residuals with deterministic names: disco lists stored names after restart; room disco#info gives live occupant count; existence oracle.
- **D5 Existing data** — A: delete all 10 MUC rooms + affiliations (lobby re-seeded; MAM rows stay). B: keep.
- **D6 MongooseIM warning logs (JID + room on denied creation)** — A: accept in dev, `loglevel = "error"` in Phase 6 prod. B: `error` now.

## Steps
0. **Old-data cleanup (only after D5-A approval; orchestrator).** `docker compose stop mongooseim`; one transaction in postgres (credentials from the container env, never printed):
   `DELETE FROM muc_room_aff WHERE room_id IN (SELECT id FROM muc_rooms WHERE muc_host='muc.chaterl.localhost'); DELETE FROM muc_rooms WHERE muc_host='muc.chaterl.localhost';` then `docker compose up -d mongooseim`. Record counts (10/10 → 0/0) in ADR-020.
1. **`mongooseim.toml.tmpl`** `[modules.mod_muc]`: keep host, access, `access_create = "muc_create"`, backend, `default_room.persistent = true`, ADR-011 `user_message_shaper` verbatim; replace `public = true` with the default_room block (Interfaces). Comment: stored options override defaults and geo_service re-applies on load (ADR-020); `load_permanent_rooms_at_startup` ignored in 6.2.1; `hibernated_room_*` must stay `infinity`. `[acl]` add `muc_room_owner = [{user = "{{XMPP_ROOM_OWNER}}"}]`. `[access]` `muc_create = [{acl = "muc_room_owner", value = "allow"}]` only (delete the `local` clause).
2. **`entrypoint.sh`**: add `XMPP_ROOM_OWNER` to `VARS`. **`docker-compose.yml`**: `XMPP_ROOM_OWNER: ${XMPP_ROOM_OWNER:-nearby-rooms}` for mongooseim and geo_service. **`.env.example`**: document (localpart, `^[a-z][a-z0-9-]{2,31}$`, same in both services).
3. **`sys.config.src`**: `{xmpp_room_owner, "${XMPP_ROOM_OWNER}"}`.
4. **`geo_config.erl`**: `session/0` validates the key last, adds `room_owner := binary()` to `session_cfg()`; new exported `parse_room_owner/1` (string/binary matching the regex, else `error`); failure `{error, {bad_config, xmpp_room_owner}}`; add to `session_key()`.
5. **`geo_xmpp_admin.erl`**: add `set_member/4`, `create_room/5`, `configure_room/3`, `exit_room/5`, each with pure `*_request` + `parse_*`; `register_user/5` (`/4` delegates with 5000). `send/1` → `send/2` with `{timeout, T}, {connect_timeout, min(2000, T)}`, no redirects. Documents/variables exactly as Interfaces; bodies never logged; `log_failure/2` covers new ops (status only). Update header comment.
6. **`geo_room_access.erl`** (new, no processes): `grant/3`: (1) `set_member` → ok done / `room_not_found` → 2. (2) `create_room` (owner full JID, nick `Nearby`); on `owner_missing`: `register_user(domain, owner, geo_session:new_password())` (`ok`/`exists` success) then `create_room` once more. (3) `configure_room`. (4) `exit_room` best effort, result ignored. (5) `set_member`. Each call `Timeout = min(5000, Deadline - now)`; < 250 ms left → `{error, unavailable}` without calling. Mapping: `unavailable` → `{error, unavailable}`; everything else (`unauthorized`, `bad_response`, second `room_not_found`, `owner_missing` after register) → `{error, failed}` + exactly one `logger:warning(#{event => room_access_failed, step => Step, reason => Reason})` (atoms only). All `geo_xmpp_admin` calls fully qualified (meck).
7. **`geo_http_locate.erl`**: `cfg()` adds `admin`, `xmpp_domain`, `room_owner`. `authenticate/2` keeps `Sub`; sub not `u`+32 lowercase hex → 401 `invalid_token` (same body/header). Thread `Sub` into `guarded/4`; after `{ok, created | updated}` from `touch_room`: `RoomJid = geo_cell:room_jid(Cell, MucDomain)`, `UserJid = <<Sub/binary,"@",Domain/binary>>`, `Deadline = erlang:monotonic_time(millisecond) + 8000`, call `geo_room_access:grant/3` fully qualified **inside the existing try**. `ok` → 200; `{error, unavailable}` → `unavailable(Req)`; `{error, failed}` → `internal_error(Req)`; else case_clause → catch. Update module comment.
8. **`geo_http.erl`**: `LocateCfg` adds `admin`, `xmpp_domain`, `room_owner`; replace least-privilege comment (locate needs admin for membership, ADR-020; still no profile access).
9. **`dev-seed.sh`**: register alice/bob as before; register `${XMPP_ROOM_OWNER:-nearby-rooms}` with random password (`head -c 24 /dev/urandom | base64 | tr -d '/+='`), never echoed, "already registered" tolerated; `createInstantRoom --room lobby@$MUC --owner "$OWNER@$XMPP_DOMAIN/geo_service" --nick Nearby`; `changeRoomConfiguration --room lobby@$MUC --config '<config JSON>'`; `exitRoom`; `setUserAffiliation` alice MEMBER, bob MEMBER. Final message: re-run after restarting MongooseIM.
10. **`web/src/xmpp/`**: delete `roomCreation.ts` + import. `client.ts` on status 201: send `buildLeavePresence`, `failJoin(room, 'other', 'room-created')`; never send a muc#owner IQ; remove `configuring` flag/branches. Add `'not-allowed'` to `KNOWN_FAILURES`. `types.ts`: `JoinFailure` + `'not-allowed'`, − `'room-config-failed'`. Remove `NS_MUC_OWNER`/`NS_DATA` from `stanzas.ts` if unused.
11. **`geo/roomAssigner.ts`**: add `refresh(): Promise<RefreshOutcome>`; `RoomAssignment.tsx` `useRoomAssignment` returns `refresh`; `geo/index.ts` exports `RefreshOutcome`.
12. **`state/useAccessRecovery.ts`** (new): spec below; must not import `geo/` (structural refresh type).
13. **`Chat.tsx`**: `useAccessRecovery({ client, desired: desiredRoomJid, nick: nickname, refresh })`. While `recovering`: `AREA_TEXT.joining(label)`, no button. Current room failed with access reason and `exhausted`: `AREA_TEXT.accessDenied` + "Try again" (`AREA_TEXT.accessRetry`) → `recover()`, same slot/focus handling as "Join again". Other failures keep "Join again".
14. **`ui/text.ts`**: `JOIN_FAILURES` − `'room-config-failed'`, + `'not-allowed': "You can't open this room."`; `AREA_TEXT.accessDenied = "Nearby couldn't let you into this area's chat."`, `AREA_TEXT.accessRetry = 'Try again'`.
15. **Docs**: ADR-020 (context, D1–D6 as decided, verified facts + sources, residuals, probe + live evidence); status lines on ADR-008/011/013 "see ADR-020"; ARCHITECTURE ("Locate & join" step 3, "Status (Phase 3f)", module rows `geo_room_access`/`geo_xmpp_admin`, `/api/locate` 503 also on MongooseIM unavailable, Security bullets); README (dev-seed re-run, `XMPP_ROOM_OWNER`). ROADMAP tick left to the orchestrator.

## Interfaces
Template additions in `[modules.mod_muc]`:
```toml
  default_room.public = false
  default_room.public_list = false
  default_room.members_only = true
  default_room.anonymous = true
  default_room.allow_private_messages = false
  default_room.allow_query_users = false
  default_room.allow_change_subj = false
  default_room.allow_user_invites = false
  default_room.maygetmemberlist = []
```
GraphQL documents (constants; values only as variables):
```
mutation SetMember($room: BareJID!, $user: JID!) { muc { setUserAffiliation(room: $room, user: $user, affiliation: MEMBER) } }
mutation CreateRoom($room: BareJID!, $owner: JID!, $nick: ResourceName!) { muc { createInstantRoom(room: $room, owner: $owner, nick: $nick) { jid } } }
mutation ConfigureRoom($room: BareJID!, $config: MUCRoomConfigInput!) { muc { changeRoomConfiguration(room: $room, config: $config) { public publicList persistent membersOnly anonymous allowPrivateMessages allowQueryUsers allowChangeSubject allowUserInvites mayGetMemberList } } }
mutation ExitRoom($room: BareJID!, $user: FullJID!, $nick: ResourceName!) { muc { exitRoom(room: $room, user: $user, nick: $nick) } }
```
`config` variable (also the dev-seed JSON), exactly:
`{"public":false,"publicList":false,"persistent":true,"membersOnly":true,"anonymous":true,"allowPrivateMessages":false,"allowQueryUsers":false,"allowChangeSubject":false,"allowUserInvites":false,"mayGetMemberList":[]}`

Parsers: set_member — 200 with `data.muc.setUserAffiliation` binary → `ok`; code `room_not_found` → `room_not_found`; other 200 → `bad_response`. create_room — 200 with `createInstantRoom.jid` == room → `ok`; `user_not_found` → `owner_missing`; other codes → `bad_response`. configure_room — 200 and every returned field == requested → `ok`; mismatch → `bad_response`; `room_not_found` → `room_not_found`. exit_room — 200 with binary → `ok`. All: 401 → `unauthorized`; 5xx/no answer → `unavailable`; else `bad_response`.

```erlang
-type room_error() :: room_not_found | unavailable | unauthorized | bad_response.
-type create_error() :: owner_missing | unavailable | unauthorized | bad_response.
-spec set_member(admin(), RoomJid :: binary(), UserJid :: binary(), Timeout :: pos_integer()) -> ok | {error, room_error()}.
-spec create_room(admin(), RoomJid :: binary(), OwnerFullJid :: binary(), Nick :: binary(), pos_integer()) -> ok | {error, create_error()}.
-spec configure_room(admin(), RoomJid :: binary(), pos_integer()) -> ok | {error, room_error()}.
-spec exit_room(admin(), RoomJid :: binary(), FullJid :: binary(), Nick :: binary(), pos_integer()) -> ok | {error, room_error()}.
-spec register_user(admin(), binary(), binary(), binary(), pos_integer()) -> ok | {error, reg_error()}.
%% geo_room_access
-type ctx() :: #{admin := geo_xmpp_admin:admin(), xmpp_domain := binary(), room_owner := binary(),
                 deadline := integer()}.   %% erlang:monotonic_time(millisecond)
-spec grant(ctx(), RoomJid :: binary(), UserJid :: binary()) -> ok | {error, unavailable | failed}.
%% geo_config
-spec parse_room_owner(term()) -> {ok, binary()} | error.
```
```ts
// geo/roomAssigner.ts
export type RefreshOutcome = 'assigned' | 'failed' | 'superseded';
// RoomAssigner gains: refresh: () => Promise<RefreshOutcome>;
```
`refresh()`: no target or disposed → `'superseded'` at once. Else cancel pending retry timer and in-flight request, `begin(target, state.room)` (room kept while running; `assigned` yields a new state object even with the same jid). Resolves `'assigned'`/`'failed'` when this request ends, `'superseded'` if `assign()`, `dispose()`, or another `refresh()`/`retry()` replaced it. Automatic unavailable retry unchanged.
```ts
// state/useAccessRecovery.ts
export const ACCESS_FAILURES: ReadonlySet<JoinFailure>; // 'registration-required', 'not-allowed'
export type RecoveryPhase = 'idle' | 'recovering' | 'exhausted';
export function useAccessRecovery(o: {
  client: XmppClient; desired: string | null; nick: string;
  refresh: () => Promise<'assigned' | 'failed' | 'superseded'>;
}): { phase: RecoveryPhase; recover: () => void };
```
Rules: per desired jid keep `attempts` (0/1). When room store `roomJid === desired`, `status === 'failed'`, reason ∈ `ACCESS_FAILURES`, `attempts === 0` → attempts 1, phase `recovering`, await `refresh()`: `'assigned'` + still mounted + desired unchanged + store still failed for it → `client.joinRoom(desired, nick)`, phase `idle`; `'failed'`/`'superseded'` → attempts 0, `idle`. Same condition with `attempts === 1` → `exhausted` (no request). `recover()` does refresh-and-join regardless of attempts; ignored while `recovering`. Reset (0, `idle`) when desired room becomes `joined` or `desired` changes to a **different non-null** jid; desired → null does not reset. Non-access failures ignored; nothing after unmount.

## Tests required
- `geo_xmpp_admin_tests.erl`: each new request uses exactly its constant document (byte equality) and exactly the listed variables; config map == constant. Each parser per mapping: 200 success, each named code, unknown code, non-JSON, 401, 503, 400. configure with one flipped field → `bad_response`; create echoing a different jid → `bad_response`.
- `geo_room_access_tests.erl` (meck `geo_xmpp_admin`): fast path exactly 1 call; `room_not_found` → exactly set → create → configure → exit → set with owner `nearby-rooms@d/geo_service`, nick `Nearby`; `owner_missing` → register (password `xp1_`+32, never passed to logger) → create again; register `exists` ok; create `unavailable` → `{error, unavailable}`, no more calls; configure `bad_response` → `{error, failed}`, **no** grant; exit error ignored; second `room_not_found` → failed; first-call `unauthorized` → failed; past deadline → `{error, unavailable}`, 0 calls; timeouts shrink with the deadline; exactly one atom-only `room_access_failed` per failure, none on success/unavailable.
- `geo_fake_mim.erl`: rooms in ETS — `set_aff` `room_not_found` unless loaded; `create` `user_not_found` unless owner registered, else mark loaded and echo jid; `configure` echoes input; `exit` answers a string. Modes `room_unloaded` (default), `owner_missing`, `configure_mismatch`, `slow_room` (7 s per room op). `calls/0` records `set_member | create | configure | exit`.
- `geo_locate_SUITE.erl`: new cell → 200 and fake records set_member, create, configure, exit, set_member; user var = token `sub@domain`, room = 200's `room_jid`. Same cell again → one set_member, identical response bytes. Admin 503 → 503 + `retry-after: 5`; admin 401 → 500; `configure_mismatch` → 500, no second set_member; `slow_room` → 503 within 9 s; Mongo down → 503, 0 admin calls; non-`u`+32hex sub (test secret) → 401 `invalid_token`, 0 admin calls; no log event contains room JID, sub or coordinate; crash-sanitising cases pass with access mocked to crash.
- `geo_config_tests.erl`: `parse_room_owner/1` accepts `nearby-rooms`; rejects `""`, `Nearby`, `n`, 33 chars, `u`+32hex, `a b`, non-string; `session/0` names `xmpp_room_owner` on failure, never the value.
- Web `tests/xmpp/client.test.ts`: `not-allowed` → `room-join-failed` reason `not-allowed`; `registration-required` → that reason, no retry; status 201 → one leave presence, reason `other` condition `room-created`, no muc#owner IQ. Remove instant-room tests; `wireShape`/`stanzas` follow.
- `tests/geo/roomAssigner.test.ts`: refresh while assigned → one locate, `assigning` with room kept, then `assigned` (new object, same jid), `'assigned'`; no target → `'superseded'`, no request; `assign(other)` during refresh → `'superseded'`; 503 → `'failed'` and auto retry fires; refresh in failed = retry; dispose during refresh → `'superseded'`.
- `tests/state/useAccessRecovery.test.tsx`: access failure → exactly 1 refresh then 1 `joinRoom(desired, nick)`; second failure → `exhausted`, refresh count 1 after +60 s; `recover()` → refresh + join; successful join resets; desired → other jid resets, → null → same jid doesn't; `conflict`/`service-unavailable` ignored; unmount during refresh → no join; refresh `'failed'` → `idle`, attempts 0.
- `chatFlow.test.tsx`: joined → access failure → "Joining…" → joined; second failure → `accessDenied` + labelled keyboard-reachable "Try again" → refresh. Status line stays `role=status`; focus moves to it when the button disappears while focused.
- `tests/ui/text.test.ts`: `JOIN_FAILURES` keys match the union; new texts present.

## Acceptance criteria ([LIVE] = orchestrator, rebuilt geo_service image + recreated mongooseim)
- AC1 eunit, ct, dialyzer (0), fmt --check, typecheck, lint, test pass; JS ≤ 277 163 B (+ gzip).
- AC2 `-spec` on every new export; no admin body, password, room JID+sub, or coordinate logged (CT scan).
- AC3 `/api/locate` 200 only after membership; 503 on MongooseIM unavailable / 8 s deadline; 500 on access failure; response bytes unchanged.
- AC4 no muc#owner IQ and no `roomCreation` in `web/src`; 201 = failed join; `'not-allowed'` known.
- AC5 one-shot automatic recovery + manual retry (tests).
- AC6 [LIVE] probe gate after step 1, before Erlang wiring, on `probe3f@muc…` via CLI: `createInstantRoom` owner full JID ok; `getRoomConfig` membersOnly true, public false, publicList false, persistent true; `listRoomUsers` after `exitRoom` → no `Nearby`; `setUserAffiliation` alice MEMBER twice ok; `listRoomAffiliations` → owner + alice member. Cleanup `deleteRoom` + muc_rooms row. Record in ADR-020. **Any deviation → stop, report to supervisor.**
- AC7 [LIVE] rendered config (grep only `default_room`, `access_create`, `muc_create`, `muc_room_owner` lines) shows new values.
- AC8 [LIVE] two pseudonymous identities at spot A: one locate 200 each, join `g7_u4pruyd`, messages both ways, MAM history loads; `listRoomAffiliations` = owner + exactly those two members; `getRoomConfig` == constant.
- AC9 [LIVE] scratchpad Node script as alice over ws://localhost:5280/ws-xmpp (password read from .env, never printed): (a) service disco#items while `g7_u4pruyd` loaded → no `g7_`; (b) join → `<registration-required/>`; (c) MAM query → error, no messages (record condition); (d) join `probe-<random>` → `<not-allowed/>`, no new muc_rooms row; (e) room disco#items → `forbidden`; (f) record room disco#info (expected: answered with occupant count, D4 residual).
- AC10 [LIVE] `docker compose restart mongooseim` with both identities in the room: each reconnects, rejoin `not-allowed`, exactly one extra locate, joined again; no error text; no repeated locate over 2 min; geo_service RestartCount 0.
- AC11 [LIVE] AC9(a) right after a restart before rejoin; record whether stored `g7_` names are listed (expected: yes, D4 residual; non-blocking).
- AC12 [LIVE] `stop mongooseim` → locate 503 + `retry-after: 5` within 9 s, client "can't reach your area chat" with auto retry; after start + rejoin, joined.
- AC13 [LIVE] geo_service logs: 0 coordinate / cell-centre / token hits, 0 sub+room lines. MongooseIM: count `check_user_can_create_room_failed` without printing JIDs.
- AC14 [LIVE] after `dev-seed.sh`, alice/bob chat in lobby via `tools/xmpp-smoke`; lobby config == constant.
- AC15 [LIVE] cleanup: test identities removed (removeUser + profiles), test rooms deleted (load if needed, `deleteRoom`), probe rows deleted; `listUsers` = alice, bob, `nearby-rooms` + the owner's own accounts.

## Risks / watch-outs
- D4 residuals (disco after restart, occupant counts via disco#info, existence oracle) — don't claim "cells are hidden" until 3g.
- Memberships accumulate in PostgreSQL until 3f-2; MAM keeps sender JID per room 24 h (Phase 4 purge).
- Template defaults reach only new rooms; stored options win; only the slow path re-applies. Future config changes need reconfigure-on-load or migration (ADR-020).
- `setUserAffiliation` crashes server-side on an ownerless room → `bad_response` → 500 (impossible after D5).
- MongooseIM logs JID + room on denied creation (D6).
- Concurrent first locates of one cell may double-create; owner join/expel visible briefly. Accepted.
- Not fixed: MUC nickname registration (`jabber:iq:register` to `muc.…`) blocks a nick in every room → client falls back to `Name-2`. Follow-up (Phase 5).
- `hibernated_room_*` must stay `infinity`.

## Out of scope
Revoke-on-move (3f-2), opaque names (3g), temporary rooms, geo_rate/jump check, geo_room idle deletion, MAM purge, xmpp-smoke 201 branch, MUC nick-registration abuse, loglevel change (unless D6-B), XEP-0198 ghost nicks.

## Proposed CLAUDE.md changes (user-owned; list only)
- Commands: re-run `bash infra/mongooseim/dev-seed.sh` after restarting MongooseIM.
- New env var `XMPP_ROOM_OWNER` (default `nearby-rooms`), shared by mongooseim and geo_service.
- Privacy: "MUC rooms are created only by geo_service through the room-owner account; never re-enable client room creation (`access_create`), `public`/`public_list`, private messages or `allow_query_users` without an ADR." and "Never put a place name or cell in a room title or description."
- MongooseIM: "Stored MUC room options override `default_room`; a MUC config change needs a per-room reconfigure (geo_service applies it on load)."
