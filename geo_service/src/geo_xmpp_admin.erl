%% Client for the MongooseIM 6.2.1 admin GraphQL API (account.registerUser / removeUser /
%% checkPassword).
%% The GraphQL documents are constants; every value travels in `variables`. Request and response
%% bodies are never logged: the register request carries the new XMPP password, and the admin
%% API echoes passwords in some responses (the checkPassword user_does_not_exist error message
%% repeats the password, so even an error body is never logged). See ADR-017 and ADR-019.
-module(geo_xmpp_admin).

-export([register_user/4, remove_user/3, check_password/3]).
-export([
    register_request/4,
    remove_request/3,
    check_password_request/3,
    parse_register/3,
    parse_remove/3,
    parse_check_password/2
]).
-export_type([admin/0, reg_error/0, check_error/0]).

-define(REGISTER_QUERY, <<
    "mutation RegisterUser($domain: DomainName!, $username: UserName, $password: String!) "
    "{ account { registerUser(domain: $domain, username: $username, password: $password) "
    "{ jid } } }"
>>).
-define(REMOVE_QUERY,
    <<"mutation RemoveUser($user: JID!) { account { removeUser(user: $user) { jid } } }">>
).
%% Selects ONLY `correct`: that keeps the echoed password out of the success and wrong-password
%% bodies (MongooseIM 6.2.1 echoes it in the default `message` field).
-define(CHECK_QUERY, <<
    "query CheckPassword($user: JID!, $password: String!) "
    "{ account { checkPassword(user: $user, password: $password) { correct } } }"
>>).
-define(TIMEOUT, 5000).
-define(CONNECT_TIMEOUT, 2000).

-type admin() :: #{
    url := string(),
    authorization := binary(),
    basic_b64 := binary(),
    password := binary()
}.
-type reg_error() :: exists | unavailable | unauthorized | rejected | bad_response.
-type check_error() :: invalid | unavailable | unauthorized | bad_response.
-type request() :: {string(), [{string(), string()}], string(), binary()}.

-spec register_user(admin(), Domain :: binary(), Localpart :: binary(), Password :: binary()) ->
    ok | {error, reg_error()}.
register_user(Admin, Domain, Localpart, Password) ->
    Request = register_request(Admin, Domain, Localpart, Password),
    Sent = send(Request),
    Result = parse_register_result(Sent, jid(Localpart, Domain)),
    log_failure(Result, Sent),
    Result.

-spec remove_user(admin(), Domain :: binary(), Localpart :: binary()) ->
    ok | {error, not_found | unavailable | unauthorized | bad_response}.
remove_user(Admin, Domain, Localpart) ->
    Request = remove_request(Admin, Domain, Localpart),
    Sent = send(Request),
    Result = parse_remove_result(Sent, jid(Localpart, Domain)),
    log_failure(Result, Sent),
    Result.

%% ok: the password is right. {error, invalid}: wrong password or no such account.
-spec check_password(admin(), Jid :: binary(), Password :: binary()) -> ok | {error, check_error()}.
check_password(Admin, Jid, Password) ->
    Sent = send(check_password_request(Admin, Jid, Password)),
    Result =
        case Sent of
            {ok, {Status, Body}} -> parse_check_password(Status, Body);
            error -> {error, unavailable}
        end,
    log_failure(Result, Sent),
    Result.

-spec register_request(admin(), binary(), binary(), binary()) -> request().
register_request(Admin, Domain, Localpart, Password) ->
    Variables = #{
        <<"domain">> => Domain,
        <<"username">> => Localpart,
        <<"password">> => Password
    },
    request(Admin, ?REGISTER_QUERY, Variables).

