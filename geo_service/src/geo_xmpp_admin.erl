%% Client for the MongooseIM 6.2.1 admin GraphQL API (account.registerUser / removeUser /
%% checkPassword; muc.setUserAffiliation (MEMBER and NONE) / createInstantRoom / changeRoomConfiguration / exitRoom).
%% The GraphQL documents are constants; every value travels in `variables`. Request and response
%% bodies are never logged: the register request carries the new XMPP password, and the admin
%% API echoes passwords in some responses (the checkPassword user_does_not_exist error message
%% repeats the password, so even an error body is never logged). See ADR-017, ADR-019 and, for
%% the MUC operations, ADR-020.
-module(geo_xmpp_admin).

-export([register_user/4, register_user/5, remove_user/3, check_password/3]).
-export([set_member/4, set_none/4, create_room/5, configure_room/3, exit_room/5]).
-export([start_http_profile/0]).
-export([
    register_request/4,
    remove_request/3,
    check_password_request/3,
    parse_register/3,
    parse_remove/3,
    parse_check_password/2,
    set_member_request/3,
    set_none_request/3,
    create_room_request/4,
    configure_room_request/2,
    exit_room_request/4,
    parse_set_member/2,
    parse_set_none/2,
    parse_create_room/3,
    parse_configure_room/2,
    parse_exit_room/2,
    room_config/0
]).
-export_type([admin/0, reg_error/0, check_error/0, room_error/0, create_error/0]).

-define(REGISTER_QUERY, <<
    "mutation RegisterUser($domain: DomainName!, $username: UserName, $password: String!) "
    "{ account { registerUser(domain: $domain, username: $username, password: $password) "
    "{ jid } } }"
>>).
-define(REMOVE_QUERY,
    <<"mutation RemoveUser($user: JID!) { account { removeUser(user: $user) { jid } } }">>
).
%% Selects ONLY `correct`: that keeps the echoed password out of the success and wrong-password
%% bodies (MongooseIM 6.2.1 echoes it in the default `message` field).
-define(CHECK_QUERY, <<
    "query CheckPassword($user: JID!, $password: String!) "
    "{ account { checkPassword(user: $user, password: $password) { correct } } }"
>>).
%% MUC operations (ADR-020). Room, user and config travel as variables.
-define(SET_MEMBER_QUERY, <<
    "mutation SetMember($room: BareJID!, $user: JID!) "
    "{ muc { setUserAffiliation(room: $room, user: $user, affiliation: MEMBER) } }"
>>).
%% Revoke a membership (ADR-021): member -> none in a members-only room kicks the user (321).
-define(SET_NONE_QUERY, <<
    "mutation SetNone($room: BareJID!, $user: JID!) "
    "{ muc { setUserAffiliation(room: $room, user: $user, affiliation: NONE) } }"
>>).
-define(CREATE_ROOM_QUERY, <<
    "mutation CreateRoom($room: BareJID!, $owner: JID!, $nick: ResourceName!) "
    "{ muc { createInstantRoom(room: $room, owner: $owner, nick: $nick) { jid } } }"
>>).
-define(CONFIGURE_ROOM_QUERY, <<
    "mutation ConfigureRoom($room: BareJID!, $config: MUCRoomConfigInput!) "
    "{ muc { changeRoomConfiguration(room: $room, config: $config) "
    "{ public publicList persistent membersOnly anonymous allowPrivateMessages allowQueryUsers "
    "allowChangeSubject allowUserInvites mayGetMemberList } } }"
>>).
-define(EXIT_ROOM_QUERY, <<
    "mutation ExitRoom($room: BareJID!, $user: FullJID!, $nick: ResourceName!) "
    "{ muc { exitRoom(room: $room, user: $user, nick: $nick) } }"
>>).
-define(TIMEOUT, 5000).
-define(CONNECT_TIMEOUT, 2000).
%% Dedicated httpc profile: see ADR-021. Never the default profile.
-define(HTTPC_PROFILE, geo_xmpp_admin).

-type admin() :: #{
    url := string(),
    authorization := binary(),
    basic_b64 := binary(),
    password := binary()
}.
-type reg_error() :: exists | unavailable | unauthorized | rejected | bad_response.
-type check_error() :: invalid | unavailable | unauthorized | bad_response.
-type room_error() :: room_not_found | unavailable | unauthorized | bad_response.
-type create_error() :: owner_missing | unavailable | unauthorized | bad_response.
-type request() :: {string(), [{string(), string()}], string(), binary()}.
-type sent() :: {ok, {non_neg_integer(), binary()}} | error.

