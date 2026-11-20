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
