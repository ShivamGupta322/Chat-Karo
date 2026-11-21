%% Pure HS256 JWT issue/verify for the geo_service API (ADR-017). No logging, no I/O.
%% HS256 only: the algorithm is never read from the token to pick a verifier, the header must
%% match exactly, and the signature is compared in constant time before the payload is parsed.
-module(geo_auth).

-export([issue/3, verify/3, verify_hs256/2]).
-export_type([claims/0]).

-define(TTL, 3600).
-define(SKEW, 30).
-define(MAX_TOKEN, 4096).
-define(ISS, <<"chaterl-geo">>).
-define(AUD, <<"chaterl-api">>).
-define(HEADER, <<"{\"alg\":\"HS256\",\"typ\":\"JWT\"}">>).

-type claims() :: #{sub := binary(), iat := integer(), exp := integer(), jti := binary()}.

-spec issue(Sub :: binary(), Key :: binary(), Now :: integer()) ->
    {Token :: binary(), ExpiresIn :: 3600}.
issue(Sub, Key, Now) ->
    Jti = b64(crypto:strong_rand_bytes(16)),
    Payload = iolist_to_binary(
        json:encode_key_value_list(
            [
                {<<"iss">>, ?ISS},
                {<<"aud">>, ?AUD},
                {<<"sub">>, Sub},
                {<<"iat">>, Now},
                {<<"exp">>, Now + ?TTL},
                {<<"jti">>, Jti}
            ],
            fun json:encode_value/2
        )
    ),
    SigningInput = <<(b64(?HEADER))/binary, ".", (b64(Payload))/binary>>,
    Signature = crypto:mac(hmac, sha256, Key, SigningInput),
    {<<SigningInput/binary, ".", (b64(Signature))/binary>>, ?TTL}.

-spec verify(Token :: binary(), Key :: binary(), Now :: integer()) ->
    {ok, claims()} | {error, invalid_token | expired}.
verify(Token, Key, Now) ->
    case verify_hs256(Token, Key) of
        {ok, #{<<"alg">> := <<"HS256">>, <<"typ">> := <<"JWT">>} = Header, Payload} when
            map_size(Header) =:= 2
        ->
            check_claims(Payload, Now);
        {ok, _Header, _Payload} ->
            {error, invalid_token};
        {error, invalid_token} = Error ->
            Error
    end.

%% Signature and structure only: no claim checks. The header may only hold alg (HS256) and,
%% optionally, typ (JWT).
-spec verify_hs256(Token :: binary(), Key :: binary()) ->
    {ok, Header :: map(), Payload :: map()} | {error, invalid_token}.
verify_hs256(Token, Key) when is_binary(Token), is_binary(Key), byte_size(Token) =< ?MAX_TOKEN ->
    case binary:split(Token, <<".">>, [global]) of
        [H, P, S] when H =/= <<>>, P =/= <<>>, S =/= <<>> ->
            maybe
                {ok, Sig} ?= unb64(S),
                {ok, HeaderJson} ?= unb64(H),
                {ok, PayloadJson} ?= unb64(P),
                ok ?= check_signature(<<H/binary, ".", P/binary>>, Sig, Key),
                {ok, Header} ?= decode_object(HeaderJson),
                ok ?= check_header(Header),
                {ok, Payload} ?= decode_object(PayloadJson),
                {ok, Header, Payload}
            end;
        _ ->
            {error, invalid_token}
    end;
verify_hs256(_Token, _Key) ->
    {error, invalid_token}.

-spec check_signature(binary(), binary(), binary()) -> ok | {error, invalid_token}.
check_signature(SigningInput, Sig, Key) ->
    Expected = crypto:mac(hmac, sha256, Key, SigningInput),
    %% hash_equals/2 needs equal sizes; the length of a SHA-256 MAC is public.
    case byte_size(Sig) =:= byte_size(Expected) andalso crypto:hash_equals(Expected, Sig) of
        true -> ok;
        false -> {error, invalid_token}
    end.

-spec check_header(map()) -> ok | {error, invalid_token}.
check_header(#{<<"alg">> := <<"HS256">>} = Header) ->
    case maps:remove(<<"alg">>, Header) of
        Rest when map_size(Rest) =:= 0 -> ok;
        #{<<"typ">> := <<"JWT">>} = Rest when map_size(Rest) =:= 1 -> ok;
        _ -> {error, invalid_token}
    end;
check_header(_) ->
    {error, invalid_token}.

-spec decode_object(binary()) -> {ok, map()} | {error, invalid_token}.
decode_object(Json) ->
    try json:decode(Json) of
        Map when is_map(Map) -> {ok, Map};
        _ -> {error, invalid_token}
    catch
        error:_ -> {error, invalid_token}
    end.

-spec check_claims(map(), integer()) -> {ok, claims()} | {error, invalid_token | expired}.
check_claims(
    #{
        <<"iss">> := ?ISS,
        <<"aud">> := ?AUD,
        <<"sub">> := Sub,
        <<"iat">> := Iat,
        <<"exp">> := Exp,
        <<"jti">> := Jti
    } = Payload,
    Now
) when
    map_size(Payload) =:= 6,
    is_binary(Sub),
    is_integer(Iat),
    is_integer(Exp),
    is_binary(Jti)
->
    case valid_sub(Sub) andalso valid_jti(Jti) andalso Exp - Iat >= 0 andalso Exp - Iat =< ?TTL of
        false ->
            {error, invalid_token};
        true when Iat > Now + ?SKEW ->
            {error, invalid_token};
        true when Now >= Exp + ?SKEW ->
            {error, expired};
        true ->
            {ok, #{sub => Sub, iat => Iat, exp => Exp, jti => Jti}}
    end;
check_claims(_, _) ->
    {error, invalid_token}.

%% u + 32 lowercase hex, as made by geo_session:new_localpart/0.
-spec valid_sub(binary()) -> boolean().
valid_sub(<<$u, Hex:32/binary>>) -> lists:all(fun is_hex/1, binary_to_list(Hex));
valid_sub(_) -> false.

-spec is_hex(byte()) -> boolean().
is_hex(C) -> (C >= $0 andalso C =< $9) orelse (C >= $a andalso C =< $f).

%% 128 random bits in base64url: 22 characters.
-spec valid_jti(binary()) -> boolean().
valid_jti(Jti) when byte_size(Jti) =:= 22 -> unb64(Jti) =/= {error, invalid_token};
valid_jti(_) -> false.

-spec b64(binary()) -> binary().
b64(Bin) -> base64:encode(Bin, #{mode => urlsafe, padding => false}).

%% Strict base64url: URL-safe alphabet only, no padding, and the last character must be the
%% canonical one (decoding then re-encoding gives back the input).
-spec unb64(binary()) -> {ok, binary()} | {error, invalid_token}.
unb64(Seg) when byte_size(Seg) rem 4 =/= 1 ->
    case lists:all(fun is_b64url/1, binary_to_list(Seg)) of
        true ->
            try base64:decode(Seg, #{mode => urlsafe, padding => false}) of
                Bin ->
                    case b64(Bin) =:= Seg of
                        true -> {ok, Bin};
                        false -> {error, invalid_token}
                    end
            catch
                error:_ -> {error, invalid_token}
            end;
        false ->
            {error, invalid_token}
    end;
unb64(_) ->
    {error, invalid_token}.

-spec is_b64url(byte()) -> boolean().
is_b64url(C) ->
    (C >= $A andalso C =< $Z) orelse (C >= $a andalso C =< $z) orelse (C >= $0 andalso C =< $9) orelse
        C =:= $- orelse C =:= $_.
