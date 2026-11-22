-module(geo_locate_tests).

-include_lib("eunit/include/eunit.hrl").
%% eunit.hrl defines a LET macro too; PropEr's ?LET is not used here but the include keeps the
%% same pattern as geohash_tests.
-undef(LET).
-include_lib("proper/include/proper.hrl").
-include("geohash_vectors.hrl").

-define(PROP_TESTS, 1000).
-define(MUC, <<"muc.chaterl.localhost">>).

body(Lat, Lng) -> #{<<"lat">> => Lat, <<"lng">> => Lng}.

cell(Hash) -> #{precision => byte_size(Hash), geohash => Hash}.

%%% Valid ----------------------------------------------------------------------------------

valid_test() ->
    ?assertEqual(
        {ok, cell(<<"u4pruyd">>), block}, geo_locate:cell_for(body(57.64911, 10.40744))
    ).

vectors_test_() ->
    [
        ?_assertEqual({ok, cell(Hash), block}, geo_locate:cell_for(body(Lat, Lng)))
     || {Lat, Lng, Hash} <- ?VECTORS
    ].

antimeridian_test() ->
    {ok, East, block} = geo_locate:cell_for(body(0, 180)),
    {ok, West, block} = geo_locate:cell_for(body(0, -180)),
    ?assertEqual(cell(<<"xbpbpbp">>), East),
    ?assertEqual(cell(<<"8000000">>), West),
    ?assertNotEqual(East, West).

zero_test_() ->
    [
        ?_assertEqual({ok, cell(<<"s000000">>), block}, geo_locate:cell_for(body(0, 0))),
        ?_assertEqual({ok, cell(<<"s000000">>), block}, geo_locate:cell_for(body(-0.0, -0.0)))
    ].

%%% Range ----------------------------------------------------------------------------------

