%% Bearer-token parsing and verification for the HTTP handlers (ADR-018). Pure: no logging, no
%% Req. The Authorization header is parsed by hand (cow_http_hd:parse_authorization/1 crashes on
%% malformed input and the value would then end up in a stack trace).
-module(geo_http_auth).

-export([bearer/1, check/3, www_authenticate/1]).

-define(MAX_TOKEN, 4096).

%% missing: no credential of the Bearer scheme was presented. invalid: one was, but it is
%% malformed. Two Authorization headers arrive joined with a comma, which makes them invalid.
-spec bearer(binary() | undefined) -> {ok, Token :: binary()} | missing | invalid.
bearer(Value) when is_binary(Value), byte_size(Value) >= 6 ->
    <<Scheme:6/binary, Rest/binary>> = Value,
    %% ASCII-only fold: string:lowercase/1 raises on invalid UTF-8, and header bytes are arbitrary.
    case geo_ascii:lower(Scheme) of
        <<"bearer">> -> credential(Rest);
        _ -> missing
    end;
bearer(_) ->
    missing.

-spec credential(binary()) -> {ok, binary()} | invalid | missing.
credential(<<>>) -> invalid;
credential(<<" ", Token/binary>>) -> token(Token);
credential(_) -> missing.

-spec token(binary()) -> {ok, binary()} | invalid.
token(Token) when byte_size(Token) >= 1, byte_size(Token) =< ?MAX_TOKEN ->
    case lists:all(fun token_char/1, binary_to_list(Token)) of
        true -> {ok, Token};
        false -> invalid
    end;
token(_) ->
    invalid.

-spec token_char(byte()) -> boolean().
token_char(C) ->
    (C >= $A andalso C =< $Z) orelse (C >= $a andalso C =< $z) orelse (C >= $0 andalso C =< $9) orelse
        C =:= $. orelse C =:= $_ orelse C =:= $-.

%% An expired token looks the same as any other invalid one from the outside.
-spec check(binary() | undefined, Key :: binary(), Now :: integer()) ->
    {ok, Sub :: binary()} | {error, missing | invalid}.
check(Header, Key, Now) ->
    case bearer(Header) of
        {ok, Token} ->
            case geo_auth:verify(Token, Key, Now) of
                {ok, #{sub := Sub}} -> {ok, Sub};
                {error, _} -> {error, invalid}
            end;
        missing ->
            {error, missing};
        invalid ->
            {error, invalid}
    end.

-spec www_authenticate(missing | invalid) -> binary().
www_authenticate(missing) -> <<"Bearer realm=\"chaterl-api\"">>;
www_authenticate(invalid) -> <<"Bearer realm=\"chaterl-api\", error=\"invalid_token\"">>.
