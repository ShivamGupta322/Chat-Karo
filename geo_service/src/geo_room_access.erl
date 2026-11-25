%% Gives a user access to a cell's MUC room before /api/locate answers (ADR-020) and takes the
%% previous cell room's membership away (ADR-021). No processes of its own: a sequence of admin
%% API calls under one hard deadline, run by the request process.
%%
%% Rooms are members-only and only the room-owner account may create them, so a user can join
%% only after geo_service made them a `member`. Fast path: the room is loaded, one call
%% (set_member). Slow path (the room is not loaded, e.g. after a MongooseIM restart or for a new
%% cell): create/restore the room as the owner, re-apply the constant room config (stored options
%% override the template defaults), let the owner's ghost occupant leave, then set_member.
%%
%% assign/3 = grant + revoke of the previous room, under the user's lock (geo_membership):
%% acquire, grant, settle (what to revoke), revoke each, requeue failures, release. A revoke
%% failure never changes the answer; the room is retried on the user's next locate. Revoking
%% sets the affiliation to NONE, which makes the room kick the user (status 321). A room that is
%% not loaded is loaded first (the same create/configure/exit sequence as the grant slow path).
%%
%% Nothing here logs a JID, a body or a password: a failure logs one event with atoms only.
%% All geo_xmpp_admin and geo_session calls are fully qualified (the tests mock them).
-module(geo_room_access).

-export([assign/3, grant/3, revoke/3]).
-export_type([ctx/0]).

-define(MAX_CALL_MS, 5000).
-define(MIN_CALL_MS, 250).
-define(OWNER_RESOURCE, <<"geo_service">>).
-define(OWNER_NICK, <<"Nearby">>).

-type ctx() :: #{
    admin := geo_xmpp_admin:admin(),
    xmpp_domain := binary(),
    muc_domain := binary(),
    room_owner := binary(),
    %% erlang:monotonic_time(millisecond)
    deadline := integer()
}.
-type step() :: set_member | create_room | register_owner | configure_room | set_member_again.
-type revoke_step() :: guard | set_none | set_none_again | crash | step().
-type event() :: room_access_failed | room_revoke_failed.

