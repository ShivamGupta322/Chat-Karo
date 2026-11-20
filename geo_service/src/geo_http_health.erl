-module(geo_http_health).
-behaviour(cowboy_handler).

-export([init/2]).

%% Liveness only. Never reads the request body.
-spec init(cowboy_req:req(), term()) -> {ok, cowboy_req:req(), term()}.
init(Req0, State) ->
    Req =
        case cowboy_req:method(Req0) of
            Method when Method =:= <<"GET">>; Method =:= <<"HEAD">> ->
                geo_http_reply:json(200, #{<<"status">> => <<"ok">>}, Req0);
            _ ->
                Req1 = cowboy_req:set_resp_header(<<"allow">>, <<"GET, HEAD">>, Req0),
                geo_http_reply:error_reply(
                    405, <<"method_not_allowed">>, <<"Use GET or HEAD on this path.">>, Req1
                )
        end,
    {ok, Req, State}.
