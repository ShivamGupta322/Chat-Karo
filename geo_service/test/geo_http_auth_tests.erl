-module(geo_http_auth_tests).

-include_lib("eunit/include/eunit.hrl").
%% eunit.hrl defines a LET macro too; it is not used here.
-undef(LET).
-include_lib("proper/include/proper.hrl").

-define(KEY, <<"auth-test-key-0123456789-abcdefghijklmnop">>).
-define(SUB, <<"u0123456789abcdef0123456789abcdef">>).
-define(NOW, 1800000000).

bearer_missing_test_() ->
    [
        ?_assertEqual(missing, geo_http_auth:bearer(In))
     || In <- [
            undefined,
            <<>>,
            <<"Basic abc">>,
            <<"Digest x">>,
            <<"Bear abc">>,
            <<"Bearerx abc">>,
            <<"abc">>
        ]
    ].

%% Regression (found by the totality property): string:lowercase/1 raised on invalid UTF-8.
bearer_invalid_utf8_scheme_test_() ->
    [
        ?_assertEqual(missing, geo_http_auth:bearer(<<255, 254, 195, 40, 128, 129>>)),
        ?_assertEqual(
            {error, missing}, geo_http_auth:check(<<255, 254, 195, 40, 128, 129>>, ?KEY, ?NOW)
        ),
        ?_assertEqual(invalid, geo_http_auth:bearer(<<"Bearer ", 255, 195, 40>>))
    ].

bearer_ok_test_() ->
    [
        ?_assertEqual({ok, <<"abc">>}, geo_http_auth:bearer(In))
     || In <- [<<"Bearer abc">>, <<"bearer abc">>, <<"BeArEr abc">>, <<"BEARER abc">>]
    ] ++
        [
            ?_assertEqual({ok, <<"a.b_c-9">>}, geo_http_auth:bearer(<<"Bearer a.b_c-9">>)),
            ?_assertEqual(
                {ok, binary:copy(<<"a">>, 4096)},
                geo_http_auth:bearer(<<"Bearer ", (binary:copy(<<"a">>, 4096))/binary>>)
            )
        ].

bearer_invalid_test_() ->
    [
        ?_assertEqual(invalid, geo_http_auth:bearer(In))
     || In <- [
            <<"Bearer">>,
            <<"bearer">>,
            <<"Bearer ">>,
            <<"Bearer  abc">>,
            <<"Bearer abc def">>,
            <<"Bearer a, Bearer b">>,
            <<"Bearer a\"b">>,
            <<"Bearer a,b">>,
            <<"Bearer a\tb">>,
            <<"Bearer a+b">>,
            <<"Bearer a=b">>,
            <<"Bearer ", (binary:copy(<<"a">>, 4097))/binary>>
        ]
    ].

check_test_() ->
    {Good, _} = geo_auth:issue(?SUB, ?KEY, ?NOW),
    {Expired, _} = geo_auth:issue(?SUB, ?KEY, ?NOW - 3700),
    {Other, _} = geo_auth:issue(?SUB, <<"another-key-0123456789-abcdefghijklmnop">>, ?NOW),
    [Header, Payload, Signature] = binary:split(Good, <<".">>, [global]),
    Claims = json:decode(base64:decode(Payload, #{mode => urlsafe, padding => false})),
    Forged = base64:encode(
        iolist_to_binary(
            json:encode(Claims#{<<"sub">> => <<"u00000000000000000000000000000000">>})
        ),
        #{mode => urlsafe, padding => false}
    ),
    Tampered = <<Header/binary, ".", Forged/binary, ".", Signature/binary>>,
    NoneHeader = base64:encode(<<"{\"alg\":\"none\",\"typ\":\"JWT\"}">>, #{
        mode => urlsafe, padding => false
    }),
    AlgNone = <<NoneHeader/binary, ".", Payload/binary, ".">>,
    Auth = fun(Token) -> <<"Bearer ", Token/binary>> end,
    [
        ?_assertEqual({ok, ?SUB}, geo_http_auth:check(Auth(Good), ?KEY, ?NOW)),
        ?_assertEqual({ok, ?SUB}, geo_http_auth:check(<<"bearer ", Good/binary>>, ?KEY, ?NOW)),
        ?_assertEqual({error, invalid}, geo_http_auth:check(Auth(Expired), ?KEY, ?NOW)),
        ?_assertEqual({error, invalid}, geo_http_auth:check(Auth(Tampered), ?KEY, ?NOW)),
        ?_assertEqual({error, invalid}, geo_http_auth:check(Auth(AlgNone), ?KEY, ?NOW)),
        ?_assertEqual({error, invalid}, geo_http_auth:check(Auth(Other), ?KEY, ?NOW)),
        ?_assertEqual({error, invalid}, geo_http_auth:check(<<"Bearer">>, ?KEY, ?NOW)),
        ?_assertEqual({error, missing}, geo_http_auth:check(undefined, ?KEY, ?NOW)),
        ?_assertEqual({error, missing}, geo_http_auth:check(<<"Basic abc">>, ?KEY, ?NOW))
    ].

%%% Totality (PropEr) ----------------------------------------------------------------------

header_gen() ->
    frequency([
        {3, binary()},
        {2, ?LET(Tail, binary(), <<"Bearer ", Tail/binary>>)},
        {1, ?LET(Tail, binary(), <<"bearer", Tail/binary>>)},
        %% invalid UTF-8 in the scheme position and in the token
        {1, ?LET(Tail, binary(), <<16#FF, 16#FE, 16#C3, 16#28, 16#80, 16#81, Tail/binary>>)},
        {1, ?LET(Tail, binary(), <<"Bearer ", 16#FF, 16#C3, 16#28, Tail/binary>>)},
        {1, undefined}
    ]).

prop_bearer_total() ->
    ?FORALL(
        H,
        header_gen(),
        case catch geo_http_auth:bearer(H) of
            {ok, T} -> is_binary(T);
            missing -> true;
            invalid -> true;
            _ -> false
        end
    ).

prop_check_total() ->
    ?FORALL(
        H,
        header_gen(),
        case catch geo_http_auth:check(H, ?KEY, ?NOW) of
            {ok, Sub} -> is_binary(Sub);
            {error, missing} -> true;
            {error, invalid} -> true;
            _ -> false
        end
    ).

bearer_total_test_() ->
    {timeout, 120, fun() ->
        ?assert(proper:quickcheck(prop_bearer_total(), [{numtests, 1000}, {to_file, user}]))
    end}.

check_total_test_() ->
    {timeout, 120, fun() ->
        ?assert(proper:quickcheck(prop_check_total(), [{numtests, 1000}, {to_file, user}]))
    end}.

www_authenticate_test_() ->
    [
        ?_assertEqual(<<"Bearer realm=\"chaterl-api\"">>, geo_http_auth:www_authenticate(missing)),
        ?_assertEqual(
            <<"Bearer realm=\"chaterl-api\", error=\"invalid_token\"">>,
            geo_http_auth:www_authenticate(invalid)
        )
    ].