%% Grant, then revoke the previous room(s); serialised per user. No lock within the deadline is
%% `unavailable` (503), like any other timeout.
-spec assign(ctx(), RoomJid :: binary(), UserJid :: binary()) -> ok | {error, unavailable | failed}.
assign(#{deadline := Deadline} = Ctx, RoomJid, UserJid) ->
    case geo_membership:acquire(UserJid, Deadline) of
        ok ->
            try
                assign_locked(Ctx, RoomJid, UserJid)
            after
                geo_membership:release(UserJid)
            end;
        {error, busy} ->
            {error, unavailable}
    end.

-spec assign_locked(ctx(), binary(), binary()) -> ok | {error, unavailable | failed}.
assign_locked(Ctx, RoomJid, UserJid) ->
    case grant(Ctx, RoomJid, UserJid) of
        ok ->
            %% The grant succeeded: nothing in the revoke phase may turn it into an error.
            try
                case geo_membership:settle(UserJid, RoomJid) of
                    {ok, Old} ->
                        revoke_all(Ctx, Old, UserJid);
                    {error, unavailable} ->
                        logger:warning(#{event => membership_tracking_failed})
                end
            catch
                Class:_Reason ->
                    %% Class only: the reason can embed request data.
                    logger:warning(#{event => room_revoke_failed, step => crash, reason => Class})
            end,
            ok;
        {error, _} = Error ->
            Error
    end.

%% Best effort; whatever could not be revoked goes back on the user's pending list. A guard
%% failure is permanent and dropped. An exception requeues the rooms not yet revoked.
-spec revoke_all(ctx(), [binary()], binary()) -> ok.
revoke_all(_Ctx, [], _UserJid) ->
    ok;
revoke_all(Ctx, Rooms, UserJid) ->
    requeue(UserJid, revoke_each(Ctx, Rooms, UserJid, [])).

-spec revoke_each(ctx(), [binary()], binary(), [binary()]) -> [binary()].
revoke_each(_Ctx, [], _UserJid, Failed) ->
    lists:reverse(Failed);
revoke_each(#{muc_domain := MucDomain} = Ctx, [Room | Rest] = Rooms, UserJid, Failed) ->
    try revoke(Ctx, Room, UserJid) of
        ok ->
            revoke_each(Ctx, Rest, UserJid, Failed);
        {error, _} ->
            case is_cell_room(Room, MucDomain) of
                true -> revoke_each(Ctx, Rest, UserJid, [Room | Failed]);
                false -> revoke_each(Ctx, Rest, UserJid, Failed)
            end
    catch
        Class:_Reason ->
            logger:warning(#{event => room_revoke_failed, step => crash, reason => Class}),
            lists:reverse(Failed) ++ Rooms
    end.

-spec requeue(binary(), [binary()]) -> ok.
requeue(_UserJid, []) ->
    ok;
requeue(UserJid, Rooms) ->
    case geo_membership:requeue(UserJid, Rooms) of
        ok -> ok;
        {error, unavailable} -> logger:warning(#{event => membership_tracking_failed})
    end.

-spec grant(ctx(), RoomJid :: binary(), UserJid :: binary()) -> ok | {error, unavailable | failed}.
grant(Ctx, RoomJid, UserJid) ->
    case
        step(Ctx, set_member, fun(A, T) -> geo_xmpp_admin:set_member(A, RoomJid, UserJid, T) end)
    of
        ok -> ok;
        {error, room_not_found} -> slow_path(Ctx, RoomJid, UserJid);
        {error, Reason} -> failure(set_member, Reason)
    end.

-spec slow_path(ctx(), binary(), binary()) -> ok | {error, unavailable | failed}.
slow_path(Ctx, RoomJid, UserJid) ->
    maybe
        ok ?= load_room(Ctx, RoomJid, room_access_failed),
        ok ?=
            wrap(
                set_member_again,
                step(Ctx, set_member_again, fun(A, T) ->
                    geo_xmpp_admin:set_member(A, RoomJid, UserJid, T)
                end),
                room_access_failed
            )
    end.

%% Make the room exist and be loaded with the right config (the owner's ghost occupant leaves).
-spec load_room(ctx(), binary(), event()) -> ok | {error, unavailable | failed}.
load_room(Ctx, RoomJid, Event) ->
    maybe
        ok ?= create_room(Ctx, RoomJid, Event),
        ok ?= configure_room(Ctx, RoomJid, Event),
        _ = exit_owner(Ctx, RoomJid),
        ok
    end.

%% Revoke the user's membership of RoomJid. Only cell rooms of the MUC domain are ever touched.
-spec revoke(ctx(), RoomJid :: binary(), UserJid :: binary()) -> ok | {error, unavailable | failed}.
revoke(#{muc_domain := MucDomain} = Ctx, RoomJid, UserJid) ->
    case is_cell_room(RoomJid, MucDomain) of
        false -> revoke_failure(guard, not_a_cell_room);
        true -> revoke_loaded(Ctx, RoomJid, UserJid)
    end.

-spec revoke_loaded(ctx(), binary(), binary()) -> ok | {error, unavailable | failed}.
revoke_loaded(Ctx, RoomJid, UserJid) ->
    case set_none(Ctx, set_none, RoomJid, UserJid) of
        ok ->
            ok;
        {error, room_not_found} ->
            maybe
                ok ?= load_room(Ctx, RoomJid, room_revoke_failed),
                set_none_again(Ctx, RoomJid, UserJid)
            end;
        {error, Reason} ->
            revoke_failure(set_none, Reason)
    end.

-spec set_none_again(ctx(), binary(), binary()) -> ok | {error, unavailable | failed}.
set_none_again(Ctx, RoomJid, UserJid) ->
    case set_none(Ctx, set_none_again, RoomJid, UserJid) of
        ok -> ok;
        {error, Reason} -> revoke_failure(set_none_again, Reason)
    end.

-spec set_none(ctx(), set_none | set_none_again, binary(), binary()) ->
    ok | {error, term()}.
set_none(Ctx, Step, RoomJid, UserJid) ->
    step(Ctx, Step, fun(A, T) -> geo_xmpp_admin:set_none(A, RoomJid, UserJid, T) end).

-spec is_cell_room(binary(), binary()) -> boolean().
is_cell_room(RoomJid, MucDomain) ->
    case binary:split(RoomJid, <<"@">>) of
        [Local, MucDomain] ->
            case geo_cell:parse_room_id(Local) of
                {ok, _Cell} -> true;
                {error, _} -> false
            end;
        _ ->
            false
    end.

%% The owner account is registered lazily, the first time MongooseIM says it does not exist.
-spec create_room(ctx(), binary(), event()) -> ok | {error, unavailable | failed}.
create_room(#{xmpp_domain := Domain, room_owner := Owner} = Ctx, RoomJid, Event) ->
    OwnerJid = <<Owner/binary, "@", Domain/binary, "/", ?OWNER_RESOURCE/binary>>,
    Create = fun() ->
        step(Ctx, create_room, fun(A, T) ->
            geo_xmpp_admin:create_room(A, RoomJid, OwnerJid, ?OWNER_NICK, T)
        end)
    end,
    case Create() of
        ok ->
            ok;
        {error, owner_missing} ->
            case register_owner(Ctx, Event) of
                ok -> wrap(create_room, Create(), Event);
                {error, _} = Error -> Error
            end;
        Other ->
            wrap(create_room, Other, Event)
    end.

-spec register_owner(ctx(), event()) -> ok | {error, unavailable | failed}.
register_owner(#{xmpp_domain := Domain, room_owner := Owner} = Ctx, Event) ->
    Result = step(Ctx, register_owner, fun(A, T) ->
        geo_xmpp_admin:register_user(A, Domain, Owner, geo_session:new_password(), T)
    end),
    case Result of
        ok -> ok;
        {error, exists} -> ok;
        Other -> wrap(register_owner, Other, Event)
    end.

-spec configure_room(ctx(), binary(), event()) -> ok | {error, unavailable | failed}.
configure_room(Ctx, RoomJid, Event) ->
    wrap(
        configure_room,
        step(Ctx, configure_room, fun(A, T) -> geo_xmpp_admin:configure_room(A, RoomJid, T) end),
        Event
    ).

%% Best effort: the owner's ghost occupant is expelled by the room anyway.
-spec exit_owner(ctx(), binary()) -> ok.
exit_owner(#{xmpp_domain := Domain, room_owner := Owner} = Ctx, RoomJid) ->
    OwnerJid = <<Owner/binary, "@", Domain/binary, "/", ?OWNER_RESOURCE/binary>>,
    _ = step(Ctx, exit_room, fun(A, T) ->
        geo_xmpp_admin:exit_room(A, RoomJid, OwnerJid, ?OWNER_NICK, T)
    end),
    ok.

%% One admin call with a timeout that shrinks with the deadline; below the minimum no call is
%% made and the answer is `unavailable`.
-spec step(ctx(), revoke_step() | exit_room, fun((geo_xmpp_admin:admin(), pos_integer()) -> Result)) ->
    Result | {error, unavailable}
when
    Result :: term().
step(#{admin := Admin, deadline := Deadline}, _Name, Call) ->
    Left = Deadline - erlang:monotonic_time(millisecond),
    case Left < ?MIN_CALL_MS of
        true -> {error, unavailable};
        false -> Call(Admin, min(?MAX_CALL_MS, Left))
    end.

%% ok passes through; {error, Reason} becomes the public error, logged once unless it is
%% plain unavailability.
-spec wrap(step(), term(), event()) -> ok | {error, unavailable | failed}.
wrap(_Step, ok, _Event) -> ok;
wrap(Step, {error, Reason}, Event) -> failure(Step, Reason, Event).

-spec failure(step(), term()) -> {error, unavailable | failed}.
failure(Step, Reason) ->
    failure(Step, Reason, room_access_failed).

-spec failure(step(), term(), event()) -> {error, unavailable | failed}.
failure(_Step, unavailable, _Event) ->
    {error, unavailable};
failure(Step, Reason, Event) ->
    logger:warning(#{event => Event, step => Step, reason => Reason}),
    {error, failed}.

-spec revoke_failure(revoke_step(), term()) -> {error, unavailable | failed}.
revoke_failure(_Step, unavailable) ->
    {error, unavailable};
revoke_failure(Step, Reason) ->
    logger:warning(#{event => room_revoke_failed, step => Step, reason => Reason}),
    {error, failed}.
