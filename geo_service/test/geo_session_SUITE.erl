%% POST /api/session end to end: the real application, a real MongoDB (database chaterl_ct only)
%% and a fake MongooseIM admin API (geo_fake_mim). The suite is skipped, loudly, when Mongo is
%% not reachable at GEO_CT_MONGO_HOSTS (default 127.0.0.1:27018).
-module(geo_session_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([
    all/0,
    groups/0,
    init_per_suite/1,
    end_per_suite/1,
    init_per_group/2,
    end_per_group/2,
    init_per_testcase/2,
    end_per_testcase/2
]).
-export([
    create_201/1,
    duplicate_case_insensitive_409/1,
    reserved_409/1,
    concurrent_same_nickname/1,
    validation/1,
    xmpp_unavailable_rolls_back/1,
    xmpp_slow_times_out/1,
    xmpp_unauthorized_500/1,
    xmpp_exists_500_no_remove/1,
    mongo_unavailable_503/1,
    logs_contain_no_secrets/1
]).
%% logger handler callback
-export([log/2]).

-define(DB, "chaterl_ct").
-define(JWT_SECRET, "ct-jwt-secret-0123456789-abcdefghijklmnop").
-define(ADMIN_USER, "admin").
-define(ADMIN_PASSWORD, "ct-admin-password").
-define(DOMAIN, "chaterl.localhost").
-define(HANDLER, geo_session_ct_capture).

all() ->
    [
        create_201,
        duplicate_case_insensitive_409,
        reserved_409,
        concurrent_same_nickname,
        validation,
        xmpp_unavailable_rolls_back,
        xmpp_slow_times_out,
        xmpp_unauthorized_500,
        xmpp_exists_500_no_remove,
        {group, mongo_down},
        logs_contain_no_secrets
    ].

groups() ->
    [{mongo_down, [], [mongo_unavailable_503]}].

init_per_suite(Config) ->
    Hosts = hosts(),
    case reachable(Hosts) of
        false ->
            {skip, "MongoDB not reachable at " ++ Hosts ++ " (set GEO_CT_MONGO_HOSTS)"};
        true ->
            {ok, _} = application:ensure_all_started(inets),
            {ok, FakePort} = geo_fake_mim:start(),
            start_app(Hosts, FakePort),
            wait_ready(10000),
            {true, _} = run_command(#{<<"dropDatabase">> => 1}),
            %% The profiles indexes, as in infra/mongo/init-indexes.js (geo_mongo_SUITE has the
            %% drift guard for that file).
            {true, #{<<"ok">> := Ok}} = run_command(#{
                <<"createIndexes">> => <<"profiles">>,
                <<"indexes">> => [
                    #{
                        <<"key">> => #{<<"nickname">> => 1},
                        <<"name">> => <<"nickname_unique_ci">>,
                        <<"unique">> => true,
                        <<"collation">> => #{<<"locale">> => <<"en">>, <<"strength">> => 2}
                    },
                    #{
                        <<"key">> => #{<<"expiresAt">> => 1},
                        <<"name">> => <<"expiresAt_ttl">>,
                        <<"expireAfterSeconds">> => 0
                    }
                ]
            }),
            true = (Ok == 1),
            %% info level so that session_created events are captured too.
            Level = maps:get(level, logger:get_primary_config()),
            ok = logger:set_primary_config(level, info),
            ok = logger:add_handler(?HANDLER, ?MODULE, #{}),
            Prefix = "Ct" ++ binary_to_list(binary:encode_hex(crypto:strong_rand_bytes(3))),
            [{fake_port, FakePort}, {prefix, Prefix}, {old_level, Level} | Config]
    end.

end_per_suite(Config) ->
    _ = logger:remove_handler(?HANDLER),
    case ?config(old_level, Config) of
        undefined -> ok;
        Level -> logger:set_primary_config(level, Level)
    end,
    _ = run_command(#{<<"dropDatabase">> => 1}),
    application:stop(geo_service),
    geo_fake_mim:stop(),
    ok.

init_per_group(mongo_down, Config) ->
    application:stop(geo_service),
    start_app("127.0.0.1:1", ?config(fake_port, Config)),
    Config.

end_per_group(mongo_down, Config) ->
    application:stop(geo_service),
    start_app(hosts(), ?config(fake_port, Config)),
    wait_ready(15000),
    ok.

init_per_testcase(_Case, Config) ->
    geo_fake_mim:set_mode(ok),
    geo_fake_mim:reset(),
    delete_all_profiles(),
    Config.

end_per_testcase(_Case, _Config) ->
    geo_fake_mim:set_mode(ok),
    delete_all_profiles(),
    ok.

%%% Cases --------------------------------------------------------------------------------

create_201(Config) ->
    Nick = nick(Config, "a"),
    {201, Headers, Body} = post_json(#{<<"nickname">> => Nick}),
    "application/json" = binary_to_list(maps:get(<<"content-type">>, Headers)),
    <<"no-store">> = maps:get(<<"cache-control">>, Headers),
    Decoded = json:decode(Body),
    [
        <<"expires_in">>,
        <<"jid">>,
        <<"nickname">>,
        <<"token">>,
        <<"token_type">>,
        <<"xmpp_password">>
    ] =
        lists:sort(maps:keys(Decoded)),
    #{
        <<"nickname">> := Nick,
        <<"jid">> := Jid,
        <<"xmpp_password">> := Password,
        <<"token">> := Token,
        <<"token_type">> := <<"Bearer">>,
        <<"expires_in">> := 3600
    } = Decoded,
    remember([Password, Token]),
    {ok, #{sub := Localpart}} = geo_auth:verify(Token, <<?JWT_SECRET>>, erlang:system_time(second)),
    {match, _} = re:run(Localpart, "^u[0-9a-f]{32}$"),
    Jid = <<Localpart/binary, "@", ?DOMAIN>>,
    {match, _} = re:run(Password, "^xp1_[A-Za-z0-9_-]{32}$"),
    %% The fake MongooseIM saw exactly one registration, with the generated values.
    [#{op := register, auth := Auth, vars := Vars}] = geo_fake_mim:calls(),
    ExpectedAuth = <<"Basic ", (base64:encode(<<?ADMIN_USER, ":", ?ADMIN_PASSWORD>>))/binary>>,
    ExpectedAuth = Auth,
    #{
        <<"domain">> := <<?DOMAIN>>,
        <<"username">> := Localpart,
        <<"password">> := Password
    } = Vars,
    %% The profile: exactly four fields, active, no expiry.
    {ok, Doc} = geo_mongo:find_one(<<"profiles">>, #{<<"_id">> => Localpart}, #{}),
    [<<"_id">>, <<"createdAt">>, <<"nickname">>, <<"state">>] = lists:sort(maps:keys(Doc)),
    <<"active">> = maps:get(<<"state">>, Doc),
    Nick = maps:get(<<"nickname">>, Doc),
    %% The token holds only the six claims and no nickname.
    [_, P, _] = binary:split(Token, <<".">>, [global]),
    Claims = json:decode(base64:decode(P, #{mode => urlsafe, padding => false})),
    [<<"aud">>, <<"exp">>, <<"iat">>, <<"iss">>, <<"jti">>, <<"sub">>] =
        lists:sort(maps:keys(Claims)).

duplicate_case_insensitive_409(Config) ->
    {201, _, Body} = post_json(#{<<"nickname">> => nick(Config, "Zed")}),
    remember_session(Body),
    {409, _, Conflict} = post_json(#{<<"nickname">> => nick(Config, "zed")}),
    #{<<"error">> := <<"nickname_taken">>} = json:decode(Conflict),
    1 = length(calls(register)),
    1 = count_profiles(Config).

reserved_409(_Config) ->
    {409, _, Body} = post_json(#{<<"nickname">> => <<"ADMIN">>}),
    #{<<"error">> := <<"nickname_taken">>} = json:decode(Body),
    [] = geo_fake_mim:calls(),
    0 = count_all_profiles().

concurrent_same_nickname(Config) ->
    Nick = nick(Config, "Race"),
    Self = self(),
    N = 10,
    lists:foreach(
        fun(I) ->
            spawn_link(fun() -> Self ! {result, I, post_json(#{<<"nickname">> => Nick})} end)
        end,
        lists:seq(1, N)
    ),
    Results = [
        receive
            {result, I, R} -> R
        after 30000 -> ct:fail({no_result, I})
        end
     || I <- lists:seq(1, N)
    ],
    Created = [Body || {201, _, Body} <- Results],
    1 = length(Created),
    9 = length([ok || {409, _, _} <- Results]),
    remember_session(hd(Created)),
    1 = count_profiles(Config),
    1 = length(calls(register)).

validation(Config) ->
    Json = [{"content-type", "application/json"}],
    %% Methods.
    lists:foreach(
        fun(Method) ->
            {405, H, B} = raw(Method, [{"content-length", "0"}], <<>>),
            <<"POST">> = maps:get(<<"allow">>, H),
            #{<<"error">> := <<"method_not_allowed">>} = json:decode(B)
        end,
        ["GET", "PUT"]
    ),
    %% Content types.
    Body = <<"{\"nickname\":\"abc\"}">>,
    {415, _, B415} = raw("POST", [{"content-length", integer_to_list(byte_size(Body))}], Body),
    #{<<"error">> := <<"unsupported_media_type">>} = json:decode(B415),
    lists:foreach(
        fun(Type) ->
            Headers = [
                {"content-type", Type}, {"content-length", integer_to_list(byte_size(Body))}
            ],
            {415, _, _} = raw("POST", Headers, Body)
        end,
        ["text/plain", "application/json; charset=latin1", "application/x-www-form-urlencoded"]
    ),
    %% Size cap: by content-length and chunked.
    Big = binary:copy(<<"a">>, 1025),
    {413, _, BigBody} = raw("POST", Json ++ [{"content-length", "1025"}], Big),
    #{<<"error">> := <<"payload_too_large">>} = json:decode(BigBody),
    {413, _, ChunkedBody} = raw("POST", Json ++ [{"transfer-encoding", "chunked"}], chunked(Big)),
    #{<<"error">> := <<"payload_too_large">>} = json:decode(ChunkedBody),
    %% JSON.
    lists:foreach(
        fun(Bad) ->
            {400, _, B} = raw(
                "POST", Json ++ [{"content-length", integer_to_list(byte_size(Bad))}], Bad
            ),
            #{<<"error">> := <<"invalid_json">>} = json:decode(B)
        end,
        [<<>>, <<"{bad">>, <<"[]">>, <<"\"x\"">>, <<"null">>]
    ),
    %% Shape.
    lists:foreach(
        fun(Bad) ->
            {400, _, B} = post_raw(Bad),
            #{<<"error">> := <<"invalid_request">>} = json:decode(B)
        end,
        [
            <<"{\"nickname\":\"abc\",\"x\":1}">>,
            <<"{\"nickname\":5}">>,
            <<"{\"nickname\":null}">>,
            <<"{}">>,
            <<"{\"nick\":\"abc\"}">>
        ]
    ),
    %% Rules.
    {400, _, BNick} = post_json(#{<<"nickname">> => <<"a b">>}),
    #{<<"error">> := <<"invalid_nickname">>} = json:decode(BNick),
    {400, _, _} = post_json(#{<<"nickname">> => <<"a">>}),
    {400, _, _} = post_json(#{<<"nickname">> => nick(Config, "<script>")}),
    %% None of it reached MongooseIM or Mongo.
    [] = geo_fake_mim:calls(),
    0 = count_all_profiles().

xmpp_unavailable_rolls_back(Config) ->
    Nick = nick(Config, "Down"),
    geo_fake_mim:set_mode(http503),
    {503, H, B} = post_json(#{<<"nickname">> => Nick}),
    <<"5">> = maps:get(<<"retry-after">>, H),
    #{<<"error">> := <<"service_unavailable">>} = json:decode(B),
    0 = count_all_profiles(),
    %% The failed registration was followed by a best-effort removal.
    [register, remove] = [Op || #{op := Op} <- geo_fake_mim:calls()],
    geo_fake_mim:set_mode(ok),
    {201, _, Ok} = post_json(#{<<"nickname">> => Nick}),
    remember_session(Ok),
    %% A closed port (nothing listening) is the same.
    Nick2 = nick(Config, "Closed"),
    Port = geo_fake_mim:port(),
    geo_fake_mim:stop_listener(),
    {503, H2, _} = post_json(#{<<"nickname">> => Nick2}),
    <<"5">> = maps:get(<<"retry-after">>, H2),
    1 = count_all_profiles(),
    {ok, _} = geo_fake_mim:start_listener(Port),
    {201, _, Ok2} = post_json(#{<<"nickname">> => Nick2}),
    remember_session(Ok2).

xmpp_slow_times_out(Config) ->
    geo_fake_mim:set_mode(slow),
    {Micros, {503, _, _}} =
        timer:tc(fun() -> post_json(#{<<"nickname">> => nick(Config, "Slow")}) end),
    true = Micros < 6500000,
    0 = count_all_profiles().

xmpp_unauthorized_500(Config) ->
    geo_fake_mim:set_mode(unauthorized),
    {500, _, B} = post_json(#{<<"nickname">> => nick(Config, "Unauth")}),
    #{<<"error">> := <<"internal_error">>} = json:decode(B),
    0 = count_all_profiles(),
    timer:sleep(200),
    1 = length([E || E <- geo_fake_mim:log_events(), is_unauthorized_event(E)]).

xmpp_exists_500_no_remove(Config) ->
    geo_fake_mim:set_mode(exists),
    {500, _, B} = post_json(#{<<"nickname">> => nick(Config, "Exists")}),
    #{<<"error">> := <<"internal_error">>} = json:decode(B),
    0 = count_all_profiles(),
    %% Never remove an account that already existed.
    [register] = [Op || #{op := Op} <- geo_fake_mim:calls()].

mongo_unavailable_503(Config) ->
    {503, H, B} = post_json(#{<<"nickname">> => nick(Config, "NoMongo")}),
    <<"5">> = maps:get(<<"retry-after">>, H),
    #{<<"error">> := <<"service_unavailable">>} = json:decode(B),
    [] = geo_fake_mim:calls().

%% Last: no captured log event contains a password, token or configured secret.
logs_contain_no_secrets(_Config) ->
    %% Control: the filter is live, so a secret logged on purpose comes out masked.
    logger:error("control ~s", [?ADMIN_PASSWORD]),
    timer:sleep(300),
    Events = geo_fake_mim:log_events(),
    Texts = lists:flatmap(
        fun(E) ->
            [
                lists:flatten(io_lib:format("~0p", [E])),
                lists:flatten(io_lib:format("~ts", [logger_formatter:format(E, #{})]))
            ]
        end,
        Events
    ),
    ct:pal("~b log events captured", [length(Events)]),
    Basic = binary_to_list(base64:encode(<<?ADMIN_USER, ":", ?ADMIN_PASSWORD>>)),
    Secrets =
        [binary_to_list(S) || S <- geo_fake_mim:secrets()] ++
            [?JWT_SECRET, ?ADMIN_PASSWORD, Basic],
    true = length(Secrets) > 3,
    lists:foreach(
        fun(Secret) ->
            lists:foreach(
                fun(Text) -> nomatch = string:find(Text, Secret) end,
                Texts
            )
        end,
        Secrets
    ),
    true = lists:any(fun(T) -> string:find(T, "session_created") =/= nomatch end, Texts),
    true = lists:any(fun(T) -> string:find(T, "[REDACTED]") =/= nomatch end, Texts).

%%% logger handler -----------------------------------------------------------------------

log(Event, _Config) ->
    geo_fake_mim:log_event(Event).

is_unauthorized_event(#{msg := {report, #{event := xmpp_admin_unauthorized}}}) -> true;
is_unauthorized_event(_) -> false.

%%% Helpers ------------------------------------------------------------------------------

hosts() ->
    os:getenv("GEO_CT_MONGO_HOSTS", "127.0.0.1:27018").

reachable(Hosts) ->
    [Host, PortStr | _] = string:split(Hosts, ":"),
    case gen_tcp:connect(Host, list_to_integer(PortStr), [], 2000) of
        {ok, Socket} ->
            gen_tcp:close(Socket),
            true;
        {error, _} ->
            false
    end.

start_app(Hosts, FakePort) ->
    lists:foreach(
        fun({K, V}) -> application:set_env(geo_service, K, V) end,
        [
            {http_ip, "127.0.0.1"},
            {http_port, "0"},
            {mongo_hosts, Hosts},
            {mongo_db, ?DB},
            {mongo_replica_set, ""},
            {mongo_user, ""},
            {mongo_password, ""},
            {mongo_auth_source, ""},
            {mongo_tls, ""},
            {mongo_tls_ca_file, ""},
            {mongo_pool_size, ""},
            {jwt_secret, ?JWT_SECRET},
            {xmpp_domain, ?DOMAIN},
            {mim_admin_url, "http://127.0.0.1:" ++ integer_to_list(FakePort) ++ "/api/graphql"},
            {mim_admin_user, ?ADMIN_USER},
            {mim_admin_password, ?ADMIN_PASSWORD}
        ]
    ),
    {ok, _} = application:ensure_all_started(geo_service),
    ok.

wait_ready(Timeout) when Timeout =< 0 ->
    ct:fail(mongo_not_ready);
wait_ready(Timeout) ->
    case geo_mongo:ready() of
        true ->
            ok;
        false ->
            timer:sleep(200),
            wait_ready(Timeout - 200)
    end.

run_command(Command) ->
    mongoc:transaction(
        geo_mongo_topology,
        fun(#{pool := Worker}) -> mc_worker_api:command(Worker, Command) end,
        #{},
        10000
    ).

%% Skipped while Mongo is down on purpose (the mongo_down group).
delete_all_profiles() ->
    case geo_mongo:ready() of
        true ->
            {true, _} = run_command(#{
                <<"delete">> => <<"profiles">>,
                <<"deletes">> => [#{<<"q">> => #{}, <<"limit">> => 0}]
            }),
            ok;
        false ->
            ok
    end.

count_all_profiles() ->
    {true, #{<<"n">> := N}} = run_command(#{<<"count">> => <<"profiles">>}),
    N.

%% Profiles whose nickname starts with this run's prefix (any case).
count_profiles(Config) ->
    {true, #{<<"n">> := N}} = run_command(#{
        <<"count">> => <<"profiles">>,
        <<"query">> => #{
            <<"nickname">> => #{
                <<"$regex">> => list_to_binary("^" ++ ?config(prefix, Config)),
                <<"$options">> => <<"i">>
            }
        }
    }),
    N.

%% Prefix (8 characters) plus a short suffix stays within 20 characters.
nick(Config, Suffix) ->
    list_to_binary(?config(prefix, Config) ++ Suffix).

calls(Op) ->
    [C || #{op := O} = C <- geo_fake_mim:calls(), O =:= Op].

remember(Secrets) ->
    lists:foreach(fun geo_fake_mim:put_secret/1, Secrets).

remember_session(Body) ->
    #{<<"xmpp_password">> := Password, <<"token">> := Token} = json:decode(Body),
    remember([Password, Token]).

%%% Raw HTTP client ------------------------------------------------------------------------
%% Raw sockets give control over content-length vs chunked bodies and over headers.

post_json(Map) ->
    post_raw(iolist_to_binary(json:encode(Map))).

post_raw(Body) ->
    raw(
        "POST",
        [
            {"content-type", "application/json"},
            {"content-length", integer_to_list(byte_size(Body))}
        ],
        Body
    ).

raw(Method, Headers, Body) ->
    Request = iolist_to_binary([
        Method,
        " /api/session HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: close\r\n",
        [[Name, ": ", Value, "\r\n"] || {Name, Value} <- Headers],
        "\r\n",
        Body
    ]),
    Port = ranch:get_port(geo_http),
    {ok, Socket} = gen_tcp:connect({127, 0, 0, 1}, Port, [binary, {active, false}], 5000),
    ok = gen_tcp:send(Socket, Request),
    Response = recv_all(Socket, <<>>),
    gen_tcp:close(Socket),
    parse_response(Response).

chunked(Data) ->
    [integer_to_binary(byte_size(Data), 16), "\r\n", Data, "\r\n0\r\n\r\n"].

recv_all(Socket, Acc) ->
    case gen_tcp:recv(Socket, 0, 20000) of
        {ok, Data} -> recv_all(Socket, <<Acc/binary, Data/binary>>);
        {error, closed} -> Acc;
        {error, econnreset} when Acc =/= <<>> -> Acc;
        {error, Reason} -> ct:fail({recv_failed, Reason})
    end.

parse_response(Response) ->
    [Head, Body] = binary:split(Response, <<"\r\n\r\n">>),
    [StatusLine | HeaderLines] = binary:split(Head, <<"\r\n">>, [global]),
    <<"HTTP/1.1 ", Code:3/binary, _/binary>> = StatusLine,
    Headers = maps:from_list([
        begin
            [Name, Value] = binary:split(Line, <<": ">>),
            {string:lowercase(Name), Value}
        end
     || Line <- HeaderLines
    ]),
    {binary_to_integer(Code), Headers, Body}.
