-module(geo_session_tests).

-include_lib("eunit/include/eunit.hrl").
%% eunit.hrl defines a LET macro too; it is not used here.
-undef(LET).
-include_lib("proper/include/proper.hrl").

localparts_are_random_and_well_formed_test() ->
    All = [geo_session:new_localpart() || _ <- lists:seq(1, 1000)],
    lists:foreach(
        fun(L) -> ?assertMatch({match, _}, re:run(L, "^u[0-9a-f]{32}$")) end,
        All
    ),
    ?assertEqual(1000, length(lists:usort(All))).

passwords_are_random_and_well_formed_test() ->
    All = [geo_session:new_password() || _ <- lists:seq(1, 1000)],
    lists:foreach(
        fun(P) -> ?assertMatch({match, _}, re:run(P, "^xp1_[A-Za-z0-9_-]{32}$")) end,
        All
    ),
    ?assertEqual(1000, length(lists:usort(All))).

%%% parse_credentials ----------------------------------------------------------------------

-define(DOMAIN, <<"chaterl.localhost">>).
-define(LOCAL, <<"u0123456789abcdef0123456789abcdef">>).
-define(JID, <<?LOCAL/binary, "@chaterl.localhost">>).
-define(PW, <<"xp1_abcdefghijklmnopqrstuvwxyzABCD-_">>).

parse_accepts_valid_shape_test() ->
    ?assertEqual({ok, ?LOCAL}, geo_session:parse_credentials(?JID, ?PW, ?DOMAIN)),
    L = geo_session:new_localpart(),
    P = geo_session:new_password(),
    ?assertEqual(
        {ok, L}, geo_session:parse_credentials(<<L/binary, "@chaterl.localhost">>, P, ?DOMAIN)
    ).

parse_rejects_bad_jids_test() ->
    Bad = [
        <<"u0123456789ABCDEF0123456789abcdef@chaterl.localhost">>,
        <<"u0123456789abcdef0123456789abcde@chaterl.localhost">>,
        <<"u0123456789abcdef0123456789abcdef0@chaterl.localhost">>,
        <<"0123456789abcdef0123456789abcdef0@chaterl.localhost">>,
        <<"alice@chaterl.localhost">>,
        <<?LOCAL/binary, "@other.example">>,
        <<?LOCAL/binary, "@CHATERL.LOCALHOST">>,
        <<?LOCAL/binary, "@chaterl.localhost/res">>,
        <<?LOCAL/binary, "@chaterl.localhost\n">>,
        ?LOCAL,
        <<>>
    ],
    lists:foreach(
        fun(Jid) -> ?assertEqual(error, geo_session:parse_credentials(Jid, ?PW, ?DOMAIN), Jid) end,
        Bad
    ).

parse_rejects_bad_passwords_test() ->
    Bad = [
        <<"abcdefghijklmnopqrstuvwxyzABCDEF">>,
        <<"xp1_abcdefghijklmnopqrstuvwxyzABCD-">>,
        <<"xp1_abcdefghijklmnopqrstuvwxyzABCD-_a">>,
        <<"xp1_abcdefghijklmnopqrstuvwxyzABC+-_">>,
        <<"xp1_abcdefghijklmnopqrstuvwxyzABC=-_">>,
        <<"xp1_abcdefghijklmnopqrstuvwxyzABCD-_\n">>,
        <<"XP1_abcdefghijklmnopqrstuvwxyzABCD-_">>,
        <<>>
    ],
    lists:foreach(
        fun(Pw) -> ?assertEqual(error, geo_session:parse_credentials(?JID, Pw, ?DOMAIN), Pw) end,
        Bad
    ).

parse_rejects_non_binaries_test() ->
    ?assertEqual(error, geo_session:parse_credentials(5, ?PW, ?DOMAIN)),
    ?assertEqual(error, geo_session:parse_credentials(?JID, 5, ?DOMAIN)),
    ?assertEqual(error, geo_session:parse_credentials(null, null, ?DOMAIN)),
    ?assertEqual(error, geo_session:parse_credentials(binary_to_list(?JID), ?PW, ?DOMAIN)),
    ?assertEqual(error, geo_session:parse_credentials(#{}, [], ?DOMAIN)).

parse_invalid_utf8_test() ->
    ?assertEqual(error, geo_session:parse_credentials(<<255, 254, 192, 128>>, ?PW, ?DOMAIN)),
    ?assertEqual(
        error,
        geo_session:parse_credentials(<<?LOCAL/binary, "@chaterl.localhos", 255>>, ?PW, ?DOMAIN)
    ),
    ?assertEqual(error, geo_session:parse_credentials(?JID, <<"xp1_", 255, 0:248>>, ?DOMAIN)).

prop_parse_total() ->
    ?FORALL(
        {Jid, Pw},
        {oneof([binary(), term(), ?JID]), oneof([binary(), term(), ?PW])},
        case geo_session:parse_credentials(Jid, Pw, ?DOMAIN) of
            {ok, L} -> is_binary(L);
            error -> true
        end
    ).

parse_total_test_() ->
    {timeout, 120, fun() ->
        ?assert(proper:quickcheck(prop_parse_total(), [{numtests, 1000}, {to_file, user}]))
    end}.

%%% renew/3 (meck) -------------------------------------------------------------------------

-define(SECRET, <<"unit-test-jwt-secret-0123456789-abcdefghijk">>).
-define(CFG, #{
    jwt_secret => ?SECRET,
    xmpp_domain => ?DOMAIN,
    muc_domain => <<"muc.chaterl.localhost">>,
    admin => #{
        url => "http://127.0.0.1:1/api/graphql",
        authorization => <<"Basic x">>,
        basic_b64 => <<"x">>,
        password => <<"p">>
    }
}).

