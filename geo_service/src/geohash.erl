%% Pure geohash (base32) encode / bounds / centre / neighbours.
%% Same algorithm as web/src/geo/geohash.ts: longitude bit first, a value at or above the
%% midpoint takes the upper half. No logging, no processes; errors are atoms only.
-module(geohash).

-export([encode/3, bounds/1, centre/1, neighbour/2, neighbours/1]).
-export_type([geohash/0, precision/0, direction/0, bounds/0]).

-type geohash() :: binary().
-type precision() :: 1..12.
-type direction() :: n | ne | e | se | s | sw | w | nw.
-type bounds() :: #{south := float(), west := float(), north := float(), east := float()}.
-type encode_error() :: invalid_precision | lat_out_of_range | lng_out_of_range.

-define(ALPHABET, <<"0123456789bcdefghjkmnpqrstuvwxyz">>).
-define(DIRECTIONS, [n, ne, e, se, s, sw, w, nw]).

%% Check order as in the TS: precision, then lat, then lng.
-spec encode(Lat :: term(), Lng :: term(), Precision :: term()) ->
    {ok, geohash()} | {error, encode_error()}.
encode(_Lat, _Lng, P) when not is_integer(P); P < 1; P > 12 ->
    {error, invalid_precision};
encode(Lat, _Lng, _P) when not is_number(Lat); Lat < -90; Lat > 90 ->
    {error, lat_out_of_range};
encode(_Lat, Lng, _P) when not is_number(Lng); Lng < -180; Lng > 180 ->
    {error, lng_out_of_range};
encode(Lat, Lng, P) ->
    {ok, encode_chars(float(Lat), float(Lng), P, {-90.0, 90.0, -180.0, 180.0}, <<>>)}.

%% Box is {LatLo, LatHi, LngLo, LngHi}. Each char consumes 5 bits starting on the lng axis;
%% 5 is odd, so chars alternate lng-first / lat-first.
-spec encode_chars(float(), float(), non_neg_integer(), box(), binary()) -> geohash().
encode_chars(_Lat, _Lng, 0, _Box, Out) ->
    Out;
encode_chars(Lat, Lng, Left, Box0, Out) ->
    Even = (byte_size(Out) rem 2) =:= 0,
    {Index, Box} = encode_bits(Lat, Lng, 5, Even, Box0, 0),
    Char = binary:at(?ALPHABET, Index),
    encode_chars(Lat, Lng, Left - 1, Box, <<Out/binary, Char>>).

-type box() :: {float(), float(), float(), float()}.

-spec encode_bits(float(), float(), non_neg_integer(), boolean(), box(), non_neg_integer()) ->
    {non_neg_integer(), box()}.
encode_bits(_Lat, _Lng, 0, _Even, Box, Index) ->
    {Index, Box};
encode_bits(Lat, Lng, N, true, {LaLo, LaHi, LoLo, LoHi}, Index) ->
    Mid = (LoLo + LoHi) / 2,
    case Lng >= Mid of
        true -> encode_bits(Lat, Lng, N - 1, false, {LaLo, LaHi, Mid, LoHi}, Index * 2 + 1);
        false -> encode_bits(Lat, Lng, N - 1, false, {LaLo, LaHi, LoLo, Mid}, Index * 2)
    end;
encode_bits(Lat, Lng, N, false, {LaLo, LaHi, LoLo, LoHi}, Index) ->
    Mid = (LaLo + LaHi) / 2,
    case Lat >= Mid of
        true -> encode_bits(Lat, Lng, N - 1, true, {Mid, LaHi, LoLo, LoHi}, Index * 2 + 1);
        false -> encode_bits(Lat, Lng, N - 1, true, {LaLo, Mid, LoLo, LoHi}, Index * 2)
    end.

-spec bounds(term()) -> {ok, bounds()} | {error, invalid_geohash}.
bounds(Hash) when is_binary(Hash), byte_size(Hash) >= 1, byte_size(Hash) =< 12 ->
    case decode_indices(Hash, []) of
        {ok, Indices} ->
            {ok, decode_box(Indices, true, {-90.0, 90.0, -180.0, 180.0})};
        error ->
            {error, invalid_geohash}
    end;
bounds(_) ->
    {error, invalid_geohash}.

