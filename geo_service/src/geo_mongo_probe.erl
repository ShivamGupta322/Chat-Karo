%% Readiness probe: pings Mongo every few seconds and publishes up/down in a named ETS table
%% (geo_mongo_status) that geo_mongo:ready/0 and /api/ready read without calling this process.
-module(geo_mongo_probe).
-behaviour(gen_server).

-export([start_link/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, handle_continue/2]).

-define(TABLE, geo_mongo_status).
-define(INTERVAL_MS, 5000).

%% unknown only until the first probe, so that the first result is always logged.
-type status() :: up | down | unknown.

-spec start_link() -> gen_server:start_ret().
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

-spec init([]) -> {ok, unknown, {continue, probe}}.
init([]) ->
    ?TABLE = ets:new(?TABLE, [named_table, set, protected, {read_concurrency, true}]),
    true = ets:insert(?TABLE, {mongo, down}),
    {ok, unknown, {continue, probe}}.

-spec handle_continue(probe, status()) -> {noreply, status()}.
handle_continue(probe, Status) ->
    {noreply, probe(Status)}.

-spec handle_call(term(), gen_server:from(), status()) -> {reply, {error, unknown_call}, status()}.
handle_call(_Request, _From, Status) ->
    {reply, {error, unknown_call}, Status}.

-spec handle_cast(term(), status()) -> {noreply, status()}.
handle_cast(_Msg, Status) ->
    {noreply, Status}.

%% Blocking in handle_info is fine here: nothing calls this process (readers use ETS), and the
%% ping is bounded by the driver call timeout.
-spec handle_info(term(), status()) -> {noreply, status()}.
handle_info(probe, Status) ->
    {noreply, probe(Status)};
handle_info(_Info, Status) ->
    {noreply, Status}.

-spec probe(status()) -> up | down.
probe(Old) ->
    New =
        case geo_mongo:ping() of
            ok -> up;
            {error, _} -> down
        end,
    true = ets:insert(?TABLE, {mongo, New}),
    log_transition(Old, New),
    _ = erlang:send_after(?INTERVAL_MS, self(), probe),
    New.

%% Log on a transition only, without any reason (driver reasons can carry data).
-spec log_transition(status(), up | down) -> ok.
log_transition(Same, Same) -> ok;
log_transition(_, up) -> logger:info(#{event => mongo_ready});
log_transition(_, down) -> logger:warning(#{event => mongo_unavailable}).
