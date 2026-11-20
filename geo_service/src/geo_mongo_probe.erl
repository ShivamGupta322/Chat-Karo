%% Readiness probe: pings Mongo every few seconds and publishes up/down in a named ETS table
%% (geo_mongo_status) that geo_mongo:ready/0 and /api/ready read without calling this process.
%% On the same tick it reaps heartbeat connections the driver abandoned (ADR-016 quirk 10).
-module(geo_mongo_probe).
-behaviour(gen_server).

-export([start_link/0]).
-export([init/1, handle_call/3, handle_cast/2, handle_info/2, handle_continue/2]).

-define(TABLE, geo_mongo_status).
-define(INTERVAL_MS, 5000).
%% Safety argument for the reaper: a live heartbeat worker (mc_monitor:check/2) lives at most
%% 2 x connectTimeoutMS (its own connect plus the protocol-detection connect in
%% mc_worker_pid_info:detect_protocol_type/2) + 2 x the call timeout (detection recv and hello),
%% about 20 s with geo_mongo connectTimeoutMS 5000 and mc_worker_call_timeout 5000. Age counts
%% from first-seen (never earlier than creation), so 30 s leaves at least 10 s margin.
%% REAP_MIN_AGE_MS must stay above that sum if either timeout is raised.
%% "The monitor is idle" is deliberately not the test: it races with a new check, and killing
%% that worker would make mc_server tear the pool down (update_unknown).
-define(REAP_MIN_AGE_MS, 30000).

%% unknown only until the first probe, so that the first result is always logged.
-type status() :: up | down | unknown.
-type state() :: #{status := status(), seen := geo_mongo_reaper:seen()}.

-spec start_link() -> gen_server:start_ret().
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

-spec init([]) -> {ok, state(), {continue, probe}}.
init([]) ->
    ?TABLE = ets:new(?TABLE, [named_table, set, protected, {read_concurrency, true}]),
    true = ets:insert(?TABLE, {mongo, down}),
    {ok, #{status => unknown, seen => #{}}, {continue, probe}}.

-spec handle_continue(probe, state()) -> {noreply, state()}.
handle_continue(probe, State) ->
    {noreply, probe(State)}.

-spec handle_call(term(), gen_server:from(), state()) -> {reply, {error, unknown_call}, state()}.
handle_call(_Request, _From, State) ->
    {reply, {error, unknown_call}, State}.

-spec handle_cast(term(), state()) -> {noreply, state()}.
handle_cast(_Msg, State) ->
    {noreply, State}.

%% Blocking in handle_info is fine here: nothing calls this process (readers use ETS), and the
%% ping is bounded by the driver call timeout.
-spec handle_info(term(), state()) -> {noreply, state()}.
handle_info(probe, State) ->
    {noreply, probe(State)};
handle_info(_Info, State) ->
    {noreply, State}.

-spec probe(state()) -> state().
probe(#{status := Old, seen := Seen} = State) ->
    New =
        case geo_mongo:ping() of
            ok -> up;
            {error, _} -> down
        end,
    true = ets:insert(?TABLE, {mongo, New}),
    log_transition(Old, New),
    NewSeen = reap(Seen),
    _ = erlang:send_after(?INTERVAL_MS, self(), probe),
    State#{status := New, seen := NewSeen}.

%% Stops heartbeat workers the monitor abandoned, via the driver's public disconnect (the
%% monitor ignores the normal exit of a non-server pid, so nothing else reacts to it).
-spec reap(geo_mongo_reaper:seen()) -> geo_mongo_reaper:seen().
reap(Seen) ->
    Now = erlang:monotonic_time(millisecond),
    {ToReap, NewSeen} =
        geo_mongo_reaper:select(geo_mongo_reaper:candidates(), Seen, Now, ?REAP_MIN_AGE_MS),
    lists:foreach(fun disconnect/1, ToReap),
    case length(ToReap) of
        0 -> ok;
        N -> logger:notice(#{event => mongo_heartbeat_reaped, count => N})
    end,
    NewSeen.

-spec disconnect(pid()) -> ok.
disconnect(Pid) ->
    %% The worker may have exited since it was selected.
    try
        mc_worker_api:disconnect(Pid)
    catch
        _:_ -> ok
    end.

%% Log on a transition only, without any reason (driver reasons can carry data).
-spec log_transition(status(), up | down) -> ok.
log_transition(Same, Same) -> ok;
log_transition(_, up) -> logger:info(#{event => mongo_ready});
log_transition(_, down) -> logger:warning(#{event => mongo_unavailable}).
