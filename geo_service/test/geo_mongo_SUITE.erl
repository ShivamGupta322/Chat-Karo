%% Integration tests against a real MongoDB (the dev one from docker-compose by default).
%% Uses the database chaterl_ct only, never the application database.
%% Needs Mongo reachable at GEO_CT_MONGO_HOSTS (default 127.0.0.1:27018); the whole suite is
%% skipped, loudly, when it is not.
-module(geo_mongo_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, groups/0, init_per_suite/1, end_per_suite/1]).
-export([
    init_indexes_drift_guard/1,
    ready_200/1,
    touch_room_create_then_update/1,
    same_cell_two_points_one_doc/1,
    get_room_missing/1,
    concurrent_touch_same_new_cell/1,
    topology_restart/1,
    pool_kill_does_not_leak/1,
    degraded_group/1,
    proxy_outage_no_leak_no_flood/1,
    password_never_logged/1
]).
%% logger handler callback
-export([log/2]).

-define(DB, "chaterl_ct").
-define(SENTINEL, "ct-sentinel-7q7q").

all() ->
    [
        init_indexes_drift_guard,
        {group, live},
        degraded_group,
        proxy_outage_no_leak_no_flood,
        password_never_logged
    ].

groups() ->
    [
        {live, [], [
            ready_200,
            touch_room_create_then_update,
            same_cell_two_points_one_doc,
            get_room_missing,
            concurrent_touch_same_new_cell,
            topology_restart,
            pool_kill_does_not_leak
        ]}
    ].

init_per_suite(Config) ->
    Hosts = hosts(),
    case reachable(Hosts) of
        false ->
            {skip, "MongoDB not reachable at " ++ Hosts ++ " (set GEO_CT_MONGO_HOSTS)"};
        true ->
            start_app(Hosts, "", ""),
            wait_ready(10000),
            {true, _} = run_command(#{<<"dropDatabase">> => 1}),
            %% The same two indexes as infra/mongo/init-indexes.js (init_indexes_drift_guard
            %% checks that file still declares them). The code never creates indexes itself.
            {true, #{<<"ok">> := Ok}} = run_command(#{
                <<"createIndexes">> => <<"rooms">>,
                <<"indexes">> => [
                    #{
                        <<"key">> => #{<<"center">> => <<"2dsphere">>},
                        <<"name">> => <<"center_2dsphere">>
                    },
                    #{
                        <<"key">> => #{<<"lastActiveAt">> => 1},
                        <<"name">> => <<"lastActiveAt_ttl">>,
                        <<"expireAfterSeconds">> => 7 * 24 * 3600
                    }
                ]
            }),
            true = (Ok == 1),
            Config
    end.

