-module(geo_log_redact_tests).

-include_lib("eunit/include/eunit.hrl").

-define(SECRET, <<"s3cret-pw-1x1x">>).
-define(MASK, <<"[REDACTED]">>).

event(Msg) -> #{level => error, msg => Msg, meta => #{}}.

run(Msg) ->
    #{msg := Out} = geo_log_redact:filter(event(Msg), [?SECRET]),
    Out.

filter_ids() ->
    [Id || {Id, _} <- maps:get(filters, logger:get_primary_config()), Id =:= geo_redact].

nested_report_test() ->
    In = {report, #{a => [{x, #{pw => ?SECRET}}, {pool, [1, 2, {login, <<"u">>}]}], b => 1}},
    ?assertEqual(
        {report, #{a => [{x, #{pw => ?MASK}}, {pool, [1, 2, {login, <<"u">>}]}], b => 1}},
        run(In)
    ).

map_keys_and_proplist_test() ->
    In = {report, #{?SECRET => 1, opts => [{password, ?SECRET}, {database, <<"db">>}]}},
    ?assertEqual(
        {report, #{?MASK => 1, opts => [{password, ?MASK}, {database, <<"db">>}]}}, run(In)
    ).

binary_substring_test() ->
    In = {report, #{url => <<"mongodb://u:", (?SECRET)/binary, "@h/db">>}},
    ?assertEqual({report, #{url => <<"mongodb://u:[REDACTED]@h/db">>}}, run(In)).

multiple_occurrences_test() ->
    In = {report, [<<(?SECRET)/binary, "-", (?SECRET)/binary>>]},
    ?assertEqual({report, [<<"[REDACTED]-[REDACTED]">>]}, run(In)).

improper_list_test() ->
    In = {report, [a, b | ?SECRET]},
    ?assertEqual({report, [a, b | ?MASK]}, run(In)),
    In2 = {report, [?SECRET | ?SECRET]},
    ?assertEqual({report, [?MASK | ?MASK]}, run(In2)).

char_list_equal_to_secret_test() ->
    In = {report, #{pw => binary_to_list(?SECRET)}},
    ?assertEqual({report, #{pw => "[REDACTED]"}}, run(In)).

char_list_containing_secret_test() ->
    In = {report, #{s => "pre-" ++ binary_to_list(?SECRET) ++ "-post"}},
    ?assertEqual({report, #{s => "pre-[REDACTED]-post"}}, run(In)).

format_args_test() ->
    ?assertEqual(
        {"login ~p ~s", [{a, ?MASK}, "ok"]},
        run({"login ~p ~s", [{a, ?SECRET}, "ok"]})
    ).

string_msg_test() ->
    ?assertEqual({string, ["x ", ?MASK]}, run({string, ["x ", ?SECRET]})),
    ?assertEqual({string, "[REDACTED]"}, run({string, binary_to_list(?SECRET)})).

non_matching_event_unchanged_test() ->
    Event = event(
        {report, #{event => mongo_ready, list => [1, 2, 3], tup => {a, <<"b">>}, s => "text"}}
    ),
    ?assertEqual(Event, geo_log_redact:filter(Event, [?SECRET])).

empty_secret_list_is_noop_test() ->
    Event = event({report, #{pw => ?SECRET}}),
    ?assertEqual(Event, geo_log_redact:filter(Event, [])).

event_without_msg_unchanged_test() ->
    ?assertEqual(#{level => info}, geo_log_redact:filter(#{level => info}, [?SECRET])).

install_twice_leaves_one_filter_test() ->
    try
        ok = geo_log_redact:install([?SECRET]),
        ok = geo_log_redact:install([?SECRET]),
        ?assertEqual([geo_redact], filter_ids())
    after
        geo_log_redact:uninstall()
    end,
    ?assertEqual([], filter_ids()).

install_empty_removes_filter_test() ->
    try
        ok = geo_log_redact:install([?SECRET]),
        ok = geo_log_redact:install([]),
        ?assertEqual([], filter_ids())
    after
        geo_log_redact:uninstall()
    end.
