%% Persistence for rooms. Only cells go in and out: no function here accepts a latitude or
%% longitude, so a raw coordinate can neither be stored nor reach a driver log line.
%% The stored centre is the centre of the geohash cell.
-module(geo_store).

-export([touch_room/1, touch_room/2, get_room/1]).
-export_type([room/0]).

-define(ROOMS, <<"rooms">>).
-define(DUPLICATE_KEY, 11000).

-type room() :: #{
    id := binary(),
    precision := geo_cell:precision(),
    geohash := binary(),
    center := geo_cell:geojson_point(),
    created_at := erlang:timestamp(),
    last_active_at := erlang:timestamp()
}.

-spec touch_room(geo_cell:cell()) ->
    {ok, created | updated} | {error, mongo_unavailable | write_failed}.
touch_room(Cell) ->
    touch_room(Cell, os:timestamp()).

%% Upsert keyed by the room id. Two concurrent first touches can both try to insert; the loser
%% gets a duplicate-key error, and a single retry then takes the update path.
-spec touch_room(geo_cell:cell(), Now :: erlang:timestamp()) ->
    {ok, created | updated} | {error, mongo_unavailable | write_failed}.
touch_room(Cell, Now) ->
    case upsert(Cell, Now) of
        {error, {write_failed, ?DUPLICATE_KEY}} -> finish(upsert(Cell, Now));
        Other -> finish(Other)
    end.

-spec upsert(geo_cell:cell(), erlang:timestamp()) ->
    {ok, geo_mongo:write_result()} | {error, geo_mongo:write_error()}.
upsert(#{precision := Precision, geohash := Hash} = Cell, Now) ->
    Update = #{
        <<"$set">> => #{<<"lastActiveAt">> => Now},
        <<"$setOnInsert">> => #{
            <<"precision">> => Precision,
            <<"geohash">> => Hash,
            <<"center">> => geo_cell:centre_geojson(Cell),
            <<"createdAt">> => Now
        }
    },
    geo_mongo:update_one(?ROOMS, #{<<"_id">> => geo_cell:room_id(Cell)}, Update, #{upsert => true}).

-spec finish({ok, geo_mongo:write_result()} | {error, geo_mongo:write_error()}) ->
    {ok, created | updated} | {error, mongo_unavailable | write_failed}.
finish({ok, #{upserted := true}}) -> {ok, created};
finish({ok, #{upserted := false}}) -> {ok, updated};
finish({error, mongo_unavailable}) -> {error, mongo_unavailable};
finish({error, {write_failed, _}}) -> {error, write_failed}.

-spec get_room(geo_cell:cell()) ->
    {ok, room()} | not_found | {error, mongo_unavailable | bad_document}.
get_room(Cell) ->
    case geo_mongo:find_one(?ROOMS, #{<<"_id">> => geo_cell:room_id(Cell)}, #{}) of
        {ok, Doc} -> decode(Doc);
        not_found -> not_found;
        {error, mongo_unavailable} -> {error, mongo_unavailable}
    end.

-spec decode(map()) -> {ok, room()} | {error, bad_document}.
decode(#{
    <<"_id">> := Id,
    <<"precision">> := Precision,
    <<"geohash">> := Hash,
    <<"center">> := Center,
    <<"createdAt">> := {_, _, _} = CreatedAt,
    <<"lastActiveAt">> := {_, _, _} = LastActiveAt
}) when
    is_binary(Id), is_integer(Precision), is_binary(Hash), is_map(Center)
->
    case geo_cell:parse_cell(Precision, Hash) of
        {ok, #{precision := P}} ->
            {ok, #{
                id => Id,
                precision => P,
                geohash => Hash,
                center => Center,
                created_at => CreatedAt,
                last_active_at => LastActiveAt
            }};
        {error, invalid_cell} ->
            {error, bad_document}
    end;
decode(_) ->
    {error, bad_document}.
