-module(geo_config).

-export([http_listen/0, parse_port/1, parse_ip/1]).
-export([
    mongo/0,
    parse_hosts/1,
    parse_replica_set/1,
    parse_db/1,
    parse_user/1,
    parse_password/1,
    parse_auth_source/1,
    parse_tls/1,
    parse_tls_ca_file/1,
    parse_pool_size/1
]).
-export([
    session/0,
    parse_jwt_secret/1,
    parse_xmpp_domain/1,
    parse_room_owner/1,
    muc_domain/1,
    parse_admin_url/1,
    parse_admin_user/1,
    parse_admin_password/1
]).
-export_type([listen/0, mongo/0, mongo_seed/0, mongo_key/0, session_cfg/0, session_key/0]).

-type listen() :: #{ip := inet:ip4_address(), port := inet:port_number()}.
%% "host:port" strings, as the mongodb driver wants them.
-type mongo_seed() :: {single, string()} | {rs, binary(), [string(), ...]}.
-type mongo() :: #{
    seed := mongo_seed(),
    database := binary(),
    auth := none | #{user := binary(), password := binary(), source := binary()},
    tls := false | #{ca := os | file:filename_all()},
    pool_size := 1..50
}.
-type mongo_key() ::
    mongo_hosts
    | mongo_replica_set
    | mongo_db
    | mongo_user
    | mongo_password
    | mongo_auth_source
    | mongo_tls
    | mongo_tls_ca_file
    | mongo_pool_size.

-type session_key() ::
    jwt_secret
    | xmpp_domain
    | mim_admin_url
    | mim_admin_user
    | mim_admin_password
    | xmpp_room_owner.
-type session_cfg() :: #{
    jwt_secret := binary(),
    xmpp_domain := binary(),
    muc_domain := binary(),
    room_owner := binary(),
    admin := geo_xmpp_admin:admin()
}.

%% The only function in the code base that reads the application environment.
-spec http_listen() -> {ok, listen()} | {error, {bad_config, http_ip | http_port}}.
http_listen() ->
    case parse_ip(application:get_env(geo_service, http_ip, undefined)) of
        {ok, Ip} ->
            case parse_port(application:get_env(geo_service, http_port, undefined)) of
                {ok, Port} -> {ok, #{ip => Ip, port => Port}};
                error -> {error, {bad_config, http_port}}
            end;
        error ->
            {error, {bad_config, http_ip}}
    end.

%% Integer, or a non-empty string/binary of ASCII digits, in 0..65535. Port 0 (ephemeral) is accepted
%% for the CT suite, but it would fail the container healthcheck, which probes a fixed port.
-spec parse_port(term()) -> {ok, inet:port_number()} | error.
parse_port(Port) when is_integer(Port), Port >= 0, Port =< 65535 ->
    {ok, Port};
parse_port(Bin) when is_binary(Bin) ->
    parse_port(binary_to_list(Bin));
parse_port([_ | _] = Str) ->
    case lists:all(fun is_digit/1, Str) of
        true -> parse_port(list_to_integer(Str));
        false -> error
    end;
parse_port(_) ->
    error.

%% IPv4 dotted quad only (string or binary).
-spec parse_ip(term()) -> {ok, inet:ip4_address()} | error.
parse_ip(Bin) when is_binary(Bin) ->
    parse_ip(binary_to_list(Bin));
parse_ip([_ | _] = Str) ->
    case lists:all(fun(C) -> is_integer(C) andalso C >= 0 andalso C =< 255 end, Str) of
        true ->
            case inet:parse_ipv4strict_address(Str) of
                {ok, Ip} -> {ok, Ip};
                {error, _} -> error
            end;
        false ->
            error
    end;
parse_ip(_) ->
    error.

-spec is_digit(term()) -> boolean().
is_digit(C) -> is_integer(C) andalso C >= $0 andalso C =< $9.

%%% MongoDB --------------------------------------------------------------------------------

%% Validation order: hosts, replica_set, db, user, password, auth_source, tls, tls_ca_file,
%% pool_size. Errors name the key only, never the value (the password must not leak).
-spec mongo() -> {ok, mongo()} | {error, {bad_config, mongo_key()}}.
mongo() ->
    Get = fun(Key, Default) -> application:get_env(geo_service, Key, Default) end,
    maybe
        {ok, HostList} ?= bad(mongo_hosts, parse_hosts(Get(mongo_hosts, undefined))),
        {ok, RsName} ?= bad(mongo_replica_set, parse_replica_set(Get(mongo_replica_set, ""))),
        ok ?= check_rs(HostList, RsName),
        {ok, Database} ?= bad(mongo_db, parse_db(Get(mongo_db, undefined))),
        {ok, User} ?= bad(mongo_user, parse_user(Get(mongo_user, ""))),
        {ok, Password} ?= bad(mongo_password, parse_password(Get(mongo_password, ""))),
        {ok, Source} ?= bad(mongo_auth_source, parse_auth_source(Get(mongo_auth_source, ""))),
        ok ?= check_pair(User, Password),
        {ok, TlsOn} ?= bad(mongo_tls, parse_tls(Get(mongo_tls, ""))),
        {ok, Tls} ?= tls_opts(TlsOn, Get(mongo_tls_ca_file, "")),
        {ok, Size} ?= bad(mongo_pool_size, parse_pool_size(Get(mongo_pool_size, ""))),
        {ok, #{
            seed => seed(HostList, RsName),
            database => Database,
            auth => auth(User, Password, Source),
            tls => Tls,
            pool_size => Size
        }}
    end.

