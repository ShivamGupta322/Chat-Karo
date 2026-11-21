%% Persistence for rooms and profiles; never coordinates. Only cells go in and out: no function
%% here accepts a latitude or longitude, so a raw coordinate can neither be stored nor reach a
%% driver log line. The stored centre is the centre of the geohash cell. A profile holds only
%% the XMPP localpart, the nickname, its state and timestamps (ADR-017).
-module(geo_store).

-export([touch_room/1, touch_room/2, get_room/1]).
-export([create_pending_profile/3, activate_profile/1, delete_profile/1, get_profile/1]).
-export_type([room/0, profile/0]).

-define(ROOMS, <<"rooms">>).
-define(PROFILES, <<"profiles">>).
-define(DUPLICATE_KEY, 11000).
%% A pending reservation that is never activated is removed by the expiresAt_ttl index.
-define(PENDING_TTL_SECONDS, 600).

-type room() :: #{
    id := binary(),
    precision := geo_cell:precision(),
    geohash := binary(),
    center := geo_cell:geojson_point(),
    created_at := erlang:timestamp(),
    last_active_at := erlang:timestamp()
}.

-type profile() :: #{
    id := binary(),
    nickname := binary(),
    state := pending | active,
    created_at := erlang:timestamp()
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

%%% Profiles -------------------------------------------------------------------------------

%% The insert is the claim on the nickname: the case-insensitive unique index decides.
-spec create_pending_profile(binary(), binary(), erlang:timestamp()) ->
    ok | {error, nickname_taken | mongo_unavailable | write_failed}.
create_pending_profile(Localpart, Nickname, {Mega, Sec, Micro} = Now) ->
    Total = Mega * 1000000 + Sec + ?PENDING_TTL_SECONDS,
    Doc = #{
        <<"_id">> => Localpart,
        <<"nickname">> => Nickname,
        <<"state">> => <<"pending">>,
        <<"createdAt">> => Now,
        <<"expiresAt">> => {Total div 1000000, Total rem 1000000, Micro}
    },
    case geo_mongo:insert_one(?PROFILES, Doc) of
        {ok, _} ->
            ok;
        %% A duplicate key is the nickname index; an _id collision (random 128 bits) is
        %% negligible and would also read as taken.
        {error, {write_failed, ?DUPLICATE_KEY}} ->
            {error, nickname_taken};
        {error, mongo_unavailable} ->
            {error, mongo_unavailable};
        {error, {write_failed, _}} ->
            {error, write_failed}
    end.

-spec activate_profile(binary()) ->
    ok | {error, not_found | mongo_unavailable | write_failed}.
activate_profile(Localpart) ->
    Update = #{
        <<"$set">> => #{<<"state">> => <<"active">>},
        <<"$unset">> => #{<<"expiresAt">> => <<>>}
    },
    case geo_mongo:update_one(?PROFILES, #{<<"_id">> => Localpart}, Update, #{upsert => false}) of
        {ok, #{matched := 0}} -> {error, not_found};
        {ok, #{matched := _}} -> ok;
        {error, mongo_unavailable} -> {error, mongo_unavailable};
        {error, {write_failed, _}} -> {error, write_failed}
    end.

%% Deleting a profile that is already gone is fine.
-spec delete_profile(binary()) -> ok | {error, mongo_unavailable | write_failed}.
delete_profile(Localpart) ->
    case geo_mongo:delete_one(?PROFILES, #{<<"_id">> => Localpart}) of
        {ok, _} -> ok;
        {error, mongo_unavailable} -> {error, mongo_unavailable};
        {error, {write_failed, _}} -> {error, write_failed}
    end.

-spec get_profile(binary()) ->
    {ok, profile()} | not_found | {error, mongo_unavailable | bad_document}.
get_profile(Localpart) ->
    case geo_mongo:find_one(?PROFILES, #{<<"_id">> => Localpart}, #{}) of
        {ok, Doc} -> decode_profile(Doc);
        not_found -> not_found;
        {error, mongo_unavailable} -> {error, mongo_unavailable}
    end.

-spec decode_profile(map()) -> {ok, profile()} | {error, bad_document}.
decode_profile(#{
    <<"_id">> := Id,
    <<"nickname">> := Nickname,
    <<"state">> := State,
    <<"createdAt">> := {_, _, _} = CreatedAt
}) when
    is_binary(Id), is_binary(Nickname), (State =:= <<"pending">> orelse State =:= <<"active">>)
->
    {ok, #{
        id => Id,
        nickname => Nickname,
        state => state_atom(State),
        created_at => CreatedAt
    }};
decode_profile(_) ->
    {error, bad_document}.

-spec state_atom(binary()) -> pending | active.
state_atom(<<"pending">>) -> pending;
state_atom(<<"active">>) -> active.
