-module(geo_room_access_tests).

-include_lib("eunit/include/eunit.hrl").

%% logger handler callback
-export([log/2]).

-define(ROOM, <<"g7_u4pruyd@muc.chaterl.localhost">>).
-define(USER, <<"u0123456789abcdef0123456789abcdef@chaterl.localhost">>).
-define(OWNER_JID, <<"nearby-rooms@chaterl.localhost/geo_service">>).
-define(HANDLER, geo_room_access_test_capture).
-define(TABLE, geo_room_access_test_log).

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
        fun logs_are_atoms_only/0
    ]}.

setup() ->
    ok = meck:new(geo_xmpp_admin, []),
    ok = meck:new(geo_session, [passthrough]),
    ?TABLE = ets:new(?TABLE, [named_table, public, bag]),
    ok = logger:add_handler(?HANDLER, ?MODULE, #{level => all}),
    ok.

teardown(_) ->
    _ = logger:remove_handler(?HANDLER),
    ets:delete(?TABLE),
    meck:unload(),
    ok.

log(#{msg := {report, #{event := room_access_failed} = Report}}, _Config) ->
    ets:insert(?TABLE, {failed, Report}),
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

%%% Helpers --------------------------------------------------------------------------------

ctx() ->
    #{
        admin => #{},
        xmpp_domain => <<"chaterl.localhost">>,
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

failures() ->
    timer:sleep(20),
    [Report || {failed, Report} <- ets:tab2list(?TABLE)].

printed(Term) ->
    lists:flatten(io_lib:format("~0p", [Term])).
