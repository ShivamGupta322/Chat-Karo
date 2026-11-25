-module(geo_room_access_tests).

-include_lib("eunit/include/eunit.hrl").

%% logger handler callback
-export([log/2]).

-define(ROOM, <<"g7_u4pruyd@muc.chaterl.localhost">>).
-define(ROOM_B, <<"g7_u4pruyg@muc.chaterl.localhost">>).
-define(OLD, <<"g7_u4pruyf@muc.chaterl.localhost">>).
-define(USER, <<"u0123456789abcdef0123456789abcdef@chaterl.localhost">>).
-define(OWNER_JID, <<"nearby-rooms@chaterl.localhost/geo_service">>).
-define(HANDLER, geo_room_access_test_capture).
-define(TABLE, geo_room_access_test_log).
-define(TRACE, geo_room_access_test_trace).

room_access_test_() ->
    {foreach, fun setup/0, fun teardown/1, [
        fun fast_path/0,
        fun slow_path_order/0,
        fun slow_path_owner_and_nick/0,
        fun owner_missing_registers_then_creates/0,
        fun register_exists_is_fine/0,
        fun register_failure_fails/0,
        fun owner_still_missing_fails/0,
        fun create_unavailable/0,
        fun create_bad_response/0,
        fun configure_bad_response_blocks_grant/0,
        fun exit_error_ignored/0,
        fun second_room_not_found_fails/0,
        fun first_call_unauthorized_fails/0,
        fun first_call_unavailable_is_silent/0,
        fun past_deadline/0,
        fun deadline_nearly_spent/0,
        fun timeouts_shrink/0,
        fun deadline_runs_out_mid_slow_path/0,
        fun logs_are_atoms_only/0,
        fun assign_fast_move/0,
        fun assign_same_room_no_revoke/0,
        fun assign_revoke_unloaded_room/0,
        fun assign_revoke_unavailable_requeues_silently/0,
        fun assign_revoke_bad_response_requeues_and_logs_once/0,
        fun assign_deadline_spent_after_grant/0,
        fun assign_grant_failed_no_settle/0,
        fun assign_grant_unavailable_no_settle/0,
        fun assign_acquire_busy/0,
        fun assign_settle_unavailable/0,
        fun assign_requeue_unavailable/0,
        fun assign_releases_when_grant_raises/0,
        fun revoke_guard_non_cell_room/0,
        fun revoke_guard_foreign_domain/0,
        fun assign_guard_failure_dropped_not_requeued/0,
        fun assign_revoke_crash_still_ok_and_requeues/0
    ]}.

