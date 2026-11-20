-module(geohash_tests).

-include_lib("eunit/include/eunit.hrl").
%% eunit.hrl defines a LET macro too; PropEr's ?LET is the one used below.
-undef(LET).
-include_lib("proper/include/proper.hrl").
-include("geohash_vectors.hrl").

-define(PROP_TESTS, 1000).
-define(ALPHABET_CHARS, "0123456789bcdefghjkmnpqrstuvwxyz").

%%% Vectors ------------------------------------------------------------------------------

vectors_test_() ->
    [
        ?_assertEqual({ok, Hash}, geohash:encode(Lat, Lng, 7))
     || {Lat, Lng, Hash} <- ?VECTORS
    ].

precision_12_test() ->
    {Lat, Lng, Expected} = ?PRECISION_12,
    ?assertEqual({ok, Expected}, geohash:encode(Lat, Lng, 12)).

precision_12_prefix_test_() ->
    [
        ?_assertMatch(
            {ok, <<Hash:7/binary, _/binary>>},
            geohash:encode(Lat, Lng, 12)
        )
     || {Lat, Lng, Hash} <- ?VECTORS
    ].

corners_test_() ->
    [
        ?_assertMatch({ok, _}, geohash:encode(Lat, Lng, 7))
     || Lat <- [-90, 90, -90.0, 90.0], Lng <- [-180, 180, -180.0, 180.0]
    ].

%% Drift guard: the .hrl vectors must equal web/tests/geo/vectors.ts.
drift_guard_test_() ->
    Path = filename:join([filename:dirname(?FILE), "..", "..", "web", "tests", "geo", "vectors.ts"]),
    case file:read_file(Path) of
        {ok, Bin} ->
            {ok, Re} = re:compile("\\[(-?[0-9.]+), (-?[0-9.]+), '([0-9a-z]+)'\\]"),
            {match, Matches} = re:run(Bin, Re, [global, {capture, all_but_first, binary}]),
            FromTs = [{num(La), num(Lo), H} || [La, Lo, H] <- Matches],
            ?debugFmt("drift guard ran: ~b vectors compared with vectors.ts", [length(FromTs)]),
            [?_assertEqual(length(?VECTORS), length(FromTs)), ?_assert(FromTs == ?VECTORS)];
        {error, _} ->
            ?debugMsg("drift guard skipped: web/tests/geo/vectors.ts not found"),
            []
    end.

num(Bin) ->
    case binary:match(Bin, <<".">>) of
        nomatch -> binary_to_integer(Bin);
        _ -> binary_to_float(Bin)
    end.

%%% Bounds -------------------------------------------------------------------------------

