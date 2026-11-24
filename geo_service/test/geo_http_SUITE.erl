-module(geo_http_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, groups/0, init_per_suite/1, end_per_suite/1, init_per_group/2, end_per_group/2]).
-export([
    health_get/1,
    health_head/1,
    health_method_not_allowed/1,
    unknown_paths_404/1,
    ready_unavailable_without_mongo/1,
    listener_supervised_and_restarts/1,
    bad_config_fails_start_without_leaking_value/1
]).
%% logger handler callback
-export([log/2]).

-define(SENTINEL, "secret-sentinel-8o8o").
%% 20 characters: below the 32-character minimum of the JWT secret.
-define(JWT_SENTINEL, "jwt-sentinel-1234567").

all() -> [{group, running}, bad_config_fails_start_without_leaking_value].

groups() ->
    [
        {running, [], [
            health_get,
            health_head,
            health_method_not_allowed,
            unknown_paths_404,
            ready_unavailable_without_mongo,
            listener_supervised_and_restarts
        ]}
    ].

init_per_suite(Config) ->
    {ok, _} = application:ensure_all_started(inets),
    %% Nothing listens on port 1: this suite runs without MongoDB (readiness is 503).
    set_mongo("127.0.0.1:1", ""),
    set_session(),
    Config.

end_per_suite(_Config) ->
    application:stop(inets),
    ok.

init_per_group(running, Config) ->
    set_listen("127.0.0.1", "0"),
    {ok, _} = application:ensure_all_started(geo_service),
    Config.

end_per_group(running, _Config) ->
    application:stop(geo_service),
    ok.

%%% Cases --------------------------------------------------------------------------------

health_get(_Config) ->
    {ok, {{_, 200, _}, Headers, Body}} = request(get, "/api/health"),
    "{\"status\":\"ok\"}" = Body,
    "application/json" = proplists:get_value("content-type", Headers),
    "no-store" = proplists:get_value("cache-control", Headers),
    "nosniff" = proplists:get_value("x-content-type-options", Headers).

health_head(_Config) ->
    {ok, {{_, 200, _}, _Headers, Body}} = request(head, "/api/health"),
    "" = Body.

health_method_not_allowed(_Config) ->
    lists:foreach(
        fun(Method) ->
            {ok, {{_, 405, _}, Headers, Body}} = request(Method, "/api/health"),
            "GET, HEAD" = proplists:get_value("allow", Headers),
            #{<<"error">> := <<"method_not_allowed">>} = json:decode(list_to_binary(Body))
        end,
        [post, delete]
    ).

unknown_paths_404(_Config) ->
    lists:foreach(
        fun(Path) ->
            {ok, {{_, 404, _}, _Headers, Body}} = request(get, Path),
            #{<<"error">> := <<"not_found">>} = json:decode(list_to_binary(Body))
        end,
        ["/nope", "/api/health/x"]
    ).

ready_unavailable_without_mongo(_Config) ->
    Expected = "{\"status\":\"unavailable\",\"mongo\":\"down\"}",
    {ok, {{_, 503, _}, Headers, Expected}} = request(get, "/api/ready"),
    "application/json" = proplists:get_value("content-type", Headers),
    "no-store" = proplists:get_value("cache-control", Headers),
    {ok, {{_, 503, _}, _, ""}} = request(head, "/api/ready"),
    {ok, {{_, 405, _}, PostHeaders, PostBody}} = request(post, "/api/ready"),
    "GET, HEAD" = proplists:get_value("allow", PostHeaders),
    #{<<"error">> := <<"method_not_allowed">>} = json:decode(list_to_binary(PostBody)),
    %% Liveness is independent of Mongo.
    {ok, {{_, 200, _}, _, "{\"status\":\"ok\"}"}} = request(get, "/api/health").

listener_supervised_and_restarts(_Config) ->
    Ids = [Id || {Id, _, _, _} <- supervisor:which_children(geo_service_sup)],
    true = lists:member(geo_mongo_sup, Ids),
    true = lists:member({ranch_embedded_sup, geo_http}, Ids) orelse lists:member(geo_http, Ids),
    %% The driver is included, never started: its processes live under geo_mongo_sup.
    false = lists:keymember(mongodb, 1, application:which_applications()),
    lists:foreach(
        fun(Name) -> true = is_pid(whereis(Name)) end,
        [mc_pool_sup, mongo_id_server, mc_worker_pid_info, geo_mongo_topology, geo_mongo_probe]
    ),
    MongoIds = [Id || {Id, _, _, _} <- supervisor:which_children(geo_mongo_sup)],
    [
        mongo_id_server,
        mc_worker_pid_info,
        geo_mongo_pool_sup,
        geo_mongo,
        geo_mongo_probe
    ] = lists:reverse(MongoIds),
    Pid = listener_pid(),
    true = is_pid(Pid),
    true = erlang:is_process_alive(Pid),
    exit(Pid, kill),
    NewPid = wait_for_new_listener(Pid, 50),
    true = is_pid(NewPid),
    {ok, {{_, 200, _}, _, "{\"status\":\"ok\"}"}} = request(get, "/api/health").

