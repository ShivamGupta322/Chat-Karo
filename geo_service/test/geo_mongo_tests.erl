-module(geo_mongo_tests).

-include_lib("eunit/include/eunit.hrl").

classify_write_test_() ->
    [
        ?_assertEqual(
            {ok, #{matched => 1, upserted => false}},
            geo_mongo:classify_write({true, #{<<"n">> => 1, <<"nModified">> => 1, <<"ok">> => 1.0}})
        ),
        ?_assertEqual(
            {ok, #{matched => 1, upserted => true}},
            geo_mongo:classify_write(
                {true, #{<<"n">> => 1, <<"upserted">> => [#{<<"index">> => 0}], <<"ok">> => 1.0}}
            )
        ),
        ?_assertEqual(
            {ok, #{matched => 0, upserted => false}},
            geo_mongo:classify_write({true, #{<<"n">> => 0, <<"ok">> => 1.0}})
        ),
        ?_assertEqual(
            {error, {write_failed, 11000}},
            geo_mongo:classify_write(
                {true, #{
                    <<"n">> => 0,
                    <<"writeErrors">> => [#{<<"index">> => 0, <<"code">> => 11000}]
                }}
            )
        ),
        ?_assertEqual(
            {error, {write_failed, unknown}},
            geo_mongo:classify_write({true, #{<<"writeErrors">> => [#{<<"errmsg">> => <<"x">>}]}})
        ),
        ?_assertEqual(
            {error, {write_failed, 64}},
            geo_mongo:classify_write(
                {true, #{<<"n">> => 1, <<"writeConcernError">> => #{<<"code">> => 64}}}
            )
        ),
        ?_assertEqual(
            {error, {write_failed, unknown}},
            geo_mongo:classify_write({true, #{<<"writeConcernError">> => #{}}})
        ),
        ?_assertEqual(
            {error, {write_failed, unknown}}, geo_mongo:classify_write({true, #{<<"ok">> => 1.0}})
        ),
        ?_assertEqual(
            {error, {write_failed, unknown}}, geo_mongo:classify_write({false, #{<<"ok">> => 0.0}})
        ),
        ?_assertEqual({error, mongo_unavailable}, geo_mongo:classify_write({error, timeout})),
        ?_assertEqual(
            {error, mongo_unavailable}, geo_mongo:classify_write({error, {noproc, whatever}})
        )
    ].

%% Without a running probe the status table is absent: not ready, and no crash.
ready_false_without_probe_test() ->
    ?assertEqual(false, geo_mongo:ready()).

%% Without a topology the wrappers must not crash the caller.
wrappers_without_topology_test_() ->
    [
        ?_assertEqual({error, mongo_unavailable}, geo_mongo:ping()),
        ?_assertEqual({error, mongo_unavailable}, geo_mongo:find_one(<<"rooms">>, #{}, #{})),
        ?_assertEqual(
            {error, mongo_unavailable},
            geo_mongo:update_one(<<"rooms">>, #{}, #{<<"$set">> => #{<<"a">> => 1}}, #{})
        )
    ].