-spec bad(Key, {ok, T} | error) -> {ok, T} | {error, {bad_config, Key}} when
    Key :: mongo_key() | session_key().
bad(_Key, {ok, _} = Ok) -> Ok;
bad(Key, error) -> {error, {bad_config, Key}}.

%% More than one host only makes sense as a replica set.
-spec check_rs([{string(), inet:port_number()}], binary()) ->
    ok | {error, {bad_config, mongo_replica_set}}.
check_rs([_, _ | _], <<>>) -> {error, {bad_config, mongo_replica_set}};
check_rs(_, _) -> ok.

%% Both empty: no auth. Exactly one empty: name the empty key.
-spec check_pair(binary(), binary()) -> ok | {error, {bad_config, mongo_user | mongo_password}}.
check_pair(<<>>, <<_, _/binary>>) -> {error, {bad_config, mongo_user}};
check_pair(<<_, _/binary>>, <<>>) -> {error, {bad_config, mongo_password}};
check_pair(_, _) -> ok.

-spec tls_opts(boolean(), term()) ->
    {ok, false | #{ca := os | file:filename_all()}} | {error, {bad_config, mongo_tls_ca_file}}.
tls_opts(false, _CaFile) ->
    {ok, false};
tls_opts(true, CaFile) ->
    case parse_tls_ca_file(CaFile) of
        {ok, Ca} -> {ok, #{ca => Ca}};
        error -> {error, {bad_config, mongo_tls_ca_file}}
    end.

-spec seed([{string(), inet:port_number()}, ...], binary()) -> mongo_seed().
seed(Hosts, Rs) ->
    [First | Rest] = [H ++ ":" ++ integer_to_list(P) || {H, P} <- Hosts],
    case {Rest, Rs} of
        {[], <<>>} -> {single, First};
        _ -> {rs, Rs, [First | Rest]}
    end.

-spec auth(binary(), binary(), binary()) ->
    none | #{user := binary(), password := binary(), source := binary()}.
auth(<<>>, <<>>, _Source) -> none;
auth(User, Password, Source) -> #{user => User, password => Password, source => Source}.

%% Comma-separated host[:port], 1..16 entries, no whitespace, no IPv6.
-spec parse_hosts(term()) -> {ok, [{string(), inet:port_number()}, ...]} | error.
parse_hosts(Value) ->
    case text(Value) of
        {ok, Bin} when byte_size(Bin) > 0 ->
            Entries = binary:split(Bin, <<",">>, [global]),
            case length(Entries) =< 16 of
                true -> parse_host_entries(Entries, []);
                false -> error
            end;
        _ ->
            error
    end.

-spec parse_host_entries([binary()], [{string(), inet:port_number()}]) ->
    {ok, [{string(), inet:port_number()}, ...]} | error.
parse_host_entries([], [_ | _] = Acc) ->
    {ok, lists:reverse(Acc)};
parse_host_entries([], []) ->
    error;
parse_host_entries([Entry | Rest], Acc) ->
    case parse_host(binary:split(Entry, <<":">>, [global])) of
        {ok, HostPort} -> parse_host_entries(Rest, [HostPort | Acc]);
        error -> error
    end.

-spec parse_host([binary()]) -> {ok, {string(), inet:port_number()}} | error.
parse_host([Host]) -> parse_host(Host, <<"27017">>);
parse_host([Host, Port]) -> parse_host(Host, Port);
parse_host(_) -> error.

-spec parse_host(binary(), binary()) -> {ok, {string(), inet:port_number()}} | error.
parse_host(Host, Port) ->
    HostOk =
        byte_size(Host) >= 1 andalso byte_size(Host) =< 253 andalso
            all_bytes(Host, fun host_char/1),
    PortOk =
        byte_size(Port) >= 1 andalso byte_size(Port) =< 5 andalso all_bytes(Port, fun is_digit/1),
    case HostOk andalso PortOk of
        true ->
            case binary_to_integer(Port) of
                N when N >= 1, N =< 65535 -> {ok, {binary_to_list(Host), N}};
                _ -> error
            end;
        false ->
            error
    end.

%% "" (standalone) or a replica-set name.
-spec parse_replica_set(term()) -> {ok, binary()} | error.
parse_replica_set(Value) ->
    optional_name(Value, 64, fun rs_char/1).

-spec parse_db(term()) -> {ok, binary()} | error.
parse_db(Value) ->
    required_name(Value, 63, fun db_char/1).

%% "" means no authentication (then the password must be empty too).
-spec parse_user(term()) -> {ok, binary()} | error.
parse_user(Value) ->
    optional_name(Value, 128, fun user_char/1).

%% Printable ASCII only (32..126), and none of the characters that would break the sys.config
%% quoting: no `"` or `\`.
-spec parse_password(term()) -> {ok, binary()} | error.
parse_password(Value) ->
    case text(Value) of
        {ok, Bin} ->
            case all_bytes(Bin, fun password_char/1) of
                true -> {ok, Bin};
                false -> error
            end;
        error ->
            error
    end.

%% "" defaults to admin.
-spec parse_auth_source(term()) -> {ok, binary()} | error.
parse_auth_source(Value) ->
    case text(Value) of
        {ok, <<>>} -> {ok, <<"admin">>};
        _ -> required_name(Value, 63, fun db_char/1)
    end.

%% Exactly "true" or "false"; "" is false.
-spec parse_tls(term()) -> {ok, boolean()} | error.
parse_tls(Value) ->
    case text(Value) of
        {ok, <<"true">>} -> {ok, true};
        {ok, <<"false">>} -> {ok, false};
        {ok, <<>>} -> {ok, false};
        _ -> error
    end.

%% "" means the operating-system trust store (it must be loadable); otherwise an existing file.
-spec parse_tls_ca_file(term()) -> {ok, os | file:filename_all()} | error.
parse_tls_ca_file(Value) ->
    case text(Value) of
        {ok, <<>>} ->
            case public_key:cacerts_load() of
                ok -> {ok, os};
                _ -> error
            end;
        {ok, Bin} ->
            Path = binary_to_list(Bin),
            case filelib:is_regular(Path) of
                true -> {ok, Path};
                false -> error
            end;
        error ->
            error
    end.

%% "" defaults to 5.
-spec parse_pool_size(term()) -> {ok, 1..50} | error.
parse_pool_size(Value) ->
    case text(Value) of
        {ok, <<>>} ->
            {ok, 5};
        {ok, Bin} when byte_size(Bin) =< 2 ->
            case all_bytes(Bin, fun is_digit/1) of
                true ->
                    case binary_to_integer(Bin) of
                        N when N >= 1, N =< 50 -> {ok, N};
                        _ -> error
                    end;
                false ->
                    error
            end;
        _ ->
            error
    end.

%%% Session (JWT + MongooseIM admin API) ------------------------------------------------

%% Validation order: jwt_secret, xmpp_domain, mim_admin_url, mim_admin_user, mim_admin_password,
%% xmpp_room_owner. Errors name the key only, never the value (these are secrets).
-spec session() -> {ok, session_cfg()} | {error, {bad_config, session_key()}}.
session() ->
    Get = fun(Key) -> application:get_env(geo_service, Key, undefined) end,
    maybe
        {ok, Secret} ?= bad(jwt_secret, parse_jwt_secret(Get(jwt_secret))),
        {ok, Domain} ?= bad(xmpp_domain, parse_xmpp_domain(Get(xmpp_domain))),
        {ok, Url} ?= bad(mim_admin_url, parse_admin_url(Get(mim_admin_url))),
        {ok, User} ?= bad(mim_admin_user, parse_admin_user(Get(mim_admin_user))),
        {ok, Password} ?= bad(mim_admin_password, parse_admin_password(Get(mim_admin_password))),
        true ?= byte_size(Domain) =< 249 orelse {error, {bad_config, xmpp_domain}},
        {ok, Owner} ?= bad(xmpp_room_owner, parse_room_owner(Get(xmpp_room_owner))),
        Basic = base64:encode(<<User/binary, ":", Password/binary>>),
        {ok, #{
            jwt_secret => Secret,
            xmpp_domain => Domain,
            muc_domain => muc_domain(Domain),
            room_owner => Owner,
            admin => #{
                url => Url,
                authorization => <<"Basic ", Basic/binary>>,
                basic_b64 => Basic,
                password => Password
            }
        }}
    end.

%% The MUC service domain: muc.<domain>, as hard-coded in mongooseim.toml.tmpl (host = "muc.@HOST@")
%% and as the web derives it (ADR-018). Callers keep the domain within 249 bytes.
-spec muc_domain(XmppDomain :: binary()) -> binary().
muc_domain(XmppDomain) -> <<"muc.", XmppDomain/binary>>.

%% 32..512 printable ASCII (no `"` or `\`), at least 10 distinct characters, and not a
%% placeholder starting with change-me (any case). The HMAC key is the raw bytes.
-spec parse_jwt_secret(term()) -> {ok, binary()} | error.
parse_jwt_secret(Value) ->
    case parse_password(Value) of
        {ok, Bin} when byte_size(Bin) >= 32, byte_size(Bin) =< 512 ->
            Distinct = length(lists:usort(binary_to_list(Bin))),
            Placeholder = string:prefix(string:lowercase(Bin), <<"change-me">>) =/= nomatch,
            case Distinct >= 10 andalso not Placeholder of
                true -> {ok, Bin};
                false -> error
            end;
        _ ->
            error
    end.

%% Lowercase only: MongooseIM returns lowercased JIDs, so an uppercase domain would make every
%% registration's JID check fail (ADR-017).
-spec parse_xmpp_domain(term()) -> {ok, binary()} | error.
parse_xmpp_domain(Value) ->
    case required_name(Value, 253, fun host_char/1) of
        {ok, Domain} ->
            case string:lowercase(Domain) of
                Domain -> {ok, Domain};
                _ -> error
            end;
        error ->
            error
    end.

%% The room-owner account's localpart (ADR-020): ^[a-z][a-z0-9-]{2,31}$, and never the shape of a
%% pseudonymous identity (u + 32 lowercase hex), so a user can't be mistaken for the owner.
-spec parse_room_owner(term()) -> {ok, binary()} | error.
parse_room_owner(Value) ->
    case text(Value) of
        {ok, <<First, _/binary>> = Bin} when
            First >= $a, First =< $z, byte_size(Bin) >= 3, byte_size(Bin) =< 32
        ->
            case all_bytes(Bin, fun owner_char/1) andalso not is_user_sub(Bin) of
                true -> {ok, Bin};
                false -> error
            end;
        _ ->
            error
    end.

-spec is_user_sub(binary()) -> boolean().
is_user_sub(<<"u", Hex:32/binary>>) ->
    all_bytes(Hex, fun(C) -> is_digit(C) orelse (C >= $a andalso C =< $f) end);
is_user_sub(_) ->
    false.

-spec owner_char(byte()) -> boolean().
owner_char(C) -> (C >= $a andalso C =< $z) orelse is_digit(C) orelse C =:= $-.

%% An http:// URL with a host and a non-empty path; no credentials, query or fragment (the
%% admin credentials travel in the Authorization header). Returned as a string for httpc.
-spec parse_admin_url(term()) -> {ok, string()} | error.
parse_admin_url(Value) ->
    case text(Value) of
        {ok, Bin} when byte_size(Bin) >= 1, byte_size(Bin) =< 2048 ->
            Str = binary_to_list(Bin),
            case lists:all(fun(C) -> C >= 33 andalso C =< 126 end, Str) of
                true -> admin_url(uri_string:parse(Str), Str);
                false -> error
            end;
        _ ->
            error
    end.

-spec admin_url(uri_string:uri_map() | uri_string:error(), string()) -> {ok, string()} | error.
admin_url(
    #{scheme := "http", host := [_ | _], path := [_ | _]} = Uri, Str
) ->
    case
        maps:is_key(userinfo, Uri) orelse maps:is_key(query, Uri) orelse maps:is_key(fragment, Uri)
    of
        true -> error;
        false -> {ok, Str}
    end;
admin_url(_, _) ->
    error.

-spec parse_admin_user(term()) -> {ok, binary()} | error.
parse_admin_user(Value) ->
    required_name(Value, 128, fun user_char/1).

-spec parse_admin_password(term()) -> {ok, binary()} | error.
parse_admin_password(Value) ->
    case parse_password(Value) of
        {ok, <<_, _/binary>> = Bin} -> {ok, Bin};
        _ -> error
    end.

%%% helpers

%% Strings and binaries only (env values arrive as strings from sys.config).
-spec text(term()) -> {ok, binary()} | error.
text(Bin) when is_binary(Bin) ->
    {ok, Bin};
text(List) when is_list(List) ->
    case lists:all(fun(C) -> is_integer(C) andalso C >= 0 andalso C =< 255 end, List) of
        true -> {ok, list_to_binary(List)};
        false -> error
    end;
text(_) ->
    error.

-spec optional_name(term(), pos_integer(), fun((byte()) -> boolean())) -> {ok, binary()} | error.
optional_name(Value, Max, Pred) ->
    case text(Value) of
        {ok, <<>>} -> {ok, <<>>};
        _ -> required_name(Value, Max, Pred)
    end.

-spec required_name(term(), pos_integer(), fun((byte()) -> boolean())) -> {ok, binary()} | error.
required_name(Value, Max, Pred) ->
    case text(Value) of
        {ok, Bin} when byte_size(Bin) >= 1, byte_size(Bin) =< Max ->
            case all_bytes(Bin, Pred) of
                true -> {ok, Bin};
                false -> error
            end;
        _ ->
            error
    end.

-spec all_bytes(binary(), fun((byte()) -> boolean())) -> boolean().
all_bytes(Bin, Pred) -> lists:all(Pred, binary_to_list(Bin)).

-spec alnum(byte()) -> boolean().
alnum(C) -> (C >= $a andalso C =< $z) orelse (C >= $A andalso C =< $Z) orelse is_digit(C).

-spec host_char(byte()) -> boolean().
host_char(C) -> alnum(C) orelse C =:= $. orelse C =:= $-.

-spec rs_char(byte()) -> boolean().
rs_char(C) -> alnum(C) orelse C =:= $_ orelse C =:= $. orelse C =:= $-.

-spec db_char(byte()) -> boolean().
db_char(C) -> alnum(C) orelse C =:= $_ orelse C =:= $-.

-spec user_char(byte()) -> boolean().
user_char(C) -> alnum(C) orelse C =:= $. orelse C =:= $_ orelse C =:= $@ orelse C =:= $-.

-spec password_char(byte()) -> boolean().
password_char(C) -> C >= 32 andalso C =< 126 andalso C =/= $" andalso C =/= $\\.
