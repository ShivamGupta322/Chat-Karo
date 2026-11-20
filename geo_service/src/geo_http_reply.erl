-module(geo_http_reply).

-export([json/3, error_reply/4]).

-spec json(cowboy:http_status(), map(), cowboy_req:req()) -> cowboy_req:req().
json(Status, Body, Req) ->
    cowboy_req:reply(Status, headers(), json:encode(Body), Req).

-spec error_reply(cowboy:http_status(), binary(), binary(), cowboy_req:req()) -> cowboy_req:req().
error_reply(Status, Code, Message, Req) ->
    json(Status, #{<<"error">> => Code, <<"message">> => Message}, Req).

-spec headers() -> cowboy:http_headers().
headers() ->
    #{
        <<"content-type">> => <<"application/json">>,
        <<"cache-control">> => <<"no-store">>,
        <<"x-content-type-options">> => <<"nosniff">>
    }.