bounds_table_test_() ->
    [
        ?_test(begin
            {ok, #{south := S, west := W, north := N, east := E}} = geohash:bounds(Hash),
            ?assert(S == South),
            ?assert(W == West),
            ?assert(N == North),
            ?assert(E == East)
        end)
     || {Hash, South, West, North, East} <- ?BOUNDS
    ].

containment_and_centre_test_() ->
    [
        ?_test(begin
            {ok, #{south := S, west := W, north := N, east := E}} = geohash:bounds(Hash),
            ?assert(Lat >= S andalso Lat =< N),
            ?assert(Lng >= W andalso Lng =< E),
            {ok, {CLat, CLng}} = geohash:centre(Hash),
            ?assertEqual({ok, Hash}, geohash:encode(CLat, CLng, 7))
        end)
     || {Lat, Lng, Hash} <- ?VECTORS
    ].

bounds_rejects_test_() ->
    [
        ?_assertEqual({error, invalid_geohash}, geohash:bounds(Bad))
     || Bad <- [
            <<>>,
            <<"U4PRUYD">>,
            <<"u4pruya">>,
            <<"u4prui">>,
            <<"u4pruydqqvj8x">>,
            "u4pruyd",
            undefined
        ]
    ].

centre_rejects_test() ->
    ?assertEqual({error, invalid_geohash}, geohash:centre(<<"a">>)).

%%% Errors -------------------------------------------------------------------------------

lat_errors_test_() ->
    [
        ?_assertEqual({error, lat_out_of_range}, geohash:encode(Lat, 0, 7))
     || Lat <- [90.0001, -90.0001, undefined, <<"1">>, "1"]
    ].

lng_errors_test_() ->
    [
        ?_assertEqual({error, lng_out_of_range}, geohash:encode(0, Lng, 7))
     || Lng <- [180.0001, -180.0001, undefined, <<"1">>, "1"]
    ].

precision_errors_test_() ->
    [
        ?_assertEqual({error, invalid_precision}, geohash:encode(0, 0, P))
     || P <- [0, 13, 7.5, -1, seven]
    ].

precision_reported_first_test() ->
    ?assertEqual({error, invalid_precision}, geohash:encode(999, 999, 0)),
    ?assertEqual({error, lat_out_of_range}, geohash:encode(999, 999, 7)).

%%% Neighbours ---------------------------------------------------------------------------

neighbour_vectors_test_() ->
    Cases = [
        {<<"u4pruyd">>, [
            {n, <<"u4pruyf">>},
            {ne, <<"u4pruyg">>},
            {e, <<"u4pruye">>},
            {se, <<"u4pruy7">>},
            {s, <<"u4pruy6">>},
            {sw, <<"u4pruy3">>},
            {w, <<"u4pruy9">>},
            {nw, <<"u4pruyc">>}
        ]},
        {<<"ezs42">>, [
            {n, <<"ezs48">>},
            {ne, <<"ezs49">>},
            {e, <<"ezs43">>},
            {se, <<"ezs41">>},
            {s, <<"ezs40">>},
            {sw, <<"ezefp">>},
            {w, <<"ezefr">>},
            {nw, <<"ezefx">>}
        ]},
        {<<"xbpbpbp">>, [{e, <<"8000000">>}, {ne, <<"8000002">>}, {se, <<"2pbpbpb">>}]},
        {<<"8000000">>, [{w, <<"xbpbpbp">>}, {nw, <<"xbpbpbr">>}, {sw, <<"rzzzzzz">>}]},
        {<<"s000000">>, [{s, <<"kpbpbpb">>}, {w, <<"ebpbpbp">>}, {sw, <<"7zzzzzz">>}]}
    ],
    [
        ?_assertEqual({ok, Expected}, geohash:neighbour(Hash, Dir))
     || {Hash, Pairs} <- Cases, {Dir, Expected} <- Pairs
    ].

north_pole_test() ->
    ?assertEqual(
        {ok, #{
            e => <<"bpbpbpb">>,
            se => <<"bpbpbp8">>,
            s => <<"zzzzzzx">>,
            sw => <<"zzzzzzw">>,
            w => <<"zzzzzzy">>
        }},
        geohash:neighbours(<<"zzzzzzz">>)
    ),
    ?assertEqual({error, beyond_pole}, geohash:neighbour(<<"zzzzzzz">>, n)).

south_pole_test() ->
    ?assertEqual(
        {ok, #{
            n => <<"0000002">>,
            ne => <<"0000003">>,
            e => <<"0000001">>,
            w => <<"pbpbpbp">>,
            nw => <<"pbpbpbr">>
        }},
        geohash:neighbours(<<"0000000">>)
    ).

