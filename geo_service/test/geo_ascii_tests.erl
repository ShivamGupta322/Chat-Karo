-module(geo_ascii_tests).

-include_lib("eunit/include/eunit.hrl").
-undef(LET).
-include_lib("proper/include/proper.hrl").

vectors_test() ->
    ?assertEqual(<<>>, geo_ascii:lower(<<>>)),
    ?assertEqual(<<"bearer">>, geo_ascii:lower(<<"BeArEr">>)),
    ?assertEqual(<<"utf-8">>, geo_ascii:lower(<<"UTF-8">>)),
    ?assertEqual(<<"az@[`{">>, geo_ascii:lower(<<"AZ@[`{">>)),
    ?assertEqual(<<"abc xyz 019">>, geo_ascii:lower(<<"ABC XYZ 019">>)).

invalid_utf8_untouched_test() ->
    ?assertEqual(<<255>>, geo_ascii:lower(<<255>>)),
    ?assertEqual(<<"la", 200>>, geo_ascii:lower(<<"La", 200>>)),
    %% valid non-ASCII is not folded either
    ?assertEqual(<<"É"/utf8>>, geo_ascii:lower(<<"É"/utf8>>)).

prop_total_idempotent() ->
    ?FORALL(
        B,
        binary(),
        begin
            L = geo_ascii:lower(B),
            byte_size(L) =:= byte_size(B) andalso L =:= geo_ascii:lower(L)
        end
    ).

total_idempotent_test_() ->
    {timeout, 120, fun() ->
        ?assert(proper:quickcheck(prop_total_idempotent(), [{numtests, 1000}, {to_file, user}]))
    end}.