renew_test_() ->
    {foreach, fun renew_setup/0, fun renew_teardown/1, [
        fun renew_malformed_makes_no_calls/0,
        fun renew_not_found_skips_admin/0,
        fun renew_pending_skips_admin/0,
        fun renew_mongo_down_skips_admin/0,
        fun renew_bad_document_internal/0,
        fun renew_check_results_mapped/0,
        fun renew_success_issues_verifiable_token/0
    ]}.

renew_setup() ->
    ok = meck:new(geo_store, [passthrough]),
    ok = meck:new(geo_xmpp_admin, [passthrough]),
    ok.

renew_teardown(_) ->
    meck:unload(geo_store),
    meck:unload(geo_xmpp_admin).

profile(State) ->
    {ok, #{id => ?LOCAL, nickname => <<"Zed">>, state => State, created_at => os:timestamp()}}.

no_admin_call() -> ?assertEqual(0, meck:num_calls(geo_xmpp_admin, check_password, '_')).

renew_malformed_makes_no_calls() ->
    ?assertEqual(
        {error, invalid_credentials}, geo_session:renew(<<"alice@chaterl.localhost">>, ?PW, ?CFG)
    ),
    ?assertEqual({error, invalid_credentials}, geo_session:renew(?JID, <<"nope">>, ?CFG)),
    ?assertEqual(0, meck:num_calls(geo_store, get_profile, '_')),
    no_admin_call().

renew_not_found_skips_admin() ->
    ok = meck:expect(geo_store, get_profile, fun(_) -> not_found end),
    ?assertEqual({error, invalid_credentials}, geo_session:renew(?JID, ?PW, ?CFG)),
    no_admin_call().

renew_pending_skips_admin() ->
    ok = meck:expect(geo_store, get_profile, fun(_) -> profile(pending) end),
    ?assertEqual({error, invalid_credentials}, geo_session:renew(?JID, ?PW, ?CFG)),
    no_admin_call().

renew_mongo_down_skips_admin() ->
    ok = meck:expect(geo_store, get_profile, fun(_) -> {error, mongo_unavailable} end),
    ?assertEqual({error, unavailable}, geo_session:renew(?JID, ?PW, ?CFG)),
    no_admin_call().

renew_bad_document_internal() ->
    ok = meck:expect(geo_store, get_profile, fun(_) -> {error, bad_document} end),
    ?assertEqual({error, internal}, geo_session:renew(?JID, ?PW, ?CFG)),
    no_admin_call().

renew_check_results_mapped() ->
    ok = meck:expect(geo_store, get_profile, fun(_) -> profile(active) end),
    Check = fun(Result) ->
        ok = meck:expect(geo_xmpp_admin, check_password, fun(_, _, _) -> Result end),
        geo_session:renew(?JID, ?PW, ?CFG)
    end,
    ?assertEqual({error, invalid_credentials}, Check({error, invalid})),
    ?assertEqual({error, unavailable}, Check({error, unavailable})),
    ?assertEqual({error, internal}, Check({error, unauthorized})),
    ?assertEqual({error, internal}, Check({error, bad_response})).

renew_success_issues_verifiable_token() ->
    ok = meck:expect(geo_store, get_profile, fun(_) -> profile(active) end),
    ok = meck:expect(geo_xmpp_admin, check_password, fun(_, _, _) -> ok end),
    {ok, #{nickname := <<"Zed">>, token := Token, expires_in := 3600}} =
        geo_session:renew(?JID, ?PW, ?CFG),
    ?assertMatch(
        {ok, #{sub := ?LOCAL}}, geo_auth:verify(Token, ?SECRET, erlang:system_time(second))
    ),
    %% The check received the exact jid and password.
    ?assertEqual(1, meck:num_calls(geo_xmpp_admin, check_password, ['_', ?JID, ?PW])).
