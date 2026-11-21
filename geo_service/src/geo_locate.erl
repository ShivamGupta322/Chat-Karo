%% Pure request logic for POST /api/locate (ADR-018). No logging, no processes.
%% The inputs of cell_for/1 are raw coordinates: every error is a bare atom that never echoes
%% an input, and nothing here keeps a coordinate after the cell is computed.
-module(geo_locate).

-export([cell_for/1, response/3]).

-define(MAX_ACCURACY, 1000000).

-spec cell_for(map()) ->
    {ok, geo_cell:cell(), geo_cell:range()} | {error, invalid_request | invalid_location}.
cell_for(Body) ->
    case check_shape(Body) of
        {ok, Lat, Lng, RangeIn, Accuracy} ->
            case geo_cell:parse_range(RangeIn) of
                {ok, Range} ->
                    case valid_accuracy(Accuracy) of
                        true -> locate(Lat, Lng, Range);
                        false -> {error, invalid_request}
                    end;
                {error, invalid_range} ->
                    {error, invalid_request}
            end;
        error ->
            {error, invalid_request}
    end.

-spec locate(number(), number(), geo_cell:range()) ->
    {ok, geo_cell:cell(), geo_cell:range()} | {error, invalid_location}.
locate(Lat, Lng, Range) ->
    case geo_cell:from_point(Lat, Lng, Range) of
        {ok, Cell} -> {ok, Cell, Range};
        {error, _} -> {error, invalid_location}
    end.

%% Known keys only; lat, lng and accuracy must be numbers. Returns the raw values for the
%% following checks (range is still unvalidated, accuracy is `none` when absent).
-spec check_shape(map()) -> {ok, number(), number(), term(), term()} | error.
check_shape(#{<<"lat">> := Lat, <<"lng">> := Lng} = Body) when is_number(Lat), is_number(Lng) ->
    Known = maps:with([<<"lat">>, <<"lng">>, <<"range">>, <<"accuracy">>], Body),
    case map_size(Known) =:= map_size(Body) of
        true ->
            {ok, Lat, Lng, maps:get(<<"range">>, Body, <<"block">>),
                maps:get(<<"accuracy">>, Body, none)};
        false ->
            error
    end;
check_shape(_) ->
    error.

%% Accepted, validated and then ignored: never stored or logged.
-spec valid_accuracy(term()) -> boolean().
valid_accuracy(none) -> true;
valid_accuracy(A) when is_number(A) -> A >= 0 andalso A =< ?MAX_ACCURACY;
valid_accuracy(_) -> false.

-spec response(geo_cell:cell(), geo_cell:range(), MucDomain :: binary()) ->
    [{binary(), binary() | integer()}].
response(#{precision := Precision, geohash := Hash} = Cell, Range, MucDomain) ->
    [
        {<<"cell">>, Hash},
        {<<"precision">>, Precision},
        {<<"range">>, atom_to_binary(Range)},
        {<<"room_jid">>, geo_cell:room_jid(Cell, MucDomain)}
    ].
