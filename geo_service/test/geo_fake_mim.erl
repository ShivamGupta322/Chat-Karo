%% A fake MongooseIM admin GraphQL endpoint for geo_session_SUITE. It answers
%% POST /api/graphql in the shapes the supervisor probed live on MongooseIM 6.2.1 and records
%% each request (operation, Authorization header, decoded variables) in an ETS table that a
%% keeper process owns, so the table outlives the Common Test process that created it.
%%
%% Modes (set per test case):
%%   ok            register and remove succeed
%%   exists        register answers "exists", remove succeeds
%%   unauthorized  every request is 401 wrong_credentials
%%   http503       every request is 503
%%   slow          register answers ok after 7 s (longer than the client timeout)
%%   garbage       every request is 200 with a non-JSON body
%%   slow_check    checkPassword answers after 7 s (everything else as ok)
%%   room_unloaded the MUC operations behave like a MongooseIM whose rooms are not loaded (same
%%                 as ok; the default). Rooms live in ETS: set_member answers room_not_found
%%                 until a create (which needs a registered owner) loaded the room.
%%   owner_missing createInstantRoom always answers user_not_found
%%   configure_mismatch changeRoomConfiguration echoes publicList flipped
%%   slow_room     every MUC operation answers after 7 s
%% A successful register (modes ok, exists never registers) stores {{pw, Jid}, Password} so
%% that checkPassword can answer: equal -> correct true, different -> correct false, no entry ->
%% 200 user_does_not_exist whose message echoes the password (the shape probed live, which is
%% why nothing may log an admin body). forget_user/1 deletes the entry.
-module(geo_fake_mim).
-behaviour(cowboy_handler).

-export([start/0, stop/0, port/0, stop_listener/0, start_listener/1]).
-export([set_mode/1, reset/0, reset_calls/0, calls/0, forget_user/1]).
-export([put_secret/1, secrets/0, log_event/1, log_events/0]).
-export([init/2]).

-define(TABLE, geo_fake_mim_tab).
-define(LISTENER, geo_fake_mim_listener).
-define(SLOW_MS, 7000).

-spec start() -> {ok, inet:port_number()}.
start() ->
    Parent = self(),
    Keeper = spawn(fun() ->
        ?TABLE = ets:new(?TABLE, [named_table, public, ordered_set]),
        true = ets:insert(?TABLE, {mode, ok}),
        Parent ! {keeper_ready, self()},
        receive
            stop -> ok
        end
    end),
    receive
        {keeper_ready, Keeper} -> ok
    after 5000 -> error(keeper_timeout)
    end,
    true = register(geo_fake_mim_keeper, Keeper),
    start_listener(0).

-spec stop() -> ok.
stop() ->
    stop_listener(),
    case whereis(geo_fake_mim_keeper) of
        undefined ->
            ok;
        Keeper ->
            Keeper ! stop,
            ok
    end.

-spec start_listener(inet:port_number()) -> {ok, inet:port_number()}.
start_listener(Port) ->
    {ok, _} = application:ensure_all_started(cowboy),
    Dispatch = cowboy_router:compile([{'_', [{"/api/graphql", ?MODULE, []}]}]),
    {ok, _} = cowboy:start_clear(
        ?LISTENER, [{ip, {127, 0, 0, 1}}, {port, Port}], #{env => #{dispatch => Dispatch}}
    ),
    {ok, ranch:get_port(?LISTENER)}.

-spec stop_listener() -> ok.
stop_listener() ->
    _ = cowboy:stop_listener(?LISTENER),
    ok.

-spec port() -> inet:port_number().
port() -> ranch:get_port(?LISTENER).

-type mode() ::
    ok
    | exists
    | unauthorized
    | http503
    | slow
    | slow_check
    | garbage
    | room_unloaded
    | owner_missing
    | configure_mismatch
    | slow_room.
-type op() :: register | remove | check | set_member | create | configure | exit | other.

-spec set_mode(mode()) -> ok.
set_mode(Mode) ->
    true = ets:insert(?TABLE, {mode, Mode}),
    ok.

%% Forget the recorded requests only.
-spec reset_calls() -> ok.
reset_calls() ->
    ets:match_delete(?TABLE, {{call, '_'}, '_'}),
    ok.

