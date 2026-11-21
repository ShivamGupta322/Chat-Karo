%% Nickname rules (ADR-017): ASCII, 2..20 characters, case preserved. Reserved names are
%% reported separately so the caller can answer them exactly like a taken name.
-module(geo_nickname).

-export([validate/1]).

-define(RESERVED, [
    <<"admin">>,
    <<"administrator">>,
    <<"mod">>,
    <<"moderator">>,
    <<"root">>,
    <<"system">>,
    <<"sysop">>,
    <<"staff">>,
    <<"support">>,
    <<"help">>,
    <<"official">>,
    <<"nearby">>,
    <<"chaterl">>,
    <<"geo">>,
    <<"geo_service">>,
    <<"greeter">>,
    <<"bot">>,
    <<"server">>,
    <<"mongooseim">>,
    <<"xmpp">>,
    <<"null">>,
    <<"undefined">>,
    <<"anonymous">>,
    <<"everyone">>,
    <<"here">>,
    <<"me">>,
    <<"you">>
]).

-spec validate(term()) -> {ok, binary()} | {error, invalid | reserved}.
validate(<<First, _/binary>> = Nick) when byte_size(Nick) >= 2, byte_size(Nick) =< 20 ->
    case alnum(First) andalso lists:all(fun nick_char/1, binary_to_list(Nick)) of
        true ->
            case lists:member(ascii_lower(Nick), ?RESERVED) of
                true -> {error, reserved};
                false -> {ok, Nick}
            end;
        false ->
            {error, invalid}
    end;
validate(_) ->
    {error, invalid}.

-spec alnum(byte()) -> boolean().
alnum(C) ->
    (C >= $a andalso C =< $z) orelse (C >= $A andalso C =< $Z) orelse (C >= $0 andalso C =< $9).

-spec nick_char(byte()) -> boolean().
nick_char(C) -> alnum(C) orelse C =:= $_ orelse C =:= $-.

-spec ascii_lower(binary()) -> binary().
ascii_lower(Bin) -> list_to_binary([lower(C) || <<C>> <= Bin]).

-spec lower(byte()) -> byte().
lower(C) when C >= $A, C =< $Z -> C + 32;
lower(C) -> C.
