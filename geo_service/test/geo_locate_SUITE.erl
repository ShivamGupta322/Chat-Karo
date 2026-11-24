%% POST /api/locate end to end: the real application, a real MongoDB (database chaterl_ct only)
%% and the fake MongooseIM admin API (only for a valid admin URL). The suite is skipped, loudly,
%% when Mongo is not reachable at GEO_CT_MONGO_HOSTS (default 127.0.0.1:27018).
%%
%% Privacy is the point: the crash_injection group makes the handler crash after the body is
%% decoded (meck) and proves that no log event carries a coordinate; the last case scans every
%% event captured during the suite.
-module(geo_locate_SUITE).

-include_lib("common_test/include/ct.hrl").

-export([
    all/0,
    groups/0,
    init_per_suite/1,
    end_per_suite/1,
    init_per_group/2,
    end_per_group/2,
    init_per_testcase/2,
    end_per_testcase/2
]).
-export([
    locate_200_block/1,
    same_cell_updates/1,
    ranges/1,
    edges/1,
    auth_401_matrix/1,
    method_405/1,
    validation/1,
    bad_charset_415/1,
    mongo_unavailable_503/1,
    grants_membership/1,
    same_cell_one_set_member/1,
    admin_unavailable_503/1,
    admin_unauthorized_500/1,
    configure_mismatch_500/1,
    slow_room_503/1,
    non_pseudonymous_sub_401/1,
    crash_in_cell_for/1,
    crash_function_clause_with_args/1,
    crash_case_clause_after_store/1,
    crash_in_room_access/1,
    logs_contain_no_coordinates/1
]).
%% logger handler callback
-export([log/2]).

-define(DB, "chaterl_ct").
-define(JWT_SECRET, "ct-jwt-secret-0123456789-abcdefghijklmnop").
-define(ADMIN_USER, "admin").
-define(ADMIN_PASSWORD, "ct-admin-password").
-define(DOMAIN, "chaterl.localhost").
-define(HANDLER, geo_locate_ct_capture).
-define(BODY_200,
    <<"{\"cell\":\"u4pruyd\",\"precision\":7,\"range\":\"block\",\"room_jid\":\"g7_u4pruyd@muc.chaterl.localhost\"}">>
).
-define(BODY_401,
    <<"{\"error\":\"unauthorized\",\"message\":\"A valid bearer token is required.\"}">>
).
-define(REALM, <<"Bearer realm=\"chaterl-api\"">>).
-define(INVALID, <<"Bearer realm=\"chaterl-api\", error=\"invalid_token\"">>).
%% Sentinels (never real positions). A and B are both in u4pruyd.
-define(A_LAT, "57.6491137").
-define(A_LNG, "10.4074419").
-define(B_LAT, "57.6485531").
-define(B_LNG, "10.4070917").
-define(SENTINELS, [
    ?A_LAT, ?A_LNG, ?B_LAT, ?B_LNG, "90.0000173", "180.0000419", "57.6491999"
]).
-define(BODY_A, <<"{\"lat\":", ?A_LAT, ",\"lng\":", ?A_LNG, "}">>).
-define(BODY_B, <<"{\"lat\":", ?B_LAT, ",\"lng\":", ?B_LNG, "}">>).

all() ->
    [
        locate_200_block,
        same_cell_updates,
        ranges,
        edges,
        auth_401_matrix,
        method_405,
        validation,
        bad_charset_415,
        grants_membership,
        same_cell_one_set_member,
        admin_unavailable_503,
        admin_unauthorized_500,
        configure_mismatch_500,
        slow_room_503,
        non_pseudonymous_sub_401,
        {group, mongo_down},
        {group, crash_injection},
        logs_contain_no_coordinates
    ].

groups() ->
    [
        {mongo_down, [], [mongo_unavailable_503]},
        {crash_injection, [], [
            crash_in_cell_for,
            crash_function_clause_with_args,
            crash_case_clause_after_store,
            crash_in_room_access
        ]}
    ].