%% Forget the recorded requests and unload every room (not the secrets, log events or accounts).
-spec reset() -> ok.
reset() ->
    ets:match_delete(?TABLE, {{call, '_'}, '_'}),
    ets:match_delete(?TABLE, {{room, '_'}, '_'}),
    ok.

-spec calls() -> [#{op := op(), auth := term(), vars := map()}].

calls() ->
    [Call || {{call, _}, Call} <- ets:tab2list(?TABLE)].

%% The account no longer exists in the fake.
-spec forget_user(Jid :: binary()) -> ok.
forget_user(Jid) ->
    true = ets:delete(?TABLE, {pw, Jid}),
    ok.

-spec put_secret(binary()) -> ok.
put_secret(Secret) ->
    true = ets:insert(?TABLE, {{secret, Secret}, true}),
    ok.

-spec secrets() -> [binary()].
secrets() ->
    [Secret || {{secret, Secret}, _} <- ets:tab2list(?TABLE)].

%% Called from a logger handler: never crashes if the table is gone.
-spec log_event(term()) -> ok.
log_event(Event) ->
    try ets:insert(?TABLE, {{log, erlang:unique_integer([monotonic])}, Event}) of
        true -> ok
    catch
        error:badarg -> ok
    end.

-spec log_events() -> [term()].
log_events() ->
    [Event || {{log, _}, Event} <- ets:tab2list(?TABLE)].

%%% Handler --------------------------------------------------------------------------------

-spec init(cowboy_req:req(), term()) -> {ok, cowboy_req:req(), term()}.
init(Req0, State) ->
    {ok, Body, Req1} = cowboy_req:read_body(Req0),
    Auth = cowboy_req:header(<<"authorization">>, Req1, undefined),
    #{<<"query">> := Query, <<"variables">> := Vars} = json:decode(Body),
    Op = operation(Query),
    true = ets:insert(
        ?TABLE,
        {{call, erlang:unique_integer([monotonic])}, #{op => Op, auth => Auth, vars => Vars}}
    ),
    [{mode, Mode}] = ets:lookup(?TABLE, mode),
    Req = respond(Mode, Op, Vars, Req1),
    {ok, Req, State}.

operation(Query) ->
    Names = [
        {<<"registerUser">>, register},
        {<<"removeUser">>, remove},
        {<<"checkPassword">>, check},
        {<<"setUserAffiliation">>, set_member},
        {<<"createInstantRoom">>, create},
        {<<"changeRoomConfiguration">>, configure},
        {<<"exitRoom">>, exit}
    ],
    case [Op || {Name, Op} <- Names, binary:match(Query, Name) =/= nomatch] of
        [Op] -> Op;
        _ -> other
    end.

respond(unauthorized, _Op, _Vars, Req) ->
    reply(401, gql_error(<<"wrong_credentials">>), Req);
respond(http503, _Op, _Vars, Req) ->
    cowboy_req:reply(503, #{}, <<"upstream unavailable">>, Req);
respond(garbage, _Op, _Vars, Req) ->
    cowboy_req:reply(200, #{}, <<"<html>not json</html>">>, Req);
respond(slow_room, Op, Vars, Req) when
    Op =:= set_member; Op =:= create; Op =:= configure; Op =:= exit
->
    timer:sleep(?SLOW_MS),
    respond(ok, Op, Vars, Req);
respond(_Mode, set_member, #{<<"room">> := Room, <<"user">> := User}, Req) ->
    case ets:lookup(?TABLE, {room, Room}) of
        [] ->
            reply(200, gql_error(<<"room_not_found">>), Req);
        [_] ->
            true = ets:insert(?TABLE, {{aff, Room, User}, member}),
            reply(200, muc_data(<<"setUserAffiliation">>, <<"User affiliation set">>), Req)
    end;
respond(owner_missing, create, _Vars, Req) ->
    reply(200, gql_error(<<"user_not_found">>), Req);
respond(_Mode, create, #{<<"room">> := Room, <<"owner">> := Owner}, Req) ->
    [Bare | _] = binary:split(Owner, <<"/">>),
    case ets:lookup(?TABLE, {pw, Bare}) of
        [] ->
            reply(200, gql_error(<<"user_not_found">>), Req);
        [_] ->
            true = ets:insert(?TABLE, {{room, Room}, loaded}),
            reply(200, muc_data(<<"createInstantRoom">>, #{<<"jid">> => Room}), Req)
    end;
respond(Mode, configure, #{<<"room">> := Room, <<"config">> := Config}, Req) ->
    case ets:lookup(?TABLE, {room, Room}) of
        [] ->
            reply(200, gql_error(<<"room_not_found">>), Req);
        [_] when Mode =:= configure_mismatch ->
            Flipped = Config#{<<"publicList">> => not maps:get(<<"publicList">>, Config)},
            reply(200, muc_data(<<"changeRoomConfiguration">>, Flipped), Req);
        [_] ->
            reply(200, muc_data(<<"changeRoomConfiguration">>, Config), Req)
    end;
respond(_Mode, exit, _Vars, Req) ->
    reply(200, muc_data(<<"exitRoom">>, <<"Exit room request sent">>), Req);
respond(exists, register, _Vars, Req) ->
    reply(200, gql_error(<<"exists">>), Req);
respond(slow, register, Vars, Req) ->
    timer:sleep(?SLOW_MS),
    respond(ok, register, Vars, Req);
respond(slow_check, check, Vars, Req) ->
    timer:sleep(?SLOW_MS),
    respond(ok, check, Vars, Req);
respond(Mode, check, #{<<"user">> := Jid, <<"password">> := Password}, Req) when
    Mode =:= ok; Mode =:= exists; Mode =:= slow
->
    case ets:lookup(?TABLE, {pw, Jid}) of
        [{_, Password}] -> reply(200, check_ok(true), Req);
        [{_, _Other}] -> reply(200, check_ok(false), Req);
        [] -> reply(200, check_missing(Jid, Password), Req)
    end;
respond(
    _Mode, register, #{<<"username">> := User, <<"domain">> := Domain, <<"password">> := Pw}, Req
) ->
    Jid = jid(User, Domain),
    true = ets:insert(?TABLE, {{pw, Jid}, Pw}),
    reply(
        200,
        #{
            <<"data">> => #{
                <<"account">> => #{
                    <<"registerUser">> => #{
                        <<"jid">> => Jid, <<"message">> => <<"User registered">>
                    }
                }
            }
        },
        Req
    );
respond(_Mode, remove, #{<<"user">> := Jid}, Req) ->
    reply(
        200,
        #{<<"data">> => #{<<"account">> => #{<<"removeUser">> => #{<<"jid">> => Jid}}}},
        Req
    );
respond(_Mode, _Op, _Vars, Req) ->
    cowboy_req:reply(400, #{}, <<"unexpected">>, Req).

muc_data(Field, Value) ->
    #{<<"data">> => #{<<"muc">> => #{Field => Value}}}.

check_ok(Correct) ->
    #{<<"data">> => #{<<"account">> => #{<<"checkPassword">> => #{<<"correct">> => Correct}}}}.

%% 200 with an error whose message echoes the password, as MongooseIM 6.2.1 does.
check_missing(Jid, Password) ->
    #{
        <<"errors">> => [
            #{
                <<"message">> =>
                    <<"Password ", Password/binary, " for user ", Jid/binary, " does not exist">>,
                <<"extensions">> => #{<<"code">> => <<"user_does_not_exist">>}
            }
        ],
        <<"data">> => #{<<"account">> => #{<<"checkPassword">> => null}}
    }.

%% MongooseIM lowercases the localpart.
jid(User, Domain) ->
    <<(string:lowercase(User))/binary, "@", Domain/binary>>.

gql_error(Code) ->
    #{
        <<"errors">> => [#{<<"message">> => <<"x">>, <<"extensions">> => #{<<"code">> => Code}}],
        <<"data">> => #{<<"account">> => #{<<"registerUser">> => null}}
    }.

reply(Status, Map, Req) ->
    cowboy_req:reply(
        Status, #{<<"content-type">> => <<"application/json">>}, json:encode(Map), Req
    ).