bad_config_fails_start_without_leaking_value(_Config) ->
    %% The running group already stopped the app; stop is a no-op then.
    _ = application:stop(geo_service),
    set_listen("127.0.0.1", ?SENTINEL),
    HandlerId = geo_http_SUITE_capture,
    ok = logger:add_handler(HandlerId, ?MODULE, #{config => #{test_pid => self()}}),
    Result =
        try
            application:start(geo_service)
        after
            logger:remove_handler(HandlerId)
        end,
    {error, Reason} = Result,
    true = contains(Reason, {bad_config, http_port}),
    Events = collect_events([]),
    true = lists:any(fun is_bad_config_event/1, Events),
    lists:foreach(
        fun(Event) ->
            Text = lists:flatten(io_lib:format("~0p", [Event])),
            nomatch = string:find(Text, ?SENTINEL)
        end,
        Events
    ),
    false = contains(Reason, ?SENTINEL),
    %% An invalid mongo setting is also a fail-fast bad_config naming the key.
    set_listen("127.0.0.1", "0"),
    set_mongo("", ""),
    {error, Reason2} = application:start(geo_service),
    true = contains(Reason2, {bad_config, mongo_hosts}),
    set_mongo("127.0.0.1:1", ""),
    %% A bad session setting is a fail-fast bad_config naming the key, and the value (here a
    %% 20-character sentinel, too short for the JWT secret) never reaches the logs.
    set_session(),
    application:set_env(geo_service, jwt_secret, ?JWT_SENTINEL),
    ok = logger:add_handler(HandlerId, ?MODULE, #{config => #{test_pid => self()}}),
    Result3 =
        try
            application:start(geo_service)
        after
            logger:remove_handler(HandlerId)
        end,
    {error, Reason3} = Result3,
    true = contains(Reason3, {bad_config, jwt_secret}),
    false = contains(Reason3, ?JWT_SENTINEL),
    Events3 = collect_events([]),
    true = lists:any(fun is_jwt_config_event/1, Events3),
    lists:foreach(
        fun(Event) ->
            Text = lists:flatten(io_lib:format("~0p", [Event])),
            nomatch = string:find(Text, ?JWT_SENTINEL)
        end,
        Events3
    ),
    set_session().

%%% logger handler -----------------------------------------------------------------------

log(Event, #{config := #{test_pid := Pid}}) ->
    Pid ! {log_event, Event},
    ok.

%%% Helpers ------------------------------------------------------------------------------

set_listen(Ip, Port) ->
    application:set_env(geo_service, http_ip, Ip),
    application:set_env(geo_service, http_port, Port).

set_mongo(Hosts, Password) ->
    lists:foreach(
        fun({K, V}) -> application:set_env(geo_service, K, V) end,
        [
            {mongo_hosts, Hosts},
            {mongo_db, "geo_ct"},
            {mongo_replica_set, ""},
            {mongo_user, ""},
            {mongo_password, Password},
            {mongo_auth_source, ""},
            {mongo_tls, ""},
            {mongo_tls_ca_file, ""},
            {mongo_pool_size, ""}
        ]
    ).

%% Valid session settings; nothing listens on the admin URL (port 1).
set_session() ->
    lists:foreach(
        fun({K, V}) -> application:set_env(geo_service, K, V) end,
        [
            {jwt_secret, "http-suite-jwt-secret-0123456789-abcdefgh"},
            {xmpp_domain, "chaterl.localhost"},
            {xmpp_room_owner, "nearby-rooms"},
            {mim_admin_url, "http://127.0.0.1:1/api/graphql"},
            {mim_admin_user, "admin"},
            {mim_admin_password, "http-suite-admin-password"}
        ]
    ).

request(Method, Path) ->
    Port = ranch:get_port(geo_http),
    Url = "http://127.0.0.1:" ++ integer_to_list(Port) ++ Path,
    Req =
        case Method of
            M when M =:= get; M =:= head -> {Url, []};
            _ -> {Url, [], "application/json", "{}"}
        end,
    httpc:request(Method, Req, [], []).

listener_pid() ->
    case
        lists:keyfind({ranch_embedded_sup, geo_http}, 1, supervisor:which_children(geo_service_sup))
    of
        {_, Pid, supervisor, _} -> Pid;
        false -> undefined
    end.

wait_for_new_listener(_Old, 0) ->
    ct:fail(listener_not_restarted);
wait_for_new_listener(Old, N) ->
    case listener_pid() of
        Pid when is_pid(Pid), Pid =/= Old ->
            Pid;
        _ ->
            timer:sleep(100),
            wait_for_new_listener(Old, N - 1)
    end.

collect_events(Acc) ->
    receive
        {log_event, Event} -> collect_events([Event | Acc])
    after 200 -> lists:reverse(Acc)
    end.

is_bad_config_event(#{msg := {report, #{event := bad_config, key := http_port}}}) -> true;
is_bad_config_event(_) -> false.

is_jwt_config_event(#{msg := {report, #{event := bad_config, key := jwt_secret}}}) -> true;
is_jwt_config_event(_) -> false.

%% True if the printed form of Sub occurs in the printed form of Term.
contains(Term, Sub) ->
    Text = lists:flatten(io_lib:format("~0p", [Term])),
    Needle = lists:flatten(io_lib:format("~0p", [Sub])),
    string:find(Text, Needle) =/= nomatch.
