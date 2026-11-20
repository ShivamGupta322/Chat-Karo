-module(geo_http_ready).
-behaviour(cowboy_handler).

-export([init/2]).

%% Readiness: 200 when the Mongo probe says up, else 503. /api/health stays pure liveness.
%% Never reads the request body.
-spec init(cowboy_req:req(), term()) -> {ok, cowboy_req:req(), term()}.
init(Req0, State) ->
    Req =
        case cowboy_req:method(Req0) of
            Method when Method =:= <<"GET">>; Method =:= <<"HEAD">> ->
                case geo_mongo:ready() of
                    true ->
                        geo_http_reply:json_ordered(
                            200, [{<<"status">>, <<"ready">>}, {<<"mongo">>, <<"up">>}], Req0
                        );
                    false ->
                        geo_http_reply:json_ordered(
                            503,
                            [{<<"status">>, <<"unavailable">>}, {<<"mongo">>, <<"down">>}],
                            Req0
                        )
                end;
            _ ->
                Req1 = cowboy_req:set_resp_header(<<"allow">>, <<"GET, HEAD">>, Req0),
                geo_http_reply:error_reply(
                    405, <<"method_not_allowed">>, <<"Use GET or HEAD on this path.">>, Req1
                )
        end,
    {ok, Req, State}.