-spec decode_indices(binary(), [0..31]) -> {ok, [0..31]} | error.
decode_indices(<<>>, Acc) ->
    {ok, lists:reverse(Acc)};
decode_indices(<<C, Rest/binary>>, Acc) ->
    case binary:match(?ALPHABET, <<C>>) of
        {Index, 1} -> decode_indices(Rest, [Index | Acc]);
        nomatch -> error
    end.

-spec decode_box([0..31], boolean(), box()) -> bounds().
decode_box([], _Even, {LaLo, LaHi, LoLo, LoHi}) ->
    #{south => LaLo, west => LoLo, north => LaHi, east => LoHi};
decode_box([Index | Rest], Even, Box0) ->
    {Even1, Box} = decode_bits(Index, 4, Even, Box0),
    decode_box(Rest, Even1, Box).

%% Consume bit Pos (4 = most significant) down to 0 of a 5-bit char index.
-spec decode_bits(0..31, integer(), boolean(), box()) -> {boolean(), box()}.
decode_bits(_Index, Pos, Even, Box) when Pos < 0 ->
    {Even, Box};
decode_bits(Index, Pos, Even, {LaLo, LaHi, LoLo, LoHi}) ->
    Upper = (Index bsr Pos) band 1 =:= 1,
    Box =
        case {Even, Upper} of
            {true, true} -> {LaLo, LaHi, (LoLo + LoHi) / 2, LoHi};
            {true, false} -> {LaLo, LaHi, LoLo, (LoLo + LoHi) / 2};
            {false, true} -> {(LaLo + LaHi) / 2, LaHi, LoLo, LoHi};
            {false, false} -> {LaLo, (LaLo + LaHi) / 2, LoLo, LoHi}
        end,
    decode_bits(Index, Pos - 1, not Even, Box).

-spec centre(term()) -> {ok, {Lat :: float(), Lng :: float()}} | {error, invalid_geohash}.
centre(Hash) ->
    case bounds(Hash) of
        {ok, #{south := S, west := W, north := N, east := E}} ->
            {ok, {(S + N) / 2, (W + E) / 2}};
        {error, _} = Error ->
            Error
    end.

%% Neighbours are computed geometrically: step from the cell centre by one cell height / width
%% (all values are dyadic, so exact in floats), wrap longitude, and re-encode. No lookup tables.
-spec neighbour(term(), direction()) -> {ok, geohash()} | {error, invalid_geohash | beyond_pole}.
neighbour(Hash, Dir) ->
    case bounds(Hash) of
        {ok, #{south := S, west := W, north := N, east := E}} ->
            {Dx, Dy} = offset(Dir),
            Lat = (S + N) / 2 + Dy * (N - S),
            Lng = wrap_lng((W + E) / 2 + Dx * (E - W)),
            case Lat > 90.0 orelse Lat < -90.0 of
                true ->
                    {error, beyond_pole};
                false ->
                    encode(Lat, Lng, byte_size(Hash))
            end;
        {error, _} = Error ->
            Error
    end.

-spec neighbours(term()) -> {ok, #{direction() => geohash()}} | {error, invalid_geohash}.
neighbours(Hash) ->
    case bounds(Hash) of
        {ok, _} ->
            {ok,
                lists:foldl(
                    fun(Dir, Acc) ->
                        case neighbour(Hash, Dir) of
                            {ok, Nb} -> Acc#{Dir => Nb};
                            {error, beyond_pole} -> Acc
                        end
                    end,
                    #{},
                    ?DIRECTIONS
                )};
        {error, _} = Error ->
            Error
    end.

-spec offset(direction()) -> {-1..1, -1..1}.
offset(n) -> {0, 1};
offset(ne) -> {1, 1};
offset(e) -> {1, 0};
offset(se) -> {1, -1};
offset(s) -> {0, -1};
offset(sw) -> {-1, -1};
offset(w) -> {-1, 0};
offset(nw) -> {-1, 1}.

-spec wrap_lng(float()) -> float().
wrap_lng(Lng) when Lng > 180.0 -> Lng - 360.0;
wrap_lng(Lng) when Lng < -180.0 -> Lng + 360.0;
wrap_lng(Lng) -> Lng.
