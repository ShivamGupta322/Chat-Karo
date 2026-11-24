-module(geo_config_tests).

-include_lib("eunit/include/eunit.hrl").

parse_port_accepts_test_() ->
    [
        ?_assertEqual({ok, N}, geo_config:parse_port(In))
     || {In, N} <- [
            {8080, 8080},
            {"8080", 8080},
            {<<"8080">>, 8080},
            {0, 0},
            {65535, 65535}
        ]
    ].

parse_port_rejects_test_() ->
    [
        ?_assertEqual(error, geo_config:parse_port(In))
     || In <- [
            "", " 8080", "8080x", "-1", 65536, "65536", 8080.0, undefined, <<>>, -1, [a], [-5, 6]
        ]
    ].

parse_ip_accepts_test_() ->
    [
        ?_assertEqual({ok, Ip}, geo_config:parse_ip(In))
     || {In, Ip} <- [
            {"0.0.0.0", {0, 0, 0, 0}},
            {"127.0.0.1", {127, 0, 0, 1}},
            {<<"127.0.0.1">>, {127, 0, 0, 1}}
        ]
    ].

parse_ip_rejects_test_() ->
    [
        ?_assertEqual(error, geo_config:parse_ip(In))
     || In <- ["", "::", "localhost", "256.0.0.1", undefined, <<>>, [a], [300, 1]]
    ].

