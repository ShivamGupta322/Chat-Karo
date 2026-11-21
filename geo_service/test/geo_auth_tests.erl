-module(geo_auth_tests).

-include_lib("eunit/include/eunit.hrl").

-define(KEY, <<"0123456789abcdef0123456789abcdef-test-key">>).
-define(SUB, <<"u0123456789abcdef0123456789abcdef">>).
-define(NOW, 1800000000).
-define(HEADER, <<"{\"alg\":\"HS256\",\"typ\":\"JWT\"}">>).
-define(JTI, <<"AAAAAAAAAAAAAAAAAAAAAA">>).

%% RFC 7515 Appendix A.1 (HMAC SHA-256 example). Key = base64url of the JWK "k" value; the
%% token is the compact serialization from A.1.1, checked against the RFC text.
-define(RFC_KEY_B64,
    "AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow"
).
-define(RFC_TOKEN, <<
    "eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9."
    "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ."
    "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
>>).

%%% issue / round trip ---------------------------------------------------------------------

round_trip_test() ->
    {Token, 3600} = geo_auth:issue(?SUB, ?KEY, ?NOW),
    {ok, #{sub := ?SUB, iat := ?NOW, exp := Exp, jti := Jti}} = geo_auth:verify(Token, ?KEY, ?NOW),
    ?assertEqual(?NOW + 3600, Exp),
    ?assertEqual(22, byte_size(Jti)).

header_and_claims_exact_test() ->
    {Token, _} = geo_auth:issue(?SUB, ?KEY, ?NOW),
    [H, P, _S] = binary:split(Token, <<".">>, [global]),
    ?assertEqual(?HEADER, unb64(H)),
    ?assertMatch(
        #{
            <<"iss">> := <<"chaterl-geo">>,
            <<"aud">> := <<"chaterl-api">>,
            <<"sub">> := ?SUB,
            <<"iat">> := ?NOW,
            <<"jti">> := _
        },
        json:decode(unb64(P))
    ),
    ?assertEqual(6, map_size(json:decode(unb64(P)))).

