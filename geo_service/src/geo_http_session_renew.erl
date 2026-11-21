%% POST /api/session/renew {"jid": ..., "xmpp_password": ...} (ADR-019): a returning device
%% swaps its stored XMPP credential for a fresh JWT.
%%
%% The request body holds a LIVE credential, so this handler follows the ADR-018 section 4b reasoning:
%% everything that sees the decoded body runs inside ONE try/catch (guarded/3). That is a
%% deliberate, narrow exception to let-it-crash: this process is short-lived with nothing to
%% restart, and its exit reason ({badmatch, Map}) and the arguments of the top stack frame are
%% exactly what could carry the password. Cowboy would log both. The catch replies 500 and logs
%% only geo_crash:summary/3 (class, atom reason, frame arities). The xp1_ pattern in
%% geo_log_redact is only the backstop.
%%
%% The read phase stays outside the try: Cowboy's {request_error, ...} exits must propagate so
%% that it answers 400/408/413 (those carry no body). There is no terminate/3 on purpose.
%% The password is never matched in a function head outside the try, and the reply is the last
%% expression of the try.
%%
%% Every credential failure (malformed shape, unknown/pending/deleted profile, wrong password,
%% unknown XMPP account) is the same constant 401 body. No www-authenticate header: the
%% credentials travel in the body, not in an HTTP auth scheme. Nothing is logged per request;
%% geo_session is called fully qualified (the CT suite fault-injects it with meck).
-module(geo_http_session_renew).
-behaviour(cowboy_handler).

-export([init/2]).

-define(MAX_BODY, 1024).

-spec init(cowboy_req:req(), geo_config:session_cfg()) ->
    {ok, cowboy_req:req(), geo_config:session_cfg()}.
init(Req0, Cfg) ->
    Req =
        case cowboy_req:method(Req0) of
            <<"POST">> ->
                read(Req0, Cfg);
            _ ->
                Req1 = cowboy_req:set_resp_header(<<"allow">>, <<"POST">>, Req0),
                geo_http_reply:error_reply(
                    405, <<"method_not_allowed">>, <<"Use POST on this path.">>, Req1
                )
        end,
    {ok, Req, Cfg}.

-spec read(cowboy_req:req(), geo_config:session_cfg()) -> cowboy_req:req().
read(Req0, Cfg) ->
    case geo_http_json:read_json_object(Req0, ?MAX_BODY) of
        {ok, Body, Req} ->
            guarded(Body, Req, Cfg);
        {error, Status, Code, Message, Req} ->
            geo_http_reply:error_reply(Status, Code, Message, Req)
    end.

-spec guarded(map(), cowboy_req:req(), geo_config:session_cfg()) -> cowboy_req:req().
guarded(Body, Req, Cfg) ->
    try
        case Body of
            #{<<"jid">> := Jid, <<"xmpp_password">> := Password} when
                map_size(Body) =:= 2, is_binary(Jid), is_binary(Password)
            ->
                reply(geo_session:renew(Jid, Password, Cfg), Req);
            _ ->
                geo_http_reply:error_reply(
                    400,
                    <<"invalid_request">>,
                    <<"Send exactly {\"jid\": string, \"xmpp_password\": string}.">>,
                    Req
                )
        end
    catch
        Class:Reason:Stack ->
            crashed(Class, Reason, Stack, Req)
    end.

-spec reply({ok, geo_session:renew_result()} | {error, atom()}, cowboy_req:req()) ->
    cowboy_req:req().
reply({ok, #{nickname := Nickname, token := Token, expires_in := ExpiresIn}}, Req) ->
    geo_http_reply:json_ordered(
        200,
        [
            {<<"nickname">>, Nickname},
            {<<"token">>, Token},
            {<<"token_type">>, <<"Bearer">>},
            {<<"expires_in">>, ExpiresIn}
        ],
        Req
    );
reply({error, invalid_credentials}, Req) ->
    geo_http_reply:error_reply(
        401, <<"invalid_credentials">>, <<"These credentials are not valid.">>, Req
    );
reply({error, unavailable}, Req0) ->
    Req = cowboy_req:set_resp_header(<<"retry-after">>, <<"5">>, Req0),
    geo_http_reply:error_reply(
        503, <<"service_unavailable">>, <<"Try again in a few seconds.">>, Req
    );
reply({error, internal}, Req) ->
    internal_error(Req).

%% Only the sanitised summary is logged.
-spec crashed(error | exit | throw, term(), list(), cowboy_req:req()) -> cowboy_req:req().
crashed(Class, Reason, Stack, Req) ->
    #{class := C, reason := R, where := W} = geo_crash:summary(Class, Reason, Stack),
    logger:error(#{event => renew_crashed, class => C, reason => R, where => W}),
    internal_error(Req).

-spec internal_error(cowboy_req:req()) -> cowboy_req:req().
internal_error(Req) ->
    geo_http_reply:error_reply(500, <<"internal_error">>, <<"Something went wrong.">>, Req).
