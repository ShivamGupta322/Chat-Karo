%% Gives a user access to a cell's MUC room before /api/locate answers (ADR-020). No processes:
%% a sequence of admin API calls under one hard deadline, run by the request process.
%%
%% Rooms are members-only and only the room-owner account may create them, so a user can join
%% only after geo_service made them a `member`. Fast path: the room is loaded, one call
%% (set_member). Slow path (the room is not loaded, e.g. after a MongooseIM restart or for a new
%% cell): create/restore the room as the owner, re-apply the constant room config (stored options
%% override the template defaults), let the owner's ghost occupant leave, then set_member.
%%
%% Nothing here logs a JID, a body or a password: a failure logs one event with atoms only.
%% All geo_xmpp_admin and geo_session calls are fully qualified (the tests mock them).
-module(geo_room_access).

-export([grant/3]).
-export_type([ctx/0]).

-define(MAX_CALL_MS, 5000).
-define(MIN_CALL_MS, 250).
-define(OWNER_RESOURCE, <<"geo_service">>).
-define(OWNER_NICK, <<"Nearby">>).

-type ctx() :: #{
    admin := geo_xmpp_admin:admin(),
    xmpp_domain := binary(),
    room_owner := binary(),
    %% erlang:monotonic_time(millisecond)
    deadline := integer()
}.
-type step() :: set_member | create_room | register_owner | configure_room | set_member_again.

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
        ok ?= create_room(Ctx, RoomJid),
        ok ?= configure_room(Ctx, RoomJid),
        _ = exit_owner(Ctx, RoomJid),
        ok ?=
            wrap(
                set_member_again,
                step(Ctx, set_member_again, fun(A, T) ->
                    geo_xmpp_admin:set_member(A, RoomJid, UserJid, T)
                end)
            )
    end.

%% The owner account is registered lazily, the first time MongooseIM says it does not exist.
-spec create_room(ctx(), binary()) -> ok | {error, unavailable | failed}.
create_room(#{xmpp_domain := Domain, room_owner := Owner} = Ctx, RoomJid) ->
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
            case register_owner(Ctx) of
                ok -> wrap(create_room, Create());
                {error, _} = Error -> Error
            end;
        Other ->
            wrap(create_room, Other)
    end.

-spec register_owner(ctx()) -> ok | {error, unavailable | failed}.
register_owner(#{xmpp_domain := Domain, room_owner := Owner} = Ctx) ->
    Result = step(Ctx, register_owner, fun(A, T) ->
        geo_xmpp_admin:register_user(A, Domain, Owner, geo_session:new_password(), T)
    end),
    case Result of
        ok -> ok;
        {error, exists} -> ok;
        Other -> wrap(register_owner, Other)
    end.

-spec configure_room(ctx(), binary()) -> ok | {error, unavailable | failed}.
configure_room(Ctx, RoomJid) ->
    wrap(
        configure_room,
        step(Ctx, configure_room, fun(A, T) -> geo_xmpp_admin:configure_room(A, RoomJid, T) end)
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
-spec step(ctx(), step() | exit_room, fun((geo_xmpp_admin:admin(), pos_integer()) -> Result)) ->
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
-spec wrap(step(), term()) -> ok | {error, unavailable | failed}.
wrap(_Step, ok) -> ok;
wrap(Step, {error, Reason}) -> failure(Step, Reason).

-spec failure(step(), term()) -> {error, unavailable | failed}.
failure(_Step, unavailable) ->
    {error, unavailable};
failure(Step, Reason) ->
    logger:warning(#{event => room_access_failed, step => Step, reason => Reason}),
    {error, failed}.
