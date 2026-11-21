-module(geo_log_redact_tests).

-include_lib("eunit/include/eunit.hrl").
%% eunit.hrl defines a LET macro too; it is not used here.
-undef(LET).
-include_lib("proper/include/proper.hrl").

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

%% Pins the documented gap (ADR-018 4a): a bare float that is not next to a coordinate-named key
%% passes through unchanged. If this ever changes, change it deliberately and update the docs.
bare_float_in_reason_passes_unchanged_test() ->
    Event = event({report, #{r => {injected, 57.6491137}}}),
    ?assertEqual(Event, geo_log_redact:filter(Event, geo_log_redact:args([]))).

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

%%% Coordinates (ADR-018) -------------------------------------------------------------------

coord_map_test() ->
    In =
        {report, #{
            body => #{<<"lat">> => 57.6491137, <<"lng">> => 10.4074419, <<"range">> => <<"block">>}
        }},
    ?assertEqual(
        {report, #{body => #{<<"lat">> => ?MASK, <<"lng">> => ?MASK, <<"range">> => <<"block">>}}},
        run_pat(In)
    ).

coord_map_key_variants_test() ->
    In =
        {report, [
            #{<<"LAT">> => 1.5},
            #{latitude => 1.5},
            #{<<"Longitude">> => 1.5},
            #{lon => 1.5},
            #{<<"accuracy">> => 25},
            #{accuracy => 25}
        ]},
    ?assertEqual(
        {report, [
            #{<<"LAT">> => ?MASK},
            #{latitude => ?MASK},
            #{<<"Longitude">> => ?MASK},
            #{lon => ?MASK},
            #{<<"accuracy">> => ?MASK},
            #{accuracy => ?MASK}
        ]},
        run_pat(In)
    ).

coord_map_other_keys_untouched_test() ->
    In = {report, #{<<"latency">> => 57, <<"range">> => <<"block">>, <<"x">> => 1.5}},
    ?assertEqual(In, run_pat(In)).

coord_raw_body_test() ->
    Body = <<"{\"lat\":57.6491137, \"lng\" : -10.4074419,\"accuracy\":25}">>,
    Expected = <<"{\"lat\":[REDACTED], \"lng\" : [REDACTED],\"accuracy\":[REDACTED]}">>,
    ?assertEqual({report, [Expected]}, run_pat({report, [Body]})),
    ?assertEqual(
        {report, #{b => binary_to_list(Expected)}},
        run_pat({report, #{b => binary_to_list(Body)}})
    ).

coord_raw_body_last_member_and_string_test() ->
    ?assertEqual(
        {report, [<<"{\"lng\":[REDACTED]}">>]}, run_pat({report, [<<"{\"lng\":10.4074419}">>]})
    ),
    ?assertEqual(
        {report, [<<"{\"Lat\": [REDACTED],\"range\":\"block\"}">>]},
        run_pat({report, [<<"{\"Lat\": \"57.6\",\"range\":\"block\"}">>]})
    ),
    ?assertEqual(
        {report, ["\"lat\": [REDACTED]"]}, run_pat({report, ["\"lat\": \"57.6\""]})
    ).

coord_preformatted_map_test() ->
    ?assertEqual(
        {report, ["#{<<\"lat\">> => [REDACTED]}"]},
        run_pat({report, ["#{<<\"lat\">> => 57.6491137}"]})
    ),
    ?assertEqual(
        {"~s", ["#{<<\"lng\">> => [REDACTED],<<\"range\">> => <<\"block\">>}"]},
        run_pat({"~s", ["#{<<\"lng\">> => -10.4074419,<<\"range\">> => <<\"block\">>}"]})
    ).

coord_unrelated_text_untouched_test() ->
    Event = event({report, [<<"{\"latency\": 57}">>, "\"range\": \"block\"", <<"\"lati\":1">>]}),
    ?assertEqual(Event, geo_log_redact:filter(Event, geo_log_redact:args([]))).

coord_filter_keeps_secrets_working_test() ->
    ?assertEqual(
        {report, #{p => ?MASK, l => #{<<"lat">> => ?MASK}}},
        run_pat({report, #{p => ?XP, l => #{<<"lat">> => 1.5}}})
    ),
    ?assertEqual({report, [?MASK]}, run_session({report, [?ADMIN_PW]})).

%%% Totality (regression: string:lowercase/1 raised on invalid UTF-8 map keys, logger then
%%% removed the failing filter and later events went out unredacted) ---------------------------

invalid_utf8_key_does_not_raise_test() ->
    Msg = {report, #{<<255>> => 1, <<"LAT">> => 1.5, <<"La", 200>> => x}},
    #{msg := {report, Out}} = geo_log_redact:filter(event(Msg), geo_log_redact:args([?SECRET])),
    ?assertEqual(?MASK, maps:get(<<"LAT">>, Out)),
    ?assertEqual(1, maps:get(<<255>>, Out)),
    ?assertEqual(x, maps:get(<<"La", 200>>, Out)).

filter_survives_logging_invalid_utf8_key_test() ->
    try
        ok = geo_log_redact:install([?SECRET]),
        logger:error(#{<<255>> => 1}),
        ?assertEqual([geo_redact], filter_ids())
    after
        geo_log_redact:uninstall()
    end.

filter_failure_drops_event_test() ->
    %% A broken args map makes redaction raise: the message is replaced by a fixed, value-free
    %% placeholder (level kept), not propagated and not passed through unredacted.
    Out = geo_log_redact:filter(
        event({report, <<"secret-payload">>}), #{secrets => [], patterns => bad}
    ),
    ?assertMatch(
        #{level := error, msg := {string, <<"[REDACTED: log redaction failed", _/binary>>}}, Out
    ),
    ?assertEqual(nomatch, string:find(io_lib:format("~p", [Out]), "secret-payload")).

term_gen() ->
    term_gen(3).

term_gen(0) ->
    oneof([
        resize(20, binary()),
        resize(20, list(range(0, 255))),
        integer(),
        float(),
        oneof([lat, lng, accuracy, foo, bar]),
        <<255>>,
        <<"LAT">>,
        <<"La", 200>>,
        "xp1_abcdefghijklmnopqrstuvwxyz012345",
        <<"{\"lat\":1.5}">>
    ]);
term_gen(N) ->
    Sub = term_gen(N - 1),
    oneof([
        term_gen(0),
        resize(3, list(Sub)),
        ?LET(L, resize(3, list(Sub)), list_to_tuple(L)),
        ?LET(
            L,
            resize(3, list({oneof([binary(), <<255>>, <<"Lng">>, lat, foo, integer()]), Sub})),
            maps:from_list(L)
        ),
        ?LET({H, T}, {Sub, Sub}, [H | T])
    ]).

prop_filter_never_raises() ->
    ?FORALL(
        {Msg, Meta},
        {
            oneof([
                {report, term_gen()},
                {string, term_gen()},
                {"fmt ~p", resize(3, list(term_gen()))},
                term_gen()
            ]),
            term_gen()
        },
        begin
            Event = #{level => error, msg => Msg, meta => #{x => Meta}},
            %% Redaction itself must never raise: reaching the catch-all (the fixed placeholder)
            %% counts as a failure here. filter_failure_drops_event_test covers the catch path.
            case catch geo_log_redact:filter(Event, geo_log_redact:args([?SECRET])) of
                #{msg := {string, <<"[REDACTED: log redaction failed", _/binary>>}} -> false;
                #{msg := _} -> true;
                _ -> false
            end
        end
    ).

filter_never_raises_test_() ->
    {timeout, 300, fun() ->
        ?assert(proper:quickcheck(prop_filter_never_raises(), [{numtests, 1000}, {to_file, user}]))
    end}.
