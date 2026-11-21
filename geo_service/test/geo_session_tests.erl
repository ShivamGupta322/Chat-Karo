-module(geo_session_tests).

-include_lib("eunit/include/eunit.hrl").

localparts_are_random_and_well_formed_test() ->
    All = [geo_session:new_localpart() || _ <- lists:seq(1, 1000)],
    lists:foreach(
        fun(L) -> ?assertMatch({match, _}, re:run(L, "^u[0-9a-f]{32}$")) end,
        All
    ),
    ?assertEqual(1000, length(lists:usort(All))).

passwords_are_random_and_well_formed_test() ->
    All = [geo_session:new_password() || _ <- lists:seq(1, 1000)],
    lists:foreach(
        fun(P) -> ?assertMatch({match, _}, re:run(P, "^xp1_[A-Za-z0-9_-]{32}$")) end,
        All
    ),
    ?assertEqual(1000, length(lists:usort(All))).