init_per_suite(Config) ->
    Hosts = hosts(),
    case reachable(Hosts) of
        false ->
            {skip, "MongoDB not reachable at " ++ Hosts ++ " (set GEO_CT_MONGO_HOSTS)"};
        true ->
            {ok, _} = application:ensure_all_started(inets),
            {ok, FakePort} = geo_fake_mim:start(),
            start_app(Hosts, FakePort),
            wait_ready(10000),
            {true, _} = run_command(#{<<"dropDatabase">> => 1}),
            %% The rooms indexes, as in infra/mongo/init-indexes.js (geo_mongo_SUITE has the
            %% drift guard for that file).
            {true, #{<<"ok">> := Ok}} = run_command(#{
                <<"createIndexes">> => <<"rooms">>,
                <<"indexes">> => [
                    #{
                        <<"key">> => #{<<"center">> => <<"2dsphere">>},
                        <<"name">> => <<"center_2dsphere">>
                    },
                    #{
                        <<"key">> => #{<<"lastActiveAt">> => 1},
                        <<"name">> => <<"lastActiveAt_ttl">>,
                        <<"expireAfterSeconds">> => 7 * 24 * 3600
                    }
                ]
            }),
            true = (Ok == 1),
            %% Debug for the whole suite: the driver is chatty, so assertions filter by event.
            Level = maps:get(level, logger:get_primary_config()),
            ok = logger:set_primary_config(level, debug),
            ok = logger:add_handler(?HANDLER, ?MODULE, #{}),
            [{fake_port, FakePort}, {old_level, Level} | Config]
    end.

end_per_suite(Config) ->
    _ = logger:remove_handler(?HANDLER),
    case ?config(old_level, Config) of
        undefined -> ok;
        Level -> logger:set_primary_config(level, Level)
    end,
    _ = run_command(#{<<"dropDatabase">> => 1}),
    application:stop(geo_service),
    geo_fake_mim:stop(),
    ok.

init_per_group(mongo_down, Config) ->
    application:stop(geo_service),
    start_app("127.0.0.1:1", ?config(fake_port, Config)),
    Config;
init_per_group(_Group, Config) ->
    Config.

end_per_group(mongo_down, Config) ->
    application:stop(geo_service),
    start_app(hosts(), ?config(fake_port, Config)),
    wait_ready(15000),
    ok;
end_per_group(_Group, _Config) ->
    ok.

init_per_testcase(_Case, Config) ->
    delete_all_rooms(),
    ok = geo_fake_mim:set_mode(ok),
    ok = geo_fake_mim:reset(),
    [{log_mark, length(geo_fake_mim:log_events())} | Config].

%% meck is node-global: always unload, whatever the case did.
end_per_testcase(_Case, _Config) ->
    catch meck:unload(),
    geo_fake_mim:set_mode(ok),
    delete_all_rooms(),
    ok.

%%% Cases --------------------------------------------------------------------------------

locate_200_block(_Config) ->
    {200, Headers, Body} = locate(?BODY_A),
    ?BODY_200 = Body,
    <<"application/json">> = maps:get(<<"content-type">>, Headers),
    <<"no-store">> = maps:get(<<"cache-control">>, Headers),
    <<"nosniff">> = maps:get(<<"x-content-type-options">>, Headers),
    {ok, Doc} = geo_mongo:find_one(<<"rooms">>, #{<<"_id">> => <<"g7_u4pruyd">>}, #{}),
    [<<"_id">>, <<"center">>, <<"createdAt">>, <<"geohash">>, <<"lastActiveAt">>, <<"precision">>] =
        lists:sort(maps:keys(Doc)),
    7 = maps:get(<<"precision">>, Doc),
    <<"u4pruyd">> = maps:get(<<"geohash">>, Doc),
    #{<<"type">> := <<"Point">>, <<"coordinates">> := Coordinates} = maps:get(<<"center">>, Doc),
    {ok, {CLat, CLng}} = geohash:centre(<<"u4pruyd">>),
    [CLng, CLat] = Coordinates,
    true = Coordinates =/= [10.4074419, 57.6491137],
    nomatch = string:find(printed(Doc), ?A_LAT),
    nomatch = string:find(printed(Doc), ?A_LNG),
    Created = maps:get(<<"createdAt">>, Doc),
    Created = maps:get(<<"lastActiveAt">>, Doc).

same_cell_updates(_Config) ->
    {200, _, First} = locate(?BODY_A),
    {ok, Doc1} = geo_mongo:find_one(<<"rooms">>, #{<<"_id">> => <<"g7_u4pruyd">>}, #{}),
    timer:sleep(20),
    {200, _, Second} = locate(?BODY_B),
    %% Created and updated are indistinguishable from the outside.
    First = Second,
    ?BODY_200 = Second,
    1 = count_rooms(),
    {ok, Doc2} = geo_mongo:find_one(<<"rooms">>, #{<<"_id">> => <<"g7_u4pruyd">>}, #{}),
    Created1 = maps:get(<<"createdAt">>, Doc1),
    Created1 = maps:get(<<"createdAt">>, Doc2),
    true = maps:get(<<"lastActiveAt">>, Doc2) > maps:get(<<"lastActiveAt">>, Doc1),
    [<<"_id">>, <<"center">>, <<"createdAt">>, <<"geohash">>, <<"lastActiveAt">>, <<"precision">>] =
        lists:sort(maps:keys(Doc2)).

ranges(_Config) ->
    {200, _, Neighbourhood} = locate(body_with(<<"\"range\":\"neighbourhood\"">>)),
    #{<<"cell">> := <<"u4pruy">>, <<"precision">> := 6, <<"room_jid">> := Jid6} =
        json:decode(Neighbourhood),
    <<"g6_u4pruy@muc.chaterl.localhost">> = Jid6,
    {200, _, Area} = locate(body_with(<<"\"range\":\"area\"">>)),
    #{<<"cell">> := <<"u4pru">>, <<"precision">> := 5, <<"room_jid">> := Jid5} = json:decode(Area),
    <<"g5_u4pru@muc.chaterl.localhost">> = Jid5,
    {ok, D6} = geo_mongo:find_one(<<"rooms">>, #{<<"_id">> => <<"g6_u4pruy">>}, #{}),
    6 = maps:get(<<"precision">>, D6),
    {ok, D5} = geo_mongo:find_one(<<"rooms">>, #{<<"_id">> => <<"g5_u4pru">>}, #{}),
    5 = maps:get(<<"precision">>, D5),
    {200, _, Default} = locate(?BODY_A),
    {200, _, Block} = locate(body_with(<<"\"range\":\"block\"">>)),
    Default = Block,
    ?BODY_200 = Block,
    {200, _, WithAccuracy} = locate(body_with(<<"\"range\":\"block\",\"accuracy\":25">>)),
    Block = WithAccuracy,
    %% accuracy alone, and never stored.
    {200, _, Alone} = locate(body_with(<<"\"accuracy\":25.5">>)),
    Block = Alone,
    {ok, Doc} = geo_mongo:find_one(<<"rooms">>, #{<<"_id">> => <<"g7_u4pruyd">>}, #{}),
    [<<"_id">>, <<"center">>, <<"createdAt">>, <<"geohash">>, <<"lastActiveAt">>, <<"precision">>] =
        lists:sort(maps:keys(Doc)).

edges(_Config) ->
    Cases = [
        {<<"{\"lat\":90,\"lng\":180}">>, <<"zzzzzzz">>},
        {<<"{\"lat\":-90,\"lng\":-180}">>, <<"0000000">>},
        {<<"{\"lat\":0,\"lng\":180}">>, <<"xbpbpbp">>},
        {<<"{\"lat\":0,\"lng\":-180}">>, <<"8000000">>},
        {<<"{\"lat\":0,\"lng\":0}">>, <<"s000000">>}
    ],
    lists:foreach(
        fun({Body, Hash}) ->
            {200, _, Reply} = locate(Body),
            #{<<"cell">> := Hash, <<"precision">> := 7} = json:decode(Reply)
        end,
        Cases
    ),
    %% One room per cell: lng 180 and -180 are different cells.
    5 = count_rooms().

auth_401_matrix(_Config) ->
    Now = erlang:system_time(second),
    Sub = new_sub(),
    {Good, _} = geo_auth:issue(Sub, <<?JWT_SECRET>>, Now),
    {Expired, _} = geo_auth:issue(Sub, <<?JWT_SECRET>>, Now - 3700),
    {Other, _} = geo_auth:issue(Sub, <<"another-secret-0123456789-abcdefghijkl">>, Now),
    [H, P, S] = binary:split(Good, <<".">>, [global]),
    Claims = json:decode(base64:decode(P, #{mode => urlsafe, padding => false})),
    Forged = b64(iolist_to_binary(json:encode(Claims#{<<"sub">> => new_sub()}))),
    Tampered = <<H/binary, ".", Forged/binary, ".", S/binary>>,
    AlgNone = <<(b64(<<"{\"alg\":\"none\",\"typ\":\"JWT\"}">>))/binary, ".", P/binary, ".">>,
    Json = [{"content-type", "application/json"}],
    Len = [{"content-length", integer_to_list(byte_size(?BODY_A))}],
    Post = fun(Target, Headers) ->
        {Status, H1, B} = geo_ct_http:request("POST", Target, Headers ++ Len, ?BODY_A),
        Status = 401,
        ?BODY_401 = B,
        nomatch = binary:match(B, Good),
        maps:get(<<"www-authenticate">>, H1)
    end,
    Bearer = fun(Token) -> {"authorization", <<"Bearer ", Token/binary>>} end,
    %% missing: realm only
    ?REALM = Post("/api/locate", Json),
    ?REALM = Post("/api/locate", Json ++ [{"authorization", "Basic dXNlcjpwdw=="}]),
    ?REALM = Post("/api/locate?access_token=" ++ binary_to_list(Good), Json),
    %% invalid: realm plus error="invalid_token"
    lists:foreach(
        fun(Headers) -> ?INVALID = Post("/api/locate", Json ++ Headers) end,
        [
            [Bearer(Expired)],
            [Bearer(Tampered)],
            [Bearer(AlgNone)],
            [Bearer(Other)],
            [{"authorization", "Bearer"}],
            [{"authorization", <<"Bearer  ", Good/binary>>}],
            [Bearer(Good), Bearer(Good)]
        ]
    ),
    %% 401 comes before 415 and before reading a large body.
    ?REALM = Post("/api/locate", [{"content-type", "text/plain"}]),
    {401, _, Big401} = geo_ct_http:request(
        "POST",
        "/api/locate",
        Json ++ [{"content-length", "10240"}],
        binary:copy(<<"a">>, 10240)
    ),
    ?BODY_401 = Big401,
    0 = count_rooms(),
    %% Positive controls: the scheme is case-insensitive.
    {200, _, ?BODY_200} = geo_ct_http:request(
        "POST",
        "/api/locate",
        Json ++ Len ++ [{"authorization", <<"bearer ", Good/binary>>}],
        ?BODY_A
    ),
    {200, _, ?BODY_200} = geo_ct_http:request(
        "POST",
        "/api/locate",
        Json ++ Len ++ [{"authorization", <<"BEARER ", Good/binary>>}],
        ?BODY_A
    ),
    1 = count_rooms().

method_405(_Config) ->
    lists:foreach(
        fun(Method) ->
            {405, H, B} = geo_ct_http:request(
                Method, "/api/locate", [{"content-length", "0"}], <<>>
            ),
            <<"POST">> = maps:get(<<"allow">>, H),
            case Method of
                "HEAD" -> <<>> = B;
                _ -> #{<<"error">> := <<"method_not_allowed">>} = json:decode(B)
            end
        end,
        ["GET", "PUT", "HEAD", "OPTIONS"]
    ),
    0 = count_rooms().

validation(_Config) ->
    Token = token(),
    Sent = fun(Headers, Body) ->
        remember_body(Body),
        geo_ct_http:request("POST", "/api/locate", [auth(Token) | Headers], Body)
    end,
    Json = [{"content-type", "application/json"}],
    WithLen = fun(Body) -> Json ++ [{"content-length", integer_to_list(byte_size(Body))}] end,
    Post = fun(Body) -> Sent(WithLen(Body), Body) end,
    %% query string
    {400, _, Q} = geo_ct_http:request(
        "POST",
        "/api/locate?x=1",
        [auth(Token) | WithLen(?BODY_A)],
        ?BODY_A
    ),
    #{
        <<"error">> := <<"invalid_request">>,
        <<"message">> := <<"Query parameters are not accepted.">>
    } =
        json:decode(Q),
    %% content type
    {415, _, B415} = Sent(
        [{"content-type", "text/plain"}, {"content-length", integer_to_list(byte_size(?BODY_A))}],
        ?BODY_A
    ),
    #{<<"error">> := <<"unsupported_media_type">>} = json:decode(B415),
    %% size cap: 257 bytes by content-length and chunked; exactly 256 is fine
    Pad = fun(N) -> binary:copy(<<" ">>, N - byte_size(?BODY_A)) end,
    Big = <<(?BODY_A)/binary, (Pad(257))/binary>>,
    257 = byte_size(Big),
    {413, _, B413a} = Post(Big),
    #{<<"error">> := <<"payload_too_large">>} = json:decode(B413a),
    {413, _, B413b} = Sent(Json ++ [{"transfer-encoding", "chunked"}], geo_ct_http:chunked(Big)),
    #{<<"error">> := <<"payload_too_large">>} = json:decode(B413b),
    Exact = <<(?BODY_A)/binary, (Pad(256))/binary>>,
    256 = byte_size(Exact),
    {200, _, ?BODY_200} = Post(Exact),
    %% from here on nothing may be written
    ok = delete_all_rooms(),
    %% JSON
    lists:foreach(
        fun(Bad) ->
            {400, _, B} = Post(Bad),
            #{<<"error">> := <<"invalid_json">>} = json:decode(B)
        end,
        [<<"{bad">>, <<"[]">>, <<"{\"lat\":1e400,\"lng\":0}">>]
    ),
    %% shape
    lists:foreach(
        fun(Bad) ->
            {400, _, B} = Post(Bad),
            #{<<"error">> := <<"invalid_request">>} = json:decode(B),
            nomatch = string:find(B, ?A_LAT),
            nomatch = string:find(B, "57.6491999")
        end,
        [
            <<"{\"lat\":57.6491137,\"lng\":10.4074419,\"foo\":1}">>,
            <<"{\"lat\":\"57.6491999\",\"lng\":10.4074419}">>,
            <<"{\"lat\":57.6491137}">>,
            <<"{\"lat\":57.6491137,\"lng\":10.4074419,\"range\":\"Block\"}">>,
            <<"{\"lat\":57.6491137,\"lng\":10.4074419,\"accuracy\":-1}">>
        ]
    ),
    %% location
    lists:foreach(
        fun(Bad) ->
            {400, _, B} = Post(Bad),
            #{<<"error">> := <<"invalid_location">>} = json:decode(B),
            nomatch = string:find(B, "90.0000173"),
            nomatch = string:find(B, "180.0000419")
        end,
        [
            <<"{\"lat\":90.0000173,\"lng\":10.4074419}">>,
            <<"{\"lat\":57.6491137,\"lng\":-180.0000419}">>
        ]
    ),
    0 = count_rooms().

%% cowlib accepts a quoted charset with invalid UTF-8; that must be a 415, not a crash (the
%% charset check once called string:lowercase/1, which raises on such bytes).
bad_charset_415(Config) ->
    Token = token(),
    Len = integer_to_list(byte_size(?BODY_A)),
    lists:foreach(
        fun(ContentType) ->
            {415, _, B} = geo_ct_http:request(
                "POST",
                "/api/locate",
                [auth(Token), {"content-type", ContentType}, {"content-length", Len}],
                ?BODY_A
            ),
            #{<<"error">> := <<"unsupported_media_type">>} = json:decode(B)
        end,
        [
            <<"application/json; charset=\"", 255, "\"">>,
            <<"application/json; charset=\"", 195, 40, "\"">>,
            <<"application/json; charset=latin-1">>
        ]
    ),
    timer:sleep(300),
    Events = events_since(Config),
    [] = [E || #{msg := {report, #{label := {proc_lib, crash}}}} = E <- Events],
    lists:foreach(
        fun(T) -> nomatch = string:find(T, "had its request process") end, texts(Events)
    ),
    0 = count_rooms().

mongo_unavailable_503(_Config) ->
    {503, H, B} = locate(?BODY_A),
    <<"5">> = maps:get(<<"retry-after">>, H),
    #{<<"error">> := <<"service_unavailable">>} = json:decode(B),
    %% Mongo is touched first: no admin call is made.
    [] = geo_fake_mim:calls(),
    %% A bad token is still a 401: auth does not need Mongo.
    {401, _, _} = geo_ct_http:request(
        "POST",
        "/api/locate",
        [
            {"content-type", "application/json"},
            {"content-length", integer_to_list(byte_size(?BODY_A))},
            {"authorization", "Bearer not.a.token"}
        ],
        ?BODY_A
    ).

%% A new cell takes the slow path; the user variable is the token's subject, the room the 200's.
grants_membership(_Config) ->
    Sub = new_sub(),
    {200, _, Body} = locate_as(Sub, ?BODY_A),
    ?BODY_200 = Body,
    #{<<"room_jid">> := RoomJid} = json:decode(Body),
    [set_member, create, configure, exit, set_member] = ops(),
    Domain = <<?DOMAIN>>,
    UserJid = <<Sub/binary, "@", Domain/binary>>,
    [First, Create, Configure, Exit, Second] = geo_fake_mim:calls(),
    #{vars := #{<<"room">> := RoomJid, <<"user">> := UserJid}} = First,
    #{vars := #{<<"room">> := RoomJid, <<"user">> := UserJid}} = Second,
    #{
        vars := #{
            <<"room">> := RoomJid,
            <<"owner">> := <<"nearby-rooms@", ?DOMAIN, "/geo_service">>,
            <<"nick">> := <<"Nearby">>
        }
    } = Create,
    #{vars := #{<<"room">> := RoomJid, <<"config">> := Config}} = Configure,
    Config = geo_xmpp_admin:room_config(),
    #{vars := #{<<"room">> := RoomJid, <<"nick">> := <<"Nearby">>}} = Exit,
    %% the admin credentials are sent on every call
    true = lists:all(fun(#{auth := A}) -> A =:= expected_auth() end, geo_fake_mim:calls()).

%% The room is loaded now: the second locate needs one call and answers the same bytes.
same_cell_one_set_member(_Config) ->
    {200, _, First} = locate_as(new_sub(), ?BODY_A),
    ok = geo_fake_mim:reset_calls(),
    {200, _, Second} = locate_as(new_sub(), ?BODY_B),
    First = Second,
    [set_member] = ops().

admin_unavailable_503(_Config) ->
    ok = geo_fake_mim:set_mode(http503),
    {503, H, B} = locate(?BODY_A),
    <<"5">> = maps:get(<<"retry-after">>, H),
    #{<<"error">> := <<"service_unavailable">>} = json:decode(B),
    [set_member] = ops().

admin_unauthorized_500(Config) ->
    ok = geo_fake_mim:set_mode(unauthorized),
    {500, _, B} = locate(?BODY_A),
    #{<<"error">> := <<"internal_error">>} = json:decode(B),
    [set_member] = ops(),
    timer:sleep(300),
    no_leak(Config).

%% A room that does not have the right config never gets a member.
configure_mismatch_500(Config) ->
    ok = geo_fake_mim:set_mode(configure_mismatch),
    {500, _, B} = locate(?BODY_A),
    #{<<"error">> := <<"internal_error">>} = json:decode(B),
    [set_member, create, configure] = ops(),
    timer:sleep(300),
    Events = events_since(Config),
    [#{step := configure_room, reason := bad_response}] =
        [R || #{msg := {report, #{event := room_access_failed} = R}} <- Events],
    no_leak(Config).

slow_room_503(_Config) ->
    ok = geo_fake_mim:set_mode(slow_room),
    Start = erlang:monotonic_time(millisecond),
    {503, H, _} = locate(?BODY_A),
    Elapsed = erlang:monotonic_time(millisecond) - Start,
    <<"5">> = maps:get(<<"retry-after">>, H),
    true = Elapsed < 9000.

%% Valid signature, but not a pseudonymous identity: same 401 as a bad token, no admin call.
non_pseudonymous_sub_401(_Config) ->
    lists:foreach(
        fun(Sub) ->
            {Token, _} = geo_auth:issue(Sub, <<?JWT_SECRET>>, erlang:system_time(second)),
            {401, H, ?BODY_401} = geo_ct_http:request(
                "POST",
                "/api/locate",
                [
                    auth(Token),
                    {"content-type", "application/json"},
                    {"content-length", integer_to_list(byte_size(?BODY_A))}
                ],
                ?BODY_A
            ),
            ?INVALID = maps:get(<<"www-authenticate">>, H)
        end,
        [
            <<"alice">>,
            <<"U0123456789ABCDEF0123456789ABCDEF">>,
            <<"u0123456789abcdef0123456789abcde">>,
            <<"u0123456789abcdef0123456789abcdeg">>,
            <<"nearby-rooms">>
        ]
    ),
    [] = geo_fake_mim:calls(),
    0 = count_rooms().

%% (a) the "after decoding" crash: the exception reason carries the decoded body.
crash_in_cell_for(Config) ->
    ok = meck:new(geo_locate, [passthrough]),
    %% The reason carries the coordinates both as bare floats and under lat/lng keys: the bare
    %% floats are exactly what the logger backstop cannot mask, so only the guarded handler
    %% keeps them out of the logs.
    ok = meck:expect(
        geo_locate,
        cell_for,
        fun(#{<<"lat">> := Lat, <<"lng">> := Lng} = Body) ->
            meck:exception(error, {injected, Lat, Lng, Body})
        end
    ),
    Injected =
        {injected, 57.6491137, 10.4074419, #{<<"lat">> => 57.6491137, <<"lng">> => 10.4074419}},
    %% Control: run through the backstop filter, the bare floats are still there.
    #{msg := {report, Filtered}} = geo_log_redact:filter(
        #{level => error, msg => {report, #{r => Injected}}, meta => #{}},
        geo_log_redact:args([])
    ),
    true = string:find(printed(Filtered), ?A_LAT) =/= nomatch,
    {500, _, B} = locate(?BODY_A),
    #{<<"error">> := <<"internal_error">>} = json:decode(B),
    %% locate_crashed is logged synchronously before the reply; the sleep only waits for
    %% Cowboy's asynchronous lines.
    timer:sleep(300),
    #{class := error, reason := injected} = one_crash(Config),
    1 = meck:num_calls(geo_locate, cell_for, '_'),
    no_leak(Config),
    0 = count_rooms().

%% (b) function_clause: the top stack frame holds the argument values.
crash_function_clause_with_args(Config) ->
    ok = meck:new(geo_locate, [passthrough]),
    ok = meck:expect(geo_locate, cell_for, fun(#{<<"lat">> := Lat, <<"lng">> := Lng}) ->
        erlang:error(function_clause, [Lat, Lng])
    end),
    {500, _, B} = locate(?BODY_A),
    #{<<"error">> := <<"internal_error">>} = json:decode(B),
    %% locate_crashed is logged synchronously before the reply; the sleep only waits for
    %% Cowboy's asynchronous lines.
    timer:sleep(300),
    #{class := error, reason := function_clause} = one_crash(Config),
    1 = meck:num_calls(geo_locate, cell_for, '_'),
    no_leak(Config),
    0 = count_rooms().

%% (c) an unexpected return from the store goes to the catch as case_clause.
crash_case_clause_after_store(Config) ->
    ok = meck:new(geo_store, [passthrough]),
    ok = meck:expect(geo_store, touch_room, fun(_Cell) -> {ok, bogus} end),
    {500, _, B} = locate(?BODY_A),
    #{<<"error">> := <<"internal_error">>} = json:decode(B),
    %% locate_crashed is logged synchronously before the reply; the sleep only waits for
    %% Cowboy's asynchronous lines.
    timer:sleep(300),
    #{class := error, reason := case_clause} = one_crash(Config),
    1 = meck:num_calls(geo_store, touch_room, '_'),
    no_leak(Config).

%% (d) the access step crashes with the user and room in the reason.
crash_in_room_access(Config) ->
    ok = meck:new(geo_room_access, [passthrough]),
    ok = meck:expect(geo_room_access, grant, fun(_Ctx, Room, User) ->
        meck:exception(error, {injected, Room, User})
    end),
    {500, _, B} = locate(?BODY_A),
    #{<<"error">> := <<"internal_error">>} = json:decode(B),
    timer:sleep(300),
    #{class := error, reason := injected} = one_crash(Config),
    1 = meck:num_calls(geo_room_access, grant, '_'),
    no_leak(Config),
    nomatch = re_find(printed(events_since(Config)), "g7_u4pruyd"),
    nomatch = re_find(printed(events_since(Config)), "u[0-9a-f]{32}").

%% Last: everything captured during the suite, with the logger at debug.
logs_contain_no_coordinates(_Config) ->
    %% Controls: the backstop filter is live, so a coordinate logged on purpose comes out masked.
    logger:error(#{body => #{<<"lat">> => 57.6491137}}),
    logger:error("~s", ["{\"lat\":57.6491137}"]),
    timer:sleep(300),
    Events = geo_fake_mim:log_events(),
    Texts = texts(Events),
    ct:pal("~b log events captured", [length(Events)]),
    true = lists:any(fun(T) -> string:find(T, "[REDACTED]") =/= nomatch end, Texts),
    lists:foreach(
        fun(Needle) ->
            lists:foreach(fun(Text) -> nomatch = string:find(Text, Needle) end, Texts)
        end,
        needles()
    ),
    %% The only locate_* event our code logs is the sanitised crash summary.
    Names = [Name || #{msg := {report, #{event := Name}}} <- Events, is_locate(Name)],
    true = lists:member(locate_crashed, Names),
    [locate_crashed] = lists:usort(Names),
    %% Neither a room JID nor a pseudonymous subject is ever logged.
    lists:foreach(
        fun(T) ->
            nomatch = re_find(T, "g7_[0-9a-z]+@muc"),
            nomatch = re_find(T, "u[0-9a-f]{32}")
        end,
        Texts
    ),
    %% No Cowboy crash line and no crash report for a request process.
    lists:foreach(fun(T) -> nomatch = string:find(T, "had its request process") end, Texts),
    [] = [E || #{msg := {report, #{label := {proc_lib, crash}}}} = E <- Events].

%%% logger handler -----------------------------------------------------------------------

log(Event, _Config) ->
    geo_fake_mim:log_event(Event).

%%% Assertions on captured events ----------------------------------------------------------

events_since(Config) ->
    lists:nthtail(?config(log_mark, Config), geo_fake_mim:log_events()).

%% Exactly one locate_crashed event, no proc_lib crash report, no Cowboy crash line.
one_crash(Config) ->
    Events = events_since(Config),
    [Report] = [R || #{msg := {report, #{event := locate_crashed} = R}} <- Events],
    [] = [E || #{msg := {report, #{label := {proc_lib, crash}}}} = E <- Events],
    lists:foreach(
        fun(T) -> nomatch = string:find(T, "had its request process") end, texts(Events)
    ),
    [class, event, reason, where] = lists:sort(maps:keys(Report)),
    Report.

no_leak(Config) ->
    Texts = texts(events_since(Config)),
    lists:foreach(
        fun(Needle) ->
            lists:foreach(fun(Text) -> nomatch = string:find(Text, Needle) end, Texts)
        end,
        needles()
    ).

%% Every representation of every sentinel, plus the raw bodies that were sent.
needles() ->
    Floats = [list_to_float(S) || S <- ?SENTINELS],
    Reprs = lists:append([
        [
            float_to_list(F, [short]),
            lists:flatten(io_lib:format("~p", [F])),
            lists:flatten(io_lib:format("~w", [F]))
        ]
     || F <- Floats
    ]),
    Bodies = [binary_to_list(B) || B <- geo_fake_mim:secrets()],
    lists:usort(?SENTINELS ++ Reprs ++ Bodies).

texts(Events) ->
    lists:flatmap(
        fun(E) ->
            [
                lists:flatten(io_lib:format("~0p", [E])),
                lists:flatten(io_lib:format("~ts", [logger_formatter:format(E, #{})]))
            ]
        end,
        Events
    ).

is_locate(Name) when is_atom(Name) -> lists:prefix("locate_", atom_to_list(Name));
is_locate(_) -> false.

%%% Helpers ------------------------------------------------------------------------------

hosts() ->
    os:getenv("GEO_CT_MONGO_HOSTS", "127.0.0.1:27018").

reachable(Hosts) ->
    [Host, PortStr | _] = string:split(Hosts, ":"),
    case gen_tcp:connect(Host, list_to_integer(PortStr), [], 2000) of
        {ok, Socket} ->
            gen_tcp:close(Socket),
            true;
        {error, _} ->
            false
    end.

start_app(Hosts, FakePort) ->
    lists:foreach(
        fun({K, V}) -> application:set_env(geo_service, K, V) end,
        [
            {http_ip, "127.0.0.1"},
            {http_port, "0"},
            {mongo_hosts, Hosts},
            {mongo_db, ?DB},
            {mongo_replica_set, ""},
            {mongo_user, ""},
            {mongo_password, ""},
            {mongo_auth_source, ""},
            {mongo_tls, ""},
            {mongo_tls_ca_file, ""},
            {mongo_pool_size, ""},
            {jwt_secret, ?JWT_SECRET},
            {xmpp_domain, ?DOMAIN},
            {xmpp_room_owner, "nearby-rooms"},
            {mim_admin_url, "http://127.0.0.1:" ++ integer_to_list(FakePort) ++ "/api/graphql"},
            {mim_admin_user, ?ADMIN_USER},
            {mim_admin_password, ?ADMIN_PASSWORD}
        ]
    ),
    {ok, _} = application:ensure_all_started(geo_service),
    ok.

expected_auth() ->
    Basic = base64:encode(<<?ADMIN_USER, ":", ?ADMIN_PASSWORD>>),
    <<"Basic ", Basic/binary>>.

%% The admin operations the fake saw, in order.
ops() ->
    [Op || #{op := Op} <- geo_fake_mim:calls()].

re_find(Text, Pattern) ->
    case re:run(Text, Pattern, [{capture, none}]) of
        match -> match;
        nomatch -> nomatch
    end.

wait_ready(Timeout) when Timeout =< 0 ->
    ct:fail(mongo_not_ready);
wait_ready(Timeout) ->
    case geo_mongo:ready() of
        true ->
            ok;
        false ->
            timer:sleep(200),
            wait_ready(Timeout - 200)
    end.

run_command(Command) ->
    mongoc:transaction(
        geo_mongo_topology,
        fun(#{pool := Worker}) -> mc_worker_api:command(Worker, Command) end,
        #{},
        10000
    ).

%% Skipped while Mongo is down on purpose (the mongo_down group).
delete_all_rooms() ->
    case geo_mongo:ready() of
        true ->
            {true, _} = run_command(#{
                <<"delete">> => <<"rooms">>,
                <<"deletes">> => [#{<<"q">> => #{}, <<"limit">> => 0}]
            }),
            ok;
        false ->
            ok
    end.

count_rooms() ->
    {true, #{<<"n">> := N}} = run_command(#{<<"count">> => <<"rooms">>}),
    N.

new_sub() ->
    <<"u", (string:lowercase(binary:encode_hex(crypto:strong_rand_bytes(16))))/binary>>.

token() ->
    token_for(new_sub()).

token_for(Sub) ->
    {Token, _} = geo_auth:issue(Sub, <<?JWT_SECRET>>, erlang:system_time(second)),
    Token.

auth(Token) -> {"authorization", <<"Bearer ", Token/binary>>}.

b64(Bin) -> base64:encode(Bin, #{mode => urlsafe, padding => false}).

%% Sentinel A plus extra members.
body_with(Extra) ->
    <<"{\"lat\":", ?A_LAT, ",\"lng\":", ?A_LNG, ",", Extra/binary, "}">>.

%% Bodies that carry a sentinel are scanned for in the captured logs (see needles/0).
remember_body(IoBody) ->
    Body = iolist_to_binary(IoBody),
    case lists:any(fun(S) -> binary:match(Body, list_to_binary(S)) =/= nomatch end, ?SENTINELS) of
        true -> geo_fake_mim:put_secret(Body);
        false -> ok
    end.

%% An authenticated, well-formed locate request.
locate(Body) ->
    remember_body(Body),
    geo_ct_http:request(
        "POST",
        "/api/locate",
        [
            auth(token()),
            {"content-type", "application/json"},
            {"content-length", integer_to_list(byte_size(Body))}
        ],
        Body
    ).

%% An authenticated locate as a known subject.
locate_as(Sub, Body) ->
    remember_body(Body),
    geo_ct_http:request(
        "POST",
        "/api/locate",
        [
            auth(token_for(Sub)),
            {"content-type", "application/json"},
            {"content-length", integer_to_list(byte_size(Body))}
        ],
        Body
    ).

printed(Term) ->
    lists:flatten(io_lib:format("~0p", [Term])).
