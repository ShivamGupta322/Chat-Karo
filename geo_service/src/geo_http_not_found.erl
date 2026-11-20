-module(geo_http_not_found).
-behaviour(cowboy_handler).

-export([init/2]).

-spec init(cowboy_req:req(), term()) -> {ok, cowboy_req:req(), term()}.
init(Req0, State) ->
    Req = geo_http_reply:error_reply(404, <<"not_found">>, <<"No such resource.">>, Req0),
    {ok, Req, State}.
