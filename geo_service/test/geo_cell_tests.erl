-module(geo_cell_tests).

-include_lib("eunit/include/eunit.hrl").

precision_test_() ->
    [
        ?_assertEqual(7, geo_cell:precision(block)),
        ?_assertEqual(6, geo_cell:precision(neighbourhood)),
        ?_assertEqual(5, geo_cell:precision(area))
    ].

parse_range_accepts_test_() ->
    [
        ?_assertEqual({ok, block}, geo_cell:parse_range(<<"block">>)),
        ?_assertEqual({ok, neighbourhood}, geo_cell:parse_range(<<"neighbourhood">>)),
        ?_assertEqual({ok, area}, geo_cell:parse_range(<<"area">>))
    ].

parse_range_rejects_test_() ->
    [
        ?_assertEqual({error, invalid_range}, geo_cell:parse_range(In))
     || In <- ["block", <<"Block">>, <<>>, block, area, undefined, 7, <<"block ">>]
    ].

from_point_test_() ->
    [
        ?_assertEqual(
            {ok, #{precision => 7, geohash => <<"u4pruyd">>}},
            geo_cell:from_point(57.64911, 10.40744, block)
        ),
        ?_assertEqual(
            {ok, #{precision => 6, geohash => <<"u4pruy">>}},
            geo_cell:from_point(57.64911, 10.40744, neighbourhood)
        ),
        ?_assertEqual(
            {ok, #{precision => 5, geohash => <<"u4pru">>}},
            geo_cell:from_point(57.64911, 10.40744, area)
        )
    ].

from_point_errors_are_bare_atoms_test_() ->
    [
        ?_assertEqual({error, lat_out_of_range}, geo_cell:from_point(91.5, 10.0, block)),
        ?_assertEqual({error, lat_out_of_range}, geo_cell:from_point(<<"x">>, 10.0, block)),
        ?_assertEqual({error, lng_out_of_range}, geo_cell:from_point(10.0, -181.25, area)),
        ?_assertEqual({error, lng_out_of_range}, geo_cell:from_point(10.0, undefined, area))
    ].

room_id_round_trip_test_() ->
    [
        fun() ->
            {ok, Cell} = geo_cell:from_point(57.64911, 10.40744, Range),
            Id = geo_cell:room_id(Cell),
            ?assertEqual({ok, Cell}, geo_cell:parse_room_id(Id))
        end
     || Range <- [block, neighbourhood, area]
    ].

room_id_exact_test() ->
    ?assertEqual(
        <<"g7_u4pruyd">>, geo_cell:room_id(#{precision => 7, geohash => <<"u4pruyd">>})
    ).

parse_room_id_rejects_test_() ->
    [
        ?_assertEqual({error, invalid_room_id}, geo_cell:parse_room_id(In))
     || In <- [
            <<"g8_x">>,
            <<"g7_u4pruy">>,
            <<"g7_u4pruya">>,
            <<"G7_u4pruyd">>,
            <<"g7u4pruyd">>,
            <<>>,
            "g7_u4pruyd",
            <<"g4_u4pr">>,
            <<"g7_U4PRUYD">>,
            undefined
        ]
    ].

parse_cell_test_() ->
    [
        ?_assertEqual(
            {ok, #{precision => 6, geohash => <<"u4pruy">>}}, geo_cell:parse_cell(6, <<"u4pruy">>)
        ),
        ?_assertEqual({error, invalid_cell}, geo_cell:parse_cell(7, <<"u4pruy">>)),
        ?_assertEqual({error, invalid_cell}, geo_cell:parse_cell(4, <<"u4pr">>)),
        ?_assertEqual({error, invalid_cell}, geo_cell:parse_cell(5, <<"u4pra">>)),
        ?_assertEqual({error, invalid_cell}, geo_cell:parse_cell(<<"5">>, <<"u4pru">>)),
        ?_assertEqual({error, invalid_cell}, geo_cell:parse_cell(5, "u4pru"))
    ].

room_jid_test() ->
    ?assertEqual(
        <<"g7_u4pruyd@muc.chaterl.localhost">>,
        geo_cell:room_jid(
            #{precision => 7, geohash => <<"u4pruyd">>}, <<"muc.chaterl.localhost">>
        )
    ).

centre_geojson_is_lng_lat_test() ->
    Cell = #{precision => 7, geohash => <<"u4pruyd">>},
    {ok, {Lat, Lng}} = geohash:centre(<<"u4pruyd">>),
    ?assertEqual(
        #{<<"type">> => <<"Point">>, <<"coordinates">> => [Lng, Lat]},
        geo_cell:centre_geojson(Cell)
    ),
    %% [Lng, Lat] is not [Lat, Lng]
    ?assertNotEqual([Lat, Lng], maps:get(<<"coordinates">>, geo_cell:centre_geojson(Cell))).

two_points_one_cell_share_centre_test() ->
    P1 = {57.64911, 10.40744},
    P2 = {57.64915, 10.40748},
    {ok, C1} = geo_cell:from_point(element(1, P1), element(2, P1), block),
    {ok, C2} = geo_cell:from_point(element(1, P2), element(2, P2), block),
    ?assertEqual(C1, C2),
    Centre = geo_cell:centre_geojson(C1),
    ?assertEqual(Centre, geo_cell:centre_geojson(C2)),
    [Lng, Lat] = maps:get(<<"coordinates">>, Centre),
    ?assertNotEqual({Lat, Lng}, P1),
    ?assertNotEqual({Lat, Lng}, P2).

extreme_cells_in_range_test_() ->
    [
        fun() ->
            {ok, Cell} = geo_cell:parse_cell(7, Hash),
            [Lng, Lat] = maps:get(<<"coordinates">>, geo_cell:centre_geojson(Cell)),
            ?assert(Lat >= -90.0 andalso Lat =< 90.0),
            ?assert(Lng >= -180.0 andalso Lng =< 180.0)
        end
     || Hash <- [<<"zzzzzzz">>, <<"0000000">>, <<"xbpbpbp">>, <<"8000000">>]
    ].
