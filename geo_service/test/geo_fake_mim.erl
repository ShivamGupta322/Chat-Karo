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
-module(geo_fake_mim).
-behaviour(cowboy_handler).

-export([start/0, stop/0, port/0, stop_listener/0, start_listener/1]).
-export([set_mode/1, reset/0, calls/0]).
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

-spec set_mode(ok | exists | unauthorized | http503 | slow | garbage) -> ok.
set_mode(Mode) ->
    true = ets:insert(?TABLE, {mode, Mode}),
    ok.

%% Forget the recorded requests (not the secrets or log events).
-spec reset() -> ok.
reset() ->
    ets:match_delete(?TABLE, {{call, '_'}, '_'}),
    ok.

-spec calls() -> [#{op := register | remove | other, auth := term(), vars := map()}].
calls() ->
    [Call || {{call, _}, Call} <- ets:tab2list(?TABLE)].

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
    case {binary:match(Query, <<"registerUser">>), binary:match(Query, <<"removeUser">>)} of
        {{_, _}, nomatch} -> register;
        {nomatch, {_, _}} -> remove;
        _ -> other
    end.

respond(unauthorized, _Op, _Vars, Req) ->
    reply(401, gql_error(<<"wrong_credentials">>), Req);
respond(http503, _Op, _Vars, Req) ->
    cowboy_req:reply(503, #{}, <<"upstream unavailable">>, Req);
respond(garbage, _Op, _Vars, Req) ->
    cowboy_req:reply(200, #{}, <<"<html>not json</html>">>, Req);
respond(exists, register, _Vars, Req) ->
    reply(200, gql_error(<<"exists">>), Req);
respond(slow, register, Vars, Req) ->
    timer:sleep(?SLOW_MS),
    respond(ok, register, Vars, Req);
respond(_Mode, register, #{<<"username">> := User, <<"domain">> := Domain}, Req) ->
    reply(
        200,
        #{
            <<"data">> => #{
                <<"account">> => #{
                    <<"registerUser">> => #{
                        <<"jid">> => jid(User, Domain), <<"message">> => <<"User registered">>
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