precision_one_test() ->
    ?assertEqual(
        {ok, #{e => <<"v">>, se => <<"t">>, s => <<"s">>, sw => <<"e">>, w => <<"g">>}},
        geohash:neighbours(<<"u">>)
    ).

neighbour_invalid_test() ->
    ?assertEqual({error, invalid_geohash}, geohash:neighbour(<<"A">>, n)),
    ?assertEqual({error, invalid_geohash}, geohash:neighbours(<<>>)).

%%% Properties (PropEr) ------------------------------------------------------------------
%% Wrapper names end in _property_test_ (not prop_*_test) to avoid clashing with EUnit exports.

bounds_contain_point_property_test_() -> run(prop_bounds_contain_point()).
prefix_property_test_() -> run(prop_prefix()).
centre_roundtrip_property_test_() -> run(prop_centre_roundtrip()).
opposite_property_test_() -> run(prop_opposite()).
shared_edges_property_test_() -> run(prop_shared_edges()).
diagonals_property_test_() -> run(prop_diagonals()).
neighbours_distinct_property_test_() -> run(prop_neighbours_distinct()).
missing_only_at_pole_property_test_() -> run(prop_missing_only_at_pole()).

run(Prop) ->
    {timeout, 120,
        ?_assert(
            proper:quickcheck(Prop, [{numtests, ?PROP_TESTS}, {to_file, user}]) =:= true
        )}.

coord(Lo, Hi) ->
    proper_types:oneof([proper_types:float(float(Lo), float(Hi)), proper_types:integer(Lo, Hi)]).

lat() -> coord(-90, 90).
lng() -> coord(-180, 180).

hash() ->
    ?LET(
        Len,
        proper_types:integer(1, 12),
        ?LET(
            Chars,
            proper_types:vector(Len, proper_types:elements(?ALPHABET_CHARS)),
            list_to_binary(Chars)
        )
    ).

%% A hash whose cell touches a pole or the antimeridian: encodes an extreme point.
edge_hash() ->
    ?LET(
        {Lat, Lng, P},
        proper_types:oneof([
            {proper_types:oneof([-90, 90]), lng(), proper_types:integer(1, 12)},
            {lat(), proper_types:oneof([-180, 180]), proper_types:integer(1, 12)}
        ]),
        begin
            {ok, H} = geohash:encode(Lat, Lng, P),
            H
        end
    ).

hash_or_edge() -> proper_types:oneof([hash(), edge_hash()]).

opposite(n) -> s;
opposite(s) -> n;
opposite(e) -> w;
opposite(w) -> e.

prop_bounds_contain_point() ->
    ?FORALL(
        {Lat, Lng, P},
        {lat(), lng(), proper_types:integer(1, 12)},
        begin
            {ok, H} = geohash:encode(Lat, Lng, P),
            {ok, #{south := S, west := W, north := N, east := E}} = geohash:bounds(H),
            Lat >= S andalso Lat =< N andalso Lng >= W andalso Lng =< E
        end
    ).

prop_prefix() ->
    ?FORALL(
        {Lat, Lng, P},
        {lat(), lng(), proper_types:integer(1, 12)},
        begin
            {ok, H} = geohash:encode(Lat, Lng, P),
            {ok, Full} = geohash:encode(Lat, Lng, 12),
            binary:part(Full, 0, P) =:= H
        end
    ).

prop_centre_roundtrip() ->
    ?FORALL(
        H,
        hash(),
        begin
            {ok, {CLat, CLng}} = geohash:centre(H),
            geohash:encode(CLat, CLng, byte_size(H)) =:= {ok, H}
        end
    ).

prop_opposite() ->
    ?FORALL(
        {H, Dir},
        {hash(), proper_types:oneof([n, s, e, w])},
        case geohash:neighbour(H, Dir) of
            {ok, Nb} -> geohash:neighbour(Nb, opposite(Dir)) =:= {ok, H};
            {error, beyond_pole} -> true
        end
    ).

%% The east edge of a cell equals the west edge of its east neighbour (and so on). Across the
%% antimeridian the shared edge is +180 on one side and -180 on the other.
prop_shared_edges() ->
    ?FORALL(
        H,
        hash_or_edge(),
        begin
            {ok, #{south := S, west := W, north := N, east := E}} = geohash:bounds(H),
            edge_ok(H, e, fun(#{west := NW}) -> E == NW orelse (E == 180.0 andalso NW == -180.0) end) andalso
                edge_ok(H, w, fun(#{east := NE}) ->
                    W == NE orelse (W == -180.0 andalso NE == 180.0)
                end) andalso
                edge_ok(H, n, fun(#{south := NS}) -> N == NS end) andalso
                edge_ok(H, s, fun(#{north := NN}) -> S == NN end)
        end
    ).

edge_ok(H, Dir, Check) ->
    case geohash:neighbour(H, Dir) of
        {ok, Nb} ->
            {ok, NbBounds} = geohash:bounds(Nb),
            Check(NbBounds);
        {error, beyond_pole} ->
            true
    end.

prop_diagonals() ->
    ?FORALL(
        H,
        hash(),
        lists:all(
            fun({Diag, First, Second}) ->
                Composed =
                    case geohash:neighbour(H, First) of
                        {ok, Mid} -> geohash:neighbour(Mid, Second);
                        {error, beyond_pole} -> {error, beyond_pole}
                    end,
                geohash:neighbour(H, Diag) =:= Composed
            end,
            [{ne, n, e}, {nw, n, w}, {se, s, e}, {sw, s, w}]
        )
    ).

prop_neighbours_distinct() ->
    ?FORALL(
        H,
        hash(),
        begin
            {ok, Nbs} = geohash:neighbours(H),
            Values = maps:values(Nbs),
            lists:all(fun(V) -> byte_size(V) =:= byte_size(H) andalso V =/= H end, Values) andalso
                length(Values) =:= length(lists:usort(Values))
        end
    ).

prop_missing_only_at_pole() ->
    ?FORALL(
        H,
        hash_or_edge(),
        begin
            {ok, #{south := S, north := N}} = geohash:bounds(H),
            {ok, Nbs} = geohash:neighbours(H),
            lists:all(
                fun(Dir) ->
                    Missing = not maps:is_key(Dir, Nbs),
                    Expect =
                        (N == 90.0 andalso lists:member(Dir, [n, ne, nw])) orelse
                            (S == -90.0 andalso lists:member(Dir, [s, se, sw])),
                    Missing =:= Expect
                end,
                [n, ne, e, se, s, sw, w, nw]
            )
        end
    ).