http_listen_test_() ->
    {foreach, fun save_env/0, fun restore_env/1, [
        fun(_) ->
            set(http_ip, "127.0.0.1"),
            set(http_port, "8080"),
            ?_assertEqual(
                {ok, #{ip => {127, 0, 0, 1}, port => 8080}}, geo_config:http_listen()
            )
        end,
        fun(_) ->
            unset(http_ip),
            set(http_port, "8080"),
            ?_assertEqual({error, {bad_config, http_ip}}, geo_config:http_listen())
        end,
        fun(_) ->
            set(http_ip, "127.0.0.1"),
            set(http_port, ""),
            ?_assertEqual({error, {bad_config, http_port}}, geo_config:http_listen())
        end,
        fun(_) ->
            set(http_ip, ""),
            set(http_port, ""),
            ?_assertEqual({error, {bad_config, http_ip}}, geo_config:http_listen())
        end,
        fun(_) ->
            set(http_ip, "127.0.0.1"),
            unset(http_port),
            ?_assertEqual({error, {bad_config, http_port}}, geo_config:http_listen())
        end
    ]}.

save_env() ->
    [{K, application:get_env(geo_service, K)} || K <- [http_ip, http_port]].

restore_env(Saved) ->
    lists:foreach(
        fun
            ({K, {ok, V}}) -> application:set_env(geo_service, K, V);
            ({K, undefined}) -> application:unset_env(geo_service, K)
        end,
        Saved
    ).

set(K, V) -> application:set_env(geo_service, K, V).
unset(K) -> application:unset_env(geo_service, K).

%%% MongoDB ---------------------------------------------------------------------------------

-define(PW_SENTINEL, "pw-sentinel-5k5k").
-define(MONGO_KEYS, [
    mongo_hosts,
    mongo_replica_set,
    mongo_db,
    mongo_user,
    mongo_password,
    mongo_auth_source,
    mongo_tls,
    mongo_tls_ca_file,
    mongo_pool_size
]).

hosts_of(N) ->
    string:join(["h" ++ integer_to_list(I) || I <- lists:seq(1, N)], ",").

parse_hosts_accepts_test_() ->
    [
        ?_assertEqual({ok, [{"mongo", 27017}]}, geo_config:parse_hosts("mongo:27017")),
        ?_assertEqual({ok, [{"mongo", 27017}]}, geo_config:parse_hosts("mongo")),
        ?_assertEqual(
            {ok, [{"a.example.net", 27017}, {"b.example.net", 27017}]},
            geo_config:parse_hosts("a.example.net:27017,b.example.net:27017")
        ),
        ?_assertEqual({ok, [{"127.0.0.1", 27018}]}, geo_config:parse_hosts(<<"127.0.0.1:27018">>)),
        ?_assertMatch({ok, L} when length(L) =:= 16, geo_config:parse_hosts(hosts_of(16)))
    ].

parse_hosts_rejects_test_() ->
    [
        ?_assertEqual(error, geo_config:parse_hosts(In))
     || In <- [
            "",
            " mongo",
            "mongo ",
            "mongo:",
            "mongo:0",
            "mongo:70000",
            "mongo:123456",
            "[::1]:27017",
            "a,,b",
            "mongodb://x",
            "a:b:c",
            "mon go",
            "mongo,",
            hosts_of(17),
            undefined,
            <<>>,
            [a]
        ]
    ].

replica_set_rule_test_() ->
    [
        ?_assertEqual({ok, <<>>}, geo_config:parse_replica_set("")),
        ?_assertEqual({ok, <<"atlas-abc_1.x">>}, geo_config:parse_replica_set("atlas-abc_1.x")),
        ?_assertEqual(error, geo_config:parse_replica_set("a b")),
        ?_assertEqual(error, geo_config:parse_replica_set(lists:duplicate(65, $a))),
        ?_assertEqual(error, geo_config:parse_replica_set(undefined))
    ].

db_regex_test_() ->
    Long = lists:duplicate(63, $a),
    [
        ?_assertEqual({ok, <<"chaterl_ct-1">>}, geo_config:parse_db("chaterl_ct-1")),
        ?_assertEqual({ok, list_to_binary(Long)}, geo_config:parse_db(Long)),
        ?_assertEqual(error, geo_config:parse_db("")),
        ?_assertEqual(error, geo_config:parse_db("a.b")),
        ?_assertEqual(error, geo_config:parse_db("a/b")),
        ?_assertEqual(error, geo_config:parse_db(Long ++ "a")),
        ?_assertEqual(error, geo_config:parse_db(undefined))
    ].

user_and_password_charset_test_() ->
    [
        ?_assertEqual({ok, <<"ct.user@x-1_">>}, geo_config:parse_user("ct.user@x-1_")),
        ?_assertEqual({ok, <<>>}, geo_config:parse_user("")),
        ?_assertEqual(error, geo_config:parse_user("a b")),
        ?_assertEqual(error, geo_config:parse_user(lists:duplicate(129, $a))),
        ?_assertEqual({ok, <<"pa$$w0rd!">>}, geo_config:parse_password("pa$$w0rd!")),
        ?_assertEqual({ok, <<>>}, geo_config:parse_password("")),
        ?_assertEqual(error, geo_config:parse_password([$a, $", $b])),
        ?_assertEqual(error, geo_config:parse_password([$a, $\\, $b])),
        ?_assertEqual(error, geo_config:parse_password([$a, 10, $b])),
        ?_assertEqual(error, geo_config:parse_password([$a, 0])),
        ?_assertEqual(error, geo_config:parse_password([$a, 127])),
        ?_assertEqual(error, geo_config:parse_password([$a, 200])),
        ?_assertEqual(error, geo_config:parse_password([$a, 955])),
        ?_assertEqual({ok, <<"~ ">>}, geo_config:parse_password("~ ")),
        ?_assertEqual(error, geo_config:parse_password(undefined))
    ].

auth_source_test_() ->
    [
        ?_assertEqual({ok, <<"admin">>}, geo_config:parse_auth_source("")),
        ?_assertEqual({ok, <<"mydb">>}, geo_config:parse_auth_source("mydb")),
        ?_assertEqual(error, geo_config:parse_auth_source("a.b")),
        ?_assertEqual(error, geo_config:parse_auth_source(undefined))
    ].

tls_strictness_test_() ->
    [
        ?_assertEqual({ok, true}, geo_config:parse_tls("true")),
        ?_assertEqual({ok, false}, geo_config:parse_tls("false")),
        ?_assertEqual({ok, false}, geo_config:parse_tls("")),
        ?_assertEqual(error, geo_config:parse_tls("TRUE")),
        ?_assertEqual(error, geo_config:parse_tls("1")),
        ?_assertEqual(error, geo_config:parse_tls("yes")),
        ?_assertEqual(error, geo_config:parse_tls(true)),
        ?_assertEqual(error, geo_config:parse_tls(undefined))
    ].

%% The "" case loads the OS trust store, which is slow on some machines (over 4 s on Windows).
%% The timeout must wrap that single test: a group timeout does not lift eunit's 5 s per-test default.
tls_ca_file_test_() ->
    [
        ?_assertEqual(error, geo_config:parse_tls_ca_file("/definitely/not/here.pem")),
        ?_assertEqual(error, geo_config:parse_tls_ca_file(undefined)),
        {timeout, 120, ?_assertEqual({ok, os}, geo_config:parse_tls_ca_file(""))},
        ?_assertMatch({ok, _}, geo_config:parse_tls_ca_file(code:which(?MODULE)))
    ].

pool_size_bounds_test_() ->
    [
        ?_assertEqual({ok, 5}, geo_config:parse_pool_size("")),
        ?_assertEqual({ok, 1}, geo_config:parse_pool_size("1")),
        ?_assertEqual({ok, 50}, geo_config:parse_pool_size("50")),
        ?_assertEqual({ok, 7}, geo_config:parse_pool_size(<<"7">>)),
        ?_assertEqual(error, geo_config:parse_pool_size("0")),
        ?_assertEqual(error, geo_config:parse_pool_size("51")),
        ?_assertEqual(error, geo_config:parse_pool_size("-1")),
        ?_assertEqual(error, geo_config:parse_pool_size("5x")),
        ?_assertEqual(error, geo_config:parse_pool_size("100")),
        ?_assertEqual(error, geo_config:parse_pool_size(5))
    ].

mongo_test_() ->
    {foreach, fun save_mongo_env/0, fun restore_env/1, [
        fun(_) ->
            base_mongo(#{}),
            ?_assertEqual(
                {ok, #{
                    seed => {single, "mongo:27017"},
                    database => <<"chaterl">>,
                    auth => none,
                    tls => false,
                    pool_size => 5
                }},
                geo_config:mongo()
            )
        end,
        fun(_) ->
            base_mongo(#{
                mongo_hosts => "a.example.net:27017,b.example.net",
                mongo_replica_set => "atlas-rs",
                mongo_user => "svc",
                mongo_password => "pw1",
                mongo_pool_size => "9"
            }),
            ?_assertEqual(
                {ok, #{
                    seed => {rs, <<"atlas-rs">>, ["a.example.net:27017", "b.example.net:27017"]},
                    database => <<"chaterl">>,
                    auth => #{user => <<"svc">>, password => <<"pw1">>, source => <<"admin">>},
                    tls => false,
                    pool_size => 9
                }},
                geo_config:mongo()
            )
        end,
        fun(_) ->
            base_mongo(#{mongo_replica_set => "rs0"}),
            ?_assertMatch({ok, #{seed := {rs, <<"rs0">>, ["mongo:27017"]}}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_hosts => "a:1,b:2"}),
            ?_assertEqual({error, {bad_config, mongo_replica_set}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_hosts => ""}),
            ?_assertEqual({error, {bad_config, mongo_hosts}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{}),
            unset(mongo_hosts),
            ?_assertEqual({error, {bad_config, mongo_hosts}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_db => ""}),
            ?_assertEqual({error, {bad_config, mongo_db}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_user => "svc"}),
            ?_assertEqual({error, {bad_config, mongo_password}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_password => "pw"}),
            ?_assertEqual({error, {bad_config, mongo_user}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_user => "svc", mongo_password => [$a, $", $b]}),
            ?_assertEqual({error, {bad_config, mongo_password}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_user => "svc", mongo_password => [$a, 200, $b]}),
            ?_assertEqual({error, {bad_config, mongo_password}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_user => "svc", mongo_password => "pw", mongo_auth_source => "mydb"}),
            ?_assertMatch({ok, #{auth := #{source := <<"mydb">>}}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_tls => "TRUE"}),
            ?_assertEqual({error, {bad_config, mongo_tls}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_tls => "true", mongo_tls_ca_file => "/definitely/not/here.pem"}),
            ?_assertEqual({error, {bad_config, mongo_tls_ca_file}}, geo_config:mongo())
        end,
        fun(_) ->
            %% The CA file is ignored (even if bogus) while TLS is off.
            base_mongo(#{mongo_tls => "false", mongo_tls_ca_file => "/definitely/not/here.pem"}),
            ?_assertMatch({ok, #{tls := false}}, geo_config:mongo())
        end,
        fun(_) ->
            File = code:which(?MODULE),
            base_mongo(#{mongo_tls => "true", mongo_tls_ca_file => File}),
            ?_assertMatch({ok, #{tls := #{ca := File}}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_pool_size => "51"}),
            ?_assertEqual({error, {bad_config, mongo_pool_size}}, geo_config:mongo())
        end,
        %% Validation order: hosts, replica_set, db, user, password, auth_source, tls,
        %% tls_ca_file, pool_size.
        fun(_) ->
            base_mongo(#{mongo_hosts => "", mongo_db => "", mongo_pool_size => "99"}),
            ?_assertEqual({error, {bad_config, mongo_hosts}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{
                mongo_db => "", mongo_user => "svc", mongo_tls => "x", mongo_pool_size => "99"
            }),
            ?_assertEqual({error, {bad_config, mongo_db}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_user => "svc", mongo_tls => "x", mongo_pool_size => "99"}),
            ?_assertEqual({error, {bad_config, mongo_password}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{mongo_tls => "x", mongo_pool_size => "99"}),
            ?_assertEqual({error, {bad_config, mongo_tls}}, geo_config:mongo())
        end,
        fun(_) ->
            base_mongo(#{
                mongo_tls => "true", mongo_tls_ca_file => "/nope.pem", mongo_pool_size => "99"
            }),
            ?_assertEqual({error, {bad_config, mongo_tls_ca_file}}, geo_config:mongo())
        end,
        %% No returned term contains the password (invalid or valid password, failing later key).
        fun(_) ->
            base_mongo(#{
                mongo_user => "svc",
                mongo_password => ?PW_SENTINEL ++ [$"],
                mongo_pool_size => "x"
            }),
            ?_assertEqual(nomatch, string:find(printed(geo_config:mongo()), ?PW_SENTINEL))
        end,
        fun(_) ->
            base_mongo(#{
                mongo_user => "svc", mongo_password => ?PW_SENTINEL ++ "-ok", mongo_pool_size => "x"
            }),
            Result = geo_config:mongo(),
            [
                ?_assertEqual({error, {bad_config, mongo_pool_size}}, Result),
                ?_assertEqual(nomatch, string:find(printed(Result), ?PW_SENTINEL))
            ]
        end
    ]}.

printed(Term) -> lists:flatten(io_lib:format("~0p", [Term])).

save_mongo_env() ->
    [{K, application:get_env(geo_service, K)} || K <- ?MONGO_KEYS].

%% A valid standalone config, with overrides.
base_mongo(Overrides) ->
    Base = #{
        mongo_hosts => "mongo:27017",
        mongo_replica_set => "",
        mongo_db => "chaterl",
        mongo_user => "",
        mongo_password => "",
        mongo_auth_source => "",
        mongo_tls => "",
        mongo_tls_ca_file => "",
        mongo_pool_size => ""
    },
    maps:foreach(fun set/2, maps:merge(Base, Overrides)).

%%% session() -------------------------------------------------------------------------------

-define(SESSION_KEYS, [
    jwt_secret, xmpp_domain, mim_admin_url, mim_admin_user, mim_admin_password, xmpp_room_owner
]).
-define(GOOD_SECRET, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").

jwt_secret_accepts_test_() ->
    [
        ?_assertEqual({ok, <<?GOOD_SECRET>>}, geo_config:parse_jwt_secret(?GOOD_SECRET)),
        ?_assertEqual({ok, <<?GOOD_SECRET>>}, geo_config:parse_jwt_secret(<<?GOOD_SECRET>>)),
        ?_assertMatch({ok, _}, geo_config:parse_jwt_secret(lists:duplicate(32, $a) ++ "bcdefghij")),
        ?_assertMatch({ok, _}, geo_config:parse_jwt_secret(sample_secret(512)))
    ].

jwt_secret_rejects_test_() ->
    [
        ?_assertEqual(error, geo_config:parse_jwt_secret(In))
     || In <- [
            "",
            undefined,
            sample_secret(31),
            lists:duplicate(32, $a),
            "change-me-to-a-long-random-string",
            string:uppercase("change-me-") ++ sample_secret(54),
            "Change-Me-" ++ sample_secret(54),
            sample_secret(40) ++ "\"",
            sample_secret(40) ++ "\\",
            sample_secret(40) ++ "\r",
            sample_secret(40) ++ [200],
            sample_secret(513)
        ]
    ].

xmpp_domain_test_() ->
    [
        ?_assertEqual(
            {ok, <<"chaterl.localhost">>}, geo_config:parse_xmpp_domain("chaterl.localhost")
        ),
        ?_assertEqual(error, geo_config:parse_xmpp_domain("")),
        ?_assertEqual(error, geo_config:parse_xmpp_domain("a b")),
        ?_assertEqual(error, geo_config:parse_xmpp_domain("a/b")),
        ?_assertEqual(error, geo_config:parse_xmpp_domain(lists:duplicate(254, $a))),
        %% MongooseIM lowercases JIDs, so an uppercase domain is rejected.
        ?_assertEqual(error, geo_config:parse_xmpp_domain("Chaterl.Localhost")),
        ?_assertEqual(error, geo_config:parse_xmpp_domain("CHATERL.LOCALHOST"))
    ].

admin_url_test_() ->
    [
        ?_assertEqual(
            {ok, "http://mongooseim:5551/api/graphql"},
            geo_config:parse_admin_url("http://mongooseim:5551/api/graphql")
        )
        | [
            ?_assertEqual(error, geo_config:parse_admin_url(In))
         || In <- [
                "",
                "https://mongooseim:5551/api/graphql",
                "ftp://h/x",
                "http://u:p@h/x",
                "http:///x",
                "http://h",
                "http://h/x?q=1",
                "http://h/x#f",
                "http://h/a b",
                undefined
            ]
        ]
    ].

admin_user_and_password_test_() ->
    [
        ?_assertEqual({ok, <<"admin">>}, geo_config:parse_admin_user("admin")),
        ?_assertEqual(error, geo_config:parse_admin_user("")),
        ?_assertEqual(error, geo_config:parse_admin_user("a:b")),
        ?_assertEqual(error, geo_config:parse_admin_user("a b")),
        ?_assertEqual({ok, <<"pw 1">>}, geo_config:parse_admin_password("pw 1")),
        ?_assertEqual(error, geo_config:parse_admin_password("")),
        ?_assertEqual(error, geo_config:parse_admin_password("a\"b")),
        ?_assertEqual(error, geo_config:parse_admin_password("a\b")),
        ?_assertEqual(error, geo_config:parse_admin_password("a\r"))
    ].

room_owner_accepts_test_() ->
    [
        ?_assertEqual({ok, <<"nearby-rooms">>}, geo_config:parse_room_owner("nearby-rooms")),
        ?_assertEqual({ok, <<"nearby-rooms">>}, geo_config:parse_room_owner(<<"nearby-rooms">>)),
        ?_assertEqual({ok, <<"abc">>}, geo_config:parse_room_owner("abc")),
        ?_assertMatch({ok, _}, geo_config:parse_room_owner(lists:duplicate(32, $a))),
        %% u + 31 hex is too short for the pseudonymous shape; u + 31 non-hex is not hex
        ?_assertMatch({ok, _}, geo_config:parse_room_owner("u" ++ lists:duplicate(31, $a))),
        ?_assertMatch({ok, _}, geo_config:parse_room_owner("u" ++ lists:duplicate(31, $g)))
    ].

room_owner_rejects_test_() ->
    [
        ?_assertEqual(error, geo_config:parse_room_owner(In))
     || In <- [
            "",
            "Nearby",
            "n",
            "ne",
            lists:duplicate(33, $a),
            "u0123456789abcdef0123456789abcdef",
            "a b",
            "1abc",
            "-abc",
            "ab_c",
            "ab@c",
            undefined,
            123,
            [a, b]
        ]
    ].

session_test_() ->
    {foreach, fun save_session_env/0, fun restore_env/1, [
        fun(_) ->
            base_session(#{}),
            [
                ?_assertMatch(
                    {ok, #{
                        jwt_secret := <<?GOOD_SECRET>>,
                        xmpp_domain := <<"chaterl.localhost">>,
                        muc_domain := <<"muc.chaterl.localhost">>,
                        room_owner := <<"nearby-rooms">>,
                        admin := #{
                            url := "http://mongooseim:5551/api/graphql",
                            authorization := <<"Basic ", _/binary>>,
                            password := <<"adm1n pw">>
                        }
                    }},
                    geo_config:session()
                ),
                ?_assertMatch(
                    {ok, #{admin := #{basic_b64 := B}}} when
                        B =:= <<"YWRtaW46YWRtMW4gcHc=">>,
                    geo_config:session()
                )
            ]
        end
        | [
            fun(_) ->
                base_session(#{Key => Value}),
                ?_assertEqual({error, {bad_config, Key}}, geo_config:session())
            end
         || {Key, Value} <- [
                {jwt_secret, ""},
                {jwt_secret, "short"},
                {jwt_secret, lists:duplicate(40, $a)},
                {xmpp_domain, ""},
                {mim_admin_url, "https://mongooseim:5551/api/graphql"},
                {mim_admin_user, ""},
                {mim_admin_password, ""},
                {xmpp_room_owner, ""},
                {xmpp_room_owner, "Nearby"}
            ]
        ] ++
            [
                %% The first invalid key in order wins.
                fun(_) ->
                    base_session(#{jwt_secret => "", mim_admin_url => "x"}),
                    ?_assertEqual({error, {bad_config, jwt_secret}}, geo_config:session())
                end,
                fun(_) ->
                    base_session(#{}),
                    unset(xmpp_domain),
                    ?_assertEqual({error, {bad_config, xmpp_domain}}, geo_config:session())
                end,
                fun(_) ->
                    base_session(#{}),
                    unset(xmpp_room_owner),
                    ?_assertEqual({error, {bad_config, xmpp_room_owner}}, geo_config:session())
                end,
                %% The room owner is validated last.
                fun(_) ->
                    base_session(#{xmpp_room_owner => "Bad Owner", mim_admin_user => ""}),
                    ?_assertEqual({error, {bad_config, mim_admin_user}}, geo_config:session())
                end,
                fun(_) ->
                    base_session(#{xmpp_room_owner => ?PW_SENTINEL ++ "!"}),
                    Result = geo_config:session(),
                    [
                        ?_assertEqual({error, {bad_config, xmpp_room_owner}}, Result),
                        ?_assertEqual(nomatch, string:find(printed(Result), ?PW_SENTINEL))
                    ]
                end,
                %% No error ever contains the offending value.
                fun(_) ->
                    base_session(#{jwt_secret => ?PW_SENTINEL ++ "\""}),
                    Result = geo_config:session(),
                    [
                        ?_assertEqual({error, {bad_config, jwt_secret}}, Result),
                        ?_assertEqual(nomatch, string:find(printed(Result), ?PW_SENTINEL))
                    ]
                end,
                fun(_) ->
                    base_session(#{mim_admin_password => ?PW_SENTINEL ++ "\"", mim_admin_user => ""}),
                    Result = geo_config:session(),
                    [
                        ?_assertEqual({error, {bad_config, mim_admin_user}}, Result),
                        ?_assertEqual(nomatch, string:find(printed(Result), ?PW_SENTINEL))
                    ]
                end
            ]
    ]}.

muc_domain_test_() ->
    Domain = fun(N) -> lists:duplicate(N, $a) end,
    [
        ?_assertEqual(<<"muc.chaterl.localhost">>, geo_config:muc_domain(<<"chaterl.localhost">>)),
        {foreach, fun save_session_env/0, fun restore_env/1, [
            fun(_) ->
                base_session(#{xmpp_domain => Domain(249)}),
                ?_assertMatch({ok, #{muc_domain := <<"muc.", _:249/binary>>}}, geo_config:session())
            end,
            fun(_) ->
                base_session(#{xmpp_domain => Domain(250)}),
                Result = geo_config:session(),
                [
                    ?_assertEqual({error, {bad_config, xmpp_domain}}, Result),
                    ?_assertEqual(nomatch, string:find(printed(Result), Domain(20)))
                ]
            end
        ]}
    ].

save_session_env() ->
    [{K, application:get_env(geo_service, K)} || K <- ?SESSION_KEYS].

%% A valid session config, with overrides.
base_session(Overrides) ->
    Base = #{
        jwt_secret => ?GOOD_SECRET,
        xmpp_domain => "chaterl.localhost",
        mim_admin_url => "http://mongooseim:5551/api/graphql",
        mim_admin_user => "admin",
        mim_admin_password => "adm1n pw",
        xmpp_room_owner => "nearby-rooms"
    },
    maps:foreach(fun set/2, maps:merge(Base, Overrides)).

%% N printable characters with plenty of distinct ones.
sample_secret(N) ->
    Alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    [lists:nth(1 + (I rem length(Alphabet)), Alphabet) || I <- lists:seq(0, N - 1)].
