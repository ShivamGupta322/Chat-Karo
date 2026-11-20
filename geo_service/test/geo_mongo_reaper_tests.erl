-module(geo_mongo_reaper_tests).

-include_lib("eunit/include/eunit.hrl").

%% Spawn target for fake/2: proc_lib:spawn/3 gives the {proc_lib,init_p,5} initial call that the
%% driver processes (started with proc_lib:start_link) have.
-export([fake_body/3]).

-define(MIN, 30000).
-define(NOW, 1000000).

%%% select/4 -----------------------------------------------------------------------------

select_test_() ->
    {setup, fun() -> [spawn(fun() -> receive
                after infinity -> ok
                end end) || _ <- lists:seq(1, 3)] end,
        fun(Pids) -> [exit(P, kill) || P <- Pids] end, fun(Pids) ->
            [A, B, C] = Pids,
            [
                {"a new pid is recorded, not reaped", fun() ->
                    ?assertEqual({[], #{A => ?NOW}}, geo_mongo_reaper:select([A], #{}, ?NOW, ?MIN))
                end},
                {"MinAge - 1 ms is kept with its first-seen time", fun() ->
                    Seen = #{A => ?NOW - ?MIN + 1},
                    ?assertEqual({[], Seen}, geo_mongo_reaper:select([A], Seen, ?NOW, ?MIN))
                end},
                {"exactly MinAge is reaped and forgotten", fun() ->
                    ?assertEqual(
                        {[A], #{}},
                        geo_mongo_reaper:select([A], #{A => ?NOW - ?MIN}, ?NOW, ?MIN)
                    )
                end},
                {"MinAge + 1 ms is reaped and forgotten", fun() ->
                    ?assertEqual(
                        {[A], #{}},
                        geo_mongo_reaper:select([A], #{A => ?NOW - ?MIN - 1}, ?NOW, ?MIN)
                    )
                end},
                {"a pid that is no longer a candidate is dropped", fun() ->
                    ?assertEqual(
                        {[], #{B => ?NOW}},
                        geo_mongo_reaper:select([B], #{A => ?NOW - 5}, ?NOW, ?MIN)
                    )
                end},
                {"no candidates empties the seen map", fun() ->
                    ?assertEqual({[], #{}}, geo_mongo_reaper:select([], #{A => 1}, ?NOW, ?MIN))
                end},
                {"mixed ages", fun() ->
                    Seen = #{A => ?NOW - ?MIN - 500, B => ?NOW - 10},
                    {Reap, NewSeen} = geo_mongo_reaper:select([A, B, C], Seen, ?NOW, ?MIN),
                    ?assertEqual([A], Reap),
                    ?assertEqual(#{B => ?NOW - 10, C => ?NOW}, NewSeen)
                end},
                {"duplicate candidates are handled once", fun() ->
                    ?assertEqual(
                        {[A], #{}},
                        geo_mongo_reaper:select([A, A], #{A => 0}, ?NOW, ?MIN)
                    )
                end}
            ]
        end}.

%%% candidates/0 -------------------------------------------------------------------------
%% Real driver processes are not started here. Fake processes get the '$initial_call' that
%% proc_lib sets for the real ones (and are spawned with proc_lib so their initial_call is
%% {proc_lib,init_p,5} like the real ones), so this exercises the same lookup.

candidates_test_() ->
    {setup, fun() -> ok end, fun(_) -> ok end, fun() ->
        Worker = fake({mc_worker, init, 1}, []),
        Other = fake({some_other, init, 1}, []),
        Plain = spawn(fun() -> receive
            after infinity -> ok
            end end),
        _Monitor = fake({mc_monitor, init, 1}, [Worker, Other, Plain]),
        %% A worker linked to a non-monitor (like a pool worker) must not be a candidate.
        PoolWorker = fake({mc_worker, init, 1}, []),
        _NotMonitor = fake({some_other, init, 1}, [PoolWorker]),
        try
            ?assertEqual([Worker], geo_mongo_reaper:candidates())
        after
            cleanup()
        end
    end}.

candidates_killed_worker_is_not_a_candidate_test() ->
    Worker = fake({mc_worker, init, 1}, []),
    Monitor = fake({mc_monitor, init, 1}, [Worker]),
    exit(Worker, kill),
    try
        ?assertEqual([], geo_mongo_reaper:candidates())
    after
        exit(Monitor, kill),
        cleanup()
    end.

%% A process with the given initial call that links to Targets and then waits. Linked
%% processes are tracked in the process dictionary of the test via cleanup/0.
fake(InitialCall, Targets) ->
    Pid = proc_lib:spawn(?MODULE, fake_body, [self(), InitialCall, Targets]),
    receive
        {ready, Pid} -> ok
    after 2000 -> error(fake_timeout)
    end,
    put({fake, Pid}, true),
    Pid.

fake_body(Parent, InitialCall, Targets) ->
    put('$initial_call', InitialCall),
    process_flag(trap_exit, true),
    lists:foreach(fun link/1, Targets),
    Parent ! {ready, self()},
    receive
    after infinity -> ok
    end.

cleanup() ->
    [exit(P, kill) || {{fake, P}, true} <- get()],
    ok.
