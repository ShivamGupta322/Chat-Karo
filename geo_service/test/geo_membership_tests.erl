-module(geo_membership_tests).

-include_lib("eunit/include/eunit.hrl").

%% logger handler callback
-export([log/2]).

-define(U1, <<"u0123456789abcdef0123456789abcdef@chaterl.localhost">>).
-define(U2, <<"u1123456789abcdef0123456789abcdef@chaterl.localhost">>).
-define(A, <<"g7_u4pruyd@muc.chaterl.localhost">>).
-define(B, <<"g7_u4pruyf@muc.chaterl.localhost">>).
-define(C, <<"g7_u4pruyg@muc.chaterl.localhost">>).
-define(HANDLER, geo_membership_test_capture).
-define(TABLE, geo_membership_test_log).

%%% Pure entry logic -----------------------------------------------------------------------

settle_none_test() ->
    ?assertEqual({#{current => ?A, pending => []}, []}, geo_membership:settle_entry(none, ?A)).

settle_same_room_returns_pending_keeps_current_test() ->
    Entry = #{current => ?A, pending => [?B]},
    ?assertEqual({#{current => ?A, pending => []}, [?B]}, geo_membership:settle_entry(Entry, ?A)).

settle_move_revokes_old_then_pending_test() ->
    Entry = #{current => ?A, pending => [?B]},
    ?assertEqual(
        {#{current => ?C, pending => []}, [?A, ?B]}, geo_membership:settle_entry(Entry, ?C)
    ).

settle_move_dedupes_test() ->
    Entry = #{current => ?A, pending => [?B, ?A, ?B]},
    {_, Revoke} = geo_membership:settle_entry(Entry, ?C),
    ?assertEqual([?A, ?B], Revoke).

settle_pending_containing_target_does_not_return_it_test() ->
    Entry = #{current => ?A, pending => [?B, ?C]},
    {Entry1, Revoke} = geo_membership:settle_entry(Entry, ?C),
    ?assertEqual([?A, ?B], Revoke),
    ?assertEqual(#{current => ?C, pending => []}, Entry1).

requeue_skips_current_and_duplicates_test() ->
    Entry = #{current => ?A, pending => [?B]},
    ?assertEqual(
        {#{current => ?A, pending => [?B, ?C]}, 0},
        geo_membership:requeue_entry(Entry, [?A, ?B, ?C, ?C], 16)
    ).

requeue_cap_keeps_newest_test() ->
    Rooms = [room(N) || N <- lists:seq(1, 20)],
    Entry = #{current => ?A, pending => []},
    {#{pending := Pending}, Dropped} = geo_membership:requeue_entry(Entry, Rooms, 16),
    ?assertEqual(4, Dropped),
    ?assertEqual(lists:nthtail(4, Rooms), Pending),
    ?assertEqual(16, length(Pending)).

requeue_cap_counts_existing_pending_test() ->
    Old = [room(N) || N <- lists:seq(1, 16)],
    Entry = #{current => ?A, pending => Old},
    {#{pending := Pending}, Dropped} = geo_membership:requeue_entry(Entry, [?B], 16),
    ?assertEqual(1, Dropped),
    ?assertEqual(tl(Old) ++ [?B], Pending).

%%% Process behaviour ----------------------------------------------------------------------

membership_test_() ->
    {foreach, fun setup/0, fun teardown/1, [
        fun different_users_independent/0,
        fun same_user_fifo/0,
        fun holder_kill_releases/0,
        fun waiter_past_deadline_is_busy_and_cancelled/0,
        fun fifth_waiter_is_busy_at_once/0,
        fun release_from_non_holder_ignored/0,
        fun settle_requeue_current_round_trip/0,
        fun requeue_without_entry_is_unavailable/0,
        fun requeue_cap_logs_one_atom_only_warning/0,
        fun format_status_has_no_user_or_room/0,
        fun crash_reports_hold_no_user_or_room/0
    ]}.

setup() ->
    {ok, Pid} = geo_membership:start_link(),
    unlink(Pid),
    ?TABLE = ets:new(?TABLE, [named_table, public, bag]),
    ok = logger:add_handler(?HANDLER, ?MODULE, #{level => all}),
    Pid.

teardown(Pid) ->
    _ = logger:remove_handler(?HANDLER),
    ets:delete(?TABLE),
    case is_process_alive(Pid) of
        true -> stop(Pid);
        false -> ok
    end,
    wait_table_gone(50).

%% The table dies with its owner, slightly after the exit signal.
wait_table_gone(0) ->
    error(table_not_deleted);
wait_table_gone(N) ->
    case ets:whereis(geo_membership) of
        undefined ->
            ok;
        _ ->
            timer:sleep(10),
            wait_table_gone(N - 1)
    end.

stop(Pid) ->
    Ref = monitor(process, Pid),
    exit(Pid, kill),
    receive
        {'DOWN', Ref, process, Pid, _} -> ok
    end.

log(Event, _Config) ->
    ets:insert(?TABLE, {event, Event}),
    ok.

different_users_independent() ->
    Holder = spawn_worker(?U1, deadline(5000), h1),
    ?assertEqual({h1, ok}, await(h1)),
    ?assertEqual(ok, geo_membership:acquire(?U2, deadline(5000))),
    ok = geo_membership:release(?U2),
    done(Holder).

same_user_fifo() ->
    Holder = spawn_worker(?U1, deadline(5000), h),
    {h, ok} = await(h),
    W1 = spawn_worker(?U1, deadline(5000), w1),
    timer:sleep(30),
    W2 = spawn_worker(?U1, deadline(5000), w2),
    timer:sleep(30),
    ?assertEqual(none, poll(w1)),
    done(Holder),
    ?assertEqual({w1, ok}, await(w1)),
    ?assertEqual(none, poll(w2)),
    done(W1),
    ?assertEqual({w2, ok}, await(w2)),
    done(W2).

holder_kill_releases() ->
    Holder = spawn_worker(?U1, deadline(5000), h),
    {h, ok} = await(h),
    _W = spawn_worker(?U1, deadline(5000), w),
    timer:sleep(30),
    exit(Holder, kill),
    ?assertEqual({w, ok}, await(w)).

waiter_past_deadline_is_busy_and_cancelled() ->
    Holder = spawn_worker(?U1, deadline(5000), h),
    {h, ok} = await(h),
    %% 450 ms left, 250 ms margin: the call times out after about 200 ms.
    ?assertEqual({error, busy}, geo_membership:acquire(?U1, deadline(450))),
    W = spawn_worker(?U1, deadline(5000), w),
    timer:sleep(30),
    done(Holder),
    %% The timed-out caller was removed (and holds nothing), so the next waiter gets the lock.
    ?assertEqual({w, ok}, await(w)),
    done(W).

%% A deadline within the margin does not even call.
deadline_inside_margin_is_busy_test() ->
    ?assertEqual({error, busy}, geo_membership:acquire(?U1, deadline(100))).

fifth_waiter_is_busy_at_once() ->
    Holder = spawn_worker(?U1, deadline(5000), h),
    {h, ok} = await(h),
    Waiters = [spawn_worker(?U1, deadline(5000), {w, N}) || N <- lists:seq(1, 4)],
    timer:sleep(100),
    Start = erlang:monotonic_time(millisecond),
    ?assertEqual({error, busy}, geo_membership:acquire(?U1, deadline(5000))),
    ?assert(erlang:monotonic_time(millisecond) - Start < 150),
    done(Holder),
    lists:foreach(
        fun({N, Pid}) ->
            ?assertEqual({{w, N}, ok}, await({w, N})),
            done(Pid)
        end,
        lists:zip([1, 2, 3, 4], Waiters)
    ).

release_from_non_holder_ignored() ->
    Holder = spawn_worker(?U1, deadline(5000), h),
    {h, ok} = await(h),
    ok = geo_membership:release(?U1),
    ?assertEqual({error, busy}, geo_membership:acquire(?U1, deadline(600))),
    done(Holder).

settle_requeue_current_round_trip() ->
    ?assertEqual(none, geo_membership:current(?U1)),
    ?assertEqual({ok, []}, geo_membership:settle(?U1, ?A)),
    ?assertEqual({ok, ?A}, geo_membership:current(?U1)),
    ?assertEqual({ok, [?A]}, geo_membership:settle(?U1, ?B)),
    ?assertEqual({ok, ?B}, geo_membership:current(?U1)),
    ?assertEqual(ok, geo_membership:requeue(?U1, [?A])),
    ?assertEqual({ok, [?A]}, geo_membership:settle(?U1, ?B)),
    ?assertEqual(ok, geo_membership:requeue(?U1, [?A])),
    ?assertEqual({ok, [?B, ?A]}, geo_membership:settle(?U1, ?C)),
    %% another user is unaffected
    ?assertEqual(none, geo_membership:current(?U2)).

requeue_without_entry_is_unavailable() ->
    ?assertEqual({error, unavailable}, geo_membership:requeue(?U1, [?A])).

requeue_cap_logs_one_atom_only_warning() ->
    {ok, []} = geo_membership:settle(?U1, ?A),
    ok = geo_membership:requeue(?U1, [room(N) || N <- lists:seq(1, 20)]),
    timer:sleep(30),
    Reports = [R || #{msg := {report, #{event := membership_pending_dropped} = R}} <- events()],
    ?assertEqual([#{event => membership_pending_dropped, count => 4}], Reports).

format_status_has_no_user_or_room() ->
    {ok, []} = geo_membership:settle(?U1, ?A),
    Holder = spawn_worker(?U1, deadline(5000), h),
    {h, ok} = await(h),
    Status = sys:get_status(geo_membership),
    Text = printed(Status),
    ?assertEqual(nomatch, string:find(Text, "chaterl.localhost")),
    ?assertEqual(nomatch, string:find(Text, "g7_")),
    ?assertEqual(nomatch, string:find(Text, "u0123456789")),
    %% terminate-style status: the message and the reason are redacted too
    Redacted = geo_membership:format_status(#{
        state => #{locks => #{?U1 => x}, monitors => #{}},
        message => {settle, ?U1, ?A},
        reason => {badmatch, ?U1, ?A},
        log => [{in, {settle, ?U1, ?A}}]
    }),
    RText = printed(Redacted),
    ?assertEqual(nomatch, string:find(RText, "chaterl.localhost")),
    ?assertEqual(nomatch, string:find(RText, "g7_")),
    ?assertMatch(#{state := #{locks := 1, rows := 1}, log := []}, Redacted),
    done(Holder).

%% A callback that fails exits with a bare atom; the crash report holds no user or room.
crash_reports_hold_no_user_or_room() ->
    {ok, []} = geo_membership:settle(?U1, ?A),
    Pid = whereis(geo_membership),
    Ref = monitor(process, Pid),
    %% not a list: dedupe/1 raises inside the callback
    ?assertEqual({error, unavailable}, geo_membership:requeue(?U1, {not_a_list, ?U1, ?B})),
    receive
        {'DOWN', Ref, process, Pid, Reason} -> ?assertEqual(membership_failed, Reason)
    after 2000 -> error(not_crashed)
    end,
    timer:sleep(100),
    Text = printed(events()),
    ?assertEqual(nomatch, string:find(Text, "chaterl.localhost")),
    ?assertEqual(nomatch, string:find(Text, "g7_")),
    ?assertEqual(nomatch, string:find(Text, "u0123456789")),
    %% the crash was logged (proves the scan looked at something)
    ?assertNotEqual(nomatch, string:find(Text, "membership_failed")).

%% No owner process: nothing crashes, the callers get the documented answers.
owner_not_running_test() ->
    ?assertEqual(undefined, whereis(geo_membership)),
    ?assertEqual({error, busy}, geo_membership:acquire(?U1, deadline(5000))),
    ?assertEqual({error, unavailable}, geo_membership:settle(?U1, ?A)),
    ?assertEqual({error, unavailable}, geo_membership:requeue(?U1, [?A])),
    ?assertEqual(ok, geo_membership:release(?U1)),
    ?assertEqual(none, geo_membership:current(?U1)).

%%% Helpers --------------------------------------------------------------------------------

room(N) ->
    iolist_to_binary(["g7_room", integer_to_list(N), "@muc.chaterl.localhost"]).

deadline(Ms) -> erlang:monotonic_time(millisecond) + Ms.

%% Acquires; reports {Tag, Result}; if it got the lock it keeps it until told `done`.
spawn_worker(User, Deadline, Tag) ->
    Parent = self(),
    spawn(fun() ->
        Result = geo_membership:acquire(User, Deadline),
        Parent ! {Tag, Result},
        case Result of
            ok ->
                receive
                    done -> geo_membership:release(User)
                end;
            _ ->
                ok
        end
    end).

done(Pid) ->
    Pid ! done,
    ok.

await(Tag) ->
    receive
        {Tag, _} = Msg -> Msg
    after 3000 -> timeout
    end.

poll(Tag) ->
    receive
        {Tag, _} = Msg -> Msg
    after 100 -> none
    end.

events() ->
    [E || {event, E} <- ets:tab2list(?TABLE)].

printed(Term) ->
    lists:flatten(io_lib:format("~0p", [Term])).