-spec register_user(admin(), Domain :: binary(), Localpart :: binary(), Password :: binary()) ->
    ok | {error, reg_error()}.
register_user(Admin, Domain, Localpart, Password) ->
    register_user(Admin, Domain, Localpart, Password, ?TIMEOUT).

-spec register_user(admin(), binary(), binary(), binary(), pos_integer()) ->
    ok | {error, reg_error()}.
register_user(Admin, Domain, Localpart, Password, Timeout) ->
    Request = register_request(Admin, Domain, Localpart, Password),
    Sent = send(Request, Timeout),
    Result = parse_register_result(Sent, jid(Localpart, Domain)),
    log_failure(Result, Sent),
    Result.

-spec remove_user(admin(), Domain :: binary(), Localpart :: binary()) ->
    ok | {error, not_found | unavailable | unauthorized | bad_response}.
remove_user(Admin, Domain, Localpart) ->
    Request = remove_request(Admin, Domain, Localpart),
    Sent = send(Request, ?TIMEOUT),
    Result = parse_remove_result(Sent, jid(Localpart, Domain)),
    log_failure(Result, Sent),
    Result.

%% ok: the password is right. {error, invalid}: wrong password or no such account.
-spec check_password(admin(), Jid :: binary(), Password :: binary()) -> ok | {error, check_error()}.
check_password(Admin, Jid, Password) ->
    Sent = send(check_password_request(Admin, Jid, Password), ?TIMEOUT),
    Result =
        case Sent of
            {ok, {Status, Body}} -> parse_check_password(Status, Body);
            error -> {error, unavailable}
        end,
    log_failure(Result, Sent),
    Result.

%% Make the user a `member` of the room (acts as the room's first owner; loaded rooms only).
-spec set_member(admin(), RoomJid :: binary(), UserJid :: binary(), Timeout :: pos_integer()) ->
    ok | {error, room_error()}.
set_member(Admin, RoomJid, UserJid, Timeout) ->
    Sent = send(set_member_request(Admin, RoomJid, UserJid), Timeout),
    Result =
        case Sent of
            {ok, {Status, Body}} -> parse_set_member(Status, Body);
            error -> {error, unavailable}
        end,
    log_failure(Result, Sent),
    Result.

%% Revoke the user's membership (affiliation NONE; loaded rooms only, a no-op when not a member).
-spec set_none(admin(), RoomJid :: binary(), UserJid :: binary(), Timeout :: pos_integer()) ->
    ok | {error, room_error()}.
set_none(Admin, RoomJid, UserJid, Timeout) ->
    Sent = send(set_none_request(Admin, RoomJid, UserJid), Timeout),
    Result =
        case Sent of
            {ok, {Status, Body}} -> parse_set_none(Status, Body);
            error -> {error, unavailable}
        end,
    log_failure(Result, Sent),
    Result.

%% Create (or restore from the database) and load the room, with OwnerFullJid joining as owner.
-spec create_room(
    admin(), RoomJid :: binary(), OwnerFullJid :: binary(), Nick :: binary(), pos_integer()
) -> ok | {error, create_error()}.
create_room(Admin, RoomJid, OwnerFullJid, Nick, Timeout) ->
    Sent = send(create_room_request(Admin, RoomJid, OwnerFullJid, Nick), Timeout),
    Result =
        case Sent of
            {ok, {Status, Body}} -> parse_create_room(Status, Body, RoomJid);
            error -> {error, unavailable}
        end,
    log_failure(Result, Sent),
    Result.

%% Apply the constant room config (room_config/0) to a loaded room.
-spec configure_room(admin(), RoomJid :: binary(), pos_integer()) -> ok | {error, room_error()}.
configure_room(Admin, RoomJid, Timeout) ->
    Sent = send(configure_room_request(Admin, RoomJid), Timeout),
    Result =
        case Sent of
            {ok, {Status, Body}} -> parse_configure_room(Status, Body);
            error -> {error, unavailable}
        end,
    log_failure(Result, Sent),
    Result.

%% Unavailable presence for an occupant (fire-and-forget on the server side).
-spec exit_room(
    admin(), RoomJid :: binary(), FullJid :: binary(), Nick :: binary(), pos_integer()
) -> ok | {error, room_error()}.
exit_room(Admin, RoomJid, FullJid, Nick, Timeout) ->
    Sent = send(exit_room_request(Admin, RoomJid, FullJid, Nick), Timeout),
    Result =
        case Sent of
            {ok, {Status, Body}} -> parse_exit_room(Status, Body);
            error -> {error, unavailable}
        end,
    log_failure(Result, Sent),
    Result.

-spec register_request(admin(), binary(), binary(), binary()) -> request().
register_request(Admin, Domain, Localpart, Password) ->
    Variables = #{
        <<"domain">> => Domain,
        <<"username">> => Localpart,
        <<"password">> => Password
    },
    request(Admin, ?REGISTER_QUERY, Variables).

