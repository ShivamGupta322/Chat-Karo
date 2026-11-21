%% ASCII-only case folding for bytes that come from the network. string:lowercase/1 RAISES
%% badarg on invalid UTF-8 (a header, a charset parameter, a log map key), so it must never see
%% untrusted input. Here only A-Z change; every other byte is left alone.
-module(geo_ascii).

-export([lower/1]).

-spec lower(binary()) -> binary().
lower(Bin) when is_binary(Bin) ->
    <<<<(fold(C))>> || <<C>> <= Bin>>.

-spec fold(byte()) -> byte().
fold(C) when C >= $A, C =< $Z -> C + 32;
fold(C) -> C.
