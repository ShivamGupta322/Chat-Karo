%% POST /api/locate (ADR-018): authenticated clients send a position, geo_service turns it into
%% a geohash cell, bumps the rooms document and answers with the room. The coordinates are
%% never logged, stored or echoed.
%%
%% Everything that sees the decoded body runs inside ONE try/catch (guarded/3). That is a
%% deliberate, narrow exception to let-it-crash: this process is short-lived with nothing to
%% restart, and its exit reason and stack trace are exactly what could carry the user's
%% position (a {badmatch, Map} reason, the arguments of the top stack frame). Cowboy would log
%% both. The catch replies 500 and logs only geo_crash:summary/3 (class, atom reason, frame
%% arities).
%%
%% Every function called here must be total on any input (bad header bytes included).
%% The read and auth phases stay outside the try: Cowboy's {request_error, ...} exits must
%% propagate so that it answers 400/408/413, and those carry no body. There is no terminate/3
%% on purpose (Cowboy would pass it {crash, Class, Reason}).
%%
%% Calls into geo_locate and geo_store are fully qualified (the CT suite fault-injects them
%% with meck). Nothing here logs the body, the request, the config, or a coordinate.
-module(geo_http_locate).
-behaviour(cowboy_handler).

-export([init/2]).
-export_type([cfg/0]).

-define(MAX_BODY, 256).

-type cfg() :: #{jwt_secret := binary(), muc_domain := binary()}.

-spec init(cowboy_req:req(), cfg()) -> {ok, cowboy_req:req(), cfg()}.
init(Req0, Cfg) ->
    Req =
        case cowboy_req:method(Req0) of
            <<"POST">> ->
                authenticate(Req0, Cfg);
            _ ->
                Req1 = cowboy_req:set_resp_header(<<"allow">>, <<"POST">>, Req0),
                geo_http_reply:error_reply(
                    405, <<"method_not_allowed">>, <<"Use POST on this path.">>, Req1
                )
        end,
    {ok, Req, Cfg}.

-spec authenticate(cowboy_req:req(), cfg()) -> cowboy_req:req().
authenticate(Req0, #{jwt_secret := Key} = Cfg) ->
    Header = cowboy_req:header(<<"authorization">>, Req0, undefined),
    case geo_http_auth:check(Header, Key, erlang:system_time(second)) of
        {ok, _Sub} -> query_check(Req0, Cfg);
        {error, Why} -> unauthorized(Why, Req0)
    end.

-spec unauthorized(missing | invalid, cowboy_req:req()) -> cowboy_req:req().
unauthorized(Why, Req0) ->
    Req = cowboy_req:set_resp_header(
        <<"www-authenticate">>, geo_http_auth:www_authenticate(Why), Req0
    ),
    geo_http_reply:error_reply(
        401, <<"unauthorized">>, <<"A valid bearer token is required.">>, Req
    ).

-spec query_check(cowboy_req:req(), cfg()) -> cowboy_req:req().
query_check(Req, Cfg) ->
    case cowboy_req:qs(Req) of
        <<>> ->
            read(Req, Cfg);
        _ ->
            geo_http_reply:error_reply(
                400, <<"invalid_request">>, <<"Query parameters are not accepted.">>, Req
            )
    end.

-spec read(cowboy_req:req(), cfg()) -> cowboy_req:req().
read(Req0, Cfg) ->
    case geo_http_json:read_json_object(Req0, ?MAX_BODY) of
        {ok, Body, Req} ->
            guarded(Body, Req, Cfg);
        {error, Status, Code, Message, Req} ->
            geo_http_reply:error_reply(Status, Code, Message, Req)
    end.

%% The reply is the last expression of the try, so a failure inside the reply cannot lead to
%% a second reply.
-spec guarded(map(), cowboy_req:req(), cfg()) -> cowboy_req:req().
guarded(Body, Req, #{muc_domain := MucDomain}) ->
    try
        case geo_locate:cell_for(Body) of
            {ok, Cell, Range} ->
                case geo_store:touch_room(Cell) of
                    %% Created and updated answer identically (no activity oracle). Any other
                    %% value is an unexpected state and goes to the catch.
                    {ok, Outcome} when Outcome =:= created; Outcome =:= updated ->
                        geo_http_reply:json_ordered(
                            200, geo_locate:response(Cell, Range, MucDomain), Req
                        );
                    {error, mongo_unavailable} ->
                        unavailable(Req);
                    {error, write_failed} ->
                        logger:warning(#{event => locate_store_failed}),
                        internal_error(Req)
                end;
            {error, invalid_request} ->
                geo_http_reply:error_reply(
                    400,
                    <<"invalid_request">>,
                    <<"Send {\"lat\": number, \"lng\": number} with optional \"range\" (block, neighbourhood, area) and \"accuracy\" (metres).">>,
                    Req
                );
            {error, invalid_location} ->
                geo_http_reply:error_reply(
                    400,
                    <<"invalid_location">>,
                    <<"lat must be within -90..90 and lng within -180..180.">>,
                    Req
                )
        end
    catch
        Class:Reason:Stack ->
            crashed(Class, Reason, Stack, Req)
    end.

%% Only the sanitised summary is logged.
-spec crashed(error | exit | throw, term(), list(), cowboy_req:req()) -> cowboy_req:req().
crashed(Class, Reason, Stack, Req) ->
    #{class := C, reason := R, where := W} = geo_crash:summary(Class, Reason, Stack),
    logger:error(#{event => locate_crashed, class => C, reason => R, where => W}),
    internal_error(Req).

-spec unavailable(cowboy_req:req()) -> cowboy_req:req().
unavailable(Req0) ->
    Req = cowboy_req:set_resp_header(<<"retry-after">>, <<"5">>, Req0),
    geo_http_reply:error_reply(
        503, <<"service_unavailable">>, <<"Try again in a few seconds.">>, Req
    ).

-spec internal_error(cowboy_req:req()) -> cowboy_req:req().
internal_error(Req) ->
    geo_http_reply:error_reply(500, <<"internal_error">>, <<"Something went wrong.">>, Req).
