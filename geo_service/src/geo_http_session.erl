%% POST /api/session {"nickname": "..."}: creates a pseudonymous session (ADR-017).
%% The response carries the XMPP password, so it is never logged: this handler passes neither
%% the body, the result nor the request to the logger.
%%
%% geo_session:create/2 generates a LIVE password and token, so this handler follows the
%% ADR-018 section 4b reasoning (as geo_http_session_renew does): everything after the body is
%% decoded runs inside ONE try/catch (guarded/3). A crash there could otherwise put the password
%% into Cowboy's crash report (exit reason, top stack frame arguments). The catch replies 500
%% and logs only geo_crash:summary/3 (class, atom reason, frame arities); the xp1_ pattern in
%% geo_log_redact is only the backstop. The read phase stays outside the try so Cowboy's
%% {request_error, ...} exits still propagate (400/408/413); there is no terminate/3; the reply
%% is the last expression of the try. geo_session is called fully qualified (the CT suite
%% fault-injects it with meck).
-module(geo_http_session).
-behaviour(cowboy_handler).

-export([init/2]).

-define(MAX_BODY, 1024).

-spec init(cowboy_req:req(), geo_config:session_cfg()) ->
    {ok, cowboy_req:req(), geo_config:session_cfg()}.
init(Req0, Cfg) ->
    Req =
        case cowboy_req:method(Req0) of
            <<"POST">> ->
                post(Req0, Cfg);
            _ ->
                Req1 = cowboy_req:set_resp_header(<<"allow">>, <<"POST">>, Req0),
                geo_http_reply:error_reply(
                    405, <<"method_not_allowed">>, <<"Use POST on this path.">>, Req1
                )
        end,
    {ok, Req, Cfg}.

-spec post(cowboy_req:req(), geo_config:session_cfg()) -> cowboy_req:req().
post(Req0, Cfg) ->
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
            #{<<"nickname">> := Nickname} when is_binary(Nickname), map_size(Body) =:= 1 ->
                reply(geo_session:create(Nickname, Cfg), Req);
            _ ->
                geo_http_reply:error_reply(
                    400, <<"invalid_request">>, <<"Send exactly {\"nickname\": string}.">>, Req
                )
        end
    catch
        Class:Reason:Stack ->
            crashed(Class, Reason, Stack, Req)
    end.

-spec reply({ok, geo_session:result()} | {error, atom()}, cowboy_req:req()) -> cowboy_req:req().
reply(
    {ok, #{
        nickname := Nickname,
        jid := Jid,
        xmpp_password := Password,
        token := Token,
        expires_in := ExpiresIn
    }},
    Req
) ->
    geo_http_reply:json_ordered(
        201,
        [
            {<<"nickname">>, Nickname},
            {<<"jid">>, Jid},
            {<<"xmpp_password">>, Password},
            {<<"token">>, Token},
            {<<"token_type">>, <<"Bearer">>},
            {<<"expires_in">>, ExpiresIn}
        ],
        Req
    );
reply({error, invalid_nickname}, Req) ->
    geo_http_reply:error_reply(
        400,
        <<"invalid_nickname">>,
        <<"Nicknames are 2-20 characters: letters, digits, _ and -, starting with a letter or digit.">>,
        Req
    );
reply({error, nickname_taken}, Req) ->
    geo_http_reply:error_reply(
        409, <<"nickname_taken">>, <<"That nickname is not available.">>, Req
    );
reply({error, unavailable}, Req0) ->
    Req = cowboy_req:set_resp_header(<<"retry-after">>, <<"5">>, Req0),
    geo_http_reply:error_reply(
        503, <<"service_unavailable">>, <<"Try again in a few seconds.">>, Req
    );
reply({error, _}, Req) ->
    internal_error(Req).

%% Only the sanitised summary is logged.
-spec crashed(error | exit | throw, term(), list(), cowboy_req:req()) -> cowboy_req:req().
crashed(Class, Reason, Stack, Req) ->
    #{class := C, reason := R, where := W} = geo_crash:summary(Class, Reason, Stack),
    logger:error(#{event => session_crashed, class => C, reason => R, where => W}),
    internal_error(Req).

-spec internal_error(cowboy_req:req()) -> cowboy_req:req().
internal_error(Req) ->
    geo_http_reply:error_reply(500, <<"internal_error">>, <<"Something went wrong.">>, Req).
