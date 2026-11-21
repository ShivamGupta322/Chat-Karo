-module(geo_log_redact_tests).

-include_lib("eunit/include/eunit.hrl").

-define(SECRET, <<"s3cret-pw-1x1x">>).
-define(MASK, <<"[REDACTED]">>).

event(Msg) -> #{level => error, msg => Msg, meta => #{}}.

run(Msg) ->
    #{msg := Out} = geo_log_redact:filter(event(Msg), geo_log_redact:args([?SECRET])),
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
    ?assertEqual(Event, geo_log_redact:filter(Event, geo_log_redact:args([?SECRET]))).

empty_secret_list_keeps_other_text_test() ->
    Event = event({report, #{pw => ?SECRET}}),
    ?assertEqual(Event, geo_log_redact:filter(Event, geo_log_redact:args([]))).

event_without_msg_unchanged_test() ->
    ?assertEqual(
        #{level => info}, geo_log_redact:filter(#{level => info}, geo_log_redact:args([?SECRET]))
    ).

install_twice_leaves_one_filter_test() ->
    try
        ok = geo_log_redact:install([?SECRET]),
        ok = geo_log_redact:install([?SECRET]),
        ?assertEqual([geo_redact], filter_ids())
    after
        geo_log_redact:uninstall()
    end,
    ?assertEqual([], filter_ids()).

install_empty_still_installs_filter_test() ->
    try
        ok = geo_log_redact:install([?SECRET]),
        ok = geo_log_redact:install([]),
        ?assertEqual([geo_redact], filter_ids())
    after
        geo_log_redact:uninstall()
    end.

%%% Run-time secrets: patterns and the session secrets ------------------------------------

-define(ADMIN_PW, <<"adm1n-pw-zz9">>).
-define(BASIC, <<"QWRtaW46YWRtMW4tcHctenp5">>).
-define(JWT_SECRET, <<"jwt-secret-0123456789-abcdefghijkl">>).
-define(XP, <<"xp1_abcdefghijklmnopqrstuvwxyz012345">>).

run_session(Msg) ->
    Args = geo_log_redact:args([?ADMIN_PW, ?BASIC, ?JWT_SECRET]),
    #{msg := Out} = geo_log_redact:filter(event(Msg), Args),
    Out.

session_secrets_redacted_test() ->
    ?assertEqual({report, [?MASK]}, run_session({report, [?ADMIN_PW]})),
    ?assertEqual({report, [?MASK]}, run_session({report, [?BASIC]})),
    ?assertEqual({report, [?MASK]}, run_session({report, [?JWT_SECRET]})).

basic_header_string_redacted_test() ->
    Header = "Basic " ++ binary_to_list(?BASIC),
    ?assertEqual({report, #{h => "Basic [REDACTED]"}}, run_session({report, #{h => Header}})),
    HeaderBin = <<"Basic ", (?BASIC)/binary>>,
    ?assertEqual({report, [<<"Basic [REDACTED]">>]}, run_session({report, [HeaderBin]})).

xp1_password_redacted_everywhere_test() ->
    ?assertEqual({report, #{p => ?MASK}}, run_pat({report, #{p => ?XP}})),
    ?assertEqual({report, #{p => "[REDACTED]"}}, run_pat({report, #{p => binary_to_list(?XP)}})),
    ?assertEqual(
        {report, #{a => [{b, #{c => ?MASK}}]}}, run_pat({report, #{a => [{b, #{c => ?XP}}]}})
    ),
    ?assertEqual(
        {report, [<<"login with [REDACTED] failed">>]},
        run_pat({report, [<<"login with ", (?XP)/binary, " failed">>]})
    ),
    ?assertEqual(
        {"pw ~s ~p", ["[REDACTED]", {x, ?MASK}]},
        run_pat({"pw ~s ~p", [binary_to_list(?XP), {x, ?XP}]})
    ).

issued_token_redacted_test() ->
    {Token, _} = geo_auth:issue(<<"u0123456789abcdef0123456789abcdef">>, ?JWT_SECRET, 1800000000),
    ?assertEqual({report, #{t => ?MASK}}, run_pat({report, #{t => Token}})),
    ?assertEqual(
        {report, [<<"Bearer [REDACTED]">>]}, run_pat({report, [<<"Bearer ", Token/binary>>]})
    ).

short_or_partial_values_untouched_test() ->
    Event = event({report, #{a => <<"xp1_short">>, b => <<"eyJ">>, c => <<"eyJhbGci.eyJ">>}}),
    ?assertEqual(Event, geo_log_redact:filter(Event, geo_log_redact:args([]))).

run_pat(Msg) ->
    #{msg := Out} = geo_log_redact:filter(event(Msg), geo_log_redact:args([])),
    Out.