end_per_suite(_Config) ->
    ensure_live(),
    _ = run_command(#{<<"dropDatabase">> => 1}),
    application:stop(geo_service),
    ok.

%%% Cases --------------------------------------------------------------------------------

init_indexes_drift_guard(_Config) ->
    Path = filename:join([filename:dirname(?FILE), "..", "..", "infra", "mongo", "init-indexes.js"]),
    {ok, Bin} = file:read_file(Path),
    Text = binary_to_list(Bin),
    true = string:find(Text, "center_2dsphere") =/= nomatch,
    true = string:find(Text, "lastActiveAt_ttl") =/= nomatch,
    true = string:find(Text, "expireAfterSeconds: 7 * 24 * 3600") =/= nomatch.

ready_200(_Config) ->
    {ok, {{_, 200, _}, _, Body}} = httpc_get("/api/ready"),
    "{\"status\":\"ready\",\"mongo\":\"up\"}" = Body,
    true = geo_mongo:ready().

touch_room_create_then_update(_Config) ->
    {ok, Block} = geo_cell:from_point(57.64911, 10.40744, block),
    {ok, Neighbourhood} = geo_cell:from_point(57.64911, 10.40744, neighbourhood),
    {ok, Area} = geo_cell:from_point(57.64911, 10.40744, area),
    {ok, Zs} = geo_cell:parse_cell(7, <<"zzzzzzz">>),
    {ok, Xb} = geo_cell:parse_cell(7, <<"xbpbpbp">>),
    Now1 = os:timestamp(),
    {ok, created} = geo_store:touch_room(Block, Now1),
    lists:foreach(
        fun(Cell) -> {ok, created} = geo_store:touch_room(Cell, Now1) end,
        [Neighbourhood, Area, Zs, Xb]
    ),
    timer:sleep(2000),
    Now2 = os:timestamp(),
    {ok, updated} = geo_store:touch_room(Block, Now2),
    {ok, Room} = geo_store:get_room(Block),
    #{
        id := <<"g7_u4pruyd">>,
        precision := 7,
        geohash := <<"u4pruyd">>,
        center := Center,
        created_at := CreatedAt,
        last_active_at := LastActiveAt
    } = Room,
    Center = geo_cell:centre_geojson(Block),
    true = ms(CreatedAt) =:= ms(Now1),
    true = ms(LastActiveAt) =:= ms(Now2),
    true = ms(LastActiveAt) - ms(CreatedAt) >= 1900,
    lists:foreach(
        fun(Cell) ->
            #{geohash := Hash} = Cell,
            Id = geo_cell:room_id(Cell),
            {ok, Doc} = geo_mongo:find_one(<<"rooms">>, #{<<"_id">> => Id}, #{}),
            %% Exactly these six keys: nothing else (no raw coordinates) is stored.
            [
                <<"_id">>,
                <<"center">>,
                <<"createdAt">>,
                <<"geohash">>,
                <<"lastActiveAt">>,
                <<"precision">>
            ] =
                lists:sort(maps:keys(Doc)),
            Id = maps:get(<<"_id">>, Doc),
            Hash = maps:get(<<"geohash">>, Doc),
            Precision = maps:get(precision, Cell),
            Precision = maps:get(<<"precision">>, Doc),
            Centre = geo_cell:centre_geojson(Cell),
            Centre = maps:get(<<"center">>, Doc)
        end,
        [Block, Neighbourhood, Area, Zs, Xb]
    ).

same_cell_two_points_one_doc(_Config) ->
    {ok, A} = geo_cell:from_point(48.85837, 2.29448, block),
    {ok, B} = geo_cell:from_point(48.85839, 2.29451, block),
    A = B,
    {ok, created} = geo_store:touch_room(A),
    {ok, updated} = geo_store:touch_room(B),
    1 = count_rooms(geo_cell:room_id(A)).

get_room_missing(_Config) ->
    {ok, Cell} = geo_cell:parse_cell(7, <<"s000000">>),
    not_found = geo_store:get_room(Cell).

concurrent_touch_same_new_cell(_Config) ->
    {ok, Cell} = geo_cell:parse_cell(7, <<"ezs42e5">>),
    Self = self(),
    N = 20,
    lists:foreach(
        fun(I) -> spawn_link(fun() -> Self ! {touched, I, geo_store:touch_room(Cell)} end) end,
        lists:seq(1, N)
    ),
    Results = [
        receive
            {touched, I, R} -> R
        after 15000 -> ct:fail({no_result, I})
        end
     || I <- lists:seq(1, N)
    ],
    1 = length([R || R = {ok, created} <- Results]),
    19 = length([R || R = {ok, updated} <- Results]),
    N = length([R || {ok, _} = R <- Results]),
    1 = count_rooms(geo_cell:room_id(Cell)).

topology_restart(_Config) ->
    Old = whereis(geo_mongo_topology),
    true = is_pid(Old),
    exit(Old, kill),
    wait_until(
        fun() ->
            New = whereis(geo_mongo_topology),
            is_pid(New) andalso New =/= Old andalso geo_mongo:ready()
        end,
        15000
    ),
    {ok, Cell} = geo_cell:parse_cell(7, <<"s000001">>),
    {ok, created} = geo_store:touch_room(Cell).

%% Regression for the orphan-pool leak (ADR-016 quirk 9): killing the pool must leave exactly
%% one pool under mc_pool_sup once mc_server has replaced it (a transient child spec would
%% restart the abandoned one as well).
pool_kill_does_not_leak(_Config) ->
    [{_, Old, _, _}] = supervisor:which_children(mc_pool_sup),
    true = is_pid(Old),
    exit(Old, kill),
    {ok, Cell} = geo_cell:parse_cell(7, <<"s000003">>),
    wait_until(
        fun() ->
            geo_mongo:ready() andalso
                (case geo_store:touch_room(Cell) of
                    {ok, _} -> true;
                    {error, _} -> false
                end)
        end,
        20000
    ),
    timer:sleep(2000),
    [{_, New, _, _}] = supervisor:which_children(mc_pool_sup),
    true = New =/= Old,
    true = is_process_alive(New),
    false = is_process_alive(Old).

degraded_group(_Config) ->
    try
        application:stop(geo_service),
        start_app("127.0.0.1:1", "", ""),
        true = is_pid(whereis(geo_service_sup)),
        {ok, Cell} = geo_cell:parse_cell(7, <<"s000002">>),
        {Micros, Result} = timer:tc(fun() -> geo_store:touch_room(Cell) end),
        {error, mongo_unavailable} = Result,
        true = Micros < 4000000,
        false = geo_mongo:ready(),
        {ok, {{_, 503, _}, _, _}} = httpc_get("/api/ready")
    after
        restore_live()
    end.

%% Mongo goes away behind a TCP proxy and comes back: no leaked pool (connections to Mongo
%% stay bounded) and no log flood while it is down.
proxy_outage_no_leak_no_flood(_Config) ->
    HandlerId = geo_mongo_SUITE_proxy_capture,
    PoolSize = 5,
    {Proxy0, Port} = proxy_start(0),
    try
        application:stop(geo_service),
        ok = logger:add_handler(HandlerId, ?MODULE, #{config => #{test_pid => self()}}),
        start_app("127.0.0.1:" ++ integer_to_list(Port), "", ""),
        wait_ready(20000),
        _ = drain_events([]),
        ok = proxy_stop(Proxy0),
        wait_until(fun() -> not geo_mongo:ready() end, 30000),
        timer:sleep(5000),
        DownEvents = drain_events([]),
        ct:pal("~b log events while Mongo was down", [length(DownEvents)]),
        true = length(DownEvents) =< 40,
        {Proxy1, Port} = proxy_start(Port),
        try
            wait_ready(40000),
            timer:sleep(2000),
            1 = length(supervisor:which_children(mc_pool_sup)),
            Upstream = proxy_connections(Proxy1),
            ct:pal("~b live upstream sockets, pool_size ~b", [Upstream, PoolSize]),
            true = Upstream =< PoolSize + 1
        after
            proxy_stop(Proxy1)
        end
    after
        logger:remove_handler(HandlerId),
        _ = proxy_stop(Proxy0),
        restore_live()
    end.

password_never_logged(_Config) ->
    HandlerId = geo_mongo_SUITE_capture,
    try
        application:stop(geo_service),
        ok = logger:add_handler(HandlerId, ?MODULE, #{config => #{test_pid => self()}}),
        start_app(hosts(), "ct_ghost", ?SENTINEL),
        timer:sleep(8000),
        false = geo_mongo:ready(),
        Topology = whereis(geo_mongo_topology),
        true = is_pid(Topology),
        exit(Topology, kill),
        timer:sleep(3000)
    after
        logger:remove_handler(HandlerId),
        restore_live()
    end,
    Events = collect_events([]),
    ct:pal("captured ~b log events", [length(Events)]),
    Texts = [lists:flatten(io_lib:format("~0p", [E])) || E <- Events],
    Formatted = [
        lists:flatten(io_lib:format("~ts", [logger_formatter:format(E, #{})]))
     || E <- Events
    ],
    lists:foreach(
        fun(Text) -> nomatch = string:find(Text, ?SENTINEL) end,
        Texts ++ Formatted
    ),
    FromDriver = [
        T
     || T <- Texts,
        lists:any(
            fun(Marker) -> string:find(T, Marker) =/= nomatch end,
            ["mc_topology", "mc_worker", "mc_server", "mongoc", "poolboy"]
        )
    ],
    true = FromDriver =/= [],
    Masked = length([T || T <- Texts, string:find(T, "[REDACTED]") =/= nomatch]),
    true = Masked >= 1,
    ct:pal("~b of ~b events were redacted, ~b came from the driver", [
        Masked, length(Texts), length(FromDriver)
    ]).

%%% logger handler -----------------------------------------------------------------------

log(Event, #{config := #{test_pid := Pid}}) ->
    Pid ! {log_event, Event},
    ok.

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

start_app(Hosts, User, Password) ->
    lists:foreach(
        fun({K, V}) -> application:set_env(geo_service, K, V) end,
        [
            {http_ip, "127.0.0.1"},
            {http_port, "0"},
            {mongo_hosts, Hosts},
            {mongo_db, ?DB},
            {mongo_replica_set, ""},
            {mongo_user, User},
            {mongo_password, Password},
            {mongo_auth_source, ""},
            {mongo_tls, ""},
            {mongo_tls_ca_file, ""},
            {mongo_pool_size, ""}
        ]
    ),
    {ok, _} = application:ensure_all_started(geo_service),
    {ok, _} = application:ensure_all_started(inets),
    ok.

restore_live() ->
    application:stop(geo_service),
    start_app(hosts(), "", ""),
    wait_ready(15000).

ensure_live() ->
    case geo_mongo:ready() of
        true -> ok;
        false -> restore_live()
    end.

wait_ready(Timeout) ->
    wait_until(fun geo_mongo:ready/0, Timeout).

wait_until(Fun, Timeout) when Timeout =< 0 ->
    case Fun() of
        true -> ok;
        false -> ct:fail(timeout_waiting)
    end;
wait_until(Fun, Timeout) ->
    case Fun() of
        true ->
            ok;
        false ->
            timer:sleep(200),
            wait_until(Fun, Timeout - 200)
    end.

run_command(Command) ->
    mongoc:transaction(
        geo_mongo_topology,
        fun(#{pool := Worker}) -> mc_worker_api:command(Worker, Command) end,
        #{},
        10000
    ).

count_rooms(Id) ->
    {true, #{<<"n">> := N}} = run_command(#{
        <<"count">> => <<"rooms">>, <<"query">> => #{<<"_id">> => Id}
    }),
    N.

%% Mongo dates have millisecond precision.
ms({Mega, Sec, Micro}) ->
    Mega * 1000000000 + Sec * 1000 + Micro div 1000.

httpc_get(Path) ->
    Port = ranch:get_port(geo_http),
    httpc:request(get, {"http://127.0.0.1:" ++ integer_to_list(Port) ++ Path, []}, [], []).

collect_events(Acc) ->
    receive
        {log_event, Event} -> collect_events([Event | Acc])
    after 200 -> lists:reverse(Acc)
    end.

drain_events(Acc) ->
    receive
        {log_event, Event} -> drain_events([Event | Acc])
    after 0 -> lists:reverse(Acc)
    end.

%%% TCP proxy to the real Mongo ------------------------------------------------------------
%% A controller process owns the listener and tracks one relay per forwarded connection; each
%% relay owns the client socket and its upstream socket, so killing it closes both.

proxy_start(Port) ->
    Parent = self(),
    Pid = spawn(fun() -> proxy_init(Parent, Port) end),
    receive
        {proxy_up, Pid, ActualPort} -> {Pid, ActualPort}
    after 5000 -> ct:fail(proxy_start_timeout)
    end.

proxy_init(Parent, Port) ->
    {ok, Listen} = gen_tcp:listen(Port, [
        binary, {active, false}, {reuseaddr, true}, {ip, {127, 0, 0, 1}}
    ]),
    {ok, ActualPort} = inet:port(Listen),
    Ctl = self(),
    spawn(fun() -> proxy_accept(Listen, Ctl) end),
    Parent ! {proxy_up, self(), ActualPort},
    proxy_loop(Listen, []).

proxy_accept(Listen, Ctl) ->
    case gen_tcp:accept(Listen) of
        {ok, Down} ->
            Relay = spawn(fun() ->
                receive
                    go -> proxy_relay(Down)
                end
            end),
            ok = gen_tcp:controlling_process(Down, Relay),
            Ctl ! {relay, Relay},
            Relay ! go,
            proxy_accept(Listen, Ctl);
        {error, _} ->
            ok
    end.

proxy_relay(Down) ->
    {Host, Port} = upstream(),
    case gen_tcp:connect(Host, Port, [binary, {active, true}]) of
        {ok, Up} ->
            ok = inet:setopts(Down, [{active, true}]),
            proxy_pipe(Down, Up);
        {error, _} ->
            gen_tcp:close(Down)
    end.

proxy_pipe(Down, Up) ->
    receive
        {tcp, Down, Data} ->
            _ = gen_tcp:send(Up, Data),
            proxy_pipe(Down, Up);
        {tcp, Up, Data} ->
            _ = gen_tcp:send(Down, Data),
            proxy_pipe(Down, Up);
        {tcp_closed, _} ->
            gen_tcp:close(Down),
            gen_tcp:close(Up);
        {tcp_error, _, _} ->
            gen_tcp:close(Down),
            gen_tcp:close(Up)
    end.

proxy_loop(Listen, Relays) ->
    receive
        {relay, Relay} ->
            proxy_loop(Listen, [Relay | Relays]);
        {count, From} ->
            From ! {proxy_count, self(), length([R || R <- Relays, is_process_alive(R)])},
            proxy_loop(Listen, Relays);
        {stop, From} ->
            gen_tcp:close(Listen),
            lists:foreach(fun(R) -> exit(R, kill) end, Relays),
            From ! {proxy_stopped, self()}
    end.

proxy_stop(Pid) ->
    case is_process_alive(Pid) of
        false ->
            ok;
        true ->
            Pid ! {stop, self()},
            receive
                {proxy_stopped, Pid} -> ok
            after 5000 -> ct:fail(proxy_stop_timeout)
            end
    end.

proxy_connections(Pid) ->
    Pid ! {count, self()},
    receive
        {proxy_count, Pid, N} -> N
    after 5000 -> ct:fail(proxy_count_timeout)
    end.

upstream() ->
    [Host, PortStr | _] = string:split(hosts(), ":"),
    {Host, list_to_integer(PortStr)}.