jti_differs_test() ->
    {T1, _} = geo_auth:issue(?SUB, ?KEY, ?NOW),
    {T2, _} = geo_auth:issue(?SUB, ?KEY, ?NOW),
    {ok, #{jti := J1}} = geo_auth:verify(T1, ?KEY, ?NOW),
    {ok, #{jti := J2}} = geo_auth:verify(T2, ?KEY, ?NOW),
    ?assertNotEqual(J1, J2).

%%% RFC 7515 A.1 ---------------------------------------------------------------------------

rfc7515_a1_vector_test() ->
    Key = base64:decode(?RFC_KEY_B64, #{mode => urlsafe, padding => false}),
    {ok, Header, Payload} = geo_auth:verify_hs256(?RFC_TOKEN, Key),
    ?assertEqual(#{<<"typ">> => <<"JWT">>, <<"alg">> => <<"HS256">>}, Header),
    ?assertMatch(#{<<"iss">> := <<"joe">>, <<"exp">> := 1300819380}, Payload),
    %% The same token under another key is rejected.
    ?assertEqual({error, invalid_token}, geo_auth:verify_hs256(?RFC_TOKEN, ?KEY)).

%%% rejections -----------------------------------------------------------------------------

good_token() ->
    {Token, _} = geo_auth:issue(?SUB, ?KEY, ?NOW),
    Token.

verify(Token) -> geo_auth:verify(Token, ?KEY, ?NOW).

flipped_character_test() ->
    [H, P, S] = binary:split(good_token(), <<".">>, [global]),
    ?assertEqual({error, invalid_token}, verify(join([H, flip(P, 10), S]))),
    ?assertEqual({error, invalid_token}, verify(join([H, P, flip(S, 3)]))),
    ?assertEqual({error, invalid_token}, verify(join([flip(H, 5), P, S]))).

wrong_key_test() ->
    ?assertEqual({error, invalid_token}, geo_auth:verify(good_token(), <<"another-key">>, ?NOW)).

alg_none_test() ->
    Payload = good_payload(),
    NoneHeader = b64(<<"{\"alg\":\"none\",\"typ\":\"JWT\"}">>),
    P = b64(Payload),
    [_, _, ValidSig] = binary:split(good_token(), <<".">>, [global]),
    ?assertEqual({error, invalid_token}, verify(join([NoneHeader, P, <<>>]))),
    ?assertEqual({error, invalid_token}, verify(<<NoneHeader/binary, ".", P/binary, ".">>)),
    ?assertEqual({error, invalid_token}, verify(join([NoneHeader, P, ValidSig]))).

other_algorithms_test_() ->
    [
        ?_assertEqual({error, invalid_token}, verify(signed(Header, good_payload(), ?KEY)))
     || Header <- [
            <<"{\"alg\":\"HS512\",\"typ\":\"JWT\"}">>,
            <<"{\"alg\":\"RS256\",\"typ\":\"JWT\"}">>,
            <<"{\"alg\":\"hs256\",\"typ\":\"JWT\"}">>
        ]
    ].

bad_headers_test_() ->
    [
        ?_assertEqual({error, invalid_token}, verify(signed(Header, good_payload(), ?KEY)))
     || Header <- [
            <<"{\"alg\":\"HS256\",\"typ\":\"JWT\",\"kid\":\"1\"}">>,
            <<"{\"alg\":\"HS256\",\"typ\":\"JWT\",\"crit\":[\"exp\"]}">>,
            <<"{\"alg\":\"HS256\",\"typ\":\"JWT\",\"jku\":\"http://x\"}">>,
            <<"{\"alg\":\"HS256\",\"typ\":\"JWS\"}">>,
            <<"{\"alg\":\"HS256\"}">>,
            <<"{\"typ\":\"JWT\"}">>,
            <<"not json">>,
            <<"[\"HS256\"]">>,
            <<"\"HS256\"">>
        ]
    ].

segment_structure_test_() ->
    [H, P, S] = binary:split(good_token(), <<".">>, [global]),
    [
        ?_assertEqual({error, invalid_token}, verify(join([H, P]))),
        ?_assertEqual({error, invalid_token}, verify(join([H, P, S, S]))),
        ?_assertEqual({error, invalid_token}, verify(join([<<>>, P, S]))),
        ?_assertEqual({error, invalid_token}, verify(join([H, <<>>, S]))),
        ?_assertEqual({error, invalid_token}, verify(join([H, P, <<>>]))),
        ?_assertEqual({error, invalid_token}, verify(<<>>)),
        ?_assertEqual({error, invalid_token}, verify(<<"...">>)),
        ?_assertEqual({error, invalid_token}, geo_auth:verify(not_a_binary, ?KEY, ?NOW))
    ].

base64_strictness_test() ->
    [H, P, S] = binary:split(good_token(), <<".">>, [global]),
    %% Padding, standard-alphabet characters and a non-canonical last character.
    ?assertEqual({error, invalid_token}, verify(join([H, P, <<S/binary, "=">>]))),
    ?assertEqual({error, invalid_token}, verify(join([<<H/binary, "==">>, P, S]))),
    ?assertEqual({error, invalid_token}, verify(join([H, <<P/binary, "+">>, S]))),
    ?assertEqual(
        {error, invalid_token},
        verify(
            join([
                H,
                P,
                <<
                    (binary:part(S, 0, 10))/binary,
                    "/",
                    (binary:part(S, 11, byte_size(S) - 11))/binary
                >>
            ])
        )
    ),
    ?assertEqual({error, invalid_token}, verify(join([H, P, noncanonical(S)]))).

too_long_test() ->
    Long = binary:copy(<<"a">>, 4097),
    ?assertEqual({error, invalid_token}, verify(Long)),
    Big = signed(?HEADER, json_obj([{<<"pad">>, binary:copy(<<"x">>, 5000)}]), ?KEY),
    ?assertEqual({error, invalid_token}, verify(Big)).

payload_shape_test_() ->
    Claims = claims(),
    Cases = [
        lists:keydelete(<<"jti">>, 1, Claims),
        lists:keydelete(<<"iss">>, 1, Claims),
        Claims ++ [{<<"nickname">>, <<"Zed">>}],
        lists:keystore(<<"exp">>, 1, Claims, {<<"exp">>, 1.8e9}),
        lists:keystore(<<"exp">>, 1, Claims, {<<"exp">>, <<"1800003600">>}),
        lists:keystore(<<"iat">>, 1, Claims, {<<"iat">>, <<"1800000000">>}),
        lists:keystore(<<"iss">>, 1, Claims, {<<"iss">>, <<"someone-else">>}),
        lists:keystore(<<"aud">>, 1, Claims, {<<"aud">>, <<"other-api">>}),
        lists:keystore(<<"sub">>, 1, Claims, {<<"sub">>, <<"alice">>}),
        lists:keystore(<<"sub">>, 1, Claims, {<<"sub">>, <<"U0123456789abcdef0123456789abcdef">>}),
        lists:keystore(<<"sub">>, 1, Claims, {<<"sub">>, <<"u0123456789abcdef0123456789abcde">>}),
        lists:keystore(<<"sub">>, 1, Claims, {<<"sub">>, 42}),
        lists:keystore(<<"jti">>, 1, Claims, {<<"jti">>, <<"short">>}),
        %% exp - iat = 3601
        lists:keystore(<<"exp">>, 1, Claims, {<<"exp">>, ?NOW + 3601})
    ],
    [
        ?_assertEqual({error, invalid_token}, verify(signed(?HEADER, json_obj(C), ?KEY)))
     || C <- Cases
    ] ++
        [
            ?_assertEqual({error, invalid_token}, verify(signed(?HEADER, <<"[1,2]">>, ?KEY))),
            ?_assertEqual({error, invalid_token}, verify(signed(?HEADER, <<"nope">>, ?KEY))),
            ?_assertMatch({ok, _}, verify(signed(?HEADER, json_obj(Claims), ?KEY)))
        ].

%%% time -----------------------------------------------------------------------------------

expiry_skew_test() ->
    Token = good_token(),
    Exp = ?NOW + 3600,
    ?assertMatch({ok, _}, geo_auth:verify(Token, ?KEY, Exp + 29)),
    ?assertEqual({error, expired}, geo_auth:verify(Token, ?KEY, Exp + 30)),
    ?assertEqual({error, expired}, geo_auth:verify(Token, ?KEY, Exp + 1000)).

issued_in_future_test() ->
    Token = good_token(),
    ?assertMatch({ok, _}, geo_auth:verify(Token, ?KEY, ?NOW - 30)),
    ?assertEqual({error, invalid_token}, geo_auth:verify(Token, ?KEY, ?NOW - 31)).

%%% helpers --------------------------------------------------------------------------------

claims() ->
    [
        {<<"iss">>, <<"chaterl-geo">>},
        {<<"aud">>, <<"chaterl-api">>},
        {<<"sub">>, ?SUB},
        {<<"iat">>, ?NOW},
        {<<"exp">>, ?NOW + 3600},
        {<<"jti">>, ?JTI}
    ].

good_payload() -> json_obj(claims()).

json_obj(Pairs) ->
    iolist_to_binary(json:encode_key_value_list(Pairs, fun json:encode_value/2)).

b64(Bin) -> base64:encode(Bin, #{mode => urlsafe, padding => false}).

unb64(Bin) -> base64:decode(Bin, #{mode => urlsafe, padding => false}).

signed(HeaderJson, PayloadJson, Key) ->
    Input = <<(b64(HeaderJson))/binary, ".", (b64(PayloadJson))/binary>>,
    <<Input/binary, ".", (b64(crypto:mac(hmac, sha256, Key, Input)))/binary>>.

join(Parts) -> iolist_to_binary(lists:join(<<".">>, Parts)).

%% Replaces the character at Pos with a different base64url character.
flip(Bin, Pos) ->
    <<Before:Pos/binary, C, After/binary>> = Bin,
    New =
        case C of
            $A -> $B;
            _ -> $A
        end,
    <<Before/binary, New, After/binary>>.

%% A 43-character segment encodes 32 bytes: the last character carries only 4 payload bits, so
%% another character with the same top bits decodes to the same bytes but is non-canonical.
noncanonical(Seg) ->
    Size = byte_size(Seg) - 1,
    <<Head:Size/binary, Last>> = Seg,
    Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    Index = length(lists:takewhile(fun(C) -> C =/= Last end, Alphabet)),
    Other = lists:nth(1 + (Index bxor 1), Alphabet),
    <<Head/binary, Other>>.