-spec remove_request(admin(), binary(), binary()) -> request().
remove_request(Admin, Domain, Localpart) ->
    request(Admin, ?REMOVE_QUERY, #{<<"user">> => jid(Localpart, Domain)}).

-spec check_password_request(admin(), binary(), binary()) -> request().
check_password_request(Admin, Jid, Password) ->
    request(Admin, ?CHECK_QUERY, #{<<"user">> => Jid, <<"password">> => Password}).

-spec request(admin(), binary(), map()) -> request().
request(#{url := Url, authorization := Authorization}, Query, Variables) ->
    Body = iolist_to_binary(json:encode(#{<<"query">> => Query, <<"variables">> => Variables})),
    {Url, [{"authorization", binary_to_list(Authorization)}], "application/json", Body}.

%% 200 + the expected jid -> ok; 200 + errors[0].extensions.code "exists" -> exists,
%% "cannot_register" -> rejected; 401 -> unauthorized; 5xx -> unavailable; anything else
%% (400, jid mismatch, bad JSON) -> bad_response.
-spec parse_register(Status :: non_neg_integer(), Body :: binary(), ExpectedJid :: binary()) ->
    ok | {error, reg_error()}.
parse_register(200, Body, Jid) ->
    case decode(Body) of
        {ok, #{<<"data">> := #{<<"account">> := #{<<"registerUser">> := #{<<"jid">> := Jid}}}}} ->
            ok;
        {ok, Decoded} ->
            case error_code(Decoded) of
                <<"exists">> -> {error, exists};
                <<"cannot_register">> -> {error, rejected};
                _ -> {error, bad_response}
            end;
        error ->
            {error, bad_response}
    end;
parse_register(Status, _Body, _Jid) ->
    status_error(Status).

%% 200 correct true -> ok; correct false -> invalid; errors[0].extensions.code
%% "user_does_not_exist" -> invalid; any other 200 (other code, non-boolean correct, not JSON) ->
%% bad_response; 401 -> unauthorized; 5xx -> unavailable; anything else -> bad_response.
-spec parse_check_password(Status :: non_neg_integer(), Body :: binary()) ->
    ok | {error, check_error()}.
parse_check_password(200, Body) ->
    case decode(Body) of
        {ok, #{
            <<"data">> := #{
                <<"account">> := #{<<"checkPassword">> := #{<<"correct">> := Correct}}
            }
        }} when is_boolean(Correct) ->
            case Correct of
                true -> ok;
                false -> {error, invalid}
            end;
        {ok, Decoded} ->
            case error_code(Decoded) of
                <<"user_does_not_exist">> -> {error, invalid};
                _ -> {error, bad_response}
            end;
        error ->
            {error, bad_response}
    end;
parse_check_password(Status, _Body) ->
    status_error(Status).

%% ok -> ok; errors[0].extensions.code "not_allowed" (no such user) -> not_found.
-spec parse_remove(Status :: non_neg_integer(), Body :: binary(), ExpectedJid :: binary()) ->
    ok | {error, not_found | unavailable | unauthorized | bad_response}.
parse_remove(200, Body, Jid) ->
    case decode(Body) of
        {ok, #{<<"data">> := #{<<"account">> := #{<<"removeUser">> := #{<<"jid">> := Jid}}}}} ->
            ok;
        {ok, Decoded} ->
            case error_code(Decoded) of
                <<"not_allowed">> -> {error, not_found};
                _ -> {error, bad_response}
            end;
        error ->
            {error, bad_response}
    end;
parse_remove(Status, _Body, _Jid) ->
    case status_error(Status) of
        {error, Reason} when Reason =:= unavailable; Reason =:= unauthorized -> {error, Reason};
        {error, _} -> {error, bad_response}
    end.

-spec status_error(non_neg_integer()) -> {error, unavailable | unauthorized | bad_response}.
status_error(401) -> {error, unauthorized};
status_error(Status) when Status >= 500, Status =< 599 -> {error, unavailable};
status_error(_) -> {error, bad_response}.

-spec decode(binary()) -> {ok, term()} | error.
decode(Body) ->
    try json:decode(Body) of
        Decoded -> {ok, Decoded}
    catch
        error:_ -> error
    end.

-spec error_code(term()) -> term().
error_code(#{<<"errors">> := [#{<<"extensions">> := #{<<"code">> := Code}} | _]}) -> Code;
error_code(_) -> undefined.

-spec jid(binary(), binary()) -> binary().
jid(Localpart, Domain) -> <<Localpart/binary, "@", Domain/binary>>.

%% httpc default profile, per-request options only. Any failure to get an HTTP answer is
%% "unavailable"; the reason is dropped because it can embed request data.
-spec send(request()) -> {ok, {non_neg_integer(), binary()}} | error.
send({Url, Headers, ContentType, Body}) ->
    HttpOpts = [
        {timeout, ?TIMEOUT},
        {connect_timeout, ?CONNECT_TIMEOUT},
        {autoredirect, false}
    ],
    try httpc:request(post, {Url, Headers, ContentType, Body}, HttpOpts, [{body_format, binary}]) of
        {ok, {{_Version, Status, _Reason}, _RespHeaders, RespBody}} when is_binary(RespBody) ->
            {ok, {Status, RespBody}};
        _ ->
            error
    catch
        _:_ -> error
    end.

-spec parse_register_result({ok, {non_neg_integer(), binary()}} | error, binary()) ->
    ok | {error, reg_error()}.
parse_register_result({ok, {Status, Body}}, Jid) -> parse_register(Status, Body, Jid);
parse_register_result(error, _Jid) -> {error, unavailable}.

-spec parse_remove_result({ok, {non_neg_integer(), binary()}} | error, binary()) ->
    ok | {error, not_found | unavailable | unauthorized | bad_response}.
parse_remove_result({ok, {Status, Body}}, Jid) -> parse_remove(Status, Body, Jid);
parse_remove_result(error, _Jid) -> {error, unavailable}.

%% Status only: never a body.
-spec log_failure(ok | {error, atom()}, {ok, {non_neg_integer(), binary()}} | error) -> ok.
log_failure({error, unauthorized}, _Sent) ->
    logger:error(#{event => xmpp_admin_unauthorized});
log_failure({error, bad_response}, {ok, {Status, _Body}}) ->
    logger:warning(#{event => xmpp_admin_bad_response, status => Status});
log_failure(_, _) ->
    ok.
