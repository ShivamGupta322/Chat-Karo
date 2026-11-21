-module(geo_crash_tests).

-include_lib("eunit/include/eunit.hrl").

printed(Term) -> lists:flatten(io_lib:format("~0p", [Term])).

sentinel_stack_test() ->
    Stack = [
        {geo_cell, from_point, [57.6491137, 10.4074419, block], [{file, "x"}, {line, 3}]},
        {m, f, 2, [{error_info, #{cause => 57.6491137}}]}
    ],
    Reason = {badmatch, #{<<"lat">> => 57.6491137, <<"lng">> => 10.4074419}},
    Summary = geo_crash:summary(error, Reason, Stack),
    ?assertEqual(
        #{
            class => error,
            reason => badmatch,
            where => [{geo_cell, from_point, 3, 3}, {m, f, 2, undefined}]
        },
        Summary
    ),
    ?assertEqual(nomatch, string:find(printed(Summary), "57.649")),
    ?assertEqual(nomatch, string:find(printed(Summary), "10.407")).

reasons_test_() ->
    [
        ?_assertMatch(#{reason := term}, geo_crash:summary(error, 57.6491137, [])),
        ?_assertMatch(#{reason := term}, geo_crash:summary(error, <<"lat">>, [])),
        ?_assertMatch(#{reason := term}, geo_crash:summary(error, #{lat => 1.5}, [])),
        ?_assertMatch(#{reason := term}, geo_crash:summary(error, [57.6, 10.4], [])),
        ?_assertMatch(#{reason := term}, geo_crash:summary(error, {57.6, 10.4}, [])),
        ?_assertMatch(#{reason := function_clause}, geo_crash:summary(error, function_clause, [])),
        ?_assertMatch(#{reason := case_clause}, geo_crash:summary(error, {case_clause, ok}, [])),
        ?_assertMatch(#{class := throw, reason := oops}, geo_crash:summary(throw, oops, [])),
        ?_assertMatch(#{class := exit, reason := normal}, geo_crash:summary(exit, normal, []))
    ].

function_clause_frame_test() ->
    Stack = [{geo_cell, from_point, [57.6491137, 10.4074419, block], []}],
    Summary = geo_crash:summary(error, function_clause, Stack),
    ?assertEqual([{geo_cell, from_point, 3, undefined}], maps:get(where, Summary)),
    ?assertEqual(nomatch, string:find(printed(Summary), "57.649")).

malformed_stack_test_() ->
    [
        ?_assertEqual(
            [{unknown, unknown, 0, undefined}],
            maps:get(where, geo_crash:summary(error, x, [Entry]))
        )
     || Entry <- [garbage, {a, b}, {1.5, 2.5, 3, []}, {m, f, -1, []}, {m, "f", 1, []}, 57.6]
    ] ++
        [
            ?_assertEqual([], maps:get(where, geo_crash:summary(error, x, not_a_list))),
            ?_assertEqual(
                [{m, f, 0, undefined}],
                maps:get(where, geo_crash:summary(error, x, [{m, f, [a | b], []}]))
            ),
            ?_assertEqual(
                [{m, f, 1, undefined}],
                maps:get(where, geo_crash:summary(error, x, [{m, f, 1, not_a_list}]))
            ),
            ?_assertEqual(
                [{m, f, 1, undefined}],
                maps:get(where, geo_crash:summary(error, x, [{m, f, 1, [{line, 0}]}]))
            )
        ].

improper_stack_test() ->
    ?assertEqual(
        [{m, f, 1, undefined}],
        maps:get(where, geo_crash:summary(error, x, [{m, f, 1, []} | tail]))
    ).

top_five_frames_test() ->
    Stack = [{m, f, I, [{line, I}]} || I <- lists:seq(1, 9)],
    #{where := Where} = geo_crash:summary(error, x, Stack),
    ?assertEqual([{m, f, I, I} || I <- lists:seq(1, 5)], Where).
