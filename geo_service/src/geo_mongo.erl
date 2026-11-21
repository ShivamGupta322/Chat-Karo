%% MongoDB access: the supervised driver topology plus thin wrappers that turn every driver
%% outcome into a tagged tuple. Quirks of the driver handled here (see ADR-016):
%%  - a failed write is reported as {true, #{<<"writeErrors">> := ...}}, so classify_write/1
%%    always inspects writeErrors / writeConcernError;
%%  - mongo_api:command/3 has a wrong spec, so ping goes through mongoc:transaction/4;
%%  - a missing topology exits with noproc in the caller, so every wrapper catches exit:_.
%% Driver reasons and documents are never logged or returned: they may carry data.
-module(geo_mongo).

-export([
    child_spec/1,
    ready/0,
    ping/0,
    update_one/4,
    insert_one/2,
    delete_one/2,
    find_one/3,
    classify_write/1
]).
-export_type([write_result/0, write_error/0]).

-define(TOPOLOGY, geo_mongo_topology).
-define(STATUS_TABLE, geo_mongo_status).
-define(CALL_TIMEOUT, 5000).

-type write_result() :: #{matched := non_neg_integer(), upserted := boolean()}.
-type write_error() :: mongo_unavailable | {write_failed, integer() | unknown}.

-spec child_spec(geo_config:mongo()) -> supervisor:child_spec().
child_spec(#{seed := Seed, database := Db, auth := Auth, tls := Tls, pool_size := Size}) ->
    TopologyOpts = [
        {register, ?TOPOLOGY},
        {pool_size, Size},
        {max_overflow, 0},
        {serverSelectionTimeoutMS, 2000},
        {connectTimeoutMS, 5000}
    ],
    WorkerOpts = [{database, Db}] ++ auth_opts(Auth) ++ tls_opts(Tls),
    #{
        id => geo_mongo,
        start => {mongoc, connect, [Seed, TopologyOpts, WorkerOpts]},
        restart => permanent,
        shutdown => 5000,
        type => worker,
        modules => [mc_topology]
    }.

-spec auth_opts(none | #{user := binary(), password := binary(), source := binary()}) ->
    proplists:proplist().
auth_opts(none) ->
    [];
auth_opts(#{user := User, password := Password, source := Source}) ->
    [{login, User}, {password, Password}, {auth_source, Source}].

-spec tls_opts(false | #{ca := os | file:filename_all()}) -> proplists:proplist().
tls_opts(false) ->
    [];
tls_opts(#{ca := Ca}) ->
    %% No server_name_indication on purpose: the hostname check uses the connect host, and an
    %% IP literal as the host fails that check (verified in the spike).
    Trust =
        case Ca of
            os -> {cacerts, public_key:cacerts_get()};
            Path -> {cacertfile, Path}
        end,
    [
        {ssl, true},
        {ssl_opts, [
            {verify, verify_peer},
            Trust,
            {versions, ['tlsv1.3', 'tlsv1.2']},
            {customize_hostname_check, [
                {match_fun, public_key:pkix_verify_hostname_match_fun(https)}
            ]}
        ]}
    ].

%% Reads the ETS table owned by geo_mongo_probe directly; never calls the probe.
-spec ready() -> boolean().
ready() ->
    try ets:lookup(?STATUS_TABLE, mongo) of
        [{mongo, up}] -> true;
        _ -> false
    catch
        %% The table is absent while the probe is not running (e.g. during a restart).
        error:badarg -> false
    end.

-spec ping() -> ok | {error, mongo_unavailable}.
ping() ->
    Result = guarded(fun() ->
        mongoc:transaction(
            ?TOPOLOGY,
            fun(#{pool := Worker}) -> mc_worker_api:command(Worker, #{<<"ping">> => 1}) end,
            #{},
            ?CALL_TIMEOUT
        )
    end),
    case Result of
        {true, #{<<"ok">> := Ok}} when Ok == 1 -> ok;
        _ -> {error, mongo_unavailable}
    end.

-spec update_one(binary(), map(), map(), #{upsert => boolean()}) ->
    {ok, write_result()} | {error, write_error()}.
update_one(Collection, Selector, Update, Opts) ->
    classify_write(
        guarded(fun() -> mongo_api:update(?TOPOLOGY, Collection, Selector, Update, Opts) end)
    ).

%% The document must carry its own _id. A duplicate key (unique index) is {write_failed, 11000}.
-spec insert_one(binary(), map()) -> {ok, write_result()} | {error, write_error()}.
insert_one(Collection, Doc) ->
    Result = guarded(fun() ->
        mongoc:transaction(
            ?TOPOLOGY,
            fun(#{pool := Worker}) -> mc_worker_api:insert(Worker, Collection, Doc) end,
            #{},
            ?CALL_TIMEOUT
        )
    end),
    case Result of
        %% The driver returns the reply together with the (id-assigned) document.
        {{Ok, Reply}, _Doc} when is_boolean(Ok) -> classify_write({Ok, Reply});
        Other -> classify_write(Other)
    end.

-spec delete_one(binary(), map()) -> {ok, write_result()} | {error, write_error()}.
delete_one(Collection, Selector) ->
    classify_write(
        guarded(fun() ->
            mongoc:transaction(
                ?TOPOLOGY,
                fun(#{pool := Worker}) ->
                    mc_worker_api:delete_one(Worker, Collection, Selector)
                end,
                #{},
                ?CALL_TIMEOUT
            )
        end)
    ).

-spec find_one(binary(), map(), map()) -> {ok, map()} | not_found | {error, mongo_unavailable}.
find_one(Collection, Selector, Projector) ->
    case guarded(fun() -> mongo_api:find_one(?TOPOLOGY, Collection, Selector, Projector) end) of
        Doc when is_map(Doc), map_size(Doc) > 0 -> {ok, Doc};
        undefined -> not_found;
        _ -> {error, mongo_unavailable}
    end.

%% {true, ...} only means the server answered; the body says whether the write happened.
-spec classify_write(term()) -> {ok, write_result()} | {error, write_error()}.
classify_write({true, #{<<"writeErrors">> := [First | _]}}) ->
    {error, {write_failed, error_code(First)}};
classify_write({true, #{<<"writeConcernError">> := Error}}) ->
    {error, {write_failed, error_code(Error)}};
classify_write({true, #{<<"n">> := N} = Reply}) when is_integer(N), N >= 0 ->
    {ok, #{matched => N, upserted => maps:is_key(<<"upserted">>, Reply)}};
classify_write({true, _}) ->
    {error, {write_failed, unknown}};
classify_write({false, _}) ->
    {error, {write_failed, unknown}};
classify_write({error, _}) ->
    {error, mongo_unavailable};
classify_write(_) ->
    {error, mongo_unavailable}.

-spec error_code(term()) -> integer() | unknown.
error_code(#{<<"code">> := Code}) when is_integer(Code) -> Code;
error_code(_) -> unknown.

%% A missing topology raises exit:{noproc, _} in the calling process, outside the driver's own
%% try/catch; a timeout inside a pool checkout exits too. Both mean "Mongo is unavailable".
-spec guarded(fun(() -> term())) -> term().
guarded(Fun) ->
    try
        Fun()
    catch
        exit:_ -> {error, mongo_unavailable}
    end.
