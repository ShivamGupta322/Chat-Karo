-module(geo_xmpp_admin_tests).

-include_lib("eunit/include/eunit.hrl").

-define(JID, <<"u0123456789abcdef0123456789abcdef@chaterl.localhost">>).
-define(ADMIN, #{
    url => "http://mongooseim:5551/api/graphql",
    authorization => <<"Basic QWxhZGRpbjpvcGVu">>,
    basic_b64 => <<"QWxhZGRpbjpvcGVu">>,
    password => <<"open">>
}).

%%% Requests -------------------------------------------------------------------------------

register_request_test() ->
    {Url, Headers, ContentType, Body} =
        geo_xmpp_admin:register_request(
            ?ADMIN,
            <<"chaterl.localhost">>,
            <<"u0123456789abcdef0123456789abcdef">>,
            <<"xp1_secret">>
        ),
    ?assertEqual("http://mongooseim:5551/api/graphql", Url),
    ?assertEqual([{"authorization", "Basic QWxhZGRpbjpvcGVu"}], Headers),
    ?assertEqual("application/json", ContentType),
    #{<<"query">> := Query, <<"variables">> := Variables} = json:decode(Body),
    ?assertMatch({_, _}, binary:match(Query, <<"registerUser">>)),
    %% Values travel in variables only: the query is a constant.
    ?assertEqual(nomatch, binary:match(Query, <<"xp1_secret">>)),
    ?assertEqual(nomatch, binary:match(Query, <<"u0123456789abcdef">>)),
    ?assertEqual(nomatch, binary:match(Query, <<"chaterl.localhost">>)),
    ?assertEqual(
        #{
            <<"domain">> => <<"chaterl.localhost">>,
            <<"username">> => <<"u0123456789abcdef0123456789abcdef">>,
            <<"password">> => <<"xp1_secret">>
        },
        Variables
    ).

query_is_a_constant_test() ->
    Query = fun(Localpart, Password) ->
        {_, _, _, Body} = geo_xmpp_admin:register_request(?ADMIN, <<"d">>, Localpart, Password),
        maps:get(<<"query">>, json:decode(Body))
    end,
    ?assertEqual(Query(<<"a">>, <<"b">>), Query(<<"c">>, <<"d">>)).

remove_request_test() ->
    {_Url, Headers, _CT, Body} =
        geo_xmpp_admin:remove_request(
            ?ADMIN, <<"chaterl.localhost">>, <<"u0123456789abcdef0123456789abcdef">>
        ),
    ?assertEqual([{"authorization", "Basic QWxhZGRpbjpvcGVu"}], Headers),
    #{<<"query">> := Query, <<"variables">> := Variables} = json:decode(Body),
    ?assertMatch({_, _}, binary:match(Query, <<"removeUser">>)),
    ?assertEqual(nomatch, binary:match(Query, <<"u0123456789abcdef">>)),
    ?assertEqual(#{<<"user">> => ?JID}, Variables).

%%% parse_register -------------------------------------------------------------------------

register_success_test() ->
    Body = json:encode(#{
        <<"data">> => #{
            <<"account">> => #{
                <<"registerUser">> => #{<<"jid">> => ?JID, <<"message">> => <<"User registered">>}
            }
        }
    }),
    ?assertEqual(ok, parse_register(200, Body)).

register_jid_mismatch_test() ->
    Body = json:encode(#{
        <<"data">> => #{
            <<"account">> => #{<<"registerUser">> => #{<<"jid">> => <<"other@chaterl.localhost">>}}
        }
    }),
    ?assertEqual({error, bad_response}, parse_register(200, Body)).

register_exists_test() ->
    ?assertEqual({error, exists}, parse_register(200, gql_error(<<"exists">>))).

register_cannot_register_test() ->
    ?assertEqual({error, rejected}, parse_register(200, gql_error(<<"cannot_register">>))).

register_input_coercion_400_test() ->
    ?assertEqual({error, bad_response}, parse_register(400, gql_error(<<"input_coercion">>))).

register_unauthorized_test() ->
    ?assertEqual({error, unauthorized}, parse_register(401, gql_error(<<"wrong_credentials">>))),
    ?assertEqual({error, unauthorized}, parse_register(401, gql_error(<<"no_permissions">>))).

register_server_error_test() ->
    ?assertEqual({error, unavailable}, parse_register(503, <<"upstream down">>)),
    ?assertEqual({error, unavailable}, parse_register(500, <<>>)).

register_garbage_test() ->
    ?assertEqual({error, bad_response}, parse_register(200, <<"<html>">>)),
    ?assertEqual({error, bad_response}, parse_register(200, <<"[]">>)),
    ?assertEqual({error, bad_response}, parse_register(200, <<"{}">>)),
    ?assertEqual({error, bad_response}, parse_register(200, gql_error(<<"something_else">>))),
    ?assertEqual({error, bad_response}, parse_register(404, <<>>)),
    ?assertEqual({error, bad_response}, parse_register(302, <<>>)).