setup() ->
    ok = meck:new(geo_xmpp_admin, []),
    ok = meck:new(geo_session, [passthrough]),
    ok = meck:new(geo_membership, []),
    ?TABLE = ets:new(?TABLE, [named_table, public, bag]),
    ?TRACE = ets:new(?TRACE, [named_table, public, ordered_set]),
    ok = logger:add_handler(?HANDLER, ?MODULE, #{level => all}),
    ok.

teardown(_) ->
    _ = logger:remove_handler(?HANDLER),
    ets:delete(?TABLE),
    ets:delete(?TRACE),
    meck:unload(),
    ok.

log(#{msg := {report, #{event := room_access_failed} = Report}}, _Config) ->
    ets:insert(?TABLE, {failed, Report}),
    ok;
log(#{msg := {report, #{event := room_revoke_failed} = Report}}, _Config) ->
    ets:insert(?TABLE, {revoke, Report}),
    ok;
log(#{msg := {report, #{event := membership_tracking_failed} = Report}}, _Config) ->
    ets:insert(?TABLE, {tracking, Report}),
    ok;
log(_Event, _Config) ->
    ok.

%%% Cases ----------------------------------------------------------------------------------

fast_path() ->
    stub(#{set_member => [ok]}),
    ?assertEqual(ok, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([set_member], calls()),
    ?assertEqual([], failures()).

slow_path_order() ->
    stub(#{set_member => [{error, room_not_found}, ok]}),
    ?assertEqual(ok, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([set_member, create_room, configure_room, exit_room, set_member], calls()),
    ?assertEqual([], failures()).

slow_path_owner_and_nick() ->
    stub(#{set_member => [{error, room_not_found}, ok]}),
    ok = geo_room_access:grant(ctx(), ?ROOM, ?USER),
    ?assertMatch(
        [[_, ?ROOM, ?OWNER_JID, <<"Nearby">>, _]], args(create_room)
    ),
    ?assertMatch([[_, ?ROOM, ?OWNER_JID, <<"Nearby">>, _]], args(exit_room)),
    ?assertMatch([[_, ?ROOM, _]], args(configure_room)),
    %% both set_member calls name the room and the user
    ?assertMatch([[_, ?ROOM, ?USER, _], [_, ?ROOM, ?USER, _]], args(set_member)).

owner_missing_registers_then_creates() ->
    stub(#{
        set_member => [{error, room_not_found}, ok],
        create_room => [{error, owner_missing}, ok]
    }),
    ?assertEqual(ok, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual(
        [
            set_member,
            create_room,
            register_user,
            create_room,
            configure_room,
            exit_room,
            set_member
        ],
        calls()
    ),
    [[_, <<"chaterl.localhost">>, <<"nearby-rooms">>, Password, _]] = args(register_user),
    ?assertMatch(<<"xp1_", _:32/binary>>, Password),
    ?assertEqual([], failures()),
    %% the password is never handed to the logger
    ?assertEqual(nomatch, string:find(printed(ets:tab2list(?TABLE)), binary_to_list(Password))).

register_exists_is_fine() ->
    stub(#{
        set_member => [{error, room_not_found}, ok],
        create_room => [{error, owner_missing}, ok],
        register_user => [{error, exists}]
    }),
    ?assertEqual(ok, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([], failures()).

register_failure_fails() ->
    stub(#{
        set_member => [{error, room_not_found}],
        create_room => [{error, owner_missing}],
        register_user => [{error, rejected}]
    }),
    ?assertEqual({error, failed}, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([set_member, create_room, register_user], calls()),
    ?assertMatch([#{step := register_owner, reason := rejected}], failures()).

owner_still_missing_fails() ->
    stub(#{
        set_member => [{error, room_not_found}],
        create_room => [{error, owner_missing}, {error, owner_missing}]
    }),
    ?assertEqual({error, failed}, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([set_member, create_room, register_user, create_room], calls()),
    ?assertMatch([#{step := create_room, reason := owner_missing}], failures()).

create_unavailable() ->
    stub(#{set_member => [{error, room_not_found}], create_room => [{error, unavailable}]}),
    ?assertEqual({error, unavailable}, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([set_member, create_room], calls()),
    ?assertEqual([], failures()).

create_bad_response() ->
    stub(#{set_member => [{error, room_not_found}], create_room => [{error, bad_response}]}),
    ?assertEqual({error, failed}, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([set_member, create_room], calls()),
    ?assertMatch([#{step := create_room, reason := bad_response}], failures()).

configure_bad_response_blocks_grant() ->
    stub(#{set_member => [{error, room_not_found}], configure_room => [{error, bad_response}]}),
    ?assertEqual({error, failed}, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    %% only the first set_member: nobody becomes a member of a room with the wrong config
    ?assertEqual([set_member, create_room, configure_room], calls()),
    ?assertMatch([#{step := configure_room, reason := bad_response}], failures()).

exit_error_ignored() ->
    stub(#{
        set_member => [{error, room_not_found}, ok],
        exit_room => [{error, unavailable}]
    }),
    ?assertEqual(ok, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([set_member, create_room, configure_room, exit_room, set_member], calls()),
    ?assertEqual([], failures()).

second_room_not_found_fails() ->
    stub(#{set_member => [{error, room_not_found}, {error, room_not_found}]}),
    ?assertEqual({error, failed}, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertMatch([#{step := set_member_again, reason := room_not_found}], failures()).

first_call_unauthorized_fails() ->
    stub(#{set_member => [{error, unauthorized}]}),
    ?assertEqual({error, failed}, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([set_member], calls()),
    ?assertMatch([#{step := set_member, reason := unauthorized}], failures()).

first_call_unavailable_is_silent() ->
    stub(#{set_member => [{error, unavailable}]}),
    ?assertEqual({error, unavailable}, geo_room_access:grant(ctx(), ?ROOM, ?USER)),
    ?assertEqual([set_member], calls()),
    ?assertEqual([], failures()).

past_deadline() ->
    stub(#{set_member => [ok]}),
    Ctx = (ctx())#{deadline => erlang:monotonic_time(millisecond) - 1},
    ?assertEqual({error, unavailable}, geo_room_access:grant(Ctx, ?ROOM, ?USER)),
    ?assertEqual([], calls()),
    ?assertEqual([], failures()).

%% Under 250 ms left no call is made.
deadline_nearly_spent() ->
    stub(#{set_member => [ok]}),
    Ctx = (ctx())#{deadline => erlang:monotonic_time(millisecond) + 100},
    ?assertEqual({error, unavailable}, geo_room_access:grant(Ctx, ?ROOM, ?USER)),
    ?assertEqual([], calls()),
    ?assertEqual([], failures()).

timeouts_shrink() ->
    stub(#{set_member => [ok]}),
    Ctx = ctx(),
    ok = geo_room_access:grant(
        Ctx#{deadline => erlang:monotonic_time(millisecond) + 60000}, ?ROOM, ?USER
    ),
    [[_, _, _, Long]] = args(set_member),
    ?assertEqual(5000, Long),
    meck:reset(geo_xmpp_admin),
    ok = geo_room_access:grant(
        Ctx#{deadline => erlang:monotonic_time(millisecond) + 1500}, ?ROOM, ?USER
    ),
    [[_, _, _, Short]] = args(set_member),
    ?assert(Short =< 1500),
    ?assert(Short >= 250).

%% The slow path hits the deadline between calls: unavailable, not failed, and no grant.
deadline_runs_out_mid_slow_path() ->
    stub(#{set_member => [{error, room_not_found}]}),
    meck:expect(geo_xmpp_admin, create_room, fun(_, _, _, _, _) ->
        timer:sleep(200),
        ok
    end),
    Ctx = (ctx())#{deadline => erlang:monotonic_time(millisecond) + 300},
    ?assertEqual({error, unavailable}, geo_room_access:grant(Ctx, ?ROOM, ?USER)),
    ?assertEqual([set_member, create_room], calls()),
    ?assertEqual([], failures()).

logs_are_atoms_only() ->
    stub(#{set_member => [{error, room_not_found}], configure_room => [{error, bad_response}]}),
    {error, failed} = geo_room_access:grant(ctx(), ?ROOM, ?USER),
    [Report] = failures(),
    ?assertEqual([event, reason, step], lists:sort(maps:keys(Report))),
    ?assert(lists:all(fun is_atom/1, maps:values(Report))).

%%% assign/3 and revoke/3 --------------------------------------------------------------------

assign_fast_move() ->
    tstub(#{settle => [{ok, [?OLD]}]}),
    ?assertEqual(ok, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([acquire, set_member, settle, set_none, release], trace()),
    ?assertMatch([[_, ?ROOM, ?USER, _]], targs(set_member)),
    ?assertMatch([[?USER, ?ROOM]], targs(settle)),
    ?assertMatch([[_, ?OLD, ?USER, _]], targs(set_none)),
    ?assertEqual([], revokes()),
    ?assertEqual([], failures()).

assign_same_room_no_revoke() ->
    tstub(#{settle => [{ok, []}]}),
    ?assertEqual(ok, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([acquire, set_member, settle, release], trace()).

assign_revoke_unloaded_room() ->
    tstub(#{settle => [{ok, [?OLD]}], set_none => [{error, room_not_found}, ok]}),
    ?assertEqual(ok, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual(
        [
            acquire,
            set_member,
            settle,
            set_none,
            create_room,
            configure_room,
            exit_room,
            set_none,
            release
        ],
        trace()
    ),
    ?assertMatch([[_, ?OLD, ?OWNER_JID, <<"Nearby">>, _]], targs(create_room)),
    ?assertMatch([[_, ?OLD, ?OWNER_JID, <<"Nearby">>, _]], targs(exit_room)),
    ?assertMatch([[_, ?OLD, _]], targs(configure_room)),
    ?assertMatch([[_, ?OLD, ?USER, _], [_, ?OLD, ?USER, _]], targs(set_none)),
    ?assertEqual([], revokes()).

assign_revoke_unavailable_requeues_silently() ->
    tstub(#{settle => [{ok, [?OLD]}], set_none => [{error, unavailable}]}),
    ?assertEqual(ok, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([acquire, set_member, settle, set_none, requeue, release], trace()),
    ?assertEqual([[?USER, [?OLD]]], targs(requeue)),
    ?assertEqual([], revokes()),
    ?assertEqual([], tracking()),
    ?assertEqual([], failures()).

assign_revoke_bad_response_requeues_and_logs_once() ->
    tstub(#{settle => [{ok, [?OLD]}], set_none => [{error, bad_response}]}),
    ?assertEqual(ok, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([[?USER, [?OLD]]], targs(requeue)),
    [Report] = revokes(),
    ?assertEqual([event, reason, step], lists:sort(maps:keys(Report))),
    ?assert(lists:all(fun is_atom/1, maps:values(Report))),
    ?assertMatch(#{event := room_revoke_failed, step := set_none, reason := bad_response}, Report),
    ?assertEqual([], failures()).

%% The grant used up the deadline: no revoke call at all, everything goes back to pending.
assign_deadline_spent_after_grant() ->
    tstub(#{settle => [{ok, [?OLD, ?ROOM_B]}], set_member => [{sleep_then, 300, ok}]}),
    Ctx = (ctx())#{deadline => erlang:monotonic_time(millisecond) + 400},
    ?assertEqual(ok, geo_room_access:assign(Ctx, ?ROOM, ?USER)),
    ?assertEqual([acquire, set_member, settle, requeue, release], trace()),
    ?assertEqual([[?USER, [?OLD, ?ROOM_B]]], targs(requeue)),
    ?assertEqual([], revokes()).

assign_grant_failed_no_settle() ->
    tstub(#{set_member => [{error, bad_response}]}),
    ?assertEqual({error, failed}, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([acquire, set_member, release], trace()),
    ?assertMatch([#{step := set_member, reason := bad_response}], failures()).

assign_grant_unavailable_no_settle() ->
    tstub(#{set_member => [{error, unavailable}]}),
    ?assertEqual({error, unavailable}, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([acquire, set_member, release], trace()).

assign_acquire_busy() ->
    tstub(#{acquire => [{error, busy}]}),
    ?assertEqual({error, unavailable}, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([acquire], trace()),
    ?assertEqual([], failures()).

assign_settle_unavailable() ->
    tstub(#{settle => [{error, unavailable}]}),
    ?assertEqual(ok, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([acquire, set_member, settle, release], trace()),
    ?assertEqual([#{event => membership_tracking_failed}], tracking()).

assign_requeue_unavailable() ->
    tstub(#{
        settle => [{ok, [?OLD]}],
        set_none => [{error, bad_response}],
        requeue => [{error, unavailable}]
    }),
    ?assertEqual(ok, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([#{event => membership_tracking_failed}], tracking()),
    ?assertMatch([#{step := set_none}], revokes()).

assign_releases_when_grant_raises() ->
    tstub(#{set_member => [{raise, boom}]}),
    ?assertError(boom, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([acquire, set_member, release], trace()).

revoke_guard_non_cell_room() ->
    tstub(#{}),
    Lobby = <<"lobby@muc.chaterl.localhost">>,
    NotACell = <<"g9_u4pruyd@muc.chaterl.localhost">>,
    ?assertEqual({error, failed}, geo_room_access:revoke(ctx(), Lobby, ?USER)),
    ?assertEqual({error, failed}, geo_room_access:revoke(ctx(), NotACell, ?USER)),
    ?assertEqual([], trace()),
    ?assertEqual(
        [#{event => room_revoke_failed, step => guard, reason => not_a_cell_room}],
        lists:usort(revokes())
    ).

revoke_guard_foreign_domain() ->
    tstub(#{}),
    Foreign = <<"g7_u4pruyd@muc.evil.example">>,
    ?assertEqual({error, failed}, geo_room_access:revoke(ctx(), Foreign, ?USER)),
    ?assertEqual([], trace()),
    ?assertMatch([#{step := guard, reason := not_a_cell_room}], revokes()).

%% A guard failure is permanent: the room is dropped, not requeued (and logged once).
assign_guard_failure_dropped_not_requeued() ->
    Lobby = <<"lobby@muc.chaterl.localhost">>,
    tstub(#{settle => [{ok, [Lobby, ?OLD]}], set_none => [{error, bad_response}]}),
    ?assertEqual(ok, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([[?USER, [?OLD]]], targs(requeue)),
    ?assertEqual(
        [guard, set_none],
        [S || #{step := S} <- lists:sort(fun(#{step := A}, #{step := B}) -> A =< B end, revokes())]
    ).

%% An exception in the revoke phase never turns a successful grant into an error; the rooms not
%% yet revoked go back on the pending list and one atom-only report is logged.
assign_revoke_crash_still_ok_and_requeues() ->
    tstub(#{settle => [{ok, [?OLD, ?ROOM_B]}], set_none => [{raise, boom}]}),
    ?assertEqual(ok, geo_room_access:assign(ctx(), ?ROOM, ?USER)),
    ?assertEqual([acquire, set_member, settle, set_none, requeue, release], trace()),
    ?assertEqual([[?USER, [?OLD, ?ROOM_B]]], targs(requeue)),
    [Report] = revokes(),
    ?assertEqual(#{event => room_revoke_failed, step => crash, reason => error}, Report),
    ?assertEqual([], failures()).

%%% Helpers --------------------------------------------------------------------------------

ctx() ->
    #{
        admin => #{},
        xmpp_domain => <<"chaterl.localhost">>,
        muc_domain => <<"muc.chaterl.localhost">>,
        room_owner => <<"nearby-rooms">>,
        deadline => erlang:monotonic_time(millisecond) + 8000
    }.

%% Per function, the answers in call order (the last one repeats). Defaults: success.
stub(Answers) ->
    Defaults = #{
        set_member => [ok],
        create_room => [ok],
        configure_room => [ok],
        exit_room => [ok],
        register_user => [ok]
    },
    maps:foreach(
        fun(Fun, Seq) ->
            Arity = arity(Fun),
            meck:expect(geo_xmpp_admin, Fun, Arity, meck:seq(Seq))
        end,
        maps:merge(Defaults, Answers)
    ),
    ok.

arity(set_member) -> 4;
arity(create_room) -> 5;
arity(configure_room) -> 3;
arity(exit_room) -> 5;
arity(register_user) -> 5.

calls() ->
    [F || {_Pid, {geo_xmpp_admin, F, _Args}, _Ret} <- meck:history(geo_xmpp_admin)].

args(Fun) ->
    [Args || {_Pid, {geo_xmpp_admin, F, Args}, _Ret} <- meck:history(geo_xmpp_admin), F =:= Fun].

%% Every admin and membership call in call order, with the answers popped per function (the last
%% one repeats). An answer {sleep_then, Ms, V} sleeps first; {raise, R} raises error R.
tstub(Answers) ->
    Defaults = #{
        acquire => [ok],
        release => [ok],
        settle => [{ok, []}],
        requeue => [ok],
        set_member => [ok],
        set_none => [ok],
        create_room => [ok],
        configure_room => [ok],
        exit_room => [ok],
        register_user => [ok]
    },
    All = maps:merge(Defaults, Answers),
    true = ets:insert(?TRACE, [{{answers, F}, Seq} || {F, Seq} <- maps:to_list(All)]),
    lists:foreach(
        fun({Mod, Fun, Arity}) -> meck:expect(Mod, Fun, traced(Fun, Arity)) end,
        [
            {geo_membership, acquire, 2},
            {geo_membership, release, 1},
            {geo_membership, settle, 2},
            {geo_membership, requeue, 2},
            {geo_xmpp_admin, set_member, 4},
            {geo_xmpp_admin, set_none, 4},
            {geo_xmpp_admin, create_room, 5},
            {geo_xmpp_admin, configure_room, 3},
            {geo_xmpp_admin, exit_room, 5},
            {geo_xmpp_admin, register_user, 5}
        ]
    ),
    ok.

traced(Name, 1) -> fun(A) -> hit(Name, [A]) end;
traced(Name, 2) -> fun(A, B) -> hit(Name, [A, B]) end;
traced(Name, 3) -> fun(A, B, C) -> hit(Name, [A, B, C]) end;
traced(Name, 4) -> fun(A, B, C, D) -> hit(Name, [A, B, C, D]) end;
traced(Name, 5) -> fun(A, B, C, D, E) -> hit(Name, [A, B, C, D, E]) end.

hit(Name, Args) ->
    true = ets:insert(?TRACE, {{seq, erlang:unique_integer([monotonic])}, Name, Args}),
    [{_, Seq}] = ets:lookup(?TRACE, {answers, Name}),
    Answer = hd(Seq),
    case tl(Seq) of
        [] -> ok;
        Rest -> true = ets:insert(?TRACE, {{answers, Name}, Rest})
    end,
    case Answer of
        {sleep_then, Ms, Value} ->
            timer:sleep(Ms),
            Value;
        {raise, Reason} ->
            erlang:error(Reason);
        Value ->
            Value
    end.

trace() ->
    [Name || {{seq, _}, Name, _} <- lists:sort(ets:match_object(?TRACE, {{seq, '_'}, '_', '_'}))].

targs(Name) ->
    [
        Args
     || {{seq, _}, N, Args} <- lists:sort(ets:match_object(?TRACE, {{seq, '_'}, '_', '_'})),
        N =:= Name
    ].

revokes() ->
    timer:sleep(20),
    [Report || {revoke, Report} <- ets:tab2list(?TABLE)].

tracking() ->
    timer:sleep(20),
    [Report || {tracking, Report} <- ets:tab2list(?TABLE)].

failures() ->
    timer:sleep(20),
    [Report || {failed, Report} <- ets:tab2list(?TABLE)].

printed(Term) ->
    lists:flatten(io_lib:format("~0p", [Term])).
