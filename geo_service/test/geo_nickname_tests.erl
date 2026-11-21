-module(geo_nickname_tests).

-include_lib("eunit/include/eunit.hrl").

valid_test_() ->
    [
        ?_assertEqual({ok, Nick}, geo_nickname:validate(Nick))
     || Nick <- [
            <<"Al">>,
            <<"zed_99">>,
            <<"A-b">>,
            <<"9z">>,
            <<"Zed">>,
            binary:copy(<<"a">>, 20)
        ]
    ].

invalid_test_() ->
    [
        ?_assertEqual({error, invalid}, geo_nickname:validate(In))
     || In <- [
            <<>>,
            <<"a">>,
            binary:copy(<<"a">>, 21),
            <<"_ab">>,
            <<"-ab">>,
            <<"a b">>,
            <<"ü"/utf8, "x">>,
            <<"ab", 16#1F600/utf8>>,
            <<"<script>">>,
            <<"a@b">>,
            <<"a/b">>,
            <<"ab\n">>,
            "Zed",
            zed,
            42,
            undefined,
            #{}
        ]
    ].

reserved_is_case_insensitive_test_() ->
    [
        ?_assertEqual({error, reserved}, geo_nickname:validate(Nick))
     || Nick <- [<<"ADMIN">>, <<"Nearby">>, <<"geo_service">>, <<"Me">>, <<"mongooseim">>]
    ].

reserved_only_matches_exactly_test_() ->
    [
        ?_assertEqual({ok, <<"admin1">>}, geo_nickname:validate(<<"admin1">>)),
        ?_assertEqual({ok, <<"my_admin">>}, geo_nickname:validate(<<"my_admin">>))
    ].
