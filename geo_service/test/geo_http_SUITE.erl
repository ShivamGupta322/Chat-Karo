-module(geo_http_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([all/0, groups/0, init_per_suite/1, end_per_suite/1, init_per_group/2, end_per_group/2]).
-export([
    health_get/1,
    health_head/1,
    health_method_not_allowed/1,
    unknown_paths_404/1,
    listener_supervised_and_restarts/1,
    bad_config_fails_start_without_leaking_value/1
]).
%% logger handler callback
-export([log/2]).

-define(SENTINEL, "secret-sentinel-8o8o").

all() -> [{group, running}, bad_config_fails_start_without_leaking_value].

groups() ->
    [
        {running, [], [
            health_get,
            health_head,
            health_method_not_allowed,
            unknown_paths_404,
            listener_supervised_and_restarts
        ]}
    ].

init_per_suite(Config) ->
    {ok, _} = application:ensure_all_started(inets),
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

listener_supervised_and_restarts(_Config) ->
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
    false = contains(Reason, ?SENTINEL).

%%% logger handler -----------------------------------------------------------------------

log(Event, #{config := #{test_pid := Pid}}) ->
    Pid ! {log_event, Event},
    ok.

%%% Helpers ------------------------------------------------------------------------------

set_listen(Ip, Port) ->
    application:set_env(geo_service, http_ip, Ip),
    application:set_env(geo_service, http_port, Port).

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

%% True if the printed form of Sub occurs in the printed form of Term.
contains(Term, Sub) ->
    Text = lists:flatten(io_lib:format("~0p", [Term])),
    Needle = lists:flatten(io_lib:format("~0p", [Sub])),
    string:find(Text, Needle) =/= nomatch.