range_test_() ->
    Base = body(57.64911, 10.40744),
    [
        ?_assertEqual(
            {ok, cell(<<"u4pruyd">>), block}, geo_locate:cell_for(Base)
        ),
        ?_assertEqual(
            {ok, cell(<<"u4pruyd">>), block},
            geo_locate:cell_for(Base#{<<"range">> => <<"block">>})
        ),
        ?_assertEqual(
            {ok, cell(<<"u4pruy">>), neighbourhood},
            geo_locate:cell_for(Base#{<<"range">> => <<"neighbourhood">>})
        ),
        ?_assertEqual(
            {ok, cell(<<"u4pru">>), area},
            geo_locate:cell_for(Base#{<<"range">> => <<"area">>})
        )
    ] ++
        [
            ?_assertEqual(
                {error, invalid_request}, geo_locate:cell_for(Base#{<<"range">> => Bad})
            )
         || Bad <- [<<"Block">>, <<"neighborhood">>, <<>>, 7, null, true, []]
        ].

%%% Types and keys -------------------------------------------------------------------------

type_matrix_test_() ->
    Bad = [<<"57.6">>, true, false, null, [], #{}],
    [
        ?_assertEqual({error, invalid_request}, geo_locate:cell_for(body(V, 10.0)))
     || V <- Bad
    ] ++
        [
            ?_assertEqual({error, invalid_request}, geo_locate:cell_for(body(57.6, V)))
         || V <- Bad
        ] ++
        [
            ?_assertEqual(
                {error, invalid_request}, geo_locate:cell_for(#{<<"lng">> => 1.0})
            ),
            ?_assertEqual(
                {error, invalid_request}, geo_locate:cell_for(#{<<"lat">> => 1.0})
            )
        ].

keys_test_() ->
    Base = body(57.6, 10.4),
    [
        ?_assertEqual(
            {error, invalid_request}, geo_locate:cell_for(Base#{<<"foo">> => 1})
        ),
        ?_assertEqual(
            {error, invalid_request}, geo_locate:cell_for(Base#{<<"Lat">> => 1.0})
        ),
        ?_assertEqual(
            {error, invalid_request}, geo_locate:cell_for(Base#{<<"latitude">> => 1.0})
        ),
        ?_assertEqual({error, invalid_request}, geo_locate:cell_for(#{})),
        ?_assertEqual(
            {error, invalid_request},
            geo_locate:cell_for(#{<<"Lat">> => 57.6, <<"Lng">> => 10.4})
        )
    ].

accuracy_test_() ->
    Base = body(57.64911, 10.40744),
    Ok = {ok, cell(<<"u4pruyd">>), block},
    [
        ?_assertEqual(Ok, geo_locate:cell_for(Base#{<<"accuracy">> => A}))
     || A <- [0, 25, 25.5, 1000000]
    ] ++
        [
            ?_assertEqual(Ok, geo_locate:cell_for(Base))
        ] ++
        [
            ?_assertEqual(
                {error, invalid_request}, geo_locate:cell_for(Base#{<<"accuracy">> => A})
            )
         || A <- [-1, 1000000.5, <<"25">>, null, true, [], #{}]
        ].

bounds_test_() ->
    [
        ?_assertEqual({error, invalid_location}, geo_locate:cell_for(body(Lat, Lng)))
     || {Lat, Lng} <- [
            {90.0000001, 0},
            {-90.0000001, 0},
            {0, 180.0000001},
            {0, -180.0000001},
            {1.0e308, 0},
            {0, 1.0e308},
            {1000000000000000000000000000000, 0},
            {0, -1000000000000000000000000000000}
        ]
    ].

order_test() ->
    %% Malformed and out of range: the shape error wins.
    ?assertEqual(
        {error, invalid_request},
        geo_locate:cell_for(#{<<"lat">> => 91, <<"lng">> => 0, <<"range">> => <<"x">>})
    ),
    ?assertEqual(
        {error, invalid_request},
        geo_locate:cell_for(#{<<"lat">> => 91, <<"lng">> => 0, <<"accuracy">> => -1})
    ).

%%% Results never contain the inputs -------------------------------------------------------

results_have_no_inputs_test_() ->
    Inputs = [
        {57.6491137, 10.4074419},
        {90.0000173, 10.4074419},
        {57.6491137, -180.0000419}
    ],
    [
        fun() ->
            Result = geo_locate:cell_for(
                (body(Lat, Lng))#{<<"range">> => <<"block">>, <<"accuracy">> => 25.5}
            ),
            Text = lists:flatten(io_lib:format("~p", [Result])),
            ?assertEqual(nomatch, string:find(Text, "57.649")),
            ?assertEqual(nomatch, string:find(Text, "10.407")),
            ?assertEqual(nomatch, string:find(Text, "90.0000173")),
            ?assertEqual(nomatch, string:find(Text, "180.0000419")),
            ?assertEqual(nomatch, string:find(Text, "25.5")),
            case Result of
                {ok, Cell, _} -> ?assertEqual([geohash, precision], lists:sort(maps:keys(Cell)));
                {error, _} -> ok
            end
        end
     || {Lat, Lng} <- Inputs
    ].

%%% Totality (PropEr) ----------------------------------------------------------------------

prop_cell_for_total() ->
    ?FORALL(
        Body,
        body_gen(),
        case catch geo_locate:cell_for(Body) of
            {ok, #{precision := P, geohash := H}, Range} when
                is_binary(H), P >= 5, P =< 7
            ->
                lists:member(Range, [block, neighbourhood, area]);
            {error, invalid_request} ->
                true;
            {error, invalid_location} ->
                true;
            _ ->
                false
        end
    ).

body_gen() ->
    ?LET(
        Entries,
        resize(6, list({key_gen(), value_gen()})),
        maps:from_list(Entries)
    ).

key_gen() ->
    frequency([
        {5, oneof([<<"lat">>, <<"lng">>, <<"range">>, <<"accuracy">>])},
        {1, binary()}
    ]).

value_gen() ->
    oneof([
        integer(),
        float(),
        ?LET(N, integer(1, 400), 1 bsl N),
        oneof([-1.0e308, 1.0e308, 90.0, -90.0, 180.0, -180.0, 0.0, -0.0]),
        binary(),
        oneof([<<"block">>, <<"neighbourhood">>, <<"area">>]),
        boolean(),
        null,
        list(integer()),
        #{}
    ]).

cell_for_total_test_() ->
    {timeout, 120, fun() ->
        ?assert(
            proper:quickcheck(prop_cell_for_total(), [{numtests, ?PROP_TESTS}, {to_file, user}])
        ),
        ?debugFmt("property ran ~b cases", [?PROP_TESTS])
    end}.

%%% Response -------------------------------------------------------------------------------

response_test_() ->
    [
        ?_assertEqual(
            [
                {<<"cell">>, <<"u4pruyd">>},
                {<<"precision">>, 7},
                {<<"range">>, <<"block">>},
                {<<"room_jid">>, <<"g7_u4pruyd@muc.chaterl.localhost">>}
            ],
            geo_locate:response(cell(<<"u4pruyd">>), block, ?MUC)
        ),
        ?_assertEqual(
            <<"{\"cell\":\"u4pruyd\",\"precision\":7,\"range\":\"block\",\"room_jid\":\"g7_u4pruyd@muc.chaterl.localhost\"}">>,
            body_text(cell(<<"u4pruyd">>), block)
        ),
        ?_assertEqual(
            <<"{\"cell\":\"u4pruy\",\"precision\":6,\"range\":\"neighbourhood\",\"room_jid\":\"g6_u4pruy@muc.chaterl.localhost\"}">>,
            body_text(cell(<<"u4pruy">>), neighbourhood)
        ),
        ?_assertEqual(
            <<"{\"cell\":\"u4pru\",\"precision\":5,\"range\":\"area\",\"room_jid\":\"g5_u4pru@muc.chaterl.localhost\"}">>,
            body_text(cell(<<"u4pru">>), area)
        )
    ].

body_text(Cell, Range) ->
    iolist_to_binary(
        json:encode_key_value_list(
            geo_locate:response(Cell, Range, ?MUC), fun json:encode_value/2
        )
    ).

%%% Drift guard ----------------------------------------------------------------------------
%% The room id format must match what the web accepts: ROOM_LOCALPART in web/src/xmpp/jid.ts,
%% the muc.<domain> default in web/src/config.ts. The client no longer builds room JIDs: it checks
%% the server's room_jid by equality (web/src/api/locate.ts).

web_file(Parts) ->
    filename:join([filename:dirname(?FILE), "..", "..", "web", "src" | Parts]).

drift_guard_test_() ->
    case file:read_file(web_file(["xmpp", "jid.ts"])) of
        {ok, Jid} ->
            {match, [Source]} = re:run(
                Jid, "ROOM_LOCALPART\\s*=\\s*/(.+)/;", [{capture, all_but_first, binary}]
            ),
            {ok, Re} = re:compile(Source),
            ?debugFmt("drift guard ran: ROOM_LOCALPART /~s/ vs room ids", [Source]),
            Ids = [
                geo_cell:room_id(#{precision => P, geohash => binary:part(Hash, 0, P)})
             || {_, _, Hash} <- ?VECTORS, P <- [5, 6, 7]
            ],
            true = length(Ids) =:= 3 * length(?VECTORS),
            [?_assertMatch({match, _}, re:run(Id, Re)) || Id <- Ids] ++
                [
                    ?_assertEqual(match, re:run(<<"g7_u4pruyd">>, Re, [{capture, none}])),
                    config_guard()
                ];
        {error, _} ->
            ?debugMsg("drift guard skipped: web/src/xmpp/jid.ts not found"),
            []
    end.

config_guard() ->
    case file:read_file(web_file(["config.ts"])) of
        {ok, Config} ->
            ?_assertNotEqual(nomatch, binary:match(Config, <<"`muc.${domain}`">>));
        {error, _} ->
            ?debugMsg("drift guard (config.ts) skipped"),
            ?_assert(true)
    end.