-spec remove_request(admin(), binary(), binary()) -> request().
remove_request(Admin, Domain, Localpart) ->
    request(Admin, ?REMOVE_QUERY, #{<<"user">> => jid(Localpart, Domain)}).

-spec check_password_request(admin(), binary(), binary()) -> request().
check_password_request(Admin, Jid, Password) ->
    request(Admin, ?CHECK_QUERY, #{<<"user">> => Jid, <<"password">> => Password}).

-spec set_member_request(admin(), binary(), binary()) -> request().
set_member_request(Admin, RoomJid, UserJid) ->
    request(Admin, ?SET_MEMBER_QUERY, #{<<"room">> => RoomJid, <<"user">> => UserJid}).

-spec set_none_request(admin(), binary(), binary()) -> request().
set_none_request(Admin, RoomJid, UserJid) ->
    request(Admin, ?SET_NONE_QUERY, #{<<"room">> => RoomJid, <<"user">> => UserJid}).

-spec create_room_request(admin(), binary(), binary(), binary()) -> request().
create_room_request(Admin, RoomJid, OwnerFullJid, Nick) ->
    Variables = #{<<"room">> => RoomJid, <<"owner">> => OwnerFullJid, <<"nick">> => Nick},
    request(Admin, ?CREATE_ROOM_QUERY, Variables).

-spec configure_room_request(admin(), binary()) -> request().
configure_room_request(Admin, RoomJid) ->
    request(Admin, ?CONFIGURE_ROOM_QUERY, #{<<"room">> => RoomJid, <<"config">> => room_config()}).

-spec exit_room_request(admin(), binary(), binary(), binary()) -> request().
exit_room_request(Admin, RoomJid, FullJid, Nick) ->
    Variables = #{<<"room">> => RoomJid, <<"user">> => FullJid, <<"nick">> => Nick},
    request(Admin, ?EXIT_ROOM_QUERY, Variables).

%% The configuration every g7_* room must have (ADR-020). Also the dev-seed JSON.
-spec room_config() -> #{binary() => boolean() | []}.
room_config() ->
    #{
        <<"public">> => false,
        <<"publicList">> => false,
        <<"persistent">> => true,
        <<"membersOnly">> => true,
        <<"anonymous">> => true,
        <<"allowPrivateMessages">> => false,
        <<"allowQueryUsers">> => false,
        <<"allowChangeSubject">> => false,
        <<"allowUserInvites">> => false,
        <<"mayGetMemberList">> => []
    }.

-spec request(admin(), binary(), map()) -> request().
request(#{url := Url, authorization := Authorization}, Query, Variables) ->
    Body = iolist_to_binary(json:encode(#{<<"query">> => Query, <<"variables">> => Variables})),
    {Url, [{"authorization", binary_to_list(Authorization)}], "application/json", Body}.

%% 200 + the expected jid -> ok; 200 + errors[0].extensions.code "exists" -> exists,
%% "cannot_register" -> rejected; 401 -> unauthorized; 5xx -> unavailable; anything else
%% (400, jid mismatch, bad JSON) -> bad_response.
-spec parse_register(Status :: non_neg_integer(), Body :: binary(), ExpectedJid :: binary()) ->
    ok | {error, reg_error()}.
parse_register(200, Body, Jid) ->
    case decode(Body) of
        {ok, #{<<"data">> := #{<<"account">> := #{<<"registerUser">> := #{<<"jid">> := Jid}}}}} ->
            ok;
        {ok, Decoded} ->
            case error_code(Decoded) of
                <<"exists">> -> {error, exists};
                <<"cannot_register">> -> {error, rejected};
                _ -> {error, bad_response}
            end;
        error ->
            {error, bad_response}
    end;
parse_register(Status, _Body, _Jid) ->
    status_error(Status).

%% 200 correct true -> ok; correct false -> invalid; errors[0].extensions.code
%% "user_does_not_exist" -> invalid; any other 200 (other code, non-boolean correct, not JSON) ->
%% bad_response; 401 -> unauthorized; 5xx -> unavailable; anything else -> bad_response.
-spec parse_check_password(Status :: non_neg_integer(), Body :: binary()) ->
    ok | {error, check_error()}.
parse_check_password(200, Body) ->
    case decode(Body) of
        {ok, #{
            <<"data">> := #{
                <<"account">> := #{<<"checkPassword">> := #{<<"correct">> := Correct}}
            }
        }} when is_boolean(Correct) ->
            case Correct of
                true -> ok;
                false -> {error, invalid}
            end;
        {ok, Decoded} ->
            case error_code(Decoded) of
                <<"user_does_not_exist">> -> {error, invalid};
                _ -> {error, bad_response}
            end;
        error ->
            {error, bad_response}
    end;
parse_check_password(Status, _Body) ->
    status_error(Status).

%% ok -> ok; errors[0].extensions.code "not_allowed" (no such user) -> not_found.
-spec parse_remove(Status :: non_neg_integer(), Body :: binary(), ExpectedJid :: binary()) ->
    ok | {error, not_found | unavailable | unauthorized | bad_response}.
parse_remove(200, Body, Jid) ->
    case decode(Body) of
        {ok, #{<<"data">> := #{<<"account">> := #{<<"removeUser">> := #{<<"jid">> := Jid}}}}} ->
            ok;
        {ok, Decoded} ->
            case error_code(Decoded) of
                <<"not_allowed">> -> {error, not_found};
                _ -> {error, bad_response}
            end;
        error ->
            {error, bad_response}
    end;
parse_remove(Status, _Body, _Jid) ->
    case status_error(Status) of
        {error, Reason} when Reason =:= unavailable; Reason =:= unauthorized -> {error, Reason};
        {error, _} -> {error, bad_response}
    end.

%% 200 + a string result -> ok; code "room_not_found" -> room_not_found; other 200 -> bad_response.
-spec parse_set_member(Status :: non_neg_integer(), Body :: binary()) ->
    ok | {error, room_error()}.
parse_set_member(200, Body) ->
    case decode(Body) of
        {ok, #{<<"data">> := #{<<"muc">> := #{<<"setUserAffiliation">> := Result}}}} when
            is_binary(Result)
        ->
            ok;
        {ok, Decoded} ->
            room_code(error_code(Decoded));
        error ->
            {error, bad_response}
    end;
parse_set_member(Status, _Body) ->
    status_error(Status).

%% Same answer shapes as set_member.
-spec parse_set_none(Status :: non_neg_integer(), Body :: binary()) ->
    ok | {error, room_error()}.
parse_set_none(Status, Body) -> parse_set_member(Status, Body).

%% 200 + the expected room jid -> ok; code "user_not_found" (owner account missing) ->
%% owner_missing; any other code -> bad_response.
-spec parse_create_room(Status :: non_neg_integer(), Body :: binary(), ExpectedRoomJid :: binary()) ->
    ok | {error, create_error()}.
parse_create_room(200, Body, RoomJid) ->
    case decode(Body) of
        {ok, #{<<"data">> := #{<<"muc">> := #{<<"createInstantRoom">> := #{<<"jid">> := RoomJid}}}}} ->
            ok;
        {ok, Decoded} ->
            case error_code(Decoded) of
                <<"user_not_found">> -> {error, owner_missing};
                _ -> {error, bad_response}
            end;
        error ->
            {error, bad_response}
    end;
parse_create_room(Status, _Body, _RoomJid) ->
    status_error(Status).

%% 200 and every field of room_config/0 echoed back with the requested value -> ok.
-spec parse_configure_room(Status :: non_neg_integer(), Body :: binary()) ->
    ok | {error, room_error()}.
parse_configure_room(200, Body) ->
    case decode(Body) of
        {ok, #{<<"data">> := #{<<"muc">> := #{<<"changeRoomConfiguration">> := Echoed}}}} when
            is_map(Echoed)
        ->
            Requested = room_config(),
            case maps:filter(fun(K, V) -> maps:find(K, Echoed) =:= {ok, V} end, Requested) of
                Requested -> ok;
                _ -> {error, bad_response}
            end;
        {ok, Decoded} ->
            room_code(error_code(Decoded));
        error ->
            {error, bad_response}
    end;
parse_configure_room(Status, _Body) ->
    status_error(Status).

%% 200 + a string result -> ok.
-spec parse_exit_room(Status :: non_neg_integer(), Body :: binary()) ->
    ok | {error, room_error()}.
parse_exit_room(200, Body) ->
    case decode(Body) of
        {ok, #{<<"data">> := #{<<"muc">> := #{<<"exitRoom">> := Result}}}} when
            is_binary(Result)
        ->
            ok;
        {ok, Decoded} ->
            room_code(error_code(Decoded));
        error ->
            {error, bad_response}
    end;
parse_exit_room(Status, _Body) ->
    status_error(Status).

-spec room_code(term()) -> {error, room_not_found | bad_response}.
room_code(<<"room_not_found">>) -> {error, room_not_found};
room_code(_) -> {error, bad_response}.

-spec status_error(non_neg_integer()) -> {error, unavailable | unauthorized | bad_response}.
status_error(401) -> {error, unauthorized};
status_error(Status) when Status >= 500, Status =< 599 -> {error, unavailable};
status_error(_) -> {error, bad_response}.

-spec decode(binary()) -> {ok, term()} | error.
decode(Body) ->
    try json:decode(Body) of
        Decoded -> {ok, Decoded}
    catch
        error:_ -> error
    end.

-spec error_code(term()) -> term().
error_code(#{<<"errors">> := [#{<<"extensions">> := #{<<"code">> := Code}} | _]}) -> Code;
error_code(_) -> undefined.

-spec jid(binary(), binary()) -> binary().
jid(Localpart, Domain) -> <<Localpart/binary, "@", Domain/binary>>.

%% Start the dedicated httpc profile. max_keep_alive_length 0 means a request is never queued
%% behind another one on a kept-alive session, so one user's hung MongooseIM call cannot delay
%% anyone else; max_sessions limits persistent connections only (overflow requests open one-off
%% Connection: close connections).
-spec start_http_profile() -> ok | {error, httpc_profile}.
start_http_profile() ->
    case inets:start(httpc, [{profile, ?HTTPC_PROFILE}]) of
        {ok, _Pid} -> set_profile_options();
        {error, {already_started, _Pid}} -> set_profile_options();
        _ -> {error, httpc_profile}
    end.

-spec set_profile_options() -> ok | {error, httpc_profile}.
set_profile_options() ->
    case httpc:set_options([{max_keep_alive_length, 0}, {max_sessions, 8}], ?HTTPC_PROFILE) of
        ok -> ok;
        _ -> {error, httpc_profile}
    end.

%% Dedicated httpc profile, per-request options only. Any failure to get an HTTP answer is
%% "unavailable"; the reason is dropped because it can embed request data.
-spec send(request(), pos_integer()) -> sent().
send({Url, Headers, ContentType, Body}, Timeout) ->
    HttpOpts = [
        {timeout, Timeout},
        {connect_timeout, min(?CONNECT_TIMEOUT, Timeout)},
        {autoredirect, false}
    ],
    try
        httpc:request(
            post,
            {Url, Headers, ContentType, Body},
            HttpOpts,
            [{body_format, binary}],
            ?HTTPC_PROFILE
        )
    of
        {ok, {{_Version, Status, _Reason}, _RespHeaders, RespBody}} when is_binary(RespBody) ->
            {ok, {Status, RespBody}};
        _ ->
            error
    catch
        _:_ -> error
    end.

-spec parse_register_result(sent(), binary()) -> ok | {error, reg_error()}.
parse_register_result({ok, {Status, Body}}, Jid) -> parse_register(Status, Body, Jid);
parse_register_result(error, _Jid) -> {error, unavailable}.

-spec parse_remove_result(sent(), binary()) ->
    ok | {error, not_found | unavailable | unauthorized | bad_response}.
parse_remove_result({ok, {Status, Body}}, Jid) -> parse_remove(Status, Body, Jid);
parse_remove_result(error, _Jid) -> {error, unavailable}.

%% Status only: never a body.
-spec log_failure(ok | {error, atom()}, sent()) -> ok.
log_failure({error, unauthorized}, _Sent) ->
    logger:error(#{event => xmpp_admin_unauthorized});
log_failure({error, bad_response}, {ok, {Status, _Body}}) ->
    logger:warning(#{event => xmpp_admin_bad_response, status => Status});
log_failure(_, _) ->
    ok.