%%% parse_remove ---------------------------------------------------------------------------

remove_success_test() ->
    Body = json:encode(#{
        <<"data">> => #{<<"account">> => #{<<"removeUser">> => #{<<"jid">> => ?JID}}}
    }),
    ?assertEqual(ok, geo_xmpp_admin:parse_remove(200, iolist_to_binary(Body), ?JID)).

remove_not_allowed_test() ->
    ?assertEqual(
        {error, not_found}, geo_xmpp_admin:parse_remove(200, gql_error(<<"not_allowed">>), ?JID)
    ).

remove_failures_test() ->
    ?assertEqual({error, unauthorized}, geo_xmpp_admin:parse_remove(401, <<>>, ?JID)),
    ?assertEqual({error, unavailable}, geo_xmpp_admin:parse_remove(502, <<>>, ?JID)),
    ?assertEqual({error, bad_response}, geo_xmpp_admin:parse_remove(400, <<>>, ?JID)),
    ?assertEqual({error, bad_response}, geo_xmpp_admin:parse_remove(200, <<"x">>, ?JID)).

%%% helpers --------------------------------------------------------------------------------

parse_register(Status, Body) ->
    geo_xmpp_admin:parse_register(Status, iolist_to_binary(Body), ?JID).

gql_error(Code) ->
    iolist_to_binary(
        json:encode(#{
            <<"errors">> => [
                #{<<"message">> => <<"x">>, <<"extensions">> => #{<<"code">> => Code}}
            ],
            <<"data">> => #{<<"account">> => #{<<"registerUser">> => null}}
        })
    ).

%%% check_password -------------------------------------------------------------------------

check_request_test() ->
    {Url, Headers, ContentType, Body} =
        geo_xmpp_admin:check_password_request(?ADMIN, ?JID, <<"xp1_secret">>),
    ?assertEqual("http://mongooseim:5551/api/graphql", Url),
    ?assertEqual([{"authorization", "Basic QWxhZGRpbjpvcGVu"}], Headers),
    ?assertEqual("application/json", ContentType),
    #{<<"query">> := Query, <<"variables">> := Variables} = json:decode(Body),
    ?assertMatch({_, _}, binary:match(Query, <<"checkPassword">>)),
    %% Only `correct` is selected: the default `message` field would echo the password.
    ?assertMatch({_, _}, binary:match(Query, <<"{ correct }">>)),
    ?assertEqual(nomatch, binary:match(Query, <<"message">>)),
    ?assertEqual(nomatch, binary:match(Query, <<"xp1_secret">>)),
    ?assertEqual(nomatch, binary:match(Query, <<"u0123456789abcdef">>)),
    ?assertEqual(#{<<"user">> => ?JID, <<"password">> => <<"xp1_secret">>}, Variables).

check_query_is_a_constant_test() ->
    Query = fun(Jid, Password) ->
        {_, _, _, Body} = geo_xmpp_admin:check_password_request(?ADMIN, Jid, Password),
        maps:get(<<"query">>, json:decode(Body))
    end,
    ?assertEqual(Query(<<"a">>, <<"b">>), Query(<<"c">>, <<"d">>)).

check_correct_test() ->
    ?assertEqual(ok, parse_check(200, check_body(true))),
    ?assertEqual({error, invalid}, parse_check(200, check_body(false))).

check_user_does_not_exist_test() ->
    Body = json:encode(#{
        <<"errors">> => [
            #{
                <<"message">> => <<"Password xp1_secret for user x does not exist">>,
                <<"extensions">> => #{<<"code">> => <<"user_does_not_exist">>}
            }
        ],
        <<"data">> => #{<<"account">> => #{<<"checkPassword">> => null}}
    }),
    ?assertEqual({error, invalid}, parse_check(200, Body)).

check_bad_response_test() ->
    ?assertEqual({error, bad_response}, parse_check(200, gql_error(<<"something_else">>))),
    ?assertEqual({error, bad_response}, parse_check(200, check_body(<<"true">>))),
    ?assertEqual({error, bad_response}, parse_check(200, check_body(null))),
    ?assertEqual({error, bad_response}, parse_check(200, <<"<html>">>)),
    ?assertEqual({error, bad_response}, parse_check(200, <<"{}">>)),
    ?assertEqual({error, bad_response}, parse_check(400, gql_error(<<"input_coercion">>))),
    ?assertEqual({error, bad_response}, parse_check(302, <<>>)).

check_status_errors_test() ->
    ?assertEqual({error, unauthorized}, parse_check(401, gql_error(<<"wrong_credentials">>))),
    ?assertEqual({error, unavailable}, parse_check(500, <<>>)),
    ?assertEqual({error, unavailable}, parse_check(503, <<"down">>)).

parse_check(Status, Body) ->
    geo_xmpp_admin:parse_check_password(Status, iolist_to_binary(Body)).

check_body(Correct) ->
    json:encode(#{
        <<"data">> => #{<<"account">> => #{<<"checkPassword">> => #{<<"correct">> => Correct}}}
    }).
