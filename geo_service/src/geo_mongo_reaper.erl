%% Finds heartbeat connections that the driver's mc_monitor abandoned (ADR-016 quirk 10).
%%
%% mc_monitor:check/2 opens a worker with mc_worker_api:connect/1 and only disconnects it when
%% the check succeeds. When the server hangs, the check exits and the worker, linked to the
%% monitor but never told to stop, keeps its socket open for ever. geo_mongo_probe stops those
%% workers; this module only decides which ones. No logging here.
%%
%% Identification relies on driver internals at the pinned SHA: the monitor is the process with
%% initial call {mc_monitor, init, 1} and its heartbeat workers are the {mc_worker, init, 1}
%% processes linked to it. A driver upgrade must re-verify this (the candidates/0 tests and the
%% proxy_blackhole_no_heartbeat_leak CT case catch drift).
-module(geo_mongo_reaper).

-export([select/4, candidates/0]).

-type seen() :: #{pid() => integer()}.
-export_type([seen/0]).

%% ToReap are the candidates first seen at least MinAgeMs ago. NewSeen keeps the first-seen time
%% of the rest and forgets pids that are no longer candidates (they exited or were reaped).
-spec select([pid()], seen(), integer(), pos_integer()) -> {[pid()], seen()}.
select(Candidates, Seen, NowMs, MinAgeMs) ->
    lists:foldl(
        fun(Pid, {Reap, Acc}) ->
            case Seen of
                #{Pid := SeenAt} when NowMs - SeenAt >= MinAgeMs ->
                    {[Pid | Reap], Acc};
                #{Pid := SeenAt} ->
                    {Reap, Acc#{Pid => SeenAt}};
                #{} ->
                    {Reap, Acc#{Pid => NowMs}}
            end
        end,
        {[], #{}},
        lists:usort(Candidates)
    ).

%% mc_worker processes linked to an mc_monitor. Scans every process: fine for this small node
%% at one scan per probe tick (5 s). Every process_info call tolerates a process that just died.
-spec candidates() -> [pid()].
candidates() ->
    Monitors = [P || P <- erlang:processes(), initial_call(P) =:= {mc_monitor, init, 1}],
    Linked = lists:append([links(M) || M <- Monitors]),
    lists:usort([P || P <- Linked, initial_call(P) =:= {mc_worker, init, 1}]).

-spec links(pid()) -> [pid() | port()].
links(Pid) ->
    case erlang:process_info(Pid, links) of
        {links, Links} -> [L || L <- Links, is_pid(L)];
        undefined -> []
    end.

-spec initial_call(pid()) -> {module(), atom(), arity()} | undefined.
initial_call(Pid) ->
    %% Only proc_lib processes have the dictionary entries read below; checking this first avoids
    %% copying the dictionary of every process on the node.
    case erlang:process_info(Pid, initial_call) of
        {initial_call, {proc_lib, init_p, 5}} ->
            dictionary_initial_call(Pid);
        _ ->
            undefined
    end.

-spec dictionary_initial_call(pid()) -> {module(), atom(), arity()} | undefined.
dictionary_initial_call(Pid) ->
    case erlang:process_info(Pid, dictionary) of
        {dictionary, Dict} ->
            %% proc_lib sets '$initial_call' for gen_servers and passes the MFA arguments for
            %% proc_lib:start_link(M, F, Args), which translate_initial_call/1 turns into M:F/N.
            try proc_lib:translate_initial_call([{dictionary, Dict}]) of
                {M, F, A} when is_atom(M), is_atom(F), is_integer(A) -> {M, F, A};
                _ -> undefined
            catch
                _:_ -> undefined
            end;
        undefined ->
            undefined
    end.
