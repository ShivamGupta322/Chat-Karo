%% Pure cell model (ADR-001): range level -> geohash precision, cell ids and JIDs.
%% No logging, no processes. Errors are atoms only and never echo the input, because the
%% inputs of from_point/3 are raw coordinates.
-module(geo_cell).

-export([
    precision/1,
    parse_range/1,
    from_point/3,
    parse_cell/2,
    room_id/1,
    parse_room_id/1,
    room_jid/2,
    centre_geojson/1
]).
-export_type([range/0, precision/0, cell/0, geojson_point/0]).

-type range() :: block | neighbourhood | area.
-type precision() :: 5 | 6 | 7.
-type cell() :: #{precision := precision(), geohash := geohash:geohash()}.
%% #{<<"type">> => <<"Point">>, <<"coordinates">> => [Lng, Lat]}
-type geojson_point() :: #{binary() => binary() | [float()]}.

-spec precision(range()) -> precision().
precision(block) -> 7;
precision(neighbourhood) -> 6;
precision(area) -> 5.

-spec parse_range(term()) -> {ok, range()} | {error, invalid_range}.
parse_range(<<"block">>) -> {ok, block};
parse_range(<<"neighbourhood">>) -> {ok, neighbourhood};
parse_range(<<"area">>) -> {ok, area};
parse_range(_) -> {error, invalid_range}.

%% The coordinates are used to compute the cell and then dropped.
-spec from_point(Lat :: term(), Lng :: term(), range()) ->
    {ok, cell()} | {error, lat_out_of_range | lng_out_of_range}.
from_point(Lat, Lng, Range) ->
    Precision = precision(Range),
    case geohash:encode(Lat, Lng, Precision) of
        {ok, Hash} -> {ok, #{precision => Precision, geohash => Hash}};
        {error, lat_out_of_range} -> {error, lat_out_of_range};
        {error, lng_out_of_range} -> {error, lng_out_of_range}
    end.

-spec parse_cell(term(), term()) -> {ok, cell()} | {error, invalid_cell}.
parse_cell(Precision, Hash) when
    (Precision =:= 5 orelse Precision =:= 6 orelse Precision =:= 7),
    is_binary(Hash),
    byte_size(Hash) =:= Precision
->
    case geohash:bounds(Hash) of
        {ok, _} -> {ok, #{precision => Precision, geohash => Hash}};
        {error, invalid_geohash} -> {error, invalid_cell}
    end;
parse_cell(_, _) ->
    {error, invalid_cell}.

-spec room_id(cell()) -> binary().
room_id(#{precision := Precision, geohash := Hash}) ->
    <<"g", (integer_to_binary(Precision))/binary, "_", Hash/binary>>.

-spec parse_room_id(term()) -> {ok, cell()} | {error, invalid_room_id}.
parse_room_id(<<"g", P, "_", Hash/binary>>) when P >= $5, P =< $7 ->
    case parse_cell(P - $0, Hash) of
        {ok, _} = Ok -> Ok;
        {error, invalid_cell} -> {error, invalid_room_id}
    end;
parse_room_id(_) ->
    {error, invalid_room_id}.

-spec room_jid(cell(), MucDomain :: binary()) -> binary().
room_jid(Cell, MucDomain) ->
    <<(room_id(Cell))/binary, "@", MucDomain/binary>>.

%% Centre of the cell, GeoJSON order [Lng, Lat]. This is the only location that is stored.
-spec centre_geojson(cell()) -> geojson_point().
centre_geojson(#{geohash := Hash}) ->
    {ok, {Lat, Lng}} = geohash:centre(Hash),
    #{<<"type">> => <<"Point">>, <<"coordinates">> => [Lng, Lat]}.
