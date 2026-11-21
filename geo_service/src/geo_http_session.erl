%% POST /api/session {"nickname": "..."}: creates a pseudonymous session (ADR-017).
%% The response carries the XMPP password, so it is never logged: this handler passes neither
%% the body, the result nor the request to the logger.
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
        {ok, #{<<"nickname">> := Nickname} = Body, Req} when
            is_binary(Nickname), map_size(Body) =:= 1
        ->
            reply(geo_session:create(Nickname, Cfg), Req);
        {ok, _Body, Req} ->
            geo_http_reply:error_reply(
                400, <<"invalid_request">>, <<"Send exactly {\"nickname\": string}.">>, Req
            );
        {error, Status, Code, Message, Req} ->
            geo_http_reply:error_reply(Status, Code, Message, Req)
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
    geo_http_reply:error_reply(500, <<"internal_error">>, <<"Something went wrong.">>, Req).
